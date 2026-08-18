"use client";

interface DriveLink {
  label: string;
  url: string;
  hint?: string;
}

const DEFAULT_LINKS: DriveLink[] = [
  {
    label: "SK Logistics Email Archive",
    url: "https://drive.google.com/drive/search?q=SK%20Logistics%20Email%20Archive",
    hint: "Root archive — auto-filed by year / month / category from Gmail ingestion",
  },
  {
    label: "Shipping Documents",
    url: "https://drive.google.com/drive/folders/15xPjToE2pAybzng1tohQYeBNct-D2I4h",
  },
  {
    label: "Shipping Documents (alt.)",
    url: "https://drive.google.com/drive/folders/1mB9cnkxZQw_hS-GL47-3ynyOp73NwZdj",
  },
  {
    label: "Inbound folder",
    url: "https://drive.google.com/drive/folders/1kCyvRL86_WVimP8sek4IhKgvCcqk00U1",
  },
];

/**
 * Static quick-links into Drive. Swap DEFAULT_LINKS for whatever the
 * swkbp.dpdns.org version pointed at if these aren't the exact right folders —
 * this is a best-effort reconstruction from what's currently in Drive, not a
 * verified 1:1 copy of the old card.
 */
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
