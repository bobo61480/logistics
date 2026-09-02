import { describe, expect, it } from "vitest";
import { airlineNameFromFlight } from "../lib/domain/airlines";

describe("airline display names", () => {
  it.each([
    ["OZ-204", "Asiana Airlines"],
    ["KE-213", "Korean Air"],
    ["YP-101", "Air Premia"],
    ["7C 1106", "Jeju Air"],
  ])("maps %s to %s", (flight, airline) => {
    expect(airlineNameFromFlight(flight)).toBe(airline);
  });

  it("does not relabel non-flight carrier text", () => {
    expect(airlineNameFromFlight("CARGOMATIC")).toBe("");
  });
});
