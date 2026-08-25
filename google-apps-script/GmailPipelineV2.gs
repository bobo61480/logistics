/**
 * GmailPipelineV2.gs — resilient email -> LOGISTICS MASTER 2026 ingestion.
 *
 * Design goals:
 *  - process messages, not whole threads, so later replies/status changes are not hidden
 *    by a thread-level processed label;
 *  - parse shipment metadata from subject/body as well as attachments;
 *  - support ZIP bundles and use Drive REST conversion as the XLSX/PDF fallback;
 *  - update an existing source row by strong identifiers before applying append validation;
 *  - insert new inbound rows immediately above the literal SCHEDULING marker;
 *  - never silently mark an unsupported/empty extraction as processed;
 *  - canonicalize statuses before strict Sheets validation and bound retries.
 */

/* eslint-disable no-unused-vars */

var GMAIL_PIPELINE_V2_VERSION = "2026-08-12-v4-status-retry-stabilization";
var GMAIL_V2_LOOKBACK_DAYS = 4;
var GMAIL_V2_MAX_THREADS = 12;
var GMAIL_V2_RUNTIME_BUDGET_MS = 210000;
var GMAIL_V2_SEEN_PREFIX = "GMAIL_V2_SEEN_";
var GMAIL_V2_ATTEMPT_PREFIX = "GMAIL_V2_ATTEMPT_";
var GMAIL_V2_RETRY_AT_PREFIX = "GMAIL_V2_RETRY_AT_";
var GMAIL_V2_MAX_TRANSIENT_ATTEMPTS = 4;

function processLogisticsEmailsV2() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { skipped: "locked" };
  var runStarted = Date.now();
  try {
    var labels = gmailV2Labels_();
    var queries = gmailV2Queries_();
    // The broadened query, when enabled, is always the last one pushed by
    // gmailV2Queries_() — used below only to attribute a thread found
    // exclusively by it, for observing its yield/noise independently.
    var broadenedQueryIndex = GMAIL_V2_BROADENED_SEARCH_ENABLED_V2 ? queries.length - 1 : -1;
    var perQueryThreadCap = Math.ceil(GMAIL_V2_MAX_THREADS / queries.length);

    // One GmailApp.search call per query (never repeated — API quota),
    // cached locally so both passes below read from the same results.
    var perQueryResults = queries.map(function (query) {
      return GmailApp.search(query, 0, GMAIL_V2_MAX_THREADS);
    });

    // Pass 1: record which quer(y/ies) matched each thread, with NO cap
    // applied yet. Codex review on PR #102: computing attribution only
    // among admitted threads let a thread that overflowed query 0's own
    // share get admitted instead under the broadened query's share and
    // counted as "broadened-only" even though query 0 found it too —
    // inflating the metric this counter exists to keep honest.
    var matchedByQueryIndex = {};
    perQueryResults.forEach(function (threads, queryIndex) {
      threads.forEach(function (thread) {
        var id = thread.getId();
        if (!matchedByQueryIndex[id]) matchedByQueryIndex[id] = {};
        matchedByQueryIndex[id][queryIndex] = true;
      });
    });
    var matchedOnlyByBroadenedQuery = {};
    if (broadenedQueryIndex !== -1) {
      Object.keys(matchedByQueryIndex).forEach(function (id) {
        var membership = matchedByQueryIndex[id];
        if (membership[broadenedQueryIndex] && Object.keys(membership).length === 1) {
          matchedOnlyByBroadenedQuery[id] = true;
        }
      });
    }

    // Pass 2: admit threads into this run's working set, each query given
    // its own reserved share of GMAIL_V2_MAX_THREADS rather than filling
    // threadsById in query order and slicing the combined set afterward —
    // with a flat slice, a busy mailbox where the first two (already-
    // established) queries alone find 12+ distinct threads would silently
    // discard every result the new broadened query found, since its
    // matches were always inserted last (Codex review on PR #102). A
    // thread already admitted by an earlier query costs nothing against a
    // later query's own share. A thread with no unprocessed message left
    // (every message already seen, retry-deferred, or past the lookback
    // window) is skipped WITHOUT consuming its query's share — otherwise a
    // query that stably returns the same already-fully-handled threads on
    // every run can permanently starve a genuinely new thread ranked just
    // below the cap in that same query's results (Codex review on PR #102,
    // a failure mode this per-query cap made newly reachable).
    var threadsById = {};
    perQueryResults.forEach(function (threads, queryIndex) {
      var addedForThisQuery = 0;
      threads.forEach(function (thread) {
        var id = thread.getId();
        if (id in threadsById) return;
        if (addedForThisQuery >= perQueryThreadCap) return;
        if (!gmailV2ThreadHasUnprocessedMessageV2_(thread)) return;
        threadsById[id] = thread;
        addedForThisQuery++;
      });
    });

    var stats = {
      threads: 0, messages: 0, inserted: 0, updated: 0, noop: 0,
      pending: 0, errors: 0, deferredThreads: 0, retryDeferred: 0, budgetHit: false,
      broadenedMatches: Object.keys(matchedOnlyByBroadenedQuery).length
    };
    var threadIds = Object.keys(threadsById);
    for (var ti = 0; ti < threadIds.length; ti++) {
      if (Date.now() - runStarted >= GMAIL_V2_RUNTIME_BUDGET_MS) {
        stats.budgetHit = true;
        stats.deferredThreads += threadIds.length - ti;
        break;
      }
      var thread = threadsById[threadIds[ti]];
      var isBroadenedOnly = Boolean(matchedOnlyByBroadenedQuery[threadIds[ti]]);
      stats.threads++;
      var threadPending = false;
      var threadError = false;
      var threadFinished = true;
      var messages = thread.getMessages();
      for (var mi = 0; mi < messages.length; mi++) {
        if (Date.now() - runStarted >= GMAIL_V2_RUNTIME_BUDGET_MS) {
          stats.budgetHit = true;
          stats.deferredThreads += 1 + Math.max(0, threadIds.length - ti - 1);
          threadFinished = false;
          break;
        }
        var message = messages[mi];
        var messageId = message.getId();
        if (gmailV2Seen_(messageId)) continue;
        if (gmailV2RetryDeferred_(messageId)) { stats.retryDeferred++; continue; }
        if (Date.now() - message.getDate().getTime() > GMAIL_V2_LOOKBACK_DAYS * 86400000) continue;
        stats.messages++;
        try {
          var result = processLogisticsMessageV2_(message, isBroadenedOnly);
          stats.inserted += result.inserted;
          stats.updated += result.updated;
          stats.noop += result.noop;
          stats.pending += result.pending;
          threadPending = threadPending || result.pending > 0;
          gmailV2MarkSeen_(messageId);
          gmailV2ClearRetry_(messageId);
        } catch (err) {
          stats.errors++;
          var disposition = gmailV2FailureDisposition_(message, err);
          if (disposition.pending) {
            stats.pending++;
            threadPending = true;
          }
          if (disposition.seen) gmailV2MarkSeen_(messageId);
          else threadError = true;
          writeLog_("GMAIL V2 ERROR", messageId, String(err && err.stack || err));
        }
      }
      if (threadError) thread.addLabel(labels.error);
      if (threadPending) thread.addLabel(labels.pending);
      if (threadFinished && !threadError) thread.addLabel(labels.processed);
      if (!threadFinished) break;
    }

    if (stats.inserted || stats.updated) {
      SpreadsheetApp.flush();
      if (Date.now() - runStarted < GMAIL_V2_RUNTIME_BUDGET_MS - 45000) {
        try { syncInventoryModule(); } catch (syncErr) { writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "warn", String(syncErr)); }
      } else {
        writeLog_("GMAIL V2 INVENTORY FOLLOWUP", "deferred", "Hourly inventory sync will pick up Gmail source updates.");
      }
    }
    stats.elapsedMs = Date.now() - runStarted;
    writeLog_("GMAIL V2 RUN", GMAIL_PIPELINE_V2_VERSION, JSON.stringify(stats));
    return stats;
  } finally {
    lock.releaseLock();
  }
}

