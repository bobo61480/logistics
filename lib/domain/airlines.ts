const AIRLINE_BY_IATA: Record<string, string> = {
  "7C": "Jeju Air",
  AA: "American Airlines",
  AC: "Air Canada",
  BR: "EVA Air",
  BX: "Air Busan",
  CI: "China Airlines",
  CX: "Cathay Pacific",
  DL: "Delta Air Lines",
  EK: "Emirates",
  JL: "Japan Airlines",
  KE: "Korean Air",
  LJ: "Jin Air",
  NH: "All Nippon Airways",
  OZ: "Asiana Airlines",
  PR: "Philippine Airlines",
  QR: "Qatar Airways",
  RS: "Air Seoul",
  SQ: "Singapore Airlines",
  SV: "Saudia",
  TG: "Thai Airways",
  TK: "Turkish Airlines",
  TW: "T'way Air",
  UA: "United Airlines",
  YP: "Air Premia",
};

/** Resolve an IATA-prefixed flight number such as OZ-204 to its airline. */
export function airlineNameFromFlight(value: string) {
  const flight = String(value ?? "").trim().toUpperCase();
  const match = flight.match(/^([A-Z0-9]{2})\s*[- ]?\s*\d{1,4}[A-Z]?\b/);
  return match ? AIRLINE_BY_IATA[match[1]] ?? "" : "";
}
