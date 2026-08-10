from pathlib import Path
import re

path = Path("app/page.tsx")
source = path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 exact match, found {count}")
    source = source.replace(old, new, 1)


def regex_once(pattern: str, replacement: str, label: str, flags: int = 0) -> None:
    global source
    source2, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 regex match, found {count}")
    source = source2


replace_once(
    "  eta?: string;\n  isSmallParcel?: boolean;",
    "  eta?: string;\n  deliveryExpected?: string;\n  isSmallParcel?: boolean;",
    "ScheduleItem.deliveryExpected",
)

replace_once(
    """    const hasShipmentIdentity = Boolean(record.shipmentNo);
    // A current import remains operational while invoice/MBL/HBL/container details are incomplete.
    // Requiring those fields hid newly scheduled rows that already had a shipment code and ETA/ETD.
    if (!hasShipmentIdentity || parcelCarrier(record.shipmentNo)) return [];""",
    """    const hasShipmentIdentity = Boolean(record.shipmentNo);
    const shipmentLabel = clean(record.shipmentNo).toUpperCase();
    const planningRow = /^(?:AS OF\\b|SCHEDULING\\b|SCHEDULED\\b|NEED SCHEDULING\\b|MONTH OF\\b|URGENT\\b|COMPLETED\\b|ESTIMATED\\b)/.test(shipmentLabel);
    // Current imports can have incomplete documents, but planning-grid labels can never
    // become shipment rows even when neighboring cells look like dates or identifiers.
    if (!hasShipmentIdentity || planningRow || parcelCarrier(record.shipmentNo)) return [];""",
    "planning-row hard reject",
)

replace_once(
    """      pod: /^OSL/i.test(record.shipmentNo) ? "LGB" : "LAX",
      eta,
      isSmallParcel: false,""",
    """      pod: /^OSL/i.test(record.shipmentNo) ? "LGB" : "LAX",
      eta,
      deliveryExpected: record.deliveryExpected,
      isSmallParcel: false,""",
    "Delivery Expected mapping",
)

inventory_anchor = """function scheduleMatchesInventoryShipment(item: ScheduleItem, selected: InventoryItem | null) {
  if (!selected) return false;
  const selectedCodes = inventoryShipmentCodes(selected);
  if (!selectedCodes.size) return false;
  return [item.shipmentNo, item.title]
    .flatMap((value) => inventoryShipmentReferences(value ?? ""))
    .map(normalizedShipmentCode)
    .some((value) => selectedCodes.has(value));
}"""
replace_once(
    inventory_anchor,
    inventory_anchor
    + """

function inventoryForActiveImports(item: InventoryItem, activeCodes: Set<string>) {
  const activeReferences = inventoryShipmentReferences(item.shipmentNo).filter((reference) =>
    activeCodes.has(normalizedShipmentCode(reference)),
  );
  if (!activeReferences.length) return null;
  return { ...item, shipmentNo: activeReferences.join(", ") };
}""",
    "active inventory projection helper",
)

replace_once(
    """      const allInboundInventory = uniqueInventoryItems([
        ...dashboardInventory.inbound,
        ...skwInboundItems(skwInboundTable),
      ], true);
      // Inbound Inventory is a detail view of the active Import Schedule, not receiving history.
      setInboundInventory(allInboundInventory.filter((inventoryItem) =>
        activeImportItems.some((scheduleItem) =>
          scheduleMatchesInventoryShipment(scheduleItem, inventoryItem),
        ),
      ));""",
    """      const activeImportCodes = new Set(
        activeImportItems
          .flatMap((item) => [item.shipmentNo, item.title])
          .flatMap((value) => inventoryShipmentReferences(value ?? ""))
          .map(normalizedShipmentCode)
          .filter(Boolean),
      );
      // Reduce each source row to active shipment references before deduplication. This prevents
      // received/history codes such as old HJ/ES rounds from surviving on a mixed allocation row.
      const currentInboundInventory = [
        ...dashboardInventory.inbound,
        ...skwInboundItems(skwInboundTable),
      ].flatMap((inventoryItem) => {
        const projected = inventoryForActiveImports(inventoryItem, activeImportCodes);
        return projected ? [projected] : [];
      });
      setInboundInventory(uniqueInventoryItems(currentInboundInventory, true));""",
    "active inbound inventory source projection",
)

replace_once(
    """  const inboundScheduleVisibleItems = useMemo(
    () => inboundVisibleItems.filter((item) => !item.isSmallParcel),
    [inboundVisibleItems],
  );""",
    """  const inboundScheduleVisibleItems = useMemo(() => {
    const first = days[0].getTime();
    const last = days[days.length - 1].getTime();
    const needle = query.trim().toLowerCase();
    return items.flatMap((item) => {
      if (item.direction !== "inbound" || item.isSmallParcel) return [];
      // Warehouse receiving appointments come from IMPORTS column Q (Delivery Expected).
      // Column O ETA stays authoritative only for the separate Import Schedule table.
      const scheduled = firstDatedValue(item.deliveryExpected ?? "");
      if (!scheduled) return [];
      const stamp = new Date(
        scheduled.date.getFullYear(),
        scheduled.date.getMonth(),
        scheduled.date.getDate(),
      ).getTime();
      if (stamp < first || stamp > last) return [];
      if (!includeFinished && finished.has(item.status.toLowerCase())) return [];
      if (needle && ![
        item.title,
        item.reference,
        item.invoice,
        item.shipmentNo,
        item.container,
        item.mbl,
        item.hbl,
        item.vessel,
        item.status,
      ].join(" ").toLowerCase().includes(needle)) return [];
      return [{ ...item, date: scheduled.date, dateText: scheduled.text }];
    });
  }, [days, includeFinished, items, query]);""",
    "warehouse inbound date semantics",
)

replace_once(
    '    const inbound = visibleItems.filter((item) => item.direction === "inbound").length;',
    '    const inbound = inboundScheduleVisibleItems.length + inboundParcelVisibleItems.length;',
    "inbound summary count",
)

path.write_text(source)
