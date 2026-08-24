type PartRow = { dataset_name: string; record_count: number; part_count: number; payload_bytes: number; source_hash: string; part_index: number; payload_text: string; part_bytes: number };
type OverrideRow = { dataset_name: string; record_key: string; value_json: string; previous_json: string | null; actor: string; correlation_id: string; created_at: string };
type IngestionRow = { id: string; provider: string; message_id: string; received_at: string; sender_domain: string; subject: string; matched_identifiers: string; matched_dataset: string; matched_record_key: string; action: string; created_at: string };

export async function readWarehouseSnapshot(db: D1Database) {
  const metadata = await db.prepare(`SELECT snapshot.id, snapshot.source_generated_at, snapshot.imported_at, snapshot.source_version, snapshot.dataset_count, snapshot.payload_bytes FROM warehouse_state state JOIN warehouse_snapshots snapshot ON snapshot.id = state.snapshot_id WHERE state.key = 'current_snapshot'`).first<{ id: string; source_generated_at: string; imported_at: string; source_version: string; dataset_count: number; payload_bytes: number }>();
  if (!metadata) return null;
  const [result, overrideResult, ingestionResult] = await Promise.all([
    db.prepare(`SELECT dataset.dataset_name, dataset.record_count, dataset.part_count, dataset.payload_bytes, dataset.source_hash, part.part_index, part.payload_text, part.payload_bytes AS part_bytes FROM warehouse_datasets dataset JOIN warehouse_dataset_parts part ON part.snapshot_id = dataset.snapshot_id AND part.dataset_name = dataset.dataset_name WHERE dataset.snapshot_id = ? ORDER BY dataset.dataset_name, part.part_index`).bind(metadata.id).all<PartRow>(),
    db.prepare(`SELECT dataset_name, record_key, value_json, previous_json, actor, correlation_id, created_at FROM warehouse_overrides WHERE field_name = 'status' ORDER BY created_at DESC`).all<OverrideRow>(),
    db.prepare(`SELECT id,provider,message_id,received_at,sender_domain,subject,matched_identifiers,matched_dataset,matched_record_key,action,created_at FROM warehouse_ingestion_events ORDER BY created_at DESC LIMIT 50`).all<IngestionRow>().catch(() => ({ results: [] as IngestionRow[] }))
  ]);
  const grouped = new Map<string, PartRow[]>();
  for (const row of result.results) grouped.set(row.dataset_name, [...(grouped.get(row.dataset_name) ?? []), row]);
  if (grouped.size !== metadata.dataset_count) throw new Error("Warehouse snapshot dataset count mismatch");
  const sources: Record<string, unknown> = {}; const datasets: Array<Record<string, unknown>> = [];
  for (const [name, parts] of grouped) {
    const first = parts[0]; if (parts.length !== first.part_count) throw new Error(`Dataset ${name} is incomplete`);
    const text = parts.map((part, index) => { if (part.part_index !== index || new TextEncoder().encode(part.payload_text).byteLength !== part.part_bytes) throw new Error(`Dataset ${name} failed integrity validation`); return part.payload_text; }).join("");
    if (new TextEncoder().encode(text).byteLength !== first.payload_bytes) throw new Error(`Dataset ${name} byte count mismatch`);
    sources[name] = JSON.parse(text) as unknown; datasets.push({ name, recordCount: first.record_count, payloadBytes: first.payload_bytes, sourceHash: first.source_hash });
  }
  const overrides = overrideResult.results.map(row => ({ datasetName: row.dataset_name, recordKey: row.record_key, status: JSON.parse(row.value_json), previousStatus: row.previous_json ? JSON.parse(row.previous_json) : null, actor: row.actor, correlationId: row.correlation_id, updatedAt: row.created_at }));
  const ingestionEvents = ingestionResult.results.map(row => ({ id: row.id, provider: row.provider, receivedAt: row.received_at, matchedDataset: row.matched_dataset, action: row.action, createdAt: row.created_at }));
  return { ok: true, storage: "d1" as const, generatedAt: metadata.source_generated_at, importedAt: metadata.imported_at, version: metadata.source_version, datasetCount: metadata.dataset_count, payloadBytes: metadata.payload_bytes, datasets, sources, overrides, ingestionEvents };
}

export async function writeGmailIngestion(db: D1Database, input: { messageId: string; receivedAt: string; senderDomain: string; subject: string; identifiers: string[]; matchedDataset: string; matchedRecordKey: string }) {
  const id = crypto.randomUUID(); const createdAt = new Date().toISOString();
  const result = await db.prepare(`INSERT INTO warehouse_ingestion_events (id,provider,message_id,received_at,sender_domain,subject,matched_identifiers,matched_dataset,matched_record_key,action,created_at) VALUES (?,?,?,?,?,?,?,?,?,'verified-import',?) ON CONFLICT(message_id) DO NOTHING`).bind(id,"gmail",input.messageId,input.receivedAt,input.senderDomain,input.subject,JSON.stringify(input.identifiers),input.matchedDataset,input.matchedRecordKey,createdAt).run();
  if (!result.meta.changes) {
    const existing = await db.prepare(`SELECT id,created_at FROM warehouse_ingestion_events WHERE message_id = ?`).bind(input.messageId).first<{ id: string; created_at: string }>();
    return { id: existing?.id ?? id, createdAt: existing?.created_at ?? createdAt, duplicate: true };
  }
  return { id, createdAt, duplicate: false };
}

export async function writeWarehouseStatus(db: D1Database, input: { datasetName: string; recordKey: string; status: string; previousStatus?: string; actor: string; correlationId: string }) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO warehouse_overrides (id,dataset_name,record_key,field_name,previous_json,value_json,actor,correlation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_name,record_key,field_name) DO UPDATE SET previous_json=warehouse_overrides.value_json,value_json=excluded.value_json,actor=excluded.actor,correlation_id=excluded.correlation_id,created_at=excluded.created_at`).bind(crypto.randomUUID(), input.datasetName, input.recordKey, "status", JSON.stringify(input.previousStatus ?? null), JSON.stringify(input.status), input.actor, input.correlationId, now).run();
}
