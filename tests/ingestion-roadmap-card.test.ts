import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = process.cwd();
const card = fs.readFileSync(path.join(root, "app", "ingestion-roadmap-card.tsx"), "utf8");
const page = fs.readFileSync(path.join(root, "app", "page.tsx"), "utf8");

test("shipping document ingestion is a live dashboard, not a roadmap placeholder", () => {
  assert.match(card, /Shipping Document Ingestion/);
  assert.match(card, /Emails processed/);
  assert.match(card, /Documents filed/);
  assert.match(card, /Needs review/);
  assert.doesNotMatch(card, /Roadmap · Design Placeholder/);
  assert.doesNotMatch(card, /Not built yet/);
  assert.doesNotMatch(card, /Not connected/);
});

test("dashboard derives document state from the shared Gmail ingestion feed", () => {
  assert.match(card, /GmailIngestionEvent/);
  assert.match(card, /classifyDocument/);
  assert.match(card, /driveFileUrl/);
  assert.doesNotMatch(card, /\bfetch\s*\(/);
  assert.doesNotMatch(card, /XMLHttpRequest|axios/);
  assert.match(
    page,
    /<IngestionRoadmapCard events=\{gmailIngestion\} loading=\{loading\} sheetUrl=\{SHEET_URL\} \/>/
  );
});
