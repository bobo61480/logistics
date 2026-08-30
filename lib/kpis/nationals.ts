export type NationalSalesRecord = {
  sourceRow: number;
  date: number;
  value: number;
  status: string;
  department: string;
};

function normalizedHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function headerIndex(header: string[], aliases: string[], fallback: number) {
  const normalizedAliases = aliases.map(normalizedHeader);
  const index = header.findIndex((value) => normalizedAliases.includes(normalizedHeader(value)));
  return index >= 0 ? index : fallback;
}

function parseDateCode(value: unknown) {
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return 0;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  return year * 10_000 + Number(match[1]) * 100 + Number(match[2]);
}

function parseSalesAmount(value: unknown) {
  const text = String(value ?? "").trim().toUpperCase().replace(/[$,\s]/g, "");
  const match = text.match(/^(-?\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return 0;
  const multiplier = match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : match[2] === "B" ? 1_000_000_000 : 1;
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parses NATIONAL ORDER PROGRESS by header name rather than fixed offsets.
 *
 * The sheet gained an "Amount in $" column before Order Date in 2026, moving
 * Order Date from the old fixed index 6 to index 7. Fixed-index readers then
 * read the intentionally blank spacer column and reduced Nationals KPIs to 0.
 * Header-driven parsing keeps the KPI stable if columns move again.
 *
 * Only Dept=National belongs in the Nationals KPI. MBX/iHerb rows share the
 * same workbook but are separate businesses and must not inflate this card.
 */
export function parseNationalSalesRows(
  rows: string[][],
  options: { yearStart: number; todayCode: number },
): NationalSalesRecord[] {
  if (!rows.length) return [];

  const header = rows[0] ?? [];
  const statusIndex = headerIndex(header, ["Status"], 0);
  const departmentIndex = headerIndex(header, ["Dept", "Department"], 2);
  const amountIndex = headerIndex(header, ["Amount"], 4);
  const orderDateIndex = headerIndex(header, ["Order Date", "OrderDate"], 6);

  return rows.slice(1).flatMap((row, offset) => {
    const status = String(row[statusIndex] ?? "").trim();
    if (status.toLowerCase() === "cancelled") return [];

    const department = String(row[departmentIndex] ?? "").trim();
    if (department.toLowerCase() !== "national") return [];

    const date = parseDateCode(row[orderDateIndex]);
    if (!date || date < options.yearStart || date > options.todayCode) return [];

    const value = parseSalesAmount(row[amountIndex]);
    if (value <= 0) return [];

    return [{
      sourceRow: offset + 2,
      date,
      value,
      status,
      department,
    }];
  });
}
