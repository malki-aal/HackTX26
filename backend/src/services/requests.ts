// Purchase requests: drafts, versioned requirements, clarification and confirmation.
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { ClarifyBody, ConfirmBody, PatchRequestBody, RequestFields, Requirement as RequirementSchema, type ClarificationQuestion } from "../contracts/domain.js";
import type { Requirement } from "../domain/types.js";
import { applyClarificationAnswers, buildClarificationQuestions, deriveMonitorRequirements, mergeExtractedRequirements, totalBudgetCents, validateRequirements } from "../domain/requirements.js";
import { AppError, IntegrationError, invalidState, notFound, versionConflict } from "../lib/errors.js";
import { emitEvent } from "./events.js";
import { getConfig } from "./agentConfigs.js";
import { markIntegration } from "./budget.js";
import { z } from "zod";

const ORG_ID = "org_demo";
const NON_MATERIAL_FIELDS = new Set(["title", "purpose"]);

type RequestRow = { id: string; current_version: number; confirmed_version: number | null; status: string; created_by: string; created_at: string; updated_at: string };
type VersionRow = { request_id: string; version: number; fields: string; requirements: string; explicit_fields: string; change_note: string; material_change: number; created_at: string; confirmed_at: string | null };

export interface ExtractionReport {
  deterministic: true;
  model: "ok" | "not_configured" | "error" | "fixture" | "skipped";
  modelError: string | null;
  droppedModelRequirements: string[];
}

function loadRequest(ctx: AppContext, id: string): RequestRow {
  const r = ctx.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
  if (!r) throw notFound("Request", id);
  return r;
}

export function loadVersion(ctx: AppContext, id: string, version: number): { fields: RequestFields; requirements: Requirement[]; explicitFields: Set<string>; row: VersionRow } {
  const row = ctx.db.prepare("SELECT * FROM request_versions WHERE request_id = ? AND version = ?").get(id, version) as VersionRow | undefined;
  if (!row) throw notFound("Request version", `${id}@${version}`);
  return { fields: json(row.fields), requirements: json(row.requirements), explicitFields: new Set(json<string[]>(row.explicit_fields)), row };
}

function questionsFor(ctx: AppContext, id: string): ClarificationQuestion[] {
  const rows = ctx.db.prepare("SELECT question, answer, answered_at FROM clarification_questions WHERE request_id = ? ORDER BY created_at, id").all(id) as Array<{ question: string; answer: string | null; answered_at: string | null }>;
  return rows.map((r) => ({ ...json<Omit<ClarificationQuestion, "answer" | "answeredAt">>(r.question), answer: r.answer === null ? null : json(r.answer), answeredAt: r.answered_at }));
}

async function deriveRequirements(ctx: AppContext, fields: RequestFields): Promise<{ requirements: Requirement[]; extraction: ExtractionReport; modelQuestions: Array<{ text: string; affects: string }> }> {
  const base = deriveMonitorRequirements(fields);
  const extraction: ExtractionReport = { deterministic: true, model: "skipped", modelError: null, droppedModelRequirements: [] };
  if (!fields.description.trim()) return { requirements: base, extraction, modelQuestions: [] };
  try {
    const out = await ctx.adapters.extractor.extract({ title: fields.title, description: fields.description, category: fields.category });
    const { merged, dropped } = mergeExtractedRequirements(base, out.requirements, `${fields.title} ${fields.description}`);
    extraction.model = ctx.adapters.extractor.source === "fixture" ? "fixture" : "ok";
    extraction.droppedModelRequirements = dropped;
    if (extraction.model === "ok") markIntegration(ctx, "gemini", "ok", null, { model: ctx.config.gemini.model, via: "requirement extraction" });
    return { requirements: merged, extraction, modelQuestions: out.questions.slice(0, 2) };
  } catch (e) {
    extraction.model = e instanceof IntegrationError && e.code === "INTEGRATION_NOT_CONFIGURED" ? "not_configured" : "error";
    extraction.modelError = e instanceof Error ? e.message : "unknown error";
    if (extraction.model === "error") markIntegration(ctx, "gemini", e instanceof IntegrationError && e.code === "UPSTREAM_RATE_LIMITED" ? "degraded" : "error", extraction.modelError);
    return { requirements: base, extraction, modelQuestions: [] };
  }
}

