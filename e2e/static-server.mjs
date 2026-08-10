// Minimal static file server for the Next.js `out/` export.
// Used as the Playwright webServer so e2e tests exercise the exact artifact
// that gets published to GitHub Pages (no dev-server behavior differences).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("../out", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    let pathname = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (pathname.endsWith("/")) pathname += "index.html";
    let filePath = join(ROOT, pathname);
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, "index.html");
    } catch {
      // Fall through to the .html fallback used by `output: "export"` routes.
      filePath = `${filePath}.html`;
    }
    const body = await readFile(filePath);
    response.writeHead(200, { "Content-Type": TYPES[extname(filePath)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`Serving out/ at http://localhost:${PORT}`);
});
