export function normalizeIdentifier(value: unknown) {
  return String(value ?? "").trim().replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

export function normalizeCustomerKey(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truckingGroupKey(customer: unknown, dateKey: unknown) {
  return `${normalizeCustomerKey(customer)}___${String(dateKey ?? "").trim()}`;
}

export function exactReferenceMatch(a: unknown, b: unknown) {
  const left = normalizeIdentifier(a);
  const right = normalizeIdentifier(b);
  return Boolean(left && right && left === right);
}
