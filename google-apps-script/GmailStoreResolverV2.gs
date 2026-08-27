/**
 * GmailStoreResolverV2.gs — DC/store-code resolution for ULTA and TJX/ROSS
 * Gmail ingestion.
 *
 * Unlike WH Trucking Request, ULTA and TJX/ROSS have no free-text "customer
 * name" column matchable against the TRUCKING master (confirmed by reading
 * the live workbook headers directly): ULTA's identity column (A) holds a
 * store/DC label like "ULTA (FRESNO)", and TJX/ROSS's identity column (C,
 * "DC#") holds a bare store number. Each sheet is its own source of truth
 * for its known identifiers — no separate master sheet is needed.
 *
 * Same never-guess discipline as GmailCustomerResolverV2.gs: an ambiguous
 * or absent match returns null rather than guessing, so the caller's normal
 * PENDING VERIFICATION escalation handles it.
 *
 * Not yet wired into GmailPipelineV2.gs's live processing — see the header
 * comment in GmailCustomerResolverV2.gs for why (its resolved identity would
 * be able to reach a live sheet write immediately, before this PR's insert
 * path and dry-run gate exist).
 */

var GMAIL_STORE_RESOLVER_ENABLED_V2 = true;
var ULTA_SHEET_NAME_V2 = "ULTA";
var TJX_ROSS_SHEET_NAME_V2 = "TJX/ROSS";

/**
 * Scans ULTA column A for existing "ULTA (CITY)"-style values, grouping by
 * the parenthesized city token. A city shared by two distinct DC values
 * (rare, but possible if two stores in the same city are tracked
 * separately) makes that city ambiguous — resolveUltaDcFromEmailV2_ never
 * guesses between them.
 */
function buildUltaDcDirectory_() {
  var sheet = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId).getSheetByName(ULTA_SHEET_NAME_V2);
  if (!sheet) return {};
  var values = sheet.getDataRange().getDisplayValues();
  var directory = {};
  for (var r = 1; r < values.length; r++) {
    var dcValue = String(values[r][0] || "").trim();
    if (!dcValue) continue;
    var cityMatch = dcValue.match(/\(([^)]+)\)/);
    if (!cityMatch) continue;
    var cityToken = cityMatch[1].trim().toUpperCase();
    if (!cityToken) continue;
    if (!directory[cityToken]) directory[cityToken] = [];
    if (directory[cityToken].indexOf(dcValue) === -1) directory[cityToken].push(dcValue);
  }
  return directory;
}

var ULTA_DESTINATION_LABEL_PATTERN_V2 = /\b(SHIP(PING)?[\s-]*TO|DELIVER(Y)?[\s-]*(TO|ADDRESS)|CONSIGNEE|DESTINATION|DROP[\s-]*(OFF|AT)|RECEIVING)\b/;
var ULTA_ORIGIN_LABEL_PATTERN_V2 = /\b(PICK[\s-]*UP|PICKUP|ORIGIN|SHIP(PING)?[\s-]*FROM|FROM[\s-]*ADDRESS)\b/;

/**
 * Splits a single line into label-owned segments — one per label
 * occurrence, running from that label to the start of the next label (or
 * end of line). Handles a line naming BOTH an origin and a destination
 * (e.g. "Pickup: Fresno; deliver to: Phoenix"): treating a mixed line as
 * belonging entirely to whichever label matches first put the origin city
 * in the destination bucket too, defeating the whole point of separating
 * them (Codex review round 4 on PR #102). Returns [] when the line has no
 * label at all.
 */
function gmailStoreLineLabelSegmentsV2_(line) {
  var matches = [];
  var destRe = new RegExp(ULTA_DESTINATION_LABEL_PATTERN_V2.source, "g");
  var originRe = new RegExp(ULTA_ORIGIN_LABEL_PATTERN_V2.source, "g");
  var m;
  while ((m = destRe.exec(line))) matches.push({ index: m.index, bucket: "dest" });
  while ((m = originRe.exec(line))) matches.push({ index: m.index, bucket: "origin" });
  if (!matches.length) return [];
  matches.sort(function (a, b) { return a.index - b.index; });
  var segments = [];
  for (var i = 0; i < matches.length; i++) {
    var start = matches[i].index;
    var end = i + 1 < matches.length ? matches[i + 1].index : line.length;
    segments.push({ bucket: matches[i].bucket, text: line.slice(start, end) });
  }
  return segments;
}

/**
 * Buckets the text under "destination" or "origin" based on labels (SHIP TO
 * / DELIVER TO / CONSIGNEE / DESTINATION vs. PICKUP / ORIGIN / SHIP FROM),
 * carrying the last label on a line forward onto following unlabeled lines
 * too — shipment emails often write a label on its own line with the
 * address below it. That carry-forward resets at the next BLANK line: a
 * footer or quoted-history block below the labeled address (typically
 * separated by a blank line) must not silently inherit that label forever
 * — e.g. "Ship-to: Phoenix" followed by a blank line and then an unrelated
 * "Dallas office" footer must not put Dallas in the destination bucket
 * just because it's textually below the last label seen (Codex review
 * round 5 on PR #102). Splitting on single line breaks (not `[\r\n]+`,
 * which collapses consecutive breaks and hides blank lines entirely) is
 * what makes a blank line detectable as its own empty entry here. An
 * unlabeled line with no label carried forward is dropped from both
 * buckets: guessing which block it belongs to would reintroduce the exact
 * ambiguity this exists to remove.
 */