// Kill switch for the third, sender-agnostic query below — independent of
// the two hand-tuned queries above it, which are unaffected either way.
var GMAIL_V2_BROADENED_SEARCH_ENABLED_V2 = true;

// Generic shipment/logistics subject terms, not tied to any specific
// sender — lets a new/unknown shipper's own notice get picked up, instead
// of only ever finding emails from senders already hardcoded above.
var GMAIL_V2_GENERIC_LOGISTICS_TERMS_V2 = [
  "packing list", "commercial invoice", "bill of lading", "proof of delivery",
  "rate confirmation", "pickup confirmation", "shipment confirmation",
  "shipping notification", "new shipment", "tracking number", "waybill",
  "freight invoice", "customs release", "warehouse receipt", "delivery order",
  "cargo release", "ISF filing", "container release"
];

function gmailV2GenericLogisticsSubjectClauseV2_() {
  return GMAIL_V2_GENERIC_LOGISTICS_TERMS_V2.map(function (term) {
    return 'subject:"' + term + '"';
  }).join(" ");
}

function gmailV2Queries_() {
  var base = "newer_than:" + GMAIL_V2_LOOKBACK_DAYS + "d -in:spam -in:trash ";
  var queries = [
    base + '{subject:출고 subject:해상 subject:해운 subject:항공 subject:선적 subject:입고 subject:"AIR SHIPMENT" subject:"OCEAN SHIPMENT" subject:"SILICON2 LIST" subject:"arrival notice" subject:"bill of lading" subject:BOL subject:"entry summary" subject:"shipping documents" subject:ISF subject:"delivery order" subject:POD subject:MAWB subject:HAWB}',
    base + '{from:info@cargomatic.com from:mcinfo@ups.com from:ups.com from:fedex.com from:usps.com from:dhl.com} {subject:shipment subject:delivery subject:delivered subject:completed subject:rescheduled subject:pickup}'
  ];
  if (GMAIL_V2_BROADENED_SEARCH_ENABLED_V2) {
    queries.push(base + '{' + gmailV2GenericLogisticsSubjectClauseV2_() + '}');
  }
  return queries;
}

function gmailV2Labels_() {
  function getOrCreate(name) { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }
  return {
    processed: getOrCreate(GMAIL_PIPELINE.labels.processed),
    pending: getOrCreate(GMAIL_PIPELINE.labels.pending),
    error: getOrCreate(GMAIL_PIPELINE.labels.error)
  };
}

function gmailV2Seen_(messageId) {
  return Boolean(PropertiesService.getScriptProperties().getProperty(GMAIL_V2_SEEN_PREFIX + messageId));
}

function gmailV2MarkSeen_(messageId) {
  PropertiesService.getScriptProperties().setProperty(GMAIL_V2_SEEN_PREFIX + messageId, String(Date.now()));
}

function gmailV2RetryDeferred_(messageId) {
  var value = Number(PropertiesService.getScriptProperties().getProperty(GMAIL_V2_RETRY_AT_PREFIX + messageId) || 0);
  return value > Date.now();
}

/**
 * True when at least one message in this thread would actually be
 * processed (not already seen, not retry-deferred, within the lookback
 * window) — the exact same three checks the main per-message loop applies
 * later. Used only at thread-ADMISSION time, so a thread with nothing
 * left to do doesn't consume its query's share of the per-query thread
 * cap (Codex review on PR #102).
 */
function gmailV2ThreadHasUnprocessedMessageV2_(thread) {
  var messages = thread.getMessages();
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    var messageId = message.getId();
    if (gmailV2Seen_(messageId)) continue;
    if (gmailV2RetryDeferred_(messageId)) continue;
    if (Date.now() - message.getDate().getTime() > GMAIL_V2_LOOKBACK_DAYS * 86400000) continue;
    return true;
  }
  return false;
}

function gmailV2ClearRetry_(messageId) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(GMAIL_V2_ATTEMPT_PREFIX + messageId);
  props.deleteProperty(GMAIL_V2_RETRY_AT_PREFIX + messageId);
}

function gmailV2DeterministicError_(error) {
  var text = String(error && error.message || error || "");
  return /data validation|unsupported logistics status|status is not allowed|ambiguous|cannot be safely inserted|outside the .* section|no longer matches/i.test(text);
}

function gmailV2FailureDisposition_(message, error) {
  var messageId = message.getId();
  var props = PropertiesService.getScriptProperties();
  var prior = Number(props.getProperty(GMAIL_V2_ATTEMPT_PREFIX + messageId) || 0);
  var attempts = prior + 1;
  props.setProperty(GMAIL_V2_ATTEMPT_PREFIX + messageId, String(attempts));

  var deterministic = gmailV2DeterministicError_(error);
  if (!deterministic && attempts < GMAIL_V2_MAX_TRANSIENT_ATTEMPTS) {
    var delayMinutes = Math.min(120, 15 * Math.pow(2, attempts - 1));
    props.setProperty(GMAIL_V2_RETRY_AT_PREFIX + messageId, String(Date.now() + delayMinutes * 60000));
    return { seen: false, pending: false, attempts: attempts };
  }

  var subject = String(message.getSubject() || "").trim();
  var body = String(message.getPlainBody() || "");
  var context = extractEmailContextV2_(subject, body);
  addPendingRow_({
    kind: context.kind || "inbound",
    issues: [deterministic
      ? "Automation stopped after a deterministic validation/matching failure: " + String(error && error.message || error)
      : "Automation retry limit reached after " + attempts + " attempts: " + String(error && error.message || error)],
    record: mergeRecordContextV2_({ parseError: String(error && error.message || error) }, context, {
      messageId: messageId,
      subject: subject,
      body: body,
      from: message.getFrom(),
      date: message.getDate(),
      permalink: "https://mail.google.com/mail/u/0/#all/" + messageId
    }),
    meta: { messageId: messageId, subject: subject },
    driveUrl: ""
  });
  gmailV2ClearRetry_(messageId);
  return { seen: true, pending: true, attempts: attempts };
}

/**
 * Backward-compatible setup helper. Trigger creation is owned by setupAllTriggers().
 */
function ensureGmailV2Trigger_() {
  return GMAIL_PIPELINE_TRIGGER_SYNC_VERSION;
}

// Kill switch for auto-committing (match-update OR insert) a record whose
// thread was found ONLY by the sender-agnostic broadened query. Query 0
// (Korean/logistics subject keywords) was already fully sender-agnostic
// before this file's changes, so this doesn't newly introduce untrusted
// senders reaching the pipeline — but the broadened query measurably
// widens that pre-existing surface, and unlike query 0/1's specific
// keyword sets, its terms ("commercial invoice", "delivery order", ...)
// are common enough that a structurally plausible but unrelated or
// adversarial email could in principle score a strong-identifier match
// against a real existing row and get updated with no human review at all
// (Codex review on PR #102). Starting false forces every broadened-only
// find through PENDING VERIFICATION regardless of match/insert
// eligibility, for an observation period — the same "watch it work safely
// before trusting it" rollout this codebase already uses elsewhere
// (WMS_TRUCKING_DRY_RUN, OUTBOUND_INSERT_DRY_RUN_V2). Flip only after
// reviewing real PENDING VERIFICATION rows this produces.
var GMAIL_V2_BROADENED_AUTOCOMMIT_ENABLED_V2 = false;

