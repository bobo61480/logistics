/**
 * GmailCustomerResolverV2.gs — sender/text customer resolution for WH
 * Trucking Request Gmail ingestion.
 *
 * record.customer is read/gated in several places in GmailPipelineV2.gs but
 * nothing has ever assigned it — every real "INGEST COMMIT" log entry has
 * customer:"" (confirmed against live PIPELINE LOG history). This file adds
 * the missing resolver, following the same "never guess, escalate ambiguity"
 * discipline as CustomerLookup.gs (which this file reuses directly, sharing
 * Apps Script's single global namespace) after the 2026-08-12 KORHEIM
 * wrong-merge incident:
 *
 *  - Tier A (sender): matches the sending address/domain against an
 *    optional "EMAIL SENDERS" column added to the TRUCKING customer master.
 *    Missing column => this tier silently no-ops (degrades to Tier B only).
 *  - Tier B (text): matches a customer's canonicalized name, word-boundary
 *    anchored (the same fix that closed the KORHEIM incident), against the
 *    email subject/body. An ambiguous multi-location family (2+ TRUCKING
 *    rows sharing a canonical key) is treated as no-match, never guessed.
 *  - The two tiers disagreeing on different customers is also treated as
 *    no-match, logged for a human, never guessed.
 *
 * Not yet wired into GmailPipelineV2.gs's live processing — this file is
 * reviewed/tested standalone first. Wiring, the insert-row path, and its own
 * dry-run gate land together in a follow-up PR, since that is the point
 * where a resolved customer would first be able to affect a live sheet
 * (upsertOutboundEmailV2_'s existing insert branch already requires
 * record.customer, so it must not go live until that gate exists).
 */

var GMAIL_CUSTOMER_RESOLVER_ENABLED_V2 = true;
var CUSTOMER_EMAIL_SENDERS_HEADER_V2 = "EMAIL SENDERS";

/**
 * Resolves a customer for one email, or null if no confident, unambiguous
 * match exists. Never throws — a resolver failure must not block ingestion,
 * the same fail-open-to-PENDING-VERIFICATION pattern used everywhere else in
 * this pipeline.
 */
function resolveCustomerFromEmailV2_(meta, context, record) {
  if (!GMAIL_CUSTOMER_RESOLVER_ENABLED_V2) return null;
  try {
    var dbSheet = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId).getSheetByName(CUSTOMER_DB_SHEET_NAME);
    if (!dbSheet) return null;
    var dbValues = dbSheet.getDataRange().getDisplayValues();
    var dbHeader = findCustomerDbHeader_(dbValues);
    var records = buildCustomerRecords_(dbValues, dbHeader);

    var senderHit = matchCustomerBySenderV2_(meta.from, dbValues, dbHeader);
    var haystack = gmailCustomerResolutionTextV2_(meta, context, record);
    var textHit = matchCustomerByTextV2_(haystack, records);

    if (senderHit && textHit && senderHit.record.rowNumber !== textHit.record.rowNumber) {
      logCustomerResolutionAmbiguousV2_(meta, senderHit, textHit);
      return null;
    }
    if (!senderHit && textHit) logCustomerSenderSuggestionV2_(meta, textHit);

    var hit = senderHit || textHit;
    return hit ? { customer: hit.record.name, method: hit.method, confidence: hit.confidence } : null;
  } catch (err) {
    writeLog_("GMAIL V2 CUSTOMER RESOLVE ERROR", meta && meta.messageId, String(err));
    return null;
  }
}

/**
 * Tier A: exact address or domain-suffix match against every non-blank
 * "EMAIL SENDERS" cell on the TRUCKING tab. Requires exactly one customer to
 * match — 0 or 2+ senders sharing the same domain both resolve to null.
 */
