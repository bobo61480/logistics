import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  amount,
  dateCode,
  distanceBand,
  freightAmount,
  freightDateCode,
  isNewJerseyDestination,
  loadType,
  pacificDateParts,
  parseCsv,
} from "../lib/sales-kpis";

// 2026-08-08 12:00 in Los Angeles (19:00 UTC). Everything date-sensitive in
// these tests is derived from this frozen clock so results never drift.
const FROZEN_NOW = Date.UTC(2026, 7, 8, 19, 0, 0);
const TODAY = { year: 2026, month: 8, day: 8, code: 2026_08_08 };

describe("parseCsv", () => {
  it("parses plain rows and columns", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('name,"Buena Park, CA"\n')).toEqual([["name", "Buena Park, CA"]]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', "x"]]);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([["line1\nline2", "x"]]);
  });

  it("strips carriage returns from CRLF line endings", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not emit a phantom row for a trailing newline", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  it("emits empty cells for consecutive commas", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  it("returns no rows for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("dateCode", () => {
  it("encodes M/D/YYYY as YYYYMMDD", () => {
    expect(dateCode("8/8/2026")).toBe(2026_08_08);
    expect(dateCode("12/31/2025")).toBe(2025_12_31);
  });

  it("expands two-digit years into the 2000s", () => {
    expect(dateCode("1/2/26")).toBe(2026_01_02);
  });

  it("tolerates surrounding whitespace", () => {
    expect(dateCode("  3/4/2026  ")).toBe(2026_03_04);
  });

  it("returns 0 for month/day-only, ISO, and garbage values", () => {
    expect(dateCode("8/8")).toBe(0);
    expect(dateCode("2026-08-08")).toBe(0);
    expect(dateCode("TBD")).toBe(0);
    expect(dateCode("")).toBe(0);
  });
});

describe("freightDateCode", () => {
  it("uses the full date when a year is present", () => {
    expect(freightDateCode("3/2/2025", TODAY)).toBe(2025_03_02);
  });

  it("assigns the current year to M/D dates that have already occurred", () => {
    expect(freightDateCode("7/15", TODAY)).toBe(2026_07_15);
  });

  it("treats today itself as already occurred", () => {
    expect(freightDateCode("8/8", TODAY)).toBe(2026_08_08);
  });

  it("rolls M/D dates that have not occurred yet into next year", () => {
    expect(freightDateCode("8/9", TODAY)).toBe(2027_08_09);
    expect(freightDateCode("12/25", TODAY)).toBe(2027_12_25);
  });

  it("returns 0 for values that are not dates", () => {
    expect(freightDateCode("pending", TODAY)).toBe(0);
    expect(freightDateCode("", TODAY)).toBe(0);
  });
});

describe("amount", () => {
  it("parses plain numbers with currency noise", () => {
    expect(amount("$1,200", true)).toBe(1200);
    expect(amount(" 1,234.56 ", false)).toBe(1234.56);
  });

  it("expands K/M/B suffixes when allowed", () => {
    expect(amount("2K", true)).toBe(2_000);
    expect(amount("1.5m", true)).toBe(1_500_000);
    expect(amount("1B", true)).toBe(1_000_000_000);
  });

  it("rejects suffixed values when suffixes are not allowed", () => {
    expect(amount("2K", false)).toBeNull();
  });

  it("keeps negative values", () => {
    expect(amount("-500", true)).toBe(-500);
  });

  it("returns null for non-numeric text", () => {
    expect(amount("FREE SAMPLE", false)).toBeNull();
    expect(amount("N/A", true)).toBeNull();
    expect(amount("", true)).toBeNull();
  });
});

describe("freightAmount", () => {
  it("parses dollar amounts", () => {
    expect(freightAmount("$1,200")).toBe(1200);
  });

  it("strips a USD suffix", () => {
    expect(freightAmount("1200 USD")).toBe(1200);
  });

  it("strips parentheses (accounting negatives parse as positive — documented behavior)", () => {
    expect(freightAmount("(1,200)")).toBe(1200);
  });

  it("rejects any value containing letters, including K suffixes", () => {
    expect(freightAmount("N/A")).toBe(0);
    expect(freightAmount("2K")).toBe(0);
    expect(freightAmount("see invoice")).toBe(0);
  });

  it("rejects zero, negatives, and amounts over the $250k sanity cap", () => {
    expect(freightAmount("0")).toBe(0);
    expect(freightAmount("-50")).toBe(0);
    expect(freightAmount("250,000")).toBe(250_000);
    expect(freightAmount("250,001")).toBe(0);
  });
});

describe("loadType", () => {
  it("detects FTL keywords", () => {
    expect(loadType("FTL")).toBe("FTL");
    expect(loadType("Full Truckload")).toBe("FTL");
    expect(loadType("53' TRUCKLOAD")).toBe("FTL");
  });

  it("classifies 10+ pallets as FTL and fewer as LTL", () => {
    expect(loadType("12 PLTS")).toBe("FTL");
    expect(loadType("10 pallets")).toBe("FTL");
    expect(loadType("9 PLTS")).toBe("LTL");
    expect(loadType("3")).toBe("LTL");
  });

  it("defaults to LTL when nothing matches", () => {
    expect(loadType("")).toBe("LTL");
    expect(loadType("LTL")).toBe("LTL");
  });
});

describe("isNewJerseyDestination", () => {
  it("matches the NJ abbreviation and the full state name", () => {
    expect(isNewJerseyDestination("Edison, NJ")).toBe(true);
    expect(isNewJerseyDestination("TRENTON NJ 08601")).toBe(true);
    expect(isNewJerseyDestination("new jersey")).toBe(true);
  });

  it("does not match other destinations or embedded letters", () => {
    expect(isNewJerseyDestination("Newark")).toBe(false);
    expect(isNewJerseyDestination("BENJAMIN ST")).toBe(false);
    expect(isNewJerseyDestination("")).toBe(false);
  });
});

describe("distanceBand", () => {
  it("classifies known local cities and ZIP codes as local", () => {
    expect(distanceBand("Buena Park, CA")).toBe("local");
    expect(distanceBand("LOS ANGELES")).toBe("local");
    expect(distanceBand("90620")).toBe("local");
    expect(distanceBand("92316")).toBe("local");
  });

  it("classifies the rest of California as california", () => {
    expect(distanceBand("Sacramento, CA")).toBe("california");
    expect(distanceBand("CALIFORNIA")).toBe("california");
  });

  it("classifies other states as out-of-state", () => {
    expect(distanceBand("Edison, NJ")).toBe("out-of-state");
    expect(distanceBand("New Jersey")).toBe("out-of-state");
    expect(distanceBand("Dallas, TX 75201")).toBe("out-of-state");
  });

  it("returns unknown when nothing matches", () => {
    expect(distanceBand("")).toBe("unknown");
    expect(distanceBand("Somewhere")).toBe("unknown");
  });
});

describe("pacificDateParts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the calendar date in America/Los_Angeles, not UTC", () => {
    // 2026-08-09 02:00 UTC is still 2026-08-08 in Los Angeles (UTC-7).
    vi.setSystemTime(Date.UTC(2026, 7, 9, 2, 0, 0));
    expect(pacificDateParts()).toEqual({ year: 2026, month: 8, day: 8, code: 2026_08_08 });
  });
});