function processLogisticsMessageV2_(message, isBroadenedOnly) {
  var subject = String(message.getSubject() || "").trim();
  var body = String(message.getPlainBody() || "");
  var meta = {
    messageId: message.getId(),
    subject: subject,
    body: body,
    from: message.getFrom(),
    date: message.getDate(),
    permalink: "https://mail.google.com/mail/u/0/#all/" + message.getId()
  };
  var context = extractEmailContextV2_(subject, body);
  // Resolved once per message, before any per-record work exists, so both
  // the Drive archiving below (which runs before records are finalized)
  // and every record (via mergeRecordContextV2_'s carry-forward list) see
  // the same customer/DC identity. Any context.kind other than "inbound"
  // (not narrowed to exactly "outbound") — extractEmailContextV2_'s
  // outbound detection looks specifically for WH-Trucking/CARGOMATIC-style
  // markers (STY/PRO#/PICKUP/RATE RQ), which a genuine ULTA/IHERB/TJX-ROSS
  // notice (just a PO/BOL/date) has no reason to contain, so context.kind
  // stays "" for exactly the emails this resolver chain most needs to
  // reach. Narrowing this to "outbound" only (an earlier revision, to
  // avoid a purely cosmetic archiving-bucket edge case below) made the
  // whole specialized-sheet routing capability effectively unreachable for
  // realistic non-WH-Trucking emails (Codex review on PR #103).
  if (context.kind !== "inbound") {
    var resolvedTarget = resolveOutboundTargetV2_({}, meta, context);
    if (resolvedTarget) context.customer = resolvedTarget.customer;
  }
  var attachments = message.getAttachments({ includeInlineImages: false, includeAttachments: true }) || [];
  var records = [];
  var supportedSeen = false;
  var documentAttachments = [];

  attachments.forEach(function (attachment) {
    var name = String(attachment.getName() || "attachment");
    if (/\.(png|jpe?g|gif|ics|vcf)$/i.test(name)) return;
    documentAttachments.push(attachment);
    var parsed = extractAttachmentRecordsV2_(attachment, name, context, meta);
    if (parsed.supported) supportedSeen = true;
    parsed.records.forEach(function (record) { records.push(record); });
  });

  if (!records.length && hasStrongLogisticsContextV2_(context)) {
    records.push(mergeRecordContextV2_({}, context, meta));
  }

  records = collapseShipmentRecordsV2_(records.map(function (record) {
    return mergeRecordContextV2_(record, context, meta);
  }));

  var documentFolderUrl = "";
  // Skip archiving only for a weak, unproven broadened-only match with zero
  // extracted records: the broadened search query is generic enough (e.g.
  // "commercial invoice", "delivery order") that an unrelated business email
  // could match the search alone, extract nothing, and still create a
  // permanent Drive folder no shipment ever references (Codex review on
  // PR #102). That risk is specific to threads found ONLY by the broadened
  // query — the two original, already-trusted queries should keep archiving
  // on a zero-record extraction failure exactly as before, since that's
  // often the only artifact a human has to debug why extraction failed
  // (Codex review round 3 on PR #102).
  var isWeakBroadenedMatch = isBroadenedOnly && !records.length;
  if (documentAttachments.length && !isWeakBroadenedMatch) {
    // A resolved customer/DC identity means an outbound-style sheet even
    // when context.kind itself stayed "" (the whole point of the broader
    // gate above) — otherwise a genuinely ULTA/IHERB/TJX-ROSS-bound email
    // would archive under "Inbound" purely because it never tripped the
    // WH-Trucking-specific outbound markers.
    var archiveDirection = (context.kind === "outbound" || context.customer) ? "outbound" : "inbound";
    documentFolderUrl = archiveEmailAttachmentsV2_(documentAttachments, records, archiveDirection, context.customer, context, meta);
    records.forEach(function (record) { record._driveFolder = documentFolderUrl; });
  }

  if (!records.length) {
    addPendingRow_({
      kind: context.kind || "inbound",
      issues: [supportedSeen ? "No reliable shipment record could be extracted." : "No supported logistics attachment or strong shipment identifiers were extracted."],
      record: mergeRecordContextV2_({ parseError: "Email extraction produced no shipment-level record." }, context, meta),
      meta: meta,
      driveUrl: documentFolderUrl
    });
    return { inserted: 0, updated: 0, noop: 0, pending: 1 };
  }

  if (isBroadenedOnly && !GMAIL_V2_BROADENED_AUTOCOMMIT_ENABLED_V2) {
    records.forEach(function (record) {
      addPendingRow_({
        kind: record.kind || context.kind || guessKindFromRecordV2_(record),
        issues: ["Broadened search match — routed to review during the initial observation period (GMAIL_V2_BROADENED_AUTOCOMMIT_ENABLED_V2 = false)."],
        record: record,
        meta: meta,
        driveUrl: record._driveFolder || documentFolderUrl
      });
    });
    return { inserted: 0, updated: 0, noop: 0, pending: records.length };
  }

  var result = { inserted: 0, updated: 0, noop: 0, pending: 0 };
  records.forEach(function (record) {
    var kind = record.kind || context.kind || guessKindFromRecordV2_(record);
    record.kind = kind;
    if (record.status) {
      var normalizedStatus = canonicalLogisticsStatus_(record.status);
      if (!normalizedStatus) throw new Error("Unsupported logistics status: " + record.status);
      record.status = normalizedStatus;
    }
    var upsert = kind === "outbound" ? upsertOutboundEmailAcrossSheetsV2_(record, false, OUTBOUND_INSERT_SHEETS_V2, OUTBOUND_INSERT_DRY_RUN_V2) : upsertInboundEmailV2_(record, false);
    if (upsert.matched) {
      result[upsert.action] = (result[upsert.action] || 0) + 1;
      logGmailIngestionCommit_(kind, upsert.action, upsert.row, record, meta, documentFolderUrl);
      recordShipmentNoticeV2_(kind, upsert, record, meta, documentFolderUrl);
      return;
    }
    var validation = validateRecord_(record, kind);
    if (!validation.ok) {
      addPendingRow_({ kind: kind, issues: validation.issues, record: record, meta: meta, driveUrl: record._driveFolder || documentFolderUrl });
      result.pending++;
      return;
    }
    var inserted = kind === "outbound" ? upsertOutboundEmailAcrossSheetsV2_(record, true, OUTBOUND_INSERT_SHEETS_V2, OUTBOUND_INSERT_DRY_RUN_V2) : upsertInboundEmailV2_(record, true);
    if (inserted.action === "inserted") {
      result.inserted++;
      logGmailIngestionCommit_(kind, "inserted", inserted.row, record, meta, documentFolderUrl);
      recordShipmentNoticeV2_(kind, inserted, record, meta, documentFolderUrl);
    }
    else if (inserted.matched) {
      result[inserted.action]++;
      logGmailIngestionCommit_(kind, inserted.action, inserted.row, record, meta, documentFolderUrl);
      recordShipmentNoticeV2_(kind, inserted, record, meta, documentFolderUrl);
    }
    else {
      addPendingRow_({ kind: kind, issues: ["Validated record could not be matched or safely inserted."], record: record, meta: meta, driveUrl: record._driveFolder || documentFolderUrl });
      result.pending++;
    }
  });
  return result;
}

