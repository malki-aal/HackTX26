// Persisted, ordered, cursor-addressable activity events.
import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { json, nowIso } from "../db/db.js";
import type { RunEventType } from "../contracts/domain.js";
import { scrubValue } from "../lib/redact.js";

export interface EventInput {
  type: RunEventType;
  summary: string;
  runId?: string | null;
  requestId?: string | null;
  proposalId?: string | null;
  executionId?: string | null;
  payload?: Record<string, unknown>;
}

export interface StoredEvent {
  id: string;
  cursor: string;
  type: RunEventType;
  runId: string | null;
  requestId: string | null;
  proposalId: string | null;
  executionId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const MAX_PAYLOAD_CHARS = 8000;

export function emitEvent(db: Db, e: EventInput): StoredEvent {
  const id = `evt_${randomUUID()}`;
  let payload = JSON.stringify(scrubValue(e.payload ?? {}));
  if (payload.length > MAX_PAYLOAD_CHARS) payload = JSON.stringify({ truncated: true, preview: payload.slice(0, 500) });
  const createdAt = nowIso();
  const r = db
    .prepare("INSERT INTO events (id, type, run_id, request_id, proposal_id, execution_id, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, e.type, e.runId ?? null, e.requestId ?? null, e.proposalId ?? null, e.executionId ?? null, e.summary.slice(0, 300), payload, createdAt);
  return { id, cursor: String(r.lastInsertRowid), type: e.type, runId: e.runId ?? null, requestId: e.requestId ?? null, proposalId: e.proposalId ?? null, executionId: e.executionId ?? null, summary: e.summary, payload: JSON.parse(payload), createdAt };
}

type Row = { seq: number; id: string; type: RunEventType; run_id: string | null; request_id: string | null; proposal_id: string | null; execution_id: string | null; summary: string; payload: string; created_at: string };

const toEvent = (r: Row): StoredEvent => ({
  id: r.id,
  cursor: String(r.seq),
  type: r.type,
  runId: r.run_id,
  requestId: r.request_id,
  proposalId: r.proposal_id,
  executionId: r.execution_id,
  summary: r.summary,
  payload: json(r.payload),
  createdAt: r.created_at,
});

export function listEvents(db: Db, filter: { runId?: string; requestId?: string; proposalId?: string }, after: string | null, limit: number): { events: StoredEvent[]; nextCursor: string | null } {
  const col = filter.runId ? "run_id" : filter.requestId ? "request_id" : "proposal_id";
  const val = filter.runId ?? filter.requestId ?? filter.proposalId;
  const afterSeq = after && /^\d+$/.test(after) ? Number(after) : 0;
  const rows = db.prepare(`SELECT * FROM events WHERE ${col} = ? AND seq > ? ORDER BY seq ASC LIMIT ?`).all(val!, afterSeq, limit) as Row[];
  const events = rows.map(toEvent);
  return { events, nextCursor: events.length ? events[events.length - 1]!.cursor : after };
}
