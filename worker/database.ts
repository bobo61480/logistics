import type { SourceHealth } from "./sources";

// A chunk is at most 512 KiB even when every UTF-16 code unit encodes to four
// UTF-8 bytes, leaving generous room below D1's 1 MB row limit.
const PART_CHARACTERS = 128 * 1024;
const MAX_PARTS = 900;
const RETAINED_SNAPSHOTS = 4;

export type OperationalSnapshot = {
  ok: true;
  generatedAt: string;
  version: string;
  sourceHealth: SourceHealth[];
  sources: Record<string, unknown>;
  kpis: unknown;
  kpiError?: string;
};

export type StoredSnapshot = OperationalSnapshot & {
  storage: "d1";
  storedAt: string;
};

type SnapshotRow = {
  id: string;
  generated_at: string;
  version: string;
  source_count: number;
  part_count: number;
  payload_bytes: number;
  created_at: string;
};

type PartRow = { part_name: string; part_index: number; payload_text: string };

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function splitPayload(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Snapshot value is not JSON serializable");
  const chunks: string[] = [];
  let start = 0;
  while (start < serialized.length) {
    let end = Math.min(start + PART_CHARACTERS, serialized.length);
    const finalCode = serialized.charCodeAt(end - 1);
    if (end < serialized.length && finalCode >= 0xd800 && finalCode <= 0xdbff) end -= 1;
    chunks.push(serialized.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

export function joinPayload(chunks: string[]) {
  return JSON.parse(chunks.join("")) as unknown;
}

function payloadEntries(snapshot: OperationalSnapshot) {
  return [
    ["sourceHealth", snapshot.sourceHealth],
    ["sources", snapshot.sources],
    ["kpis", snapshot.kpis],
    ["kpiError", snapshot.kpiError ?? null],
  ] as const;
}

export async function persistSnapshot(db: D1Database, snapshot: OperationalSnapshot) {
  const id = crypto.randomUUID();
  const entries = payloadEntries(snapshot);
  const parts = entries.flatMap(([name, value]) =>
    splitPayload(value).map((payload, index) => ({ name, index, payload, bytes: byteLength(payload) })),
  );
  if (parts.length > MAX_PARTS) throw new Error(`Snapshot requires ${parts.length} database parts; limit is ${MAX_PARTS}`);
  const payloadBytes = parts.reduce((total, part) => total + part.bytes, 0);
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO operational_snapshots
      (id, generated_at, version, source_count, part_count, payload_bytes)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(
      id,
      snapshot.generatedAt,
      snapshot.version,
      snapshot.sourceHealth.length,
      parts.length,
      payloadBytes,
    ),
    ...parts.map((part) => db.prepare(`INSERT INTO operational_snapshot_parts
      (snapshot_id, part_name, part_index, payload_text, payload_bytes)
      VALUES (?, ?, ?, ?, ?)`).bind(id, part.name, part.index, part.payload, part.bytes)),
    db.prepare(`INSERT INTO operational_state (key, snapshot_id, updated_at)
      VALUES ('current_snapshot', ?, ?)
      ON CONFLICT(key) DO UPDATE SET snapshot_id = excluded.snapshot_id, updated_at = excluded.updated_at`).bind(id, now),
  ];
  await db.batch(statements);

  await db.prepare(`DELETE FROM operational_snapshots
    WHERE id NOT IN (
      SELECT id FROM operational_snapshots ORDER BY generated_at DESC LIMIT ?
    ) AND id NOT IN (SELECT snapshot_id FROM operational_state)`).bind(RETAINED_SNAPSHOTS).run();
  return { id, partCount: parts.length, payloadBytes };
}

export async function readCurrentSnapshot(db: D1Database): Promise<StoredSnapshot | null> {
  const [metadataResult, partsResult] = await db.batch([
    db.prepare(`SELECT s.id, s.generated_at, s.version, s.source_count, s.part_count,
      s.payload_bytes, s.created_at
      FROM operational_state state
      JOIN operational_snapshots s ON s.id = state.snapshot_id
      WHERE state.key = 'current_snapshot'`),
    db.prepare(`SELECT p.part_name, p.part_index, p.payload_text
      FROM operational_state state
      JOIN operational_snapshot_parts p ON p.snapshot_id = state.snapshot_id
      WHERE state.key = 'current_snapshot'
      ORDER BY p.part_name, p.part_index`),
  ]);
  const metadata = metadataResult.results[0] as SnapshotRow | undefined;
  if (!metadata) return null;
  const rows = partsResult.results as PartRow[];
  if (rows.length !== metadata.part_count) throw new Error("Current D1 snapshot is incomplete");

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const chunks = grouped.get(row.part_name) ?? [];
    chunks[row.part_index] = row.payload_text;
    grouped.set(row.part_name, chunks);
  }
  const decode = (name: string) => {
    const chunks = grouped.get(name);
    if (!chunks?.length || chunks.some((chunk) => chunk === undefined)) {
      throw new Error(`Current D1 snapshot is missing ${name}`);
    }
    return joinPayload(chunks);
  };
  return {
    ok: true,
    generatedAt: metadata.generated_at,
    version: metadata.version,
    sourceHealth: decode("sourceHealth") as SourceHealth[],
    sources: decode("sources") as Record<string, unknown>,
    kpis: decode("kpis"),
    kpiError: (decode("kpiError") as string | null) ?? undefined,
    storage: "d1",
    storedAt: metadata.created_at,
  };
}

export async function readDatabaseHealth(db: D1Database) {
  const row = await db.prepare(`SELECT s.generated_at, s.created_at, s.source_count,
    s.part_count, s.payload_bytes
    FROM operational_state state
    JOIN operational_snapshots s ON s.id = state.snapshot_id
    WHERE state.key = 'current_snapshot'`).first<{
      generated_at: string;
      created_at: string;
      source_count: number;
      part_count: number;
      payload_bytes: number;
    }>();
  return row ? {
    ready: true,
    generatedAt: row.generated_at,
    storedAt: row.created_at,
    ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(row.generated_at)) / 1000)),
    sourceCount: row.source_count,
    partCount: row.part_count,
    payloadBytes: row.payload_bytes,
  } : { ready: false };
}

export async function recordConfirmedStatusWrite(db: D1Database, event: {
  correlationId: string;
  entityType: "inbound" | "outbound";
  entityId: string;
  previousStatus?: string;
  status: string;
  sourceSheet: string;
  sourceRow: number;
}) {
  await db.prepare(`INSERT INTO automation_events
    (id, source, entity_type, entity_id, previous_json, proposed_json, decision,
      actor, correlation_id, verification, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 'operator', ?, 'source-confirmed', ?)`)
    .bind(
      crypto.randomUUID(),
      `${event.sourceSheet}:${event.sourceRow}`,
      event.entityType,
      event.entityId,
      JSON.stringify({ status: event.previousStatus ?? null }),
      JSON.stringify({ status: event.status }),
      event.correlationId,
      new Date().toISOString(),
    )
    .run();
}
