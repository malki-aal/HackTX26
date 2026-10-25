// Saved, versioned agent configurations. Edits create a new version; old versions stay immutable
// so each run can reference exactly the configuration it used.
import type { Db } from "../db/db.js";
import { json, nowIso, tx } from "../db/db.js";
import { AgentConfigFields, CreateAgentConfigBody, PatchAgentConfigBody, type AgentConfig } from "../contracts/domain.js";
import { AppError, notFound, versionConflict } from "../lib/errors.js";
import type { z } from "zod";

export const DEFAULT_CONFIGS: Array<{ id: string; fields: z.infer<typeof AgentConfigFields> }> = [
  {
    id: "cfg_default",
    fields: {
      displayName: "Exact-spec researcher",
      instructions: "Search for listings that state the confirmed specifications explicitly. Prefer fewer, precise searches. Check product details for the cheapest candidates whose mandatory specs are unconfirmed. Explain the computed top candidate briefly.",
      enabledTools: ["getConfirmedRequirements", "searchProducts", "getProductDetails", "evaluateCandidates", "readBudgetContext", "prepareProposalDraft"],
      rankingPriority: "lowest_known_total",
      searchStrategy: "exact_specs",
      limits: { maxSearchCalls: 2, maxDetailCalls: 3, maxSteps: 14, maxDurationMs: 300_000 },
    },
  },
  {
    id: "cfg_broad_scan",
    fields: {
      displayName: "Broad market scan",
      instructions: "Cast a wider net with broader queries, then rely on deterministic evaluation to filter. Prefer listings with more complete evidence.",
      enabledTools: ["getConfirmedRequirements", "searchProducts", "getProductDetails", "evaluateCandidates", "prepareProposalDraft"],
      rankingPriority: "evidence_completeness",
      searchStrategy: "broad_then_filter",
      limits: { maxSearchCalls: 3, maxDetailCalls: 2, maxSteps: 14, maxDurationMs: 300_000 },
    },
  },
];

function insertVersion(db: Db, id: string, version: number, fields: z.infer<typeof AgentConfigFields>): AgentConfig {
  const createdAt = nowIso();
  const cfg: AgentConfig = { ...fields, id, version, createdAt };
  db.prepare("INSERT INTO agent_configs (id, version, payload, created_at) VALUES (?, ?, ?, ?)").run(id, version, JSON.stringify(cfg), createdAt);
  db.prepare("INSERT INTO agent_config_heads (id, current_version) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET current_version = excluded.current_version").run(id, version);
  return cfg;
}

export function seedDefaultConfigs(db: Db): void {
  for (const c of DEFAULT_CONFIGS) {
    const exists = db.prepare("SELECT 1 FROM agent_config_heads WHERE id = ?").get(c.id);
    if (!exists) tx(db, () => insertVersion(db, c.id, 1, c.fields));
  }
}

export function getConfig(db: Db, id: string, version?: number | null): AgentConfig {
  const v = version ?? (db.prepare("SELECT current_version FROM agent_config_heads WHERE id = ?").get(id) as { current_version: number } | undefined)?.current_version;
  if (!v) throw notFound("Agent configuration", id);
  const row = db.prepare("SELECT payload FROM agent_configs WHERE id = ? AND version = ?").get(id, v) as { payload: string } | undefined;
  if (!row) throw notFound("Agent configuration", `${id}@${v}`);
  return json<AgentConfig>(row.payload);
}

export function listConfigs(db: Db): Array<AgentConfig & { versions: number[] }> {
  const heads = db.prepare("SELECT id, current_version FROM agent_config_heads ORDER BY id").all() as Array<{ id: string; current_version: number }>;
  return heads.map((h) => ({
    ...getConfig(db, h.id, h.current_version),
    versions: (db.prepare("SELECT version FROM agent_configs WHERE id = ? ORDER BY version").all(h.id) as Array<{ version: number }>).map((r) => r.version),
  }));
}

export function createConfig(db: Db, body: unknown): AgentConfig {
  const parsed = CreateAgentConfigBody.parse(body);
  const { id: maybeId, ...fields } = parsed;
  const id = maybeId ?? `cfg_${Math.random().toString(36).slice(2, 10)}`;
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM agent_config_heads WHERE id = ?").get(id)) throw new AppError("VALIDATION_ERROR", `Configuration ${id} already exists`, 409);
    return insertVersion(db, id, 1, fields);
  });
}

export function patchConfig(db: Db, id: string, body: unknown): AgentConfig {
  const parsed = PatchAgentConfigBody.parse(body);
  return tx(db, () => {
    const current = getConfig(db, id);
    if (parsed.expectedVersion !== current.version) throw versionConflict(parsed.expectedVersion, current.version);
    const { expectedVersion: _ev, ...patch } = parsed;
    const next = AgentConfigFields.parse({
      displayName: patch.displayName ?? current.displayName,
      instructions: patch.instructions ?? current.instructions,
      enabledTools: patch.enabledTools ?? current.enabledTools,
      rankingPriority: patch.rankingPriority ?? current.rankingPriority,
      searchStrategy: patch.searchStrategy ?? current.searchStrategy,
      limits: { ...current.limits, ...(patch.limits ?? {}) },
    });
    return insertVersion(db, id, current.version + 1, next);
  });
}

/** Effective limits: a configuration can only tighten the application-wide environment caps. */
export function effectiveLimits(cfg: AgentConfig, env: { maxSearchCallsPerRun: number; maxAgentSteps: number; maxResearchDurationMs: number }) {
  return {
    maxSearchCalls: Math.min(cfg.limits.maxSearchCalls, env.maxSearchCallsPerRun),
    maxDetailCalls: cfg.enabledTools.includes("getProductDetails") ? (cfg.limits.maxDetailCalls ?? 3) : 0,
    maxSteps: Math.min(cfg.limits.maxSteps, env.maxAgentSteps),
    maxDurationMs: Math.min(cfg.limits.maxDurationMs, env.maxResearchDurationMs),
  };
}
