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
 * Tier B, two safe sub-tiers, checked in order:
 *
 *  - Exact: the candidate's own full name (including any location
 *    qualifier, e.g. "MEGA MART (PALO ALTO)" or "MEGA MART - 1") literally
 *    appears in the email. Always trusted — mirrors CustomerLookup.gs's
 *    own exact-name trust tier.
 *  - Brand: a shared canonical/brand key appears, but ONLY among
 *    candidates with NO location qualifier at all. A record carrying a
 *    parenthetical or "- N" suffix is excluded from this tier entirely —
 *    even when it is currently the sole TRUCKING row for that brand, an
 *    email naming a DIFFERENT, not-yet-on-file location of the same brand
 *    (e.g. "MEGA MART (FREMONT)" when only "MEGA MART (PALO ALTO)" exists)
 *    would otherwise silently resolve to the wrong physical location —
 *    exactly the class of bug that caused the 2026-08-12 KORHEIM incident,
 *    flagged again here by Codex review on PR #102. A brand with only
 *    location-qualified candidates therefore has no safe brand-level
 *    match at all and falls through to null (never guessed).
 *
 * Both sub-tiers compare against the SAME lightly-normalized haystack
 * (uppercased, "&" expanded to "AND", punctuation collapsed to spaces) so
 * that a candidate name reduced through canonicalWmsCustomer_'s aliasing
 * (which also strips legal suffixes like "INC"/"LLC") still matches a real
 * email that spells the name out with that suffix or an ampersand present
 * (Codex review on PR #102) — deliberately NOT running the haystack
 * through canonicalWmsCustomer_'s own legal-suffix stripping, since doing
 * that to arbitrary free text (not a known customer-name field) risks
 * collapsing an unrelated phrase into a false match (e.g. "Mega Corp Mart
 * Inc" stripping down to "Mega Mart").
 */
function matchCustomerByTextV2_(haystack, records) {
  if (!haystack) return null;
  var text = normalizedCustomerHaystackV2_(haystack);
  if (text === "  ") return null;

  var exactMatches = records.filter(function (record) {
    return customerKeyAppearsV2_(text, normalizedCustomerHaystackV2_(record.name).trim());
  });
  if (exactMatches.length === 1) return { record: exactMatches[0], method: "text-exact", confidence: "high" };
  if (exactMatches.length > 1) return null;

  var byCanonicalKey = {};
  records.forEach(function (record) {
    if (hasCustomerLocationQualifierV2_(record.name)) return;
    var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(record.name));
    if (!canonicalKey) return;
    if (!byCanonicalKey[canonicalKey]) byCanonicalKey[canonicalKey] = [];
    if (byCanonicalKey[canonicalKey].indexOf(record) === -1) byCanonicalKey[canonicalKey].push(record);
  });

  var matchedKeys = Object.keys(byCanonicalKey).filter(function (key) {
    return customerKeyAppearsV2_(text, key);
  });
  if (matchedKeys.length !== 1) return null;
  var candidates = byCanonicalKey[matchedKeys[0]];
  if (candidates.length !== 1) return null;
  return { record: candidates[0], method: "text-brand", confidence: "medium" };
}

/**
 * True when name carries a location-disambiguation qualifier — a
 * parenthetical ("(FRESNO)") or a trailing "- N" suffix (the sheet's
 * existing multi-location convention, see CustomerLookup.gs's
 * stripCustomerLocationSuffix_) — meaning it is one of possibly several
 * per-location entries for the same brand.
 */
function hasCustomerLocationQualifierV2_(name) {
  return /\([^)]*\)/.test(name) || /-\s*\d+\s*$/.test(name);
}

/**
 * Lighter-touch than normalizeWmsCustomerKey_: uppercases, expands "&" to
 * "AND", and collapses punctuation/whitespace to single spaces, but does
 * NOT strip legal suffixes (INC/LLC/CORP/...) — that step is only safe to
 * apply to a known customer-name field, not arbitrary email text (see the
 * function doc comment above). Padded with a leading/trailing space so
 * every comparison below can use a simple, unambiguous substring test.
 */
function normalizedCustomerHaystackV2_(text) {
  return " " + String(text || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() + " ";
}

function customerKeyAppearsV2_(paddedHaystack, key) {
  if (!key) return false;
  return paddedHaystack.indexOf(" " + key + " ") !== -1;
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
