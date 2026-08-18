"use client";

interface DriveLink {
  label: string;
  url: string;
  hint?: string;
}

// Canonical destinations from GmailPipeline.gs (GMAIL_PIPELINE config):
// importShipmentsFolderId is where GmailPipelineV2 creates every inbound
// attachment folder; warehouseDocumentsFolderId backs the live IMPORTS
// document links.
const DEFAULT_LINKS: DriveLink[] = [
  {
    label: "Import shipment documents",
    url: "https://drive.google.com/drive/folders/1AhGI2qM2pGFXSb406OY6dsOaN8unlGDM",
    hint: "Canonical archive — Gmail ingestion files every inbound attachment here",
  },
  {
    label: "Warehouse documents",
    url: "https://drive.google.com/drive/folders/1YBWV9lXAasRt7JolWxk199dPkGbx60M9",
  },
  {
    label: "SK Logistics Email Archive",
    url: "https://drive.google.com/drive/search?q=SK%20Logistics%20Email%20Archive",
    hint: "Legacy archive folders — auto-filed by year / month / category",
  },
];

/** Static quick-links into the pipeline's configured Drive destinations. */
export function DriveArchiveCard({ links = DEFAULT_LINKS }: { links?: DriveLink[] }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white shadow-sm">
      <header className="border-b border-neutral-100 px-5 py-4">
        <h3 className="text-sm font-semibold text-neutral-900">Drive Archive</h3>
        <p className="text-xs text-neutral-500">Source documents and Gmail-archived attachments.</p>
      </header>
      <ul className="divide-y divide-neutral-100">
        {links.map((link) => (
          <li key={link.url}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 px-5 py-3 text-sm text-neutral-800 hover:bg-neutral-50"
            >
              <span>
                <span className="font-medium">{link.label}</span>
                {link.hint && <span className="block text-xs text-neutral-500">{link.hint}</span>}
              </span>
              <span aria-hidden className="text-neutral-400">
                ↗
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
