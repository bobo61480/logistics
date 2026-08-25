export function inboundScheduleDateSource(deliveryExpected: unknown, eta: unknown) {
  const delivery = String(deliveryExpected ?? "").trim();
  if (delivery) return delivery;
  return String(eta ?? "").trim();
}