/**
 * Logs a committed (matched/updated/inserted) email-ingestion event to the
 * existing PIPELINE LOG sheet, so the dashboard's Gmail Ingestion card can
 * show which shipment each email produced. Never throws — logPipeline_
 * already swallows its own errors, consistent with the rest of this file.
 */
function logGmailIngestionCommit_(kind, action, row, record, meta, driveUrl) {
  var shipmentId = record.shipmentNo || record.container || record.invoice || record.pro || record.mbl || record.hbl || "";
  logPipeline_("INGEST COMMIT", meta.subject, JSON.stringify({
    kind: kind,
    action: action,
    row: row,
    shipmentId: shipmentId,
    customer: record.customer || "",
    carrier: record.carrier || "",
    eta: record.eta || record.shipDate || "",
    sourceEmail: meta.permalink,
    driveUrl: driveUrl || record._driveFolder || "",
    sender: meta.from || ""
  }));
}

/**
 * Surfaces a silently-committed email (inserted, or updated with an actual
 * field change) as a "Received:"/"Changed:" row in PENDING VERIFICATION, so
 * the dashboard's Shipment Notices card has something to show for commits
 * that never needed a human review. Never called for "noop" — a re-processed
 * email that changed nothing must stay invisible, not spam the feed.
 *
 * The live schedule row has already been written by the time this runs — a
 * failure here (transient Sheets error, quota) must never look like the
 * ingestion itself failed, so this swallows its own errors the same way
 * logGmailIngestionCommit_/logPipeline_ do for the other auxiliary log.
 */
function recordShipmentNoticeV2_(kind, upsert, record, meta, driveUrl) {
  if (upsert.action === "noop") return;
  try {
    var note = upsert.action === "inserted"
      ? "Received: " + briefShipmentSummaryV2_(kind, record)
      : "Changed: " + ((upsert.changes && upsert.changes.length) ? upsert.changes.join(", ") : "fields updated");
    addCommittedAuditRow_({ kind: kind, record: record, meta: meta, driveUrl: driveUrl, note: note });
  } catch (e) {
    Logger.log("recordShipmentNoticeV2_ failed: " + e.message);
  }
}

function briefShipmentSummaryV2_(kind, record) {
  var parts = kind === "inbound"
    ? [record.shipmentNo, record.container, record.eta && ("ETA " + record.eta)]
    : [record.customer, record.invoice, record.shipDate && ("Ship " + record.shipDate)];
  return parts.filter(Boolean).join(" · ") || "Details in source email";
}