function matchCustomerBySenderV2_(fromHeader, dbValues, dbHeader) {
  var sendersCol = dbHeader.map[CUSTOMER_EMAIL_SENDERS_HEADER_V2];
  if (sendersCol === undefined) return null;
  var address = emailAddressFromFromHeaderV2_(fromHeader);
  if (!address) return null;
  var domain = emailDomainFromAddressV2_(address);

  var matches = [];
  for (var r = dbHeader.rowIndex + 1; r < dbValues.length; r++) {
    var row = dbValues[r];
    var name = String(row[dbHeader.map["CUSTOMER NAME"]] || "").trim();
    if (!name) continue;
    var senders = String(row[sendersCol] || "")
      .split(/[\n,;]+/)
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);
    var isMatch = senders.some(function (sender) {
      if (sender.indexOf("@") !== -1) return sender === address;
      return Boolean(domain) && (domain === sender || domain.slice(-(sender.length + 1)) === "." + sender);
    });
    if (isMatch) matches.push({ rowNumber: r + 1, name: name });
  }
  if (matches.length !== 1) return null;
  return { record: matches[0], method: "sender", confidence: "high" };
}

/**
 * Tier B: word-boundary-anchored match of each distinct canonical customer
 * key (grouped the same way CustomerLookup.gs's isAmbiguousLocationFamily_
 * groups multi-location families) against the email text. Requires exactly
 * one canonical key to appear, and that key must map to exactly one
 * TRUCKING row — a multi-location family (e.g. two "ULTA (...)"-style
 * per-location rows sharing a brand) is never guessed between.
 */
function matchCustomerByTextV2_(haystack, records) {
  if (!haystack) return null;
  var text = String(haystack).toUpperCase();
  var byCanonicalKey = {};
  records.forEach(function (record) {
    var strippedName = stripCustomerLocationSuffix_(record.name);
    var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(strippedName));
    if (!canonicalKey) return;
    if (!byCanonicalKey[canonicalKey]) byCanonicalKey[canonicalKey] = [];
    if (byCanonicalKey[canonicalKey].indexOf(record) === -1) byCanonicalKey[canonicalKey].push(record);
  });

  var matchedKeys = Object.keys(byCanonicalKey).filter(function (key) {
    return new RegExp("\\b" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text);
  });
  if (matchedKeys.length !== 1) return null;
  var candidates = byCanonicalKey[matchedKeys[0]];
  if (candidates.length !== 1) return null;
  return { record: candidates[0], method: "text", confidence: "medium" };
}

function gmailCustomerResolutionTextV2_(meta, context, record) {
  var parts = [meta && meta.subject, meta && meta.body, record && record.note, context && context.note];
  return parts.filter(Boolean).join("\n");
}

function emailAddressFromFromHeaderV2_(from) {
  var match = String(from || "").match(/<([^>]+)>/);
  var address = match ? match[1] : String(from || "").trim();
  return address.toLowerCase();
}

function emailDomainFromAddressV2_(address) {
  var at = String(address || "").lastIndexOf("@");
  return at === -1 ? "" : String(address).slice(at + 1).toLowerCase();
}

/**
 * Grows the manually-curated "EMAIL SENDERS" column over time: whenever the
 * text tier alone resolves a customer (the sender wasn't already known),
 * log the sender/customer pairing for a human to review and, if it recurs,
 * add to TRUCKING by hand. Never writes to TRUCKING itself — the resolver
 * has no live-write path of its own.
 */
function logCustomerSenderSuggestionV2_(meta, textHit) {
  writeLog_("CUSTOMER SENDER SUGGESTION", textHit.record.name, JSON.stringify({
    messageId: meta && meta.messageId,
    sender: meta && meta.from,
    domain: emailDomainFromAddressV2_(emailAddressFromFromHeaderV2_(meta && meta.from)),
    matchedCustomer: textHit.record.name
  }));
}

function logCustomerResolutionAmbiguousV2_(meta, senderHit, textHit) {
  writeLog_("GMAIL V2 CUSTOMER RESOLVE AMBIGUOUS", meta && meta.subject, JSON.stringify({
    messageId: meta && meta.messageId,
    sender: meta && meta.from,
    senderMatch: senderHit.record.name,
    textMatch: textHit.record.name
  }));
}
