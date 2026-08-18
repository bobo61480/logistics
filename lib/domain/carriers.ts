export type CarrierResolution = {
  sourceCarrier: string;
  detectedCarrier: string;
  effectiveCarrier: string;
  confidence: "strong" | "source" | "unknown";
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedTracking(value: unknown) {
  return clean(value)
    .replace(/^(TRACKING|TRACK|PRO)\s*#?\s*/i, "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

export function detectStrongCarrier(value: unknown) {
  const tracking = normalizedTracking(value);
  if (!tracking) return "";
  if (/^1Z[A-Z0-9]{16}$/.test(tracking)) return "UPS";
  if (/^TBA[A-Z0-9]{8,}$/.test(tracking)) return "AMAZON";
  if (/^(?:JJD|JD)[A-Z0-9]{8,}$/.test(tracking)) return "DHL";
  if (/^(?:92|93|94|95)\d{18,22}$/.test(tracking)) return "USPS";
  if (/^[A-Z]{2}\d{9}US$/.test(tracking)) return "USPS";
  return "";
}

export function resolveCarrier(sourceCarrier: unknown, tracking: unknown): CarrierResolution {
  const source = clean(sourceCarrier);
  const detectedCarrier = detectStrongCarrier(tracking);
  if (detectedCarrier) {
    return {
      sourceCarrier: source,
      detectedCarrier,
      effectiveCarrier: detectedCarrier,
      confidence: "strong",
    };
  }
  if (source) {
    return {
      sourceCarrier: source,
      detectedCarrier: "",
      effectiveCarrier: source,
      confidence: "source",
    };
  }
  return {
    sourceCarrier: "",
    detectedCarrier: "",
    effectiveCarrier: "",
    confidence: "unknown",
  };
}

export function trackingCandidate(...values: unknown[]) {
  const candidates = values
    .flatMap((value) => clean(value).split(/\r?\n|,\s*/))
    .map(normalizedTracking)
    .filter(Boolean);
  const strong = candidates.find((value) => Boolean(detectStrongCarrier(value)));
  if (strong) return strong;
  return candidates.find((value) => /^\d{10,30}$/.test(value)) ?? "";
}