function extractEmailContextV2_(subject, body) {
  var text = String(subject || "") + "\n" + String(body || "");
  var context = { kind: "", shipmentNo: "", invoice: "", mbl: "", hbl: "", filing: "", container: "", vessel: "", etd: "", eta: "", shipDate: "", pro: "", status: "", carrier: "", note: "" };

  var sty = text.match(/\b(STY[- ]?\d{3,})\b/i);
  var isCarrierOutbound = Boolean(sty) || /CARGOMATIC|\bPRO\s*#|PICKUP|PICK UP|RATE RQ/i.test(text);
  var isInbound = /AIR SHIPMENT|OCEAN SHIPMENT|SILICON2 LIST|ARRIVAL NOTICE|MAWB|HAWB|\bETA\b|항공|해상|해운|선적서류|입고/i.test(text);
  context.kind = isCarrierOutbound && !/MAWB|HAWB|ARRIVAL NOTICE/i.test(text) ? "outbound" : (isInbound ? "inbound" : "");

  var shipment = text.match(/\b((?:ES|HJ|ER|OSL|MCI)\s*[- ]?\d{1,3})(?:\s*[- ]?2026)?\b/i);
  if (shipment) context.shipmentNo = shipment[1].replace(/\s+/g, "").replace(/-$/, "").toUpperCase().replace(/^([A-Z]+)(\d+)$/, "$1$2 - 2026");
  var step = text.match(/\b(ES|HJ|ER|OSL|MCI)\s*(\d{1,3})\s*차\b/i);
  if (!context.shipmentNo && step) context.shipmentNo = step[1].toUpperCase() + step[2] + " - 2026";
  var jsl = text.match(/\b(JSL\d{6,})\b/i);
  if (!context.shipmentNo && jsl) context.shipmentNo = jsl[1].toUpperCase();

  var mawb = text.match(/\bMAWB\s*#?\s*[:#]?\s*([0-9]{3}-?[0-9]{8})\b/i);
  var mbl = text.match(/\bMBL\s*#?\s*[:#]?\s*([A-Z0-9-]{7,})\b/i);
  if (mawb) context.mbl = mawb[1].toUpperCase();
  else if (mbl) context.mbl = mbl[1].toUpperCase();
  var hawb = text.match(/\b(?:HAWB|HBL)\s*#?\s*[:#]?\s*([A-Z0-9-]{5,})\b/i);
  if (hawb) context.hbl = hawb[1].toUpperCase();

  var containers = text.match(/\b[A-Z]{4}\d{7}\b/g);
  if (containers && containers.length === 1) context.container = containers[0].toUpperCase();
  var invoices = text.match(/\bIN\d{8}\b/gi);
  if (invoices && invoices.length) context.invoice = uniqueTextV2_(invoices.map(function (v) { return v.toUpperCase(); })).join("\n");
  var filing = text.match(/\bN8N-\d{6,}-\d+\b/i);
  if (filing) context.filing = filing[0].toUpperCase();
  if (sty) context.pro = sty[1].replace(/\s/g, "").toUpperCase();
  var pro = text.match(/\bPRO\s*#?\s*[:#]?\s*([A-Z0-9-]{6,})\b/i);
  if (!context.pro && pro) context.pro = pro[1].toUpperCase();

  context.eta = dateAfterLabelV2_(text, "ETA") || dateAfterLabelV2_(text, "ESTIMATED ARRIVAL");
  context.etd = dateAfterLabelV2_(text, "ETD");
  context.shipDate = dateAfterLabelV2_(text, "SHIP DATE") || dateAfterLabelV2_(text, "PICKUP DATE");

  var vessel = text.match(/\b(?:VSL|VESSEL(?:\s*\/\s*VOY)?)\b\s*[:#-]?\s*([^\r\n]{3,60})/i);
  if (vessel) {
    var vesselCandidate = cleanVesselV2_(vessel[1]);
    if (isPlausibleVesselV2_(vesselCandidate)) context.vessel = vesselCandidate;
  }

  context.status = explicitEmailStatusV2_(subject, body);

  if (/UPS/i.test(text)) context.carrier = "UPS";
  else if (/FEDEX/i.test(text)) context.carrier = "FedEx";
  else if (/CARGOMATIC/i.test(text)) context.carrier = "CARGOMATIC";
  context.note = String(subject || "").trim();
  return context;
}

function dateAfterLabelV2_(text, label) {
  var escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var re = new RegExp(escaped + "\\s*[:#=-]?\\s*(\\d{1,2}[\\/. -]\\d{1,2}(?:[\\/. -]\\d{2,4})?)", "i");
  var match = String(text || "").match(re);
  if (!match) return "";
  return normalizeEmailDateV2_(match[1]);
}

function normalizeEmailDateV2_(value) {
  var s = String(value || "").trim().replace(/[. -]+/g, "/");
  var m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return s;
  var year = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : String(new Date().getFullYear());
  return String(Number(m[1])).padStart(2, "0") + "/" + String(Number(m[2])).padStart(2, "0") + "/" + year.slice(-2);
}

function cleanVesselV2_(value) {
  return String(value || "").replace(/\s{2,}/g, " ").replace(/[|,;].*$/, "").trim().slice(0, 60);
}

function isPlausibleVesselV2_(value) {
  var s = cleanVesselV2_(value);
  if (!s || s.length < 3) return false;
  if (/^(?:DELAY|DELAYS|DELAYED|STATUS|PENDING|RECEIVED|DELIVERED|COMPLETED|CUSTOMS|FDA|NOTES?|REMARKS?)$/i.test(s)) return false;
  if (/^[A-Z]{1,3}-?\d{2,4}$/i.test(s)) return true;
  if (/\b\d{3,4}[EW]\b/i.test(s) && /[A-Z]{2}/i.test(s)) return true;
  return s.length >= 6 && /\s/.test(s) && !/\b(?:ETA|ETD|DELAY|STATUS|CUSTOMS|FDA|DELIVERY|RECEIVED|COMPLETED)\b/i.test(s);
}

function explicitEmailStatusV2_(subject, body) {
  var subj = String(subject || "").trim();
  var lines = String(body || "").split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  var operational = lines.filter(function (line) {
    return /(?:STATUS|SHIPMENT|PACKAGE|DELIVER|TRANSIT|PICKED UP|PICKUP|FDA|FWS|CUSTOMS|HOLD|DETAIN|RELEASE|RESCHEDULE|DELAY|입고|배송|통관|보류|도착)/i.test(line);
  }).slice(0, 80);
  var signal = [subj].concat(operational).join("\n");

  if (/\bSHIPMENT\b[^\n]{0,60}\bHAS BEEN COMPLETED\b|\bSTATUS\s*[:=-]?\s*COMPLETED\b|배송\s*완료/i.test(signal)) return "Completed";
  if (/\b(?:PACKAGE|PACKAGES|SHIPMENT|DELIVERY)\b[^\n]{0,70}\b(?:HAS BEEN\s+)?DELIVERED\b|\bSTATUS\s*[:=-]?\s*DELIVERED\b|배송(?:이|은|는)?\s*완료/i.test(signal)) return "Delivered";
  if (/\b(?:STATUS|CURRENT STATUS|WAREHOUSE STATUS)\s*[:=-]?\s*RECEIVED\b|\bSHIPMENT\b[^\n]{0,50}\b(?:HAS BEEN\s+)?RECEIVED\b|입고\s*완료|창고\s*입고/i.test(signal)) return "Received";
  if (/FDA[^\n]{0,40}\b(?:HOLD|DETAINED?|REVIEW)\b|FDA[^\n]{0,30}보류/i.test(signal)) return "FDA Review / Hold";
  if (/FWS[^\n]{0,40}\b(?:HOLD|REVIEW|EXAM)\b|USFWS[^\n]{0,40}\b(?:HOLD|REVIEW|EXAM)\b/i.test(signal)) return "FWS Review / Hold";
  if (/CUSTOMS[^\n]{0,40}\b(?:HOLD|CLEARANCE PENDING|UNDER REVIEW)\b|통관[^\n]{0,30}(?:보류|검사|대기)/i.test(signal)) return "Customs Clearance";
  if (/\b(?:STATUS\s*[:=-]?\s*)?(?:IN TRANSIT|SHIPPED)\b|\bSHIPMENT\b[^\n]{0,40}\b(?:PICKED UP|SHIPPED)\b/i.test(signal)) return "Shipping";
  if (/\b(?:DELIVERY|ETA|SHIPMENT)\b[^\n]{0,60}\b(?:RESCHEDULED|DELAYED)\b|\bRESCHEDULED DELIVERY\b/i.test(signal)) return "Delayed";
  return "";
}

function hasStrongLogisticsContextV2_(record) {
  return Boolean(record.container || record.mbl || record.hbl || record.filing || record.invoice || record.pro || record.shipmentNo) &&
    Boolean(record.eta || record.etd || record.shipDate || record.status || record.kind);
}

function guessKindFromRecordV2_(record) {
  if (record.kind) return record.kind;
  if (record.container || record.mbl || record.hbl || record.eta) return "inbound";
  return "outbound";
}

function mergeRecordContextV2_(record, context, meta) {
  var out = {};
  Object.keys(record || {}).forEach(function (key) { out[key] = record[key]; });
  ["kind", "shipmentNo", "invoice", "mbl", "hbl", "filing", "container", "vessel", "etd", "eta", "shipDate", "pro", "status", "carrier", "customer"].forEach(function (key) {
    if (!out[key] && context[key]) out[key] = context[key];
  });
  if (!out.note) out.note = context.note || "";
  out._sourceEmail = meta.permalink;
  out._emailSubject = meta.subject;
  return out;
}

function extractAttachmentRecordsV2_(attachment, name, context, meta) {
  var lower = String(name || "").toLowerCase();
  var blob = attachment.copyBlob();
  blob.setName(name);
  if (/\.zip$/i.test(lower) || /zip/i.test(blob.getContentType())) {
    var records = [];
    var blobs;
    try { blobs = Utilities.unzip(blob); }
    catch (zipErr) { return { supported: true, records: [{ parseError: "ZIP could not be opened: " + zipErr.message }] }; }
    blobs.forEach(function (inner) {
      var parsed = extractBlobRecordsV2_(inner, inner.getName(), context, meta);
      parsed.records.forEach(function (r) { records.push(r); });
    });
    return { supported: true, records: records };
  }
  return extractBlobRecordsV2_(blob, name, context, meta);
}

function extractBlobRecordsV2_(blob, name, context, meta) {
  var lower = String(name || "").toLowerCase();
  try {
    if (/\.(csv|tsv)$/i.test(lower)) {
      var delimiter = /\.tsv$/i.test(lower) ? "\t" : ",";
      var rows = Utilities.parseCsv(blob.getDataAsString(), delimiter);
      return { supported: true, records: tableToShipmentRecordsV2_(rows, context, name) };
    }
    if (/\.(xlsx|xlsm|xls)$/i.test(lower) || /spreadsheet|excel/i.test(blob.getContentType())) {
      var tables = xlsxTablesV2_(blob);
      var xRecords = [];
      tables.forEach(function (table) {
        tableToShipmentRecordsV2_(table.rows, context, name + " / " + table.name).forEach(function (r) { xRecords.push(r); });
      });
      return { supported: true, records: xRecords };
    }
    if (/\.pdf$/i.test(lower) || /pdf/i.test(blob.getContentType())) {
      var text = pdfTextV2_(blob);
      var record = pdfTextRecordV2_(text, context, name);
      return { supported: true, records: hasStrongLogisticsContextV2_(record) ? [record] : [] };
    }
    return { supported: false, records: [] };
  } catch (err) {
    return { supported: true, records: [{ parseError: "Attachment parse failed: " + err.message, note: name }] };
  }
}

function tableToShipmentRecordsV2_(rows, context, sourceName) {
  if (!rows || !rows.length) return [];
  var headerRow = findLogisticsHeaderRowV2_(rows);
  if (headerRow < 0) return [];
  var headers = rows[headerRow].map(normalizeHeaderV2_);
  var map = {};
  headers.forEach(function (h, i) { if (h && map[h] === undefined) map[h] = i; });
  function idx(names) {
    for (var i = 0; i < names.length; i++) if (map[names[i]] !== undefined) return map[names[i]];
    return -1;
  }
  var cContainer = idx(["CONTAINER", "CONTAINER#", "CNTR", "CNTR#", "CNTRNO", "CONTAINERNO"]);
  var cInvoice = idx(["INVOICE", "INVOICE#", "INVOICENO", "PI", "PINO", "ENTRYNO", "ENTRYNUMBER"]);
  var cMbl = idx(["MBL", "MAWB", "MASTERBL", "MASTERB/L"]);
  var cHbl = idx(["HBL", "HAWB", "HOUSEBL", "HOUSEB/L"]);
  var cEta = idx(["ETA", "ESTIMATEDARRIVAL", "ARRIVALDATE"]);
  var cEtd = idx(["ETD", "DEPARTUREDATE"]);
  var cVessel = idx(["VSL", "VESSEL", "VESSEL/VOY", "VESSELVOY"]);
  var cQty = idx(["QTY", "QUANTITY", "TOTALQTY", "PCS", "UNITS"]);
  var cSku = idx(["SKU", "SKU#", "ITEM", "ITEMCODE"]);
  var cStatus = idx(["STATUS", "DELIVERY", "CUSTOMSSTATUS", "WEBSITESTATUS"]);
  var cNote = idx(["NOTE", "NOTES", "NOTES/REMARKS", "REMARKS"]);
  var cShipment = idx(["SHIPMENT", "SHIPMENT#", "차수"]);
  var records = [];

  rows.slice(headerRow + 1).forEach(function (row) {
    var record = { kind: context.kind || "inbound" };
    function val(index) { return index >= 0 ? String(row[index] == null ? "" : row[index]).trim() : ""; }
    record.container = normalizeContainerV2_(val(cContainer));
    record.invoice = val(cInvoice);
    record.mbl = val(cMbl);
    record.hbl = val(cHbl);
    record.eta = normalizeEmailDateV2_(val(cEta));
    record.etd = normalizeEmailDateV2_(val(cEtd));
    record.vessel = val(cVessel);
    record.qty = val(cQty);
    record.sku = val(cSku);
    record.status = normalizeEmailStatusV2_(val(cStatus));
    record.note = val(cNote) || sourceName;
    record.shipmentNo = val(cShipment);
    if (record.container || record.invoice || record.mbl || record.hbl || record.shipmentNo || record.sku) records.push(record);
  });
  return records;
}

function findLogisticsHeaderRowV2_(rows) {
  var best = -1, bestScore = 0;
  for (var r = 0; r < Math.min(rows.length, 40); r++) {
    var joined = rows[r].map(normalizeHeaderV2_);
    var score = 0;
    ["CONTAINER", "CONTAINER#", "CNTR#", "INVOICE", "INVOICE#", "MBL", "MAWB", "HBL", "HAWB", "ETA", "ETD", "VSL", "VESSEL", "SKU", "QTY"].forEach(function (name) {
      if (joined.indexOf(name) !== -1) score++;
    });
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return bestScore >= 2 ? best : -1;
}

function normalizeHeaderV2_(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "").replace(/NO\.?$/, "NO");
}

function normalizeContainerV2_(value) {
  var m = String(value || "").toUpperCase().replace(/\s/g, "").match(/[A-Z]{4}\d{7}/);
  return m ? m[0] : "";
}

function normalizeEmailStatusV2_(value) {
  var s = String(value || "").trim();
  if (!s) return "";
  if (/complete/i.test(s)) return "Completed";
  if (/deliver/i.test(s)) return "Delivered";
  if (/receive/i.test(s)) return "Received";
  if (/FDA.*(hold|detain|review)/i.test(s)) return "FDA Review / Hold";
  if (/FWS.*(hold|review|exam)|USFWS.*(hold|review|exam)/i.test(s)) return "FWS Review / Hold";
  if (/custom/i.test(s)) return "Customs Clearance";
  if (/delay|resched/i.test(s)) return "Delayed";
  if (/ship|transit/i.test(s)) return "Shipping";
  return "";
}

function collapseShipmentRecordsV2_(records) {
  var groups = {};
  records.forEach(function (record) {
    if (record.parseError) {
      groups["ERROR_" + Object.keys(groups).length] = record;
      return;
    }
    var key = normalizedEmailKeyV2_(record.container || record.mbl || record.hbl || record.filing || record.shipmentNo || firstTokenV2_(record.invoice) || record.pro || record.sku);
    if (!key) key = "ROW_" + Object.keys(groups).length;
    if (!groups[key]) groups[key] = record;
    else groups[key] = mergeShipmentRecordV2_(groups[key], record);
  });
  return Object.keys(groups).map(function (key) { return groups[key]; });
}

function mergeShipmentRecordV2_(a, b) {
  var out = {};
  Object.keys(a).forEach(function (key) { out[key] = a[key]; });
  ["kind", "shipmentNo", "mbl", "hbl", "filing", "container", "vessel", "etd", "eta", "shipDate", "pro", "status", "carrier", "customer"].forEach(function (key) {
    if (!out[key] && b[key]) out[key] = b[key];
  });
  out.invoice = mergeMultilineV2_(out.invoice, b.invoice);
  if (a.qty || b.qty) out.qty = sumQtyV2_(a.qty, b.qty);
  if (!out.note && b.note) out.note = b.note;
  out._sourceEmail = out._sourceEmail || b._sourceEmail;
  out._driveFile = out._driveFile || b._driveFile;
  return out;
}

function sumQtyV2_(a, b) {
  var na = Number(String(a || "0").replace(/,/g, ""));
  var nb = Number(String(b || "0").replace(/,/g, ""));
  if (isNaN(na) && isNaN(nb)) return a || b || "";
  return String((isNaN(na) ? 0 : na) + (isNaN(nb) ? 0 : nb));
}

function uniqueTextV2_(values) {
  var seen = {};
  return values.filter(function (value) { var k = String(value || "").trim(); if (!k || seen[k]) return false; seen[k] = true; return true; });
}
function mergeMultilineV2_(a, b) { return uniqueTextV2_((String(a || "") + "\n" + String(b || "")).split(/[\n,;]+/).map(function (v) { return v.trim(); })).join("\n"); }
function firstTokenV2_(value) { return String(value || "").split(/[\n,;]+/)[0].trim(); }
function normalizedEmailKeyV2_(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function xlsxTablesV2_(blob) {
  var id = convertBlobWithDriveRestV2_(blob, "application/vnd.google-apps.spreadsheet");
  try {
    var ss = SpreadsheetApp.openById(id);
    return ss.getSheets().map(function (sheet) { return { name: sheet.getName(), rows: sheet.getDataRange().getDisplayValues() }; });
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  }
}

function pdfTextV2_(blob) {
  var id = convertBlobWithDriveRestV2_(blob, "application/vnd.google-apps.document");
  try {
    var url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "/export?mimeType=text%2Fplain";
    var response = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (response.getResponseCode() >= 300) throw new Error("PDF text export failed HTTP " + response.getResponseCode());
    return response.getContentText();
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  }
}

function convertBlobWithDriveRestV2_(blob, targetMime) {
  var boundary = "sklogistics_" + Date.now() + "_" + Math.floor(Math.random() * 1000000);
  var metadata = JSON.stringify({ name: "TMP-email-import-" + Date.now(), mimeType: targetMime });
  var prefix = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata +
    "\r\n--" + boundary + "\r\nContent-Type: " + (blob.getContentType() || "application/octet-stream") + "\r\n\r\n";
  var suffix = "\r\n--" + boundary + "--\r\n";
  var bytes = Utilities.newBlob(prefix).getBytes().concat(blob.getBytes()).concat(Utilities.newBlob(suffix).getBytes());
  var response = UrlFetchApp.fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "post",
    contentType: "multipart/related; boundary=" + boundary,
    payload: bytes,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 300) throw new Error("Drive conversion failed HTTP " + response.getResponseCode() + ": " + response.getContentText().slice(0, 250));
  var parsed = JSON.parse(response.getContentText());
  if (!parsed.id) throw new Error("Drive conversion returned no file id.");
  return parsed.id;
}

function pdfTextRecordV2_(text, context, sourceName) {
  var record = extractEmailContextV2_(sourceName, text);
  record.kind = context.kind || record.kind || "inbound";
  var containers = String(text || "").toUpperCase().match(/\b[A-Z]{4}\d{7}\b/g);
  if (!record.container && containers && containers.length === 1) record.container = containers[0];
  if (!record.invoice) {
    var inv = String(text || "").match(/\bIN\d{8}\b/i);
    if (inv) record.invoice = inv[0].toUpperCase();
  }
  record.note = "Auto-extracted from " + sourceName;
  return record;
}

/**
 * Archives attachments under Root -> Inbound|Outbound -> <bucket> ->
 * <shipment-id>, replacing the old flat "one folder per shipment under a
 * single root" scheme. Existing flat folders are never migrated — every
 * sheet link references a folder by Drive file ID, not path, so an old
 * folder left in place (or physically relocated later) stays resolvable;
 * only newly-created folders use the nested path going forward.
 *
 * Inbound (IMPORTS) keeps its existing ID-based folder-reuse lookup
 * (findExistingInboundDocsFolderV2_, unchanged) since that sheet already
 * stores a rich-text Drive link per row. Outbound has no such link column
 * today (IHERB/TJX-ROSS's real headers have no NOTE column at all to hold
 * one) — its reuse instead comes for free from childFolderV2_'s existing
 * get-or-create-by-name semantics: the same shipment identifier producing
 * the same leaf folder name across repeated runs.
 */
function archiveEmailAttachmentsV2_(attachments, records, direction, customerName, context, meta) {
  try {
    var existing = direction === "inbound" ? findExistingInboundDocsFolderV2_(records) : null;
    var folder = existing || getOrCreateShipmentDocsFolderV2_(direction, customerName, records, context, meta);
    attachments.forEach(function (attachment) { createAttachmentIfMissingV2_(folder, attachment); });
    return folder.getUrl();
  } catch (err) {
    writeLog_("GMAIL V2 ARCHIVE", meta.messageId, String(err));
    return "";
  }
}

function findExistingInboundDocsFolderV2_(records) {
  if (!records || !records.length) return null;
  var sheet = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId).getSheetByName("IMPORTS");
  if (!sheet) return null;
  var values = sheet.getDataRange().getDisplayValues();
  var hits = [];
  for (var r = 2; r < values.length; r++) {
    var best = 0;
    records.forEach(function (record) { best = Math.max(best, inboundMatchScoreV2_(values[r], record)); });
    if (best) hits.push({ row: r + 1, score: best });
  }
  hits.sort(function (a, b) { return b.score - a.score; });
  if (!hits.length || (hits[1] && hits[0].score === hits[1].score)) return null;
  var rich = sheet.getRange(hits[0].row, 2).getRichTextValue();
  var id = folderIdFromDriveUrlV2_(rich && rich.getLinkUrl ? rich.getLinkUrl() : "");
  if (!id) return null;
  try { return DriveApp.getFolderById(id); } catch (err) { return null; }
}

/**
 * Root -> Inbound|Outbound -> <bucket> -> <shipment-id>, three chained
 * get-or-create calls against the one existing primitive (childFolderV2_).
 * Bucket is the resolved customer name / DC identity for outbound
 * (WH Trucking Request/ULTA/TJX-ROSS), the literal "IHERB" for IHERB
 * (single implicit customer, not the UNSORTED fallback), and "UNSORTED"
 * for inbound IMPORTS records, which have no customer field in their real
 * schema at all (a consolidated ocean/air container commonly carries SKUs
 * for multiple different customers).
 */
function getOrCreateShipmentDocsFolderV2_(direction, customerName, records, context, meta) {
  var root = DriveApp.getFolderById(GMAIL_PIPELINE.importShipmentsFolderId);
  var directionFolder = childFolderV2_(root, direction === "outbound" ? "Outbound" : "Inbound");
  var bucketName = sanitizeDriveFolderNameV2_(customerName) || "UNSORTED";
  var bucketFolder = childFolderV2_(directionFolder, bucketName);
  return childFolderV2_(bucketFolder, shipmentDocsLeafNameV2_(records, context, meta));
}

// invoice/PO before pro/BOL: an invoice or PO number is typically assigned
// at order time, while a carrier PRO/BOL is often assigned later at
// pickup — checking invoice first keeps a shipment's later emails
// resolving to the SAME folder name once a PRO/BOL is additionally known,
// instead of switching folders the moment it appears (Codex review on PR
// #103). This doesn't fully solve identifier-evolution folder splitting
// in every order (e.g. a first email with only a PRO, a later one with
// only an invoice, would still split) — a complete fix needs a real
// existing-folder lookup across all 4 outbound sheets, out of scope here.
function shipmentDocsLeafNameV2_(records, context, meta) {
  var names = uniqueTextV2_((records || []).map(function (record) {
    return record.shipmentNo || record.hbl || record.container || record.mbl || record.invoice || record.pro || "";
  }).filter(Boolean));
  var base = names.length === 1
    ? names[0]
    : (context.shipmentNo || context.hbl || context.container || context.mbl || context.invoice || context.pro || meta.subject);
  return sanitizeDriveFolderNameV2_(base || "EMAIL IMPORT " + Utilities.formatDate(meta.date, "America/Los_Angeles", "yyyyMMdd"));
}

function sanitizeDriveFolderNameV2_(value) {
  return String(value || "").replace(/[\\/:*?\"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function createAttachmentIfMissingV2_(folder, attachment) {
  var name = String(attachment.getName() || "attachment").replace(/[\\/:*?\"<>|]+/g, "_");
  var size = Number(attachment.getSize ? attachment.getSize() : attachment.getBytes().length);
  var existing = folder.getFilesByName(name);
  while (existing.hasNext()) {
    if (Number(existing.next().getSize()) === size) return;
  }
  var blob = attachment.copyBlob();
  blob.setName(name);
  folder.createFile(blob);
}

function folderIdFromDriveUrlV2_(url) {
  var match = String(url || "").match(/\/folders\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : "";
}

function childFolderV2_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function upsertInboundEmailV2_(record, allowInsert) {
  var ss = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId);
  var sheet = ss.getSheetByName("IMPORTS");
  if (!sheet) throw new Error("IMPORTS sheet not found.");
  var data = sheet.getDataRange().getDisplayValues();
  var schedulingIndex = data.findIndex(function (row) { return String(row[0] || "").trim().toUpperCase() === "SCHEDULING"; });
  var end = schedulingIndex === -1 ? data.length : schedulingIndex;
  var candidates = [];
  for (var r = 2; r < end; r++) {
    var score = inboundMatchScoreV2_(data[r], record);
    if (score) candidates.push({ row: r + 1, score: score });
  }
  candidates.sort(function (a, b) { return b.score - a.score; });
  if (candidates.length && (!candidates[1] || candidates[0].score > candidates[1].score)) {
    var updateResult = updateInboundRowV2_(sheet, candidates[0].row, data[candidates[0].row - 1], record);
    return { matched: true, action: updateResult.changed ? "updated" : "noop", row: candidates[0].row, changes: updateResult.changes };
  }
  if (!allowInsert) return { matched: false, action: "noop" };
  if (!record.eta || !(record.shipmentNo || record.container || record.mbl || record.hbl)) return { matched: false, action: "noop" };
  var markerRow = schedulingIndex === -1 ? sheet.getLastRow() + 1 : schedulingIndex + 1;
  sheet.insertRowBefore(markerRow);
  var targetRow = markerRow;
  if (targetRow > 3) sheet.getRange(targetRow - 1, 1, 1, 28).copyTo(sheet.getRange(targetRow, 1, 1, 28), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  var values = new Array(28).fill("");
  values[0] = record.shipmentNo || "EMAIL IMPORT";
  values[1] = record.shipmentNo || record.hbl || "DOCS";
  values[2] = record.invoice || "";
  values[3] = record.mbl || "";
  values[4] = record.hbl || "";
  values[7] = record.container || "";
  values[10] = record.filing || "";
  values[11] = emailNoteV2_(record);
  values[12] = isPlausibleVesselV2_(record.vessel) ? record.vessel : "";
  values[13] = record.etd || "";
  values[14] = record.eta || "";
  var insertStatus = record.status ? canonicalLogisticsStatus_(record.status) : "Work in Progress";
  if (record.status && !insertStatus) throw new Error("Unsupported logistics status: " + record.status);
  values[27] = insertStatus || "Work in Progress";
  sheet.getRange(targetRow, 1, 1, 28).setValues([values]);
  setInboundDocsLinkV2_(sheet, targetRow, values[1], record._driveFolder);
  return { matched: true, action: "inserted", row: targetRow };
}

function inboundMatchScoreV2_(row, record) {
  var score = 0;
  if (sameEmailIdV2_(row[7], record.container)) score += 120;
  if (sameEmailIdV2_(row[3], record.mbl)) score += 100;
  if (sameEmailIdV2_(row[4], record.hbl)) score += 100;
  if (sameEmailIdV2_(row[10], record.filing)) score += 90;
  if (sameEmailIdV2_(row[0], record.shipmentNo) || sameEmailIdV2_(row[1], record.shipmentNo)) score += 85;
  if (multilineHasV2_(row[2], record.invoice)) score += 65;
  return score;
}

function updateInboundRowV2_(sheet, rowNumber, oldRow, record) {
  var changed = false;
  var changes = [];
  function set(col, value, overwrite, label) {
    if (!value) return;
    var old = String(oldRow[col - 1] || "").trim();
    if (old === String(value).trim()) return;
    if (old && !overwrite) return;
    sheet.getRange(rowNumber, col).setValue(value);
    if (label) changes.push(label + " " + (old || "—") + " → " + String(value).trim());
    oldRow[col - 1] = value;
    changed = true;
  }
  set(1, record.shipmentNo, false, "Shipment #");
  if (record._driveFolder && setInboundDocsLinkV2_(sheet, rowNumber, record.shipmentNo || record.hbl || oldRow[1] || "DOCS", record._driveFolder)) changed = true;
  if (record.invoice) {
    var mergedInvoices = mergeMultilineV2_(oldRow[2], record.invoice);
    if (mergedInvoices !== String(oldRow[2] || "").trim()) set(3, mergedInvoices, true, "Invoice");
  }
  set(4, record.mbl, false, "MBL");
  set(5, record.hbl, false, "HBL");
  set(8, record.container, false, "Container");
  set(11, record.filing, false, "Filing #");
  if (isPlausibleVesselV2_(record.vessel)) set(13, record.vessel, true, "Vessel");
  set(14, record.etd, true, "ETD");
  set(15, record.eta, true, "ETA");
  if (record.note || record._emailSubject) {
    var note = emailNoteV2_(record);
    var existing = String(oldRow[11] || "");
    if (note && existing.indexOf(note) === -1) set(12, existing ? existing + "\n" + note : note, true, "Note");
  }
  if (record.status) {
    var normalizedStatus = canonicalLogisticsStatus_(record.status);
    if (!normalizedStatus) throw new Error("Unsupported logistics status: " + record.status);
    var current = String(oldRow[27] || "").trim();
    if (canAutoTransitionLogisticsStatus_(current, normalizedStatus)) set(28, normalizedStatus, true, "Status");
  }
  if (changed) formatEmailStatusRowV2_(sheet, rowNumber, String(oldRow[27] || record.status || ""));
  return { changed: changed, changes: changes };
}

function setInboundDocsLinkV2_(sheet, rowNumber, label, folderUrl) {
  if (!folderUrl) return false;
  var cell = sheet.getRange(rowNumber, 2);
  var prior = cell.getRichTextValue();
  var priorUrl = prior && prior.getLinkUrl ? prior.getLinkUrl() : "";
  if (priorUrl && priorUrl !== folderUrl) return false;
  var text = String(label || cell.getDisplayValue() || "DOCS").trim();
  if (priorUrl === folderUrl && cell.getDisplayValue() === text) return false;
  var rich = SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(folderUrl).build();
  cell.setRichTextValue(rich);
  return true;
}

/**
 * Thin wrapper preserving this function's exact existing reach (WH Trucking
 * Request only) for its existing callers (GmailXpoV2.gs's fallback match,
 * Validation.gs's manual-approval path prior to this PR — now updated to
 * call the multi-sheet version directly). The real matching/insert logic
 * lives in OutboundSheetInsertV2.gs's upsertOutboundEmailAcrossSheetsV2_,
 * rewritten to look columns up by header name rather than the hardcoded
 * indices this function used to hardcode directly — verified byte-
 * equivalent against WH Trucking Request's live header (CUSTOMER=A,
 * INVOICE NO.=B, SHIP DATE=D, CARRIER=Q, PRO#=S, NOTE=T, STATUS=U).
 */
function upsertOutboundEmailV2_(record, allowInsert) {
  // dryRun: false — always live, exactly preserving this shim's pre-
  // existing behavior for its callers (GmailXpoV2.gs's fallback), which
  // has no dry-run concept of its own and already writes live everywhere
  // else in that file. OUTBOUND_INSERT_DRY_RUN_V2 only ever gates the
  // automatic-ingestion path in processLogisticsMessageV2_.
  return upsertOutboundEmailAcrossSheetsV2_(record, allowInsert, ["WH Trucking Request"], false);
}

function sameEmailIdV2_(a, b) {
  var aa = normalizedEmailKeyV2_(a), bb = normalizedEmailKeyV2_(b);
  return Boolean(aa && bb && aa === bb);
}
function multilineHasV2_(cellValue, wanted) {
  var wantedKeys = String(wanted || "").split(/[\n,;]+/).map(normalizedEmailKeyV2_).filter(Boolean);
  if (!wantedKeys.length) return false;
  var cellKeys = String(cellValue || "").split(/[\n,;]+/).map(normalizedEmailKeyV2_).filter(Boolean);
  return wantedKeys.some(function (key) { return cellKeys.indexOf(key) !== -1; });
}
function emailNoteV2_(record) {
  return "";
}
function formatEmailStatusRowV2_(sheet, rowNumber, status) {
  var done = isTerminalLogisticsStatus_(status);
  var range = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn());
  if (done) range.setBackground("#E8EAED").setFontColor("#5F6368");
  else range.setBackground(null).setFontColor(null);
}
