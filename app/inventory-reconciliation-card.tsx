import type { InventoryItem } from "./page";

export type CmsInventoryItem = {
  productName: string;
  sku: string;
  upc: string;
  expirationDate: string;
  quantity: number;
};

export type InventoryDifference = CmsInventoryItem & {
  warehouseQuantity: number;
  cmsQuantity: number;
  difference: number;
  potentialCause: string;
};

function key(item: Pick<CmsInventoryItem, "sku" | "upc" | "expirationDate">) {
  const identifier = String(item.sku || item.upc).trim().toUpperCase();
  const expiry = String(item.expirationDate || "NO-EXPIRY").trim().toUpperCase();
  return `${identifier}|${expiry}`;
}

export function reconcileInventory(warehouse: InventoryItem[], cms: CmsInventoryItem[]) {
  const combined = new Map<string, InventoryDifference>();
  const add = (item: CmsInventoryItem, source: "warehouse" | "cms") => {
    if (!item.sku && !item.upc) return;
    const itemKey = key(item);
    const current = combined.get(itemKey) ?? {
      productName: item.productName,
      sku: item.sku,
      upc: item.upc,
      expirationDate: item.expirationDate,
      quantity: 0,
      warehouseQuantity: 0,
      cmsQuantity: 0,
      difference: 0,
      potentialCause: "",
    };
    if (!current.productName) current.productName = item.productName;
    if (!current.sku) current.sku = item.sku;
    if (!current.upc) current.upc = item.upc;
    if (!current.expirationDate) current.expirationDate = item.expirationDate;
    if (source === "warehouse") current.warehouseQuantity += Number(item.quantity) || 0;
    else current.cmsQuantity += Number(item.quantity) || 0;
    combined.set(itemKey, current);
  };
  warehouse.forEach((item) => add(item, "warehouse"));
  cms.forEach((item) => add(item, "cms"));
  return [...combined.values()].map((item) => {
    const difference = item.warehouseQuantity - item.cmsQuantity;
    let potentialCause = "Matched";
    if (!item.cmsQuantity && item.warehouseQuantity) potentialCause = "SKU/lot is missing or not mapped in CMS";
    else if (!item.warehouseQuantity && item.cmsQuantity) potentialCause = "CMS stock is absent from the warehouse snapshot";
    else if (difference > 0) potentialCause = "Receiving or putaway may not yet be posted to CMS";
    else if (difference < 0) potentialCause = "Shipment, allocation, or WMS deduction may be delayed";
    return { ...item, difference, potentialCause };
  }).filter((item) => item.difference !== 0)
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

export function InventoryReconciliationCard({ warehouse, cms, configured }: {
  warehouse: InventoryItem[];
  cms: CmsInventoryItem[];
  configured: boolean;
}) {
  const differences = reconcileInventory(warehouse, cms);
  return (
    <section className="inventory-reconciliation" aria-label="Warehouse and Siliconii inventory differences">
      <div className="inventory-reconciliation-heading">
        <div>
          <p className="eyebrow">Inventory reconciliation</p>
          <h2>Warehouse vs Siliconii CMS</h2>
        </div>
        <strong>{differences.length} differences</strong>
      </div>
      {!configured ? <p className="inventory-reconciliation-empty">Siliconii CMS is not configured for this deployment.</p>
        : cms.length === 0 ? <p className="inventory-reconciliation-empty">CMS inventory is temporarily unavailable. The last warehouse stock remains visible below.</p>
        : differences.length === 0 ? <p className="inventory-reconciliation-empty">No quantity differences were found.</p>
        : <div className="inventory-reconciliation-table-wrap"><table className="inventory-reconciliation-table">
          <thead><tr><th>Product</th><th>SKU / UPC</th><th>Expiration</th><th>Warehouse</th><th>CMS</th><th>Difference</th><th>Potential cause</th></tr></thead>
          <tbody>{differences.slice(0, 100).map((item) => <tr key={key(item)}>
            <td>{item.productName || "Unidentified product"}</td>
            <td><b>{item.sku || "—"}</b><small>{item.upc || "No UPC"}</small></td>
            <td>{item.expirationDate || "Not recorded"}</td>
            <td>{item.warehouseQuantity.toLocaleString()}</td><td>{item.cmsQuantity.toLocaleString()}</td>
            <td className={item.difference > 0 ? "difference-positive" : "difference-negative"}>{item.difference > 0 ? "+" : ""}{item.difference.toLocaleString()}</td>
            <td>{item.potentialCause}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  );
}
