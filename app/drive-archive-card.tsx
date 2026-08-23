"use client";

interface DriveLink {
  label: string;
  url: string;
  hint?: string;
}

// Real Warehouse Documents drive folders. A few categories (Shipping
// Documents, Bill of Ladings, Invoices) don't have one single dedicated
// folder today, so those point to the nearest matching home — see
// GmailPipeline.gs (GMAIL_PIPELINE config) for the canonical ingestion
// targets: importShipmentsFolderId is where GmailPipelineV2 creates every
// inbound attachment folder; warehouseDocumentsFolderId backs the live
// IMPORTS document links.
const DEFAULT_LINKS: DriveLink[] = [
  {
    label: "Shipping Documents",
    url: "https://drive.google.com/drive/folders/1YBWV9lXAasRt7JolWxk199dPkGbx60M9",
  },
  {
    label: "Bill of Ladings",
    url: "https://drive.google.com/drive/folders/1m7L79x17oW-qFSq3pVrkWMcJwT-8AHzE",
  },
  {
    label: "Invoices",
    url: "https://drive.google.com/drive/folders/1AhGI2qM2pGFXSb406OY6dsOaN8unlGDM",
    hint: "Canonical archive — Gmail ingestion files every inbound attachment here",
  },
  {
    label: "POD",
    url: "https://drive.google.com/drive/folders/1CsF3FEpPB9_8ROblc2Uq6Y0EGw5fp8Q4",
  },
  {
    label: "Entry Summaries",
    url: "https://drive.google.com/drive/folders/1BcaMbPfCEPnb-Ig1rNq_pB7WWdauNE1J",
  },
  {
    label: "Supplies Purchase",
    url: "https://drive.google.com/drive/folders/1vUktkh6D6O3rNFKEv1kV54BKIfJSiXCV",
  },
  {
    label: "Inbound Shipments",
    url: "https://drive.google.com/drive/folders/1yLstLWGf-wx_qxw0rzthdMzlhKmAZ9gZ",
  },
  {
    label: "SK Logistics Email Archive",
    url: "https://drive.google.com/drive/search?q=SK%20Logistics%20Email%20Archive",
    hint: "Legacy archive folders — auto-filed by year / month / category",
  },
];

/**
 * Is this a Drive *folder* (or a folder search) versus a single file? Only
 * genuine folders get a colored folder glyph — a plain document or
 * spreadsheet link stays a plain file glyph so the icon never overstates
 * what the link actually opens.
 */
export function isDriveFolderLink(url: string): boolean {
  return /\/drive\/folders\//.test(url) || /\/drive\/search\?/.test(url);
}

// Keyword → color/emoji so a folder's icon actually reflects its title,
// rather than every folder getting the same generic glyph.
const FOLDER_ICON_RULES: Array<{ pattern: RegExp; emoji: string; className: string }> = [
  { pattern: /import|shipment|inbound/i, emoji: "📦", className: "bg-blue-100 text-blue-700" },
  { pattern: /warehouse|stock|inventory/i, emoji: "🏭", className: "bg-amber-100 text-amber-700" },
  { pattern: /archive|email/i, emoji: "🗄️", className: "bg-violet-100 text-violet-700" },
  { pattern: /invoice|packing|billing/i, emoji: "🧾", className: "bg-emerald-100 text-emerald-700" },
  { pattern: /outbound|trucking|fulfillment/i, emoji: "🚚", className: "bg-orange-100 text-orange-700" },
];
const DEFAULT_FOLDER_ICON = { emoji: "📁", className: "bg-neutral-100 text-neutral-700" };

/** Plain emoji glyph only (no chip/background) — for compact inline table links. */
export function driveLinkGlyph(label: string, url: string): string {
  if (!isDriveFolderLink(url)) return "📄";
  return (FOLDER_ICON_RULES.find((r) => r.pattern.test(label)) ?? DEFAULT_FOLDER_ICON).emoji;
}

/** Colorful folder glyph for folders, plain file glyph for everything else. */
export function DriveLinkIcon({ label, url }: { label: string; url: string }) {
  if (!isDriveFolderLink(url)) {
    return (
      <span aria-hidden className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-sm text-neutral-500">
        📄
      </span>
    );
  }
  const rule = FOLDER_ICON_RULES.find((r) => r.pattern.test(label)) ?? DEFAULT_FOLDER_ICON;
  return (
    <span aria-hidden className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm ${rule.className}`}>
      {rule.emoji}
    </span>
  );
}

/** Static quick-links into the pipeline's configured Drive destinations. */
export function DriveArchiveCard({ links = DEFAULT_LINKS }: { links?: DriveLink[] }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <header className="border-b border-neutral-100 px-5 py-4">
        <h3 className="text-lg font-extrabold text-neutral-900">Document Folders</h3>
        <p className="text-xs text-neutral-500">Warehouse Documents drive — source documents and Gmail-archived attachments.</p>
      </header>
      <ul className="divide-y divide-neutral-100">
        {links.map((link) => (
          <li key={link.url}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 px-5 py-3 text-sm text-neutral-800 hover:bg-neutral-50"
            >
              <DriveLinkIcon label={link.label} url={link.url} />
              <span className="flex flex-1 items-center justify-between gap-3">
                <span>
                  <span className="font-medium">{link.label}</span>
                  {link.hint && <span className="block text-xs text-neutral-500">{link.hint}</span>}
                </span>
                <span aria-hidden className="text-neutral-400">
                  ↗
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
