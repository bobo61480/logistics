import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCmsImports,
  importsInvoiceSet,
  mapCmsImportRows,
  reduceCmsImportsToImports,
  type CmsImportRow,
} from "../worker/cms-imports";

// Build an MCP-over-HTTP JSON-RPC response body the way the live CMS gateway
// replies, so runCmsReadonlyQuery parses `rows` out of it.
function mcpResponse(rows: Record<string, unknown>[]) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      result: { content: [{ text: JSON.stringify({ rows }) }] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mapCmsImportRows", () => {
  it("normalizes dates to YYYY-MM-DD, coerces quantities, and trims strings", () => {
    const [row] = mapCmsImportRows([
      {
        invc_no: "  IN20260012  ",
        eta_dt: "2026-07-18T00:00:00.000Z",
        ow_dt: "2026-07-01",
        carrier: "  MAERSK BOSTON 626E ",
        invc_qtot: "1200",
        arrv_dt: "2026-07-29T09:30:00Z",
        iw_qtot: 1200,
      },
    ]);
    expect(row).toEqual({
      invoiceNo: "IN20260012",
      etaDate: "2026-07-18",
      actualArrival: "2026-07-29",
      outboundDate: "2026-07-01",
      carrier: "MAERSK BOSTON 626E",
      invoicedQty: 1200,
      receivedQty: 1200,
    });
  });

  it("leaves actualArrival empty and receivedQty null when TB_PNFM columns are masked to null", () => {
    const [row] = mapCmsImportRows([
      {
        invc_no: "IN20260013",
        eta_dt: "2026-08-02",
        ow_dt: null,
        carrier: "HANSA EUROPE 627E",
        invc_qtot: 800,
        arrv_dt: null,
        iw_qtot: null,
      },
    ]);
    // TB_INVC columns survive; masked PNFM columns degrade to empty/null (NOT 0,
    // so a masked value is never confused with a real zero receipt).
    expect(row.etaDate).toBe("2026-08-02");
    expect(row.invoicedQty).toBe(800);
    expect(row.actualArrival).toBe("");
    expect(row.receivedQty).toBeNull();
  });

  it("preserves a real zero received quantity distinctly from a masked null", () => {
    const [row] = mapCmsImportRows([
      { invc_no: "IN0", invc_qtot: 500, iw_qtot: 0, arrv_dt: "2026-08-10" },
    ]);
    expect(row.receivedQty).toBe(0);
    expect(row.invoicedQty).toBe(500);
  });

  it("drops rows with no invoice number", () => {
    expect(mapCmsImportRows([{ invc_no: "  " }, { eta_dt: "2026-01-01" }])).toEqual([]);
  });

  it("maps non-numeric or absent quantities to null (not 0)", () => {
    const [row] = mapCmsImportRows([{ invc_no: "IN1", invc_qtot: "n/a", iw_qtot: undefined }]);
    expect(row.invoicedQty).toBeNull();
    expect(row.receivedQty).toBeNull();
  });
});

describe("reduceCmsImportsToImports / importsInvoiceSet", () => {
  const cmsRow = (invoiceNo: string): CmsImportRow => ({
    invoiceNo,
    etaDate: "",
    actualArrival: "",
    outboundDate: "",
    carrier: "",
    invoicedQty: null,
    receivedQty: null,
  });
  // IMPORTS rows: col 0 shipment, col 2 invoice; first two rows are headers.
  const importsRows: string[][] = [
    ["IMPORTS"],
    ["SHIPMENT"],
    ["HJ99 - 2026", "", "IN00777", "", "", "", "", "MSKU1"],
    ["MULTI - 2026", "", "IN00801, IN00802", "", "", "", "", "MSKU2"],
    ["OSL10 - 2026", "", "N00451013", "", "", "", "", "MSKU3"],
  ];

  it("collects every IMPORTS-sheet invoice (uppercased, split, OSL10-corrected)", () => {
    const set = importsInvoiceSet(importsRows);
    expect(set.has("IN00777")).toBe(true);
    expect(set.has("IN00801")).toBe(true);
    expect(set.has("IN00802")).toBe(true);
    // OSL10's typo'd N00451013 is corrected to IN00451013 to match CMS.
    expect(set.has("IN00451013")).toBe(true);
    expect(set.has("N00451013")).toBe(false);
  });

  it("keeps only CMS records whose invoice is on the IMPORTS sheet", () => {
    const rows = [cmsRow("IN00777"), cmsRow("IN00801"), cmsRow("IN99999"), cmsRow("in00451013")];
    const kept = reduceCmsImportsToImports(rows, importsRows).map((r) => r.invoiceNo);
    // IN99999 (not on the sheet) is dropped; case-insensitive match keeps in00451013.
    expect(kept).toEqual(["IN00777", "IN00801", "in00451013"]);
  });

  it("returns nothing when there are no IMPORTS rows to match against", () => {
    expect(reduceCmsImportsToImports([cmsRow("IN00777")], null)).toEqual([]);
    expect(reduceCmsImportsToImports([cmsRow("IN00777")], [])).toEqual([]);
  });
});

describe("fetchCmsImports", () => {
  it("returns configured:false and does not touch the network when CMS_MCP_URL is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchCmsImports({});
    expect(result.configured).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.health.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scopes the query to the SELF/CU000731/WH000095 imports within the recent window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    let sentSql = "";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      sentSql = body.params.arguments.sql;
      return mcpResponse([
        { invc_no: "IN20260012", eta_dt: "2026-07-18", carrier: "MAERSK BOSTON 626E", invc_qtot: 1200, arrv_dt: "2026-07-29", iw_qtot: 1200 },
      ]);
    }));
    const result = await fetchCmsImports({ CMS_MCP_URL: "https://cms.example/mcp/" });
    expect(result.configured).toBe(true);
    expect(result.health.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actualArrival).toBe("2026-07-29");
    expect(sentSql).toContain("i.biz_type = 'SELF'");
    expect(sentSql).toContain("i.cust_cd = 'CU000731'");
    expect(sentSql).toContain("i.whouse_cd = 'WH000095'");
    expect(sentSql).toContain("LEFT JOIN CSMS.dbo.TB_PNFM");
    // 180 days before 2026-09-02 is 2026-03-06.
    expect(sentSql).toContain("i.invc_dt >= '2026-03-06'");
  });

  it("degrades to configured:true with empty rows when the query fails, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 })));
    const result = await fetchCmsImports({ CMS_MCP_URL: "https://cms.example/mcp/" });
    expect(result.configured).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.health.ok).toBe(false);
    expect(result.health.error).toBeTruthy();
  });
});
