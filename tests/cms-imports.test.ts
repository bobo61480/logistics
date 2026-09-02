import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCmsImports, mapCmsImportRows } from "../worker/cms-imports";

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

  it("leaves actualArrival/receivedQty empty when TB_PNFM columns are masked to null", () => {
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
    // TB_INVC columns survive; PNFM enrichment degrades to empty/0.
    expect(row.etaDate).toBe("2026-08-02");
    expect(row.invoicedQty).toBe(800);
    expect(row.actualArrival).toBe("");
    expect(row.receivedQty).toBe(0);
  });

  it("drops rows with no invoice number", () => {
    expect(mapCmsImportRows([{ invc_no: "  " }, { eta_dt: "2026-01-01" }])).toEqual([]);
  });

  it("coerces non-numeric quantities to 0", () => {
    const [row] = mapCmsImportRows([{ invc_no: "IN1", invc_qtot: "n/a", iw_qtot: undefined }]);
    expect(row.invoicedQty).toBe(0);
    expect(row.receivedQty).toBe(0);
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
