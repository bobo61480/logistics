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
 * Wired into GmailPipelineV2.gs's live ingestion path via
 * resolveOutboundTargetV2_(), which calls matchCustomerBySenderV2_ and
 * matchCustomerByTextV2_ for every outbound-context message. Live writes
 * are gated by OUTBOUND_INSERT_DRY_RUN_V2 in OutboundSheetInsertV2.gs.
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
    var textOutcome = matchCustomerByTextV2_(haystack, records);

    // The text tier finding INTERNALLY conflicting evidence (two customers
    // both plausibly mentioned) must never be silently discarded in favor
    // of a confident sender match — that conflicting evidence is itself a
    // reason not to trust anything here, not merely "no text signal"
    // (Codex review, round 2 on PR #102).
    if (textOutcome && textOutcome.ambiguous) {
      logCustomerResolutionAmbiguousV2_(meta, senderHit, null);
      return null;
    }
    var textHit = textOutcome;

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
 *
 * A location-qualified row (e.g. "MEGA MART (PALO ALTO)") only accepts an
 * EXACT address configured for it, never a bare-domain match: the brand's
 * whole domain could just as easily send mail about a different, not-yet-
 * on-file location of the same brand, and a domain-wide trust would
 * silently route that shipment to this row's address anyway — the same
 * class of cross-location mismatch Tier B's own brand-tier guard exists to
 * prevent (Codex review round 7 on PR #102, see hasCustomerLocationQualifierV2_
 * below). An unqualified row (bare "MEGA MART") has no such ambiguity — it
 * IS the one location on file for that brand — so a domain match is safe.
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
    var qualified = hasCustomerLocationQualifierV2_(name);
    var senders = String(row[sendersCol] || "")
      .split(/[\n,;]+/)
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);
    var isMatch = senders.some(function (sender) {
      if (sender.indexOf("@") !== -1) return sender === address;
      if (qualified) return false;
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
var TEXT_MATCH_AMBIGUOUS_V2 = { ambiguous: true };

function matchCustomerByTextV2_(haystack, records) {
  if (!haystack) return null;
  var text = normalizedCustomerHaystackV2_(haystack);
  if (text === "  ") return null;

  var exactMatches = records.filter(function (record) {
    return customerNameAppearsExactlyV2_(text, record.name);
  });
  // 2+ literal full names mentioned is real conflicting evidence, not mere
  // absence of a signal — must block the whole resolution, including a
  // confident sender match (Codex review, round 2 on PR #102).
  if (exactMatches.length > 1) return TEXT_MATCH_AMBIGUOUS_V2;

  var byCanonicalKey = {};
  records.forEach(function (record) {
    if (hasCustomerLocationQualifierV2_(record.name)) return;
    var canonicalKey = normalizeWmsCustomerKey_(canonicalWmsCustomer_(record.name));
    if (!canonicalKey) return;
    if (!byCanonicalKey[canonicalKey]) byCanonicalKey[canonicalKey] = [];
    if (byCanonicalKey[canonicalKey].indexOf(record) === -1) byCanonicalKey[canonicalKey].push(record);
  });

  var matchedKeys = Object.keys(byCanonicalKey).filter(function (key) {
    return customerKeyAppearsWithoutTrailingLocationV2_(text, key);
  });

  if (exactMatches.length === 1) {
    var exactRecord = exactMatches[0];
    // A canonical/brand-tier hit for a DIFFERENT customer than the exact
    // match is real conflicting evidence too, not something the exact
    // tier's early return should get to silently ignore — e.g. text naming
    // both "A&B LLC" (exact) and "Royal Imex" (brand-only) mentions two
    // customers, and the resolver must not just pick the exact one (Codex
    // review round 4 on PR #102).
    var conflictsWithAnotherBrand = matchedKeys.some(function (key) {
      return byCanonicalKey[key].indexOf(exactRecord) === -1;
    });
    if (conflictsWithAnotherBrand) return TEXT_MATCH_AMBIGUOUS_V2;
    return { record: exactRecord, method: "text-exact", confidence: "high" };
  }

  if (matchedKeys.length === 0) return null;
  if (matchedKeys.length > 1) return TEXT_MATCH_AMBIGUOUS_V2;
  var candidates = byCanonicalKey[matchedKeys[0]];
  if (candidates.length !== 1) return TEXT_MATCH_AMBIGUOUS_V2;
  return { record: candidates[0], method: "text-brand", confidence: "medium" };
}

/**
 * Exact-tier match for a candidate with NO location qualifier of its own
 * (e.g. bare "MEGA MART") must reject a haystack mention that is itself
 * MORE specific — "MEGA MART (FREMONT)" — since that names a different,
 * possibly not-yet-on-file location, not the bare candidate (Codex review,
 * round 2 on PR #102: the padded-substring test alone can't tell these
 * apart, since parens/dashes collapse to plain spaces during
 * normalization same as any other punctuation). A candidate that DOES
 * carry its own qualifier (e.g. "MEGA MART (PALO ALTO)") is unaffected:
 * its own key already includes the location marker, so it only matches
 * text naming that same specific location.
 */
function customerNameAppearsExactlyV2_(paddedHaystack, name) {
  var key = normalizedCustomerHaystackV2_(name).trim();
  if (hasCustomerLocationQualifierV2_(name)) return customerKeyAppearsV2_(paddedHaystack, key);
  return customerKeyAppearsWithoutTrailingLocationV2_(paddedHaystack, key);
}

function customerKeyAppearsV2_(paddedHaystack, key) {
  if (!key) return false;
  return paddedHaystack.indexOf(" " + key + " ") !== -1;
}

function customerKeyAppearsWithoutTrailingLocationV2_(paddedHaystack, key) {
  if (!customerKeyAppearsV2_(paddedHaystack, key)) return false;
  return paddedHaystack.indexOf(" " + key + " " + CUSTOMER_LOCATION_MARKER_V2) === -1;
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
 * Marks the position of a location qualifier (an opening/closing paren
 * pair, or a "- N" suffix) so it survives the generic punctuation-to-space
 * collapse below as a distinguishable token, instead of becoming
 * indistinguishable from any other word-separating space. Applied
 * identically to both a candidate's own name and the email haystack, so
 * "MEGA MART (PALO ALTO)" and "MEGA MART (FREMONT)" both retain the marker
 * right after "MEGA MART" — letting
 * customerKeyAppearsWithoutTrailingLocationV2_ detect that a BARE
 * "MEGA MART" key is immediately followed by a location qualifier it
 * doesn't itself include, and refuse to treat that as a match.
 *
 * The CLOSE marker matters just as much as the OPEN one: without it, a
 * shorter stored qualifier is a prefix-substring of a longer haystack
 * mention of the same brand — e.g. stored "MEGA MART (PALO)" normalizes to
 * "...SKLOCQUALIFIERV2 PALO" and would appear as a padded substring inside
 * an email's "...SKLOCQUALIFIERV2 PALO ALTO...", incorrectly resolving to
 * the wrong (shorter) location (Codex review round 3 on PR #102). Marking
 * the close paren too means the stored key only matches when the FULL
 * qualifier text between the markers is identical, not merely a prefix.
 */
var CUSTOMER_LOCATION_MARKER_V2 = "SKLOCQUALIFIERV2";
var CUSTOMER_LOCATION_MARKER_END_V2 = "SKLOCQUALIFIERV2END";

/**
 * Lighter-touch than normalizeWmsCustomerKey_: uppercases, expands "&" to
 * "AND", marks location-qualifier positions (see above), and collapses
 * remaining punctuation/whitespace to single spaces — but does NOT strip
 * legal suffixes (INC/LLC/CORP/...), since that's only safe to apply to a
 * known customer-name field, not arbitrary email text (see the function
 * doc comment above). Padded with a leading/trailing space so every
 * comparison below can use a simple, unambiguous substring test.
 */
function normalizedCustomerHaystackV2_(text) {
  return " " + String(text || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/\(/g, " " + CUSTOMER_LOCATION_MARKER_V2 + " ")
    .replace(/\)/g, " " + CUSTOMER_LOCATION_MARKER_END_V2 + " ")
    .replace(/-\s*(\d+)/g, " " + CUSTOMER_LOCATION_MARKER_V2 + " $1")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() + " ";
}

function gmailCustomerResolutionTextV2_(meta, context, record) {
  var parts = [
    meta && meta.subject,
    meta && gmailStripQuotedReplyHistoryV2_(meta.body),
    record && record.note,
    context && context.note
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Truncates a plain-text body at the first reply-quote marker (Gmail/most
 * clients' "On <date>, <sender> wrote:" header, an Outlook-style
 * "-----Original Message-----" separator, or a classic "> " quote-prefixed
 * line), so an older, possibly different shipment quoted below a reply
 * can't be scanned as if it were part of the current message (Codex review
 * round 7 on PR #102: if the current message names a new/unmatched
 * customer while the quoted history below names exactly one known
 * customer, the text tier would otherwise confidently return the OLD
 * customer). Deliberately does NOT strip a "------ Forwarded message
 * ------" block — a forward is frequently the actual content of interest
 * in this pipeline's real traffic (a shipment notice forwarded along),
 * not stale history to discard.
 */
function gmailStripQuotedReplyHistoryV2_(body) {
  var text = String(body || "");
  var lines = text.split(/\r\n|\r|\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (/^>/.test(line)) return lines.slice(0, i).join("\n");
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) return lines.slice(0, i).join("\n");
    if (/^On .+ wrote:$/.test(line)) return lines.slice(0, i).join("\n");
  }
  return text;
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
    senderMatch: senderHit ? senderHit.record.name : "",
    // textHit is null both when the text tier found nothing and when it
    // found internally conflicting evidence — the caller only reaches
    // this log function in the latter case (or a real tier-disagreement),
    // so a blank value here specifically means "text tier itself was
    // ambiguous," not "no text signal at all."
    textMatch: textHit ? textHit.record.name : ""
  }));
}
