#!/usr/bin/env node
/**
 * cms-imports-map.mjs — prototype: map CMS invoice data onto the IMPORTS tab layout.
 *
 * Looks up import invoice numbers (IN########) in the company CMS via the
 * cms-mcp-server (read-only MSSQL gateway) and emits rows shaped like the
 * IMPORTS tab of LOGISTICS MASTER 2026, so CMS can pre-fill / reconcile the
 * columns that are currently maintained by hand.
 *
 * Field mapping (IMPORTS column ← CMS source) — see docs/cms-imports-mapping.md:
 *
 *   A  SHIPMENT NO        ← (no CMS equivalent — OSL numbering is manual;
 *                            rows sharing TB_INVC.carrier sail together)
 *   C  INVOICE            ← CSMS.dbo.TB_INVC.invc_no          (join key)
 *   D  MBL                ← TB_INVC.airway_bill               (air only; null for ocean)
 *   E  HBL                ← (not in CMS header tables)
 *   H  CONTAINER          ← (not in CMS header tables)
 *   M  VESSEL             ← TB_INVC.carrier                   ("MAERSK BOSTON 626E")
 *   N  ETD                ← TB_INVC.sailing_dt                (출항일)
 *   O  ETA                ← TB_INVC.eta_dt                    (carrier ETA — see caveat)
 *   Q  DELIVERY EXPECTED  ← CSMS.dbo.TB_PNFM.arrv_dt          (actual arrival, 실제도착)
 *   AB STATUS             ← derived: TB_PNFM.iw_yn='Y' → RECEIVED,
 *                            else arrv_dt past → DELIVERED,
 *                            else TB_INVC.ow_yn='Y' → SHIPPING, else SCHEDULED
 *
 * Extra CMS fields with no IMPORTS column are emitted for reference:
 * qty (invc_qtot), received qty (TB_PNFM.iw_qtot), items (invc_icnt),
 * amount USD (invc_atot), ports, pallet height.
 *
 * Caveat (measured on the Jun–Jul 2026 shipments): TB_INVC.eta_dt ran 1–2
 * weeks optimistic vs TB_PNFM.arrv_dt on every ocean shipment — treat eta_dt
 * as the carrier's plan and arrv_dt as ground truth.
 *
 * Usage (--prompt is REQUIRED):
 *   node scripts/cms-imports-map.mjs --prompt "<question>"                 # invoices from app/inbound-invoice-links.ts
 *   node scripts/cms-imports-map.mjs --prompt "<question>" IN00450138 ...  # explicit invoice numbers
 *   node scripts/cms-imports-map.mjs --prompt "<question>" --json          # JSON instead of CSV
 *
 * The CMS server records the `prompt` argument verbatim in its operator audit
 * log, so --prompt is mandatory and must carry the requesting user's actual
 * question — it is never defaulted or left empty.
 *
 * Optional env: CMS_MCP_URL (gateway URL), CMS_MCP_AUTH_TOKEN (bearer token for
 * a protected gateway — forwarded on both the fetch and curl transports).
 *
 * Not part of the Next.js build. Requires network access to
 * https://cms.mcp.siliconii.com/mcp/ (via HTTPS_PROXY when set — falls back
 * to `curl`, which honors proxy env vars, when direct fetch cannot connect).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MCP_URL = process.env.CMS_MCP_URL || "https://cms.mcp.siliconii.com/mcp/";
// Optional bearer token for a protected gateway (mirrors worker/cms-client.ts).
const AUTH_TOKEN = process.env.CMS_MCP_AUTH_TOKEN;
const FETCH_TIMEOUT_MS = 20_000;

// The Imports invoices all share this scope (see docs/cms-imports-mapping.md):
// SELF intercompany, Stylekorean Inc. (CU000731), 미주 warehouse (WH000095), USD.
const EXPECTED_SCOPE = {
  biz_type: "SELF",
  cust_cd: "CU000731",
  whouse_cd: "WH000095",
  biz_curr: "2", // BASE_DB TB_CODE C005: 2 = USD
};
// biz_curr numeric codes → ISO (BASE_DB.dbo.TB_CODE gbn_cd='C005').
const CURRENCY = {
  1: "KRW", 2: "USD", 6: "EUR", 7: "GBP", 8: "SGD", 9: "CAD",
  12: "MYR", 13: "RUB", 15: "AUD", 16: "MXN", 17: "VND", 18: "AED",
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const promptIndex = args.indexOf("--prompt");
// The gateway records `prompt` verbatim in its operator audit log, so it must
// be a real, explicit question — never a silent default or an empty value.
const auditPrompt = promptIndex !== -1 ? args[promptIndex + 1] : undefined;
if (!auditPrompt || auditPrompt.startsWith("--")) {
  console.error(
    'Missing required --prompt "<your verbatim question>" — it is written to the\n' +
      "CMS operator audit log and must not be defaulted or left empty.",
  );
  process.exit(1);
}
const invoiceArgs = args.filter(
  (a, i) => !a.startsWith("--") && i !== promptIndex + 1,
);

function invoicesFromRepo() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    path.join(here, "..", "app", "inbound-invoice-links.ts"),
    "utf8",
  );
  return [...source.matchAll(/\b(IN\d{8})\b/g)].map((m) => m[1]);
}

const invoices = [...new Set(invoiceArgs.length ? invoiceArgs : invoicesFromRepo())];
if (!invoices.length) {
  console.error("No invoice numbers found (args or app/inbound-invoice-links.ts).");
  process.exit(1);
}
if (invoices.some((n) => !/^IN\d{8}$/.test(n))) {
  console.error("Invoice numbers must look like IN00450138.");
  process.exit(1);
}

// ─── Minimal MCP client (streamable HTTP, stateless) ─────────────────────────

async function mcpCall(tool, toolArgs) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: { ...toolArgs, prompt: auditPrompt } },
  });
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
  };

  // Server may reply as plain JSON or a single SSE data: frame. Proxies can
  // also return non-JSON error bodies ("upstream connect error ...") — treat
  // those as transport failures and retry.
  const parseRpc = (raw) => {
    const payload = raw.trim().startsWith("{")
      ? raw
      : raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    return JSON.parse(payload ?? raw);
  };
  const viaFetch = async () => {
    // Bound the attempt so a blackholed connection can't hang forever before
    // the loop advances to the proxy-aware curl fallback.
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return parseRpc(await res.text());
  };
  // Node's fetch ignores HTTPS_PROXY; curl honors it (sandboxed environments).
  const curlArgs = ["-sS", "--max-time", "60", "-X", "POST", MCP_URL,
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json, text/event-stream"];
  if (AUTH_TOKEN) curlArgs.push("-H", `Authorization: Bearer ${AUTH_TOKEN}`);
  curlArgs.push("-d", body);
  const viaCurl = () =>
    parseRpc(
      execFileSync("curl", curlArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    );

  let rpc;
  let lastError;
  for (const attempt of [viaFetch, viaCurl, viaCurl]) {
    try {
      rpc = await attempt();
      break;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!rpc) throw lastError;
  if (rpc.error) throw new Error(`CMS MCP error: ${JSON.stringify(rpc.error)}`);
  const text = rpc.result?.content?.map((c) => c.text ?? "").join("") ?? "";
  const result = JSON.parse(text);
  if (rpc.result?.isError || result.error) {
    throw new Error(`CMS tool error: ${result.error ?? text}`);
  }
  return result;
}

// ─── Queries (verified against live schema; see docs/cms-imports-mapping.md) ─

const inList = invoices.map((n) => `'${n}'`).join(",");

const invcSql = `SELECT i.invc_no, i.invc_dt, i.biz_type, i.cust_cd, i.whouse_cd,
  i.biz_curr, i.invc_icnt, i.invc_qtot, i.invc_atot, i.ship_dt, i.ship_via,
  i.carrier, i.airway_bill, i.ship_port, i.arrv_port, i.sailing_dt, i.eta_dt,
  i.ow_dt, i.ow_yn, i.ow_qtot, i.pallet_height
  FROM CSMS.dbo.TB_INVC i WITH (NOLOCK) WHERE i.invc_no IN (${inList})`;

const pnfmSql = `SELECT p.invc_no, p.pnfm_no, p.eta_dt, p.arrv_dt, p.iw_yn, p.iw_qtot
  FROM CSMS.dbo.TB_PNFM p WITH (NOLOCK) WHERE p.invc_no IN (${inList})`;

const limit = Math.max(invoices.length, 50);
// Sequential on purpose — parallel calls have tripped upstream connection
// resets at the gateway.
const invcRes = await mcpCall("run_readonly_query", { sql: invcSql, limit });
// TB_PNFM enrichment is access-grade dependent (see docs): if the caller's
// grade denies it outright, keep the TB_INVC mapping working instead of
// aborting the whole run.
let pnfmRes = { rows: [] };
try {
  pnfmRes = await mcpCall("run_readonly_query", { sql: pnfmSql, limit });
} catch (error) {
  console.error(
    `TB_PNFM enrichment unavailable (${error.message}); ` +
      "emitting TB_INVC columns only (no actual-arrival / received-qty / confirmation).",
  );
}

const pnfmByInvoice = new Map(pnfmRes.rows.map((r) => [r.invc_no, r]));

// ─── Mapping ──────────────────────────────────────────────────────────────────

// The logistics calendar runs on warehouse time (America/Los_Angeles), not
// UTC — after ~17:00 PT toISOString() is already tomorrow's date.
const todayIso = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
}).format(new Date());

function suggestedStatus(invc, pnfm) {
  if (pnfm?.iw_yn === "Y") return "RECEIVED";
  if (pnfm?.arrv_dt && pnfm.arrv_dt <= todayIso) return "DELIVERED";
  if (invc.ow_yn === "Y") return "SHIPPING";
  return "SCHEDULED";
}

// A syntactically valid invoice number can resolve to a row outside the IMPORTS
// scope (a typo landing on a neighboring customer/warehouse/currency). Flag
// those rather than silently emitting unrelated invoices as IMPORTS data.
function scopeMismatch(invc) {
  return Object.entries(EXPECTED_SCOPE)
    .filter(([field, want]) => String(invc[field] ?? "") !== want)
    .map(([field]) => field);
}

const rows = invoices.map((invoiceNo) => {
  const invc = invcRes.rows.find((r) => r.invc_no === invoiceNo);
  if (!invc) return { "INVOICE (C)": invoiceNo, "STATUS (AB)": "NOT IN CMS" };
  const pnfm = pnfmByInvoice.get(invoiceNo);
  const mismatch = scopeMismatch(invc);
  return {
    "INVOICE (C)": invc.invc_no,
    "MBL/AWB (D)": invc.airway_bill ?? "",
    "VESSEL (M)": invc.carrier ?? "",
    "ETD (N)": invc.sailing_dt ?? "",
    "ETA (O)": invc.eta_dt ?? "",
    "DELIVERY EXPECTED (Q)": pnfm?.arrv_dt ?? "",
    "STATUS (AB)": suggestedStatus(invc, pnfm),
    MODE: invc.ship_via ?? "",
    "SHIP PORT": invc.ship_port ?? "",
    "ARRV PORT": invc.arrv_port ?? "",
    "OUTBOUND DT": invc.ow_dt ?? "",
    QTY: invc.invc_qtot ?? "",
    "RECEIVED QTY": pnfm?.iw_qtot ?? "",
    ITEMS: invc.invc_icnt ?? "",
    AMOUNT: invc.invc_atot ?? "",
    CURRENCY: CURRENCY[Number(invc.biz_curr)] ?? String(invc.biz_curr ?? ""),
    "PALLET HT": invc.pallet_height ?? "",
    "CMS CONFIRM NO": pnfm?.pnfm_no ?? "",
    SCOPE: mismatch.length ? `OUT-OF-SCOPE:${mismatch.join("/")}` : "",
  };
});

// ─── Output ───────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const headers = Object.keys(rows.find((r) => Object.keys(r).length > 2) ?? rows[0]);
  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  console.log(headers.join(","));
  for (const row of rows) console.log(headers.map((h) => csvCell(row[h])).join(","));
}

const missing = rows.filter((r) => r["STATUS (AB)"] === "NOT IN CMS");
const outOfScope = rows.filter((r) => r.SCOPE);
console.error(
  `\n${rows.length - missing.length}/${invoices.length} invoices resolved in CMS` +
    (missing.length ? `; not found: ${missing.map((r) => r["INVOICE (C)"]).join(", ")}` : ""),
);
if (outOfScope.length) {
  console.error(
    `⚠ ${outOfScope.length} invoice(s) outside the expected IMPORTS scope ` +
      `(SELF / CU000731 / WH000095 / USD): ` +
      outOfScope.map((r) => `${r["INVOICE (C)"]} [${r.SCOPE}]`).join(", "),
  );
}