function insertQuestions(ctx: AppContext, requestId: string, version: number, qs: Array<Omit<ClarificationQuestion, "answer" | "answeredAt">>, source: string) {
  const now = nowIso();
  for (const q of qs) {
    ctx.db
      .prepare("INSERT INTO clarification_questions (id, request_id, request_version, question, source, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(request_id, id) DO NOTHING")
      .run(q.id, requestId, version, JSON.stringify(q), source, now);
  }
}

function insertVersion(ctx: AppContext, requestId: string, version: number, fields: RequestFields, requirements: Requirement[], explicit: Set<string>, note: string, material: boolean, confirmedAt: string | null) {
  ctx.db
    .prepare("INSERT INTO request_versions (request_id, version, fields, requirements, explicit_fields, change_note, material_change, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(requestId, version, JSON.stringify(fields), JSON.stringify(requirements), JSON.stringify([...explicit]), note, material ? 1 : 0, nowIso(), confirmedAt);
}

function statusAfterEdit(questions: ClarificationQuestion[]): string {
  return questions.some((q) => q.answer === null) ? "needs_clarification" : "ready_to_confirm";
}

export async function createRequest(ctx: AppContext, body: unknown, actor = "employee-demo") {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fields = RequestFields.parse(raw);
  getConfig(ctx.db, fields.agentConfigId, fields.agentConfigVersion);
  const explicit = new Set(Object.keys(raw));
  let requirements: Requirement[];
  let extraction: ExtractionReport;
  let modelQuestions: Array<{ text: string; affects: string }> = [];
  if (fields.requirements) {
    requirements = fields.requirements;
    extraction = { deterministic: true, model: "skipped", modelError: null, droppedModelRequirements: [] };
  } else {
    ({ requirements, extraction, modelQuestions } = await deriveRequirements(ctx, fields));
  }
  const { requirements: _r, ...storedFields } = fields;
  const validation = validateRequirements(requirements, fields);
  if (!validation.ok) throw new AppError("VALIDATION_ERROR", "Requirements are invalid", 422, false, { issues: validation.errors });
  const questions = [
    ...buildClarificationQuestions({ fields, explicitFields: explicit, requirements }),
    ...modelQuestions.map((q, i) => ({ id: `q_model_${i + 1}`, text: q.text, kind: "text" as const, options: [], affects: q.affects })),
  ];
  const id = `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = nowIso();
  tx(ctx.db, () => {
    const status = questions.length ? "needs_clarification" : "ready_to_confirm";
    ctx.db.prepare("INSERT INTO requests (id, org_id, current_version, confirmed_version, status, created_by, created_at, updated_at) VALUES (?, ?, 1, NULL, ?, ?, ?, ?)").run(id, ORG_ID, status, actor, now, now);
    insertVersion(ctx, id, 1, storedFields as RequestFields, requirements, explicit, "created", true, null);
    insertQuestions(ctx, id, 1, questions, "deterministic");
    if (questions.length) emitEvent(ctx.db, { type: "clarification_required", requestId: id, summary: `${questions.length} clarification question(s)`, payload: { questionIds: questions.map((q) => q.id) } });
  });
  return { ...getRequestView(ctx, id), extraction };
}

export function getRequestView(ctx: AppContext, id: string) {
  const r = loadRequest(ctx, id);
  const v = loadVersion(ctx, id, r.current_version);
  const questions = questionsFor(ctx, id);
  const runs = ctx.db.prepare("SELECT id, status, outcome, request_version, created_at FROM runs WHERE request_id = ? ORDER BY created_at DESC").all(id) as Array<{ id: string; status: string; outcome: string | null; request_version: number; created_at: string }>;
  const proposals = ctx.db.prepare("SELECT id, current_version, decision_state FROM proposals WHERE request_id = ? ORDER BY created_at DESC").all(id) as Array<{ id: string; current_version: number; decision_state: string }>;
  return {
    id,
    version: r.current_version,
    status: r.status,
    confirmedVersion: r.confirmed_version,
    isCurrentVersionConfirmed: r.confirmed_version === r.current_version,
    ...v.fields,
    totalBudgetCents: totalBudgetCents(v.fields),
    requirements: v.requirements,
    validation: validateRequirements(v.requirements, v.fields),
    questions,
    unansweredQuestionIds: questions.filter((q) => q.answer === null).map((q) => q.id),
    runs: runs.map((x) => ({ id: x.id, status: x.status, outcome: x.outcome, requestVersion: x.request_version, createdAt: x.created_at })),
    latestRunId: runs[0]?.id ?? null,
    proposals: proposals.map((p) => ({ id: p.id, version: p.current_version, decisionState: p.decision_state })),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listRequests(ctx: AppContext, opts: { limit: number; cursor: string | null; status?: string }) {
  const params: Array<string | number> = [];
  let where = "1=1";
  if (opts.status) {
    where += " AND status = ?";
    params.push(opts.status);
  }
  if (opts.cursor) {
    where += " AND created_at < ?";
    params.push(Buffer.from(opts.cursor, "base64url").toString());
  }
  const rows = ctx.db.prepare(`SELECT id, created_at FROM requests WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, opts.limit + 1) as Array<{ id: string; created_at: string }>;
  const page = rows.slice(0, opts.limit);
  return {
    items: page.map((r) => {
      const v = getRequestView(ctx, r.id);
      return { id: v.id, version: v.version, title: v.title, status: v.status, quantity: v.quantity, budgetCents: v.budgetCents, totalBudgetCents: v.totalBudgetCents, latestRunId: v.latestRunId, createdAt: v.createdAt, updatedAt: v.updatedAt };
    }),
    nextCursor: rows.length > opts.limit ? Buffer.from(page[page.length - 1]!.created_at).toString("base64url") : null,
  };
}

