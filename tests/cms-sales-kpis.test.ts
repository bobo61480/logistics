import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { fetchCmsSalesKpis } from "../worker/cms-sales-kpis";

function gatewayResponse(month: string, totalSales: number, currency = "2", invoiceCount = 1) {
  return new Response(JSON.stringify({
    ok: true,
    month,
    rows: totalSales === 0 ? [] : [{ currency, invoiceCount, totalSales, averageInvoiceValue: totalSales / invoiceCount }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockGateway(monthTotals: Record<string, number>, currency = "2") {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const month = url.searchParams.get("month") ?? "";
    return gatewayResponse(month, monthTotals[month] ?? 0, currency);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CMS sales KPI aggregation", () => {
  it("uses current-month CMS invoices for MTD and January-through-current-month invoices for YTD", async () => {
    const fetchImpl = mockGateway({
      "2026-01": 100,
      "2026-02": 200,
      "2026-03": 300,
      "2026-04": 400,
      "2026-05": 500,
      "2026-06": 600,
      "2026-07": 700,
      "2026-08": 800,
      "2026-09": 90,
    });

    const result = await fetchCmsSalesKpis(
      { CMS_GATEWAY_URL: "https://gateway.example" },
      new Date("2026-09-01T12:00:00Z"),
      fetchImpl,
    );

    expect(result.currency).toBe("2");
    expect(result.wmsSalesMtd).toBe(90);
    expect(result.wmsSalesYtd).toBe(3690);
    expect(result.months).toHaveLength(9);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("month"))).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
  });

  it("allows zero-sales months without inventing a currency bucket", async () => {
    const fetchImpl = mockGateway({ "2026-08": 800 });
    const result = await fetchCmsSalesKpis(
      { CMS_GATEWAY_URL: "https://gateway.example" },
      new Date("2026-09-01T12:00:00Z"),
      fetchImpl,
    );

    expect(result.currency).toBe("2");
    expect(result.wmsSalesMtd).toBe(0);
    expect(result.wmsSalesYtd).toBe(800);
  });

  it("refuses to collapse multiple CMS currencies into one KPI total", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const month = new URL(String(input)).searchParams.get("month") ?? "";
      if (month === "2026-08") {
        return new Response(JSON.stringify({
          ok: true,
          month,
          rows: [
            { currency: "2", invoiceCount: 1, totalSales: 100 },
            { currency: "3", invoiceCount: 1, totalSales: 200 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return gatewayResponse(month, 0);
    });

    await expect(fetchCmsSalesKpis(
      { CMS_GATEWAY_URL: "https://gateway.example" },
      new Date("2026-09-01T12:00:00Z"),
      fetchImpl,
    )).rejects.toThrow("CMS_SALES_MULTIPLE_CURRENCIES");
  });

  it("exposes the CMS-backed values through the same-origin diagnostic route", async () => {
    const fetchImpl = mockGateway({
      "2026-01": 100,
      "2026-02": 200,
      "2026-03": 300,
      "2026-04": 400,
      "2026-05": 500,
      "2026-06": 600,
      "2026-07": 700,
      "2026-08": 800,
      "2026-09": 90,
    });
    vi.stubGlobal("fetch", fetchImpl);

    const response = await worker.fetch(
      new Request("https://stylekorean.example/api/logistics/cms-sales-kpis"),
      {
        CMS_GATEWAY_URL: "https://gateway.example",
      } as unknown as Env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      source: "siliconii-cms-invoices",
      currency: "2",
      wmsSalesMtd: 90,
      wmsSalesYtd: 3690,
    });
  });
});
