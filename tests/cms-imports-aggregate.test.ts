import { describe, expect, it } from "vitest";
import { aggregateCmsImports, cmsQtyLabel, resolveImportCmsLookups } from "../app/page";
import type { CmsImportRow } from "../worker/cms-imports";

function row(partial: Partial<CmsImportRow>): CmsImportRow {
  return {
    invoiceNo: partial.invoiceNo ?? "IN1",
    etaDate: partial.etaDate ?? "",
    actualArrival: partial.actualArrival ?? "",
    outboundDate: partial.outboundDate ?? "",
    carrier: partial.carrier ?? "",
    invoicedQty: partial.invoicedQty ?? null,
    receivedQty: partial.receivedQty ?? null,
  };
}

describe("aggregateCmsImports", () => {
  it("returns null for no matches", () => {
    expect(aggregateCmsImports([])).toBeNull();
  });

  it("passes a single match through, preserving a real zero received", () => {
    const agg = aggregateCmsImports([row({ actualArrival: "2026-08-30", invoicedQty: 500, receivedQty: 0 })]);
    expect(agg).toEqual({ actualArrival: "2026-08-30", invoicedQty: 500, receivedQty: 0, partial: false });
  });

  it("keeps quantities null (not 0) when every match masks them", () => {
    const agg = aggregateCmsImports([row({ invoicedQty: null, receivedQty: null })]);
    expect(agg?.receivedQty).toBeNull();
    expect(agg?.invoicedQty).toBeNull();
    expect(agg?.partial).toBe(false);
  });

  it("sums quantities and takes the latest arrival across multiple invoices", () => {
    const agg = aggregateCmsImports([
      row({ actualArrival: "2026-08-28", invoicedQty: 500, receivedQty: 500 }),
      row({ actualArrival: "2026-09-01", invoicedQty: 300, receivedQty: 300 }),
    ]);
    expect(agg).toEqual({ actualArrival: "2026-09-01", invoicedQty: 800, receivedQty: 800, partial: false });
  });

  it("flags a partial total when some matched invoices lack a quantity", () => {
    const agg = aggregateCmsImports([
      row({ invoicedQty: 200, receivedQty: 100 }),
      row({ invoicedQty: null, receivedQty: null }),
    ]);
    // The known parts are summed but the total is incomplete → partial.
    expect(agg?.receivedQty).toBe(100);
    expect(agg?.invoicedQty).toBe(200);
    expect(agg?.partial).toBe(true);
  });

  it("flags partial when an invoice on the row has no CMS row at all", () => {
    // Two invoices listed, one has no CMS match (undefined slot) → the summed
    // total covers only part of the shipment.
    const agg = aggregateCmsImports([row({ invoicedQty: 200, receivedQty: 100 }), undefined]);
    expect(agg?.receivedQty).toBe(100);
    expect(agg?.invoicedQty).toBe(200);
    expect(agg?.partial).toBe(true);
  });

  it("is not partial when every listed invoice matched with complete quantities", () => {
    const agg = aggregateCmsImports([
      row({ actualArrival: "2026-08-30", invoicedQty: 200, receivedQty: 200 }),
      row({ actualArrival: "2026-09-01", invoicedQty: 300, receivedQty: 300 }),
    ]);
    expect(agg?.partial).toBe(false);
  });

  it("flags partial when an arrival date is known for only some matched invoices", () => {
    // Both invoices matched with complete quantities, but one has no arrival
    // date — the aggregate must not present the known date as the whole
    // shipment's arrival.
    const agg = aggregateCmsImports([
      row({ actualArrival: "2026-08-30", invoicedQty: 200, receivedQty: 200 }),
      row({ actualArrival: "", invoicedQty: 300, receivedQty: 300 }),
    ]);
    expect(agg?.actualArrival).toBe("2026-08-30");
    expect(agg?.partial).toBe(true);
  });

  it("is not partial when no arrival date is known at all", () => {
    // Nothing to qualify — an absent arrival is simply not rendered, so a
    // uniformly-missing arrival is not a partial state on its own.
    const agg = aggregateCmsImports([
      row({ actualArrival: "", invoicedQty: 200, receivedQty: 200 }),
      row({ actualArrival: "", invoicedQty: 300, receivedQty: 300 }),
    ]);
    expect(agg?.actualArrival).toBe("");
    expect(agg?.partial).toBe(false);
  });
});

describe("resolveImportCmsLookups", () => {
  const in001 = row({ invoiceNo: "IN001", invoicedQty: 200, receivedQty: 100 });
  const byInvoice = new Map<string, CmsImportRow>([["IN001", in001]]);

  it("resolves a repeated invoice cell value to a single lookup (no double-count)", () => {
    const lookups = resolveImportCmsLookups("IN001, IN001", byInvoice);
    expect(lookups).toEqual([in001]);
    // Aggregating the deduped lookups must not sum the same record twice.
    const agg = aggregateCmsImports(lookups);
    expect(agg).toEqual({ actualArrival: "", invoicedQty: 200, receivedQty: 100, partial: false });
  });

  it("dedupes case- and whitespace-variant duplicates of the same invoice", () => {
    const lookups = resolveImportCmsLookups("in001\n IN001 ", byInvoice);
    expect(lookups).toEqual([in001]);
    expect(aggregateCmsImports(lookups)?.invoicedQty).toBe(200);
  });

  it("keeps a distinct unmatched invoice as its own miss slot (still flags partial)", () => {
    const lookups = resolveImportCmsLookups("IN001, IN999", byInvoice);
    expect(lookups).toEqual([in001, undefined]);
    expect(aggregateCmsImports(lookups)?.partial).toBe(true);
  });
});

describe("cmsQtyLabel", () => {
  it("shows received over invoiced when both are known", () => {
    expect(cmsQtyLabel(100, 200)).toBe("Received 100/200");
  });

  it("shows received alone when invoiced is absent", () => {
    expect(cmsQtyLabel(100, undefined)).toBe("Received 100");
  });

  it("shows a real zero received (not hidden as absent)", () => {
    expect(cmsQtyLabel(0, 200)).toBe("Received 0/200");
  });

  it("falls back to invoiced-only when TB_PNFM received is masked away", () => {
    // The documented TB_INVC-only degradation: received unavailable, invoiced
    // from the invoice header still surfaces.
    expect(cmsQtyLabel(undefined, 800)).toBe("Invoiced 800");
  });

  it("is null when neither quantity is available", () => {
    expect(cmsQtyLabel(undefined, undefined)).toBeNull();
  });
});