function gmailStoreLabeledLinesV2_(haystack) {
  var lines = String(haystack || "").split(/\r\n|\r|\n/);
  var destination = [];
  var origin = [];
  var carry = null;
  lines.forEach(function (line) {
    if (!line.trim()) { carry = null; return; }
    var segments = gmailStoreLineLabelSegmentsV2_(line);
    if (segments.length) {
      segments.forEach(function (segment) {
        (segment.bucket === "dest" ? destination : origin).push(segment.text);
      });
      carry = segments[segments.length - 1].bucket;
      return;
    }
    if (carry === "dest") { destination.push(line); return; }
    if (carry === "origin") { origin.push(line); return; }
    carry = null;
  });
  return { destination: destination.join(" "), origin: origin.join(" "), hasLabels: Boolean(destination.length || origin.length) };
}

/**
 * Requires exactly one directory city token to appear (word-boundary
 * anchored) in the given text, and that city to map to exactly one DC
 * value. Returns { customer, method, confidence } on a confident hit, else
 * null.
 */
function resolveUltaDcFromEmailV2_(text) {
  if (!GMAIL_STORE_RESOLVER_ENABLED_V2) return null;
  try {
    var directory = buildUltaDcDirectory_();
    var haystack = String(text || "").toUpperCase();
    var labeled = gmailStoreLabeledLinesV2_(haystack);
    // When the email labels a destination (or a pickup/origin) anywhere,
    // only the destination-labeled text can identify the DC — a directory
    // city mentioned solely on a pickup/origin line (e.g. "Pickup in
    // Fresno; deliver to the new Phoenix DC") must not resolve to that
    // pickup city just because it's the only directory-known city anywhere
    // in the email (Codex review round 3 on PR #102). With no labels at
    // all, fall back to the whole email — most real shipment emails aren't
    // explicitly labeled and mention only the one relevant location, so
    // restricting then would just suppress real matches for no reason.
    var searchText = labeled.hasLabels ? labeled.destination : haystack;
    var matchedCities = Object.keys(directory).filter(function (city) {
      return new RegExp("\\b" + city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(searchText);
    });
    if (matchedCities.length !== 1) return null;
    var dcValues = directory[matchedCities[0]];
    if (dcValues.length !== 1) return null;
    return { customer: dcValues[0], method: "ulta-dc-city", confidence: "medium" };
  } catch (err) {
    writeLog_("GMAIL V2 STORE RESOLVE ERROR", "ULTA", String(err));
    return null;
  }
}

/**
 * Scans TJX/ROSS column C ("DC#") for bare numeric store identifiers.
 * Real live data has this column populated inconsistently (blank on several
 * sampled rows) — that just means a sparser directory and a lower match
 * rate, not an unsafe one: a DC# with no directory entry simply fails to
 * resolve and falls through to PENDING VERIFICATION like any other miss.
 */
function buildTjxDcDirectory_() {
  var sheet = SpreadsheetApp.openById(GMAIL_PIPELINE.masterId).getSheetByName(TJX_ROSS_SHEET_NAME_V2);
  if (!sheet) return {};
  var values = sheet.getDataRange().getDisplayValues();
  var directory = {};
  for (var r = 1; r < values.length; r++) {
    var dcNumber = String(values[r][2] || "").trim();
    if (/^\d{3,6}$/.test(dcNumber)) directory[dcNumber] = true;
  }
  return directory;
}

/**
 * Requires exactly one distinct DC# pattern found in the text to also be a
 * known directory entry. Multiple distinct DC# mentions, or a DC# with no
 * directory entry, both resolve to null rather than guessing.
 */
function resolveTjxDcFromEmailV2_(text) {
  if (!GMAIL_STORE_RESOLVER_ENABLED_V2) return null;
  try {
    var directory = buildTjxDcDirectory_();
    var haystack = String(text || "");
    // Requires an explicit "#" or ":" marker between "DC" and the number —
    // both were previously optional, so ordinary postal text like "Deliver
    // to Washington DC 20001" matched as a DC-number mention; if that ZIP
    // also happened to be a real TJX/ROSS directory entry, it confidently
    // (and wrongly) resolved the shipment there (Codex review round 8 on
    // PR #102).
    var found = haystack.match(/\bDC\s*[:#]\s*(\d{3,6})\b/gi) || [];
    var seen = {};
    var distinct = [];
    // Collect every distinct mention BEFORE checking directory membership —
    // an email naming one known DC and one unknown/mistyped DC (e.g. "DC#
    // 1234 and DC# 9999") must still be rejected as ambiguous, not silently
    // narrowed down to the one that happens to be on file (Codex review on
    // PR #102: filtering to directory-known numbers first let the unknown
    // one disappear before the ambiguity check ever saw it).
    found.forEach(function (mention) {
      var numberMatch = mention.match(/(\d{3,6})/);
      var number = numberMatch ? numberMatch[1] : "";
      if (number && !seen[number]) { seen[number] = true; distinct.push(number); }
    });
    if (distinct.length !== 1) return null;
    if (!directory[distinct[0]]) return null;
    return { customer: distinct[0], method: "tjx-dc-number", confidence: "medium" };
  } catch (err) {
    writeLog_("GMAIL V2 STORE RESOLVE ERROR", "TJX/ROSS", String(err));
    return null;
  }
}
