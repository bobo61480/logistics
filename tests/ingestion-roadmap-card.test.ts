import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const root = process.cwd();
const card = fs.readFileSync(path.join(root, "app", "ingestion-roadmap-card.tsx"), "utf8");
const page = fs.readFileSync(path.join(root, "app", "page.tsx"), "utf8");

test("shipping document ingestion is a live dashboard, not a roadmap placeholder", () => {
  expect(card).toMatch(/Shipping Document Ingestion/);
  expect(card).toMatch(/Emails processed/);
  expect(card).toMatch(/Documents filed/);
  expect(card).toMatch(/Needs review/);
  expect(card).not.toMatch(/Roadmap · Design Placeholder/);
  expect(card).not.toMatch(/Not built yet/);
  expect(card).not.toMatch(/Not connected/);
});

test("dashboard derives document state from the shared Gmail ingestion feed", () => {
  expect(card).toMatch(/GmailIngestionEvent/);
  expect(card).toMatch(/classifyDocument/);
  expect(card).toMatch(/driveFileUrl/);
  expect(card).not.toMatch(/\bfetch\s*\(/);
  expect(card).not.toMatch(/XMLHttpRequest|axios/);
  expect(page).toMatch(
    /<IngestionRoadmapCard events=\{gmailIngestion\} loading=\{loading\} sheetUrl=\{SHEET_URL\} \/>/
  );
});