export async function patchRequest(ctx: AppContext, id: string, body: unknown) {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch = PatchRequestBody.parse(raw);
  const r = loadRequest(ctx, id);
  if (patch.expectedVersion !== r.current_version) throw versionConflict(patch.expectedVersion, r.current_version);
  if (["submitted", "approved"].includes(r.status)) throw invalidState(`Request is ${r.status}; create a change request instead`);
  const cur = loadVersion(ctx, id, r.current_version);
  const { expectedVersion: _e, requirements: newReqs, ...fieldPatch } = patch;
  const changedKeys = Object.keys(fieldPatch).filter((k) => JSON.stringify((fieldPatch as Record<string, unknown>)[k]) !== JSON.stringify((cur.fields as Record<string, unknown>)[k]));
  const fields = RequestFields.parse({ ...cur.fields, ...fieldPatch });
  let requirements = cur.requirements;
  if (newReqs) requirements = z.array(RequirementSchema).parse(newReqs);
  else if (changedKeys.some((k) => ["description", "allowedCondition", "category"].includes(k))) requirements = deriveMonitorRequirements(fields);
  const validation = validateRequirements(requirements, fields);
  if (!validation.ok) throw new AppError("VALIDATION_ERROR", "Requirements are invalid", 422, false, { issues: validation.errors });
  const material = !!newReqs || changedKeys.some((k) => !NON_MATERIAL_FIELDS.has(k));
  if (!material && changedKeys.length === 0) return getRequestView(ctx, id);
  const explicit = new Set([...cur.explicitFields, ...Object.keys(fieldPatch)]);
  tx(ctx.db, () => {
    const next = r.current_version + 1;
    const keepConfirmation = !material && r.confirmed_version === r.current_version;
    const { requirements: _x, ...storedFields } = fields;
    insertVersion(ctx, id, next, storedFields as RequestFields, requirements, explicit, `edited: ${[...changedKeys, ...(newReqs ? ["requirements"] : [])].join(", ")}`, material, keepConfirmation ? nowIso() : null);
    const qs = questionsFor(ctx, id);
    const status = keepConfirmation ? "confirmed" : statusAfterEdit(qs);
    ctx.db.prepare("UPDATE requests SET current_version = ?, confirmed_version = ?, status = ?, updated_at = ? WHERE id = ?").run(next, keepConfirmation ? next : r.confirmed_version, status, nowIso(), id);
  });
  return getRequestView(ctx, id);
}

