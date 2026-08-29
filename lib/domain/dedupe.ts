export type DedupeResult = {
  rows: string[][];
  removed: number;
  merged: number;
  conflicts: number;
};

const normalize = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
const compact = (value: unknown) => normalize(value).replace(/[\s-]+/g, "");

function findHeaderRow(rows: string[][], required: string[][]) {
  for (let r = 0; r < Math.min(rows.length, 8); r += 1) {
    const values = rows[r].map(normalize);
    const ok = required.every((group) => group.some((name) => values.includes(name)));
    if (ok) return r;
  }
  return 0;
}

function columnMap(header: string[]) {
  const normalized = header.map(normalize);
  const idx = (...names: string[]) => names.map(normalize).map((name) => normalized.indexOf(name)).find((i) => i >= 0) ?? -1;
  return { idx };
}

function valueAt(row: string[], index: number) {
  return index >= 0 ? String(row[index] ?? "").trim() : "";
}

function firstToken(value: string) {
  return value.split(/[\n,;|]+/).map((part) => part.trim()).find(Boolean) ?? "";
}

function realContainer(value: string) {
  const match = normalize(value).match(/\b[A-Z]{4}\d{7}\b/);
  return match?.[0] ?? "";
}

function importKey(row: string[], header: string[]) {
  const { idx } = columnMap(header);
  const container = realContainer(valueAt(row, idx("CONTAINER", "CONTAINER NO", "CONTAINER RAW (SYSTEM)")));
  const hbl = compact(firstToken(valueAt(row, idx("HBL", "HOUSE B/L", "HOUSE BL"))));
  const mbl = compact(firstToken(valueAt(row, idx("MBL", "MASTER B/L", "MASTER BL"))));
  const shipment = compact(firstToken(valueAt(row, idx("SHIPMENT", "SHIPMENT #", "SHIPMENT NO", "SHIPMENT NO."))));
  const invoice = compact(firstToken(valueAt(row, idx("INVOICE", "INVOICE#", "INVOICE NO."))));
  const eta = compact(valueAt(row, idx("ETA", "ARRIVAL")));
  if (container) return `container:${container}`;
  if (hbl) return `hbl:${hbl}`;
  if (mbl && shipment) return `mbl-shipment:${mbl}|${shipment}`;
  if (shipment) return `shipment:${shipment}`;
  if (invoice && eta) return `invoice-eta:${invoice}|${eta}`;
  return "";
}

function outboundKey(row: string[], header: string[]) {
  const { idx } = columnMap(header);
  const pro = compact(firstToken(valueAt(row, idx("PRO#", "PRO", "PRO #", "TRACKING", "TRACKING #", "TRACKING#", "BOL", "B/L"))));
  const shipment = compact(firstToken(valueAt(row, idx("SHIPMENT", "SHIPMENT #", "SHIPMENT NO", "SHIPMENT NO."))));
  const invoice = compact(firstToken(valueAt(row, idx("INVOICE", "INVOICE#", "INVOICE NO.", "INVOICE NO"))));
  const customer = normalize(valueAt(row, idx("CUSTOMER", "CUSTOMER NAME")));
  const shipDate = compact(valueAt(row, idx("SHIP DATE", "SHIPPING DATE", "PICK UP DATE", "PU DATE")));
  if (pro && /\d/.test(pro)) return `pro:${pro}`;
  if (shipment && /\d/.test(shipment)) return `shipment:${shipment}`;
  if (invoice && customer && shipDate) return `invoice-customer-date:${invoice}|${customer}|${shipDate}`;
  return "";
}

function rowFingerprint(row: string[]) {
  return row.map(normalize).join("\u001f");
}

function nonEmptyCount(row: string[]) {
  return row.reduce((count, cell) => count + (String(cell ?? "").trim() ? 1 : 0), 0);
}

function isSubset(sparse: string[], rich: string[]) {
  const width = Math.max(sparse.length, rich.length);
  let sawValue = false;
  for (let i = 0; i < width; i += 1) {
    const a = normalize(sparse[i]);
    if (!a) continue;
    sawValue = true;
    if (a !== normalize(rich[i])) return false;
  }
  return sawValue;
}

export function dedupeShipmentRows(rows: string[][] | null | undefined, kind: "inbound" | "outbound" | "generic"): DedupeResult {
  if (!rows?.length) return { rows: [], removed: 0, merged: 0, conflicts: 0 };
  const required = kind === "inbound"
    ? [["SHIPMENT", "SHIPMENT #", "CONTAINER", "HBL", "MBL"], ["ETA", "INVOICE", "HBL"]]
    : kind === "outbound"
      ? [["CUSTOMER", "CUSTOMER NAME"], ["SHIP DATE", "SHIPPING DATE", "PICK UP DATE"]]
      : [[]];
  const headerRow = kind === "generic" ? 0 : findHeaderRow(rows, required);
  const header = rows[headerRow] ?? [];
  const output = rows.slice(0, headerRow + 1).map((row) => row.slice());
  const byKey = new Map<string, number>();
  const exact = new Set<string>();
  let removed = 0;
  let merged = 0;
  let conflicts = 0;

  for (let sourceIndex = headerRow + 1; sourceIndex < rows.length; sourceIndex += 1) {
    const source = rows[sourceIndex].map((cell) => String(cell ?? ""));
    if (!source.some((cell) => cell.trim())) {
      output.push(source);
      continue;
    }

    const fp = rowFingerprint(source);
    if (exact.has(fp)) {
      removed += 1;
      continue;
    }
    exact.add(fp);

    const key = kind === "inbound" ? importKey(source, header) : kind === "outbound" ? outboundKey(source, header) : "";
    if (!key) {
      output.push(source);
      continue;
    }

    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, output.length);
      output.push(source);
      continue;
    }

    const existing = output[existingIndex];
    if (isSubset(source, existing)) {
      removed += 1;
      merged += 1;
      continue;
    }
    if (isSubset(existing, source)) {
      output[existingIndex] = source;
      removed += 1;
      merged += 1;
      continue;
    }

    conflicts += 1;
    if (nonEmptyCount(source) > nonEmptyCount(existing)) byKey.set(key, output.length);
    output.push(source);
  }

  return { rows: output, removed, merged, conflicts };
}
