import { describe, expect, it, vi } from "vitest";
import { currentPacificMonth, verifyCmsGateway } from "../scripts/verify-cms-gateway.mjs";

const gatewayUrl = "https://gateway.example";
const month = "2026-09";
function mockGateway(sales: unknown, status = 200) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ok: true, unattendedAuthConfigured: false, bootstrapSessionConfigured: true }))
    .mockResolvedValueOnce(Response.json(sales, { status }));
}

describe("CMS gateway deployment verification", () => {
  it.each([401, 404, 500, 502, 503])("rejects HTTP %s even when health is reachable", async (status) => {
    await expect(verifyCmsGateway({ gatewayUrl, month, fetchImpl: mockGateway({ ok: false, error: "private upstream detail" }, status) }))
      .rejects.toThrow(`/sales-summary: HTTP ${status}`);
  });

  it("rejects failed and malformed success envelopes", async () => {
    for (const sales of [{ ok: false }, { ok: true, month }, { ok: true, month: "2026-08", rows: [] }]) {
      await expect(verifyCmsGateway({ gatewayUrl, month, fetchImpl: mockGateway(sales) })).rejects.toThrow();
    }
  });

  it("accepts real aggregates with bootstrap auth and returns safe metadata only", async () => {
    const fetchImpl = mockGateway({ ok: true, month, rows: [{ currency: "USD", invoiceCount: 3, totalSales: 125.5 }] });
    expect(await verifyCmsGateway({ gatewayUrl, month, fetchImpl })).toEqual({
      ok: true, month, aggregateCount: 1, invoiceCount: 3,
      unattendedAuthConfigured: false, bootstrapSessionConfigured: true,
    });
  });

  it("accepts a confirmed empty month but rejects invalid totals", async () => {
    await expect(verifyCmsGateway({ gatewayUrl, month, fetchImpl: mockGateway({ ok: true, month, rows: [] }) }))
      .resolves.toMatchObject({ invoiceCount: 0 });
    await expect(verifyCmsGateway({ gatewayUrl, month, fetchImpl: mockGateway({ ok: true, month, rows: [{ invoiceCount: 1, totalSales: "bad" }] }) }))
      .rejects.toThrow("invalid aggregate values");
  });

  it("selects the month in the operational timezone at a UTC month boundary", () => {
    expect(currentPacificMonth(new Date("2026-09-01T01:00:00Z"))).toBe("2026-08");
    expect(currentPacificMonth(new Date("2026-09-01T08:00:00Z"))).toBe("2026-09");
  });
});