export function clarifyRequest(ctx: AppContext, id: string, body: unknown) {
  const parsed = ClarifyBody.parse(body);
  const r = loadRequest(ctx, id);
  if (parsed.expectedVersion !== r.current_version) throw versionConflict(parsed.expectedVersion, r.current_version);
  if (parsed.answers.length === 0) return getRequestView(ctx, id);
  const questions = questionsFor(ctx, id);
  for (const a of parsed.answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) throw new AppError("VALIDATION_ERROR", `Unknown question ${a.questionId}`, 422);
    if (q.options.length && !q.options.some((o) => o.value === a.value)) throw new AppError("VALIDATION_ERROR", `Invalid answer for ${a.questionId}`, 422, false, { allowed: q.options.map((o) => o.value) });
  }
  const cur = loadVersion(ctx, id, r.current_version);
  const effect = applyClarificationAnswers(cur.fields, cur.requirements, parsed.answers);
  const fields = RequestFields.parse({ ...cur.fields, ...effect.fields });
  tx(ctx.db, () => {
    const now = nowIso();
    for (const a of parsed.answers) ctx.db.prepare("UPDATE clarification_questions SET answer = ?, answered_at = ? WHERE request_id = ? AND id = ?").run(JSON.stringify(a.value), now, id, a.questionId);
    const next = r.current_version + 1;
    const explicit = new Set([...cur.explicitFields, ...Object.keys(effect.fields)]);
    const { requirements: _x, ...storedFields } = fields;
    insertVersion(ctx, id, next, storedFields as RequestFields, effect.requirements, explicit, `clarified: ${parsed.answers.map((a) => a.questionId).join(", ")}`, true, null);
    ctx.db.prepare("UPDATE requests SET current_version = ?, status = ?, updated_at = ? WHERE id = ?").run(next, statusAfterEdit(questionsFor(ctx, id)), now, id);
  });
  return getRequestView(ctx, id);
}

export function confirmRequest(ctx: AppContext, id: string, body: unknown) {
  const { version } = ConfirmBody.parse(body);
  const r = loadRequest(ctx, id);
  if (version !== r.current_version) throw versionConflict(version, r.current_version);
  const qs = questionsFor(ctx, id).filter((q) => q.answer === null);
  if (qs.length) throw new AppError("CONFIRMATION_REQUIRED", "Answer all clarification questions before confirming", 409, false, { unansweredQuestionIds: qs.map((q) => q.id) });
  const v = loadVersion(ctx, id, version);
  const validation = validateRequirements(v.requirements, v.fields);
  if (!validation.ok) throw new AppError("VALIDATION_ERROR", "Requirements are invalid", 422, false, { issues: validation.errors });
  if (r.confirmed_version === version) return getRequestView(ctx, id);
  tx(ctx.db, () => {
    const now = nowIso();
    ctx.db.prepare("UPDATE request_versions SET confirmed_at = ? WHERE request_id = ? AND version = ?").run(now, id, version);
    ctx.db.prepare("UPDATE requests SET confirmed_version = ?, status = 'confirmed', updated_at = ? WHERE id = ?").run(version, now, id);
    emitEvent(ctx.db, { type: "requirements_confirmed", requestId: id, summary: `Requirements v${version} confirmed`, payload: { version } });
  });
  return getRequestView(ctx, id);
}

export function setRequestStatus(ctx: AppContext, id: string, status: string) {
  ctx.db.prepare("UPDATE requests SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
}

export { loadRequest };
