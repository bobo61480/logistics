/**
 * Shared customer-database matching primitives.
 *
 * CustomerLookup and CustomerBackfill keep separate record-building and write
 * policies, but exact/canonical uniqueness and TRUCKING header discovery must
 * not drift between them.
 */
/* eslint-disable no-unused-vars */

function customerExactKey_(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, " ").trim();
}

function customerCanonicalKey_(value) {
  return normalizeWmsCustomerKey_(canonicalWmsCustomer_(value));
}

function findCustomerDatabaseHeader_(rows, label) {
  for (var r = 0; r < Math.min(rows.length, 5); r++) {
    var map = headerMap_(rows[r]);
    if (map["CUSTOMER NAME"] !== undefined && map["ADDRESS"] !== undefined) return { rowIndex: r, map: map };
  }
  throw new Error("Could not locate the " + String(label || "customer database") + " header row.");
}

function matchUniqueCustomerRecord_(customerValue, records) {
  var exactKey = customerExactKey_(customerValue);
  var exact = records.filter(function (record) { return record.exactKey === exactKey; });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  var canonicalKey = customerCanonicalKey_(customerValue);
  if (!canonicalKey) return null;
  var canonical = records.filter(function (record) { return record.canonicalKey === canonicalKey; });
  return canonical.length === 1 ? canonical[0] : null;
}
