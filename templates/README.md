# Dashboard templates

Standalone, self-contained HTML dashboard mockups for the logistics operation.
Each file is a single HTML document with inline CSS/JS and no build step — open
it directly in a browser, or use it as a starting point for a real, data-wired
panel in the Next.js app.

These are **reference templates only**. They are not part of the Next.js static
export (`output: "export"` builds `app/` routes and `public/` into `out/`), so
nothing here is served on the production site.

| File | What it is | Data |
|------|-----------|------|
| `skdistribution.html` | Inbound & outbound operations board (KPI strip + filterable schedule table). | Fetches Google Sheets client-side at runtime; shows placeholders until data loads. |
| `stylekorean-hq.html` | HQ control dashboard — KPI strip, Inbox / Inbound / Inventory panels. | Inbound & inventory panels use baked-in snapshot data; the Inbox panel wires a live Gmail connector via the Claude artifact MCP runtime. |

## ⚠️ Sensitive content

`stylekorean-hq.html` is committed **as-is** and its baked-in snapshot includes
confidential business figures (revenue, inventory) and personal mailbox content
(inbox subjects/snippets and a third-party contact). Treat it as internal-only.
A redacted variant (personal inbox content removed) was produced separately for
sharing — regenerate that rather than distributing this file.

## Notes

- Both were exported from Claude artifacts. `stylekorean-hq.html`'s Inbox panel
  calls `claude.use('mcp')`, which only resolves inside the Claude artifact
  runtime with the Gmail connector enabled; opened as a plain file it falls back
  to its static/empty state.
- The original upload set also included a `Hybrid_Control_Tower.html`, which was
  only the Claude artifact **frame-shell loader** (no dashboard markup of its
  own), so it is intentionally not included here.
