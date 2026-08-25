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
    var matchedCities = Object.keys(directory).filter(function (city) {
      return new RegExp("\\b" + city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(haystack);
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
    var found = haystack.match(/\bDC\s*#?\s*[:#]?\s*(\d{3,6})\b/gi) || [];
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
