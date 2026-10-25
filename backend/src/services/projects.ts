// Projects: a small multi-material wrapper. Each line is an ordinary single-category request, so
// research, evaluation, proposals and execution are reused unchanged. The project adds a hard
// budget across lines, supplied inventory (recorded, never purchased) and a rollup.
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso } from "../db/db.js";
import { CreateProjectBody, RequestFields } from "../contracts/domain.js";
import { AppError, notFound } from "../lib/errors.js";
import { confirmRequest, createRequest, getRequestView } from "./requests.js";
import { getCandidates, startResearch } from "./research.js";

type ProjectRow = { id: string; title: string; payload: string; budget_cents: number; created_by: string; created_at: string };

function loadProject(ctx: AppContext, id: string): ProjectRow {
  const r = ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  if (!r) throw notFound("Project", id);
  return r;
}

function lineRequestBody(p: CreateProjectBody, line: CreateProjectBody["lines"][number]) {
  return {
    title: line.title,
    purpose: p.purpose,
    description: line.description,
    category: line.category,
    quantity: line.quantity,
    unit: line.unit,
    currency: "USD",
    budgetCents: line.budgetCents,
    budgetBasis: "total",
    allowedCondition: line.allowedCondition,
    deadline: line.deadline === undefined ? p.neededBy : line.deadline,
    deadlineType: line.deadlineType ?? p.deadlineType,
    agentConfigId: p.agentConfigId,
  };
}

export async function createProject(ctx: AppContext, body: unknown, actor = "employee-demo", orgId = "org_demo") {
  const p = CreateProjectBody.parse(body);
  // Validate every line before writing anything.
  for (const line of p.lines) RequestFields.parse(lineRequestBody(p, line));
  const id = `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  ctx.db.prepare("INSERT INTO projects (id, title, payload, budget_cents, created_by, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, p.title, JSON.stringify(p), p.budgetCents, actor, nowIso(), orgId);
  for (const line of p.lines) await createRequest(ctx, lineRequestBody(p, line), actor, { projectId: id, lineKey: line.key, orgId });
  return getProjectView(ctx, id);
}

/** Committed spend against the project: every non-failed execution for its lines. */
export function projectCommittedCents(ctx: AppContext, projectId: string): number {
  const row = ctx.db
    .prepare("SELECT COALESCE(SUM(e.amount_cents), 0) AS n FROM executions e JOIN proposals p ON p.id = e.proposal_id JOIN requests r ON r.id = p.request_id WHERE r.project_id = ? AND e.status != 'failed'")
    .get(projectId) as { n: number };
  return row.n;
}

export function getProjectView(ctx: AppContext, id: string) {
  const row = loadProject(ctx, id);
  const p = json<CreateProjectBody>(row.payload);
  const reqIds = ctx.db.prepare("SELECT id FROM requests WHERE project_id = ? ORDER BY created_at, rowid").all(id) as Array<{ id: string }>;
  const lines = reqIds.map(({ id: rid }) => {
    const r = getRequestView(ctx, rid);
    let research: null | { runId: string; runStatus: string; outcome: string | null; resultsCurrent: boolean; lowestCost: { offerId: string; title: string; seller: string | null; knownComparableCostCents: number | null; totalStatus: string } | null; recommendations: number; notes: string[] } = null;
    if (r.latestRunId) {
      try {
        const c = getCandidates(ctx, rid, r.latestRunId);
        const low = c.recommendations.find((x) => x.kinds.includes("lowest_cost"));
        const cand = low ? c.candidates.find((x) => x.offerId === low.offerId) : undefined;
        research = {
          runId: c.runId,
          runStatus: c.runStatus,
          outcome: c.outcome,
          resultsCurrent: c.resultsCurrent,
          lowestCost: cand ? { offerId: cand.offerId, title: cand.title, seller: cand.seller, knownComparableCostCents: cand.knownComparableCostCents, totalStatus: cand.totalStatus } : null,
          recommendations: c.recommendations.length,
          notes: c.recommendationNotes,
        };
      } catch {
        research = null;
      }
    }
    const latestProposal = r.proposals[r.proposals.length - 1] ?? null;
    return {
      key: r.lineKey,
      requestId: rid,
      title: r.title,
      item: r.item,
      quantity: r.quantity,
      unit: r.unit,
      lineBudgetCents: r.totalBudgetCents,
      deadline: r.deadline,
      deadlineType: r.deadlineType,
      status: r.status,
      version: r.version,
      isCurrentVersionConfirmed: r.isCurrentVersionConfirmed,
      unansweredQuestionIds: r.unansweredQuestionIds,
      research,
      proposal: latestProposal,
    };
  });
  const lowCosts = lines.map((l) => l.research?.lowestCost?.knownComparableCostCents ?? null);
  const knownTotal = lowCosts.every((c) => c !== null) ? lowCosts.reduce<number>((s, c) => s + (c ?? 0), 0) : null;
  const committed = projectCommittedCents(ctx, id);
  return {
    id,
    title: p.title,
    purpose: p.purpose,
    sector: p.sector,
    currency: "USD",
    budgetCents: row.budget_cents,
    budgetType: "hard",
    neededBy: p.neededBy,
    deadlineType: p.deadlineType,
    suppliedInventory: p.suppliedInventory.map((i) => ({ ...i, purchased: false, source: "supplied inventory" })),
    lines,
    totals: {
      lineBudgetsCents: lines.reduce((s, l) => s + l.lineBudgetCents, 0),
      lowestKnownCostCents: knownTotal,
      lowestKnownCostStatus: knownTotal === null ? "incomplete: some lines have no compliant priced offer yet" : "provisional: tax unknown, shipping only where stated",
      fitsBudget: knownTotal === null ? "unknown" : knownTotal <= row.budget_cents ? "yes_provisional" : "no",
      committedCents: committed,
      remainingCents: row.budget_cents - committed,
    },
    limitations: [
      "Each line is researched, proposed, approved and recorded separately; there is no combined bill of materials or single checkout.",
      "Supplied inventory is recorded for context and is never purchased or checked for quantity.",
    ],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function listProjects(ctx: AppContext, scope: { orgId: string; ownerId?: string }) {
  const rows = (scope.ownerId
    ? ctx.db.prepare("SELECT id FROM projects WHERE org_id = ? AND created_by = ? ORDER BY created_at DESC").all(scope.orgId, scope.ownerId)
    : ctx.db.prepare("SELECT id FROM projects WHERE org_id = ? ORDER BY created_at DESC").all(scope.orgId)) as Array<{ id: string }>;
  return rows.map((r) => {
    const v = getProjectView(ctx, r.id);
    return { id: v.id, title: v.title, sector: v.sector, budgetCents: v.budgetCents, neededBy: v.neededBy, lines: v.lines.length, committedCents: v.totals.committedCents, createdAt: v.createdAt };
  });
}

/** Confirm every line that is ready (explicit user action; lines with open questions are reported). */
export function confirmProjectLines(ctx: AppContext, id: string) {
  const v = getProjectView(ctx, id);
  const results = v.lines.map((l) => {
    if (l.isCurrentVersionConfirmed) return { key: l.key, requestId: l.requestId, result: "already_confirmed" };
    if (l.unansweredQuestionIds.length) return { key: l.key, requestId: l.requestId, result: "needs_clarification", questionIds: l.unansweredQuestionIds };
    try {
      confirmRequest(ctx, l.requestId, { version: l.version });
      return { key: l.key, requestId: l.requestId, result: "confirmed" };
    } catch (e) {
      return { key: l.key, requestId: l.requestId, result: "error", code: e instanceof AppError ? e.code : "INTERNAL_ERROR" };
    }
  });
  return { project: getProjectView(ctx, id), results };
}

/** Start research for confirmed lines. This is the paid action and only runs on explicit request. */
export function researchProject(ctx: AppContext, id: string, body: unknown) {
  const keys = (body as { lineKeys?: string[] } | null)?.lineKeys;
  const v = getProjectView(ctx, id);
  const results = v.lines
    .filter((l) => !keys || keys.includes(l.key ?? ""))
    .map((l) => {
      if (!l.isCurrentVersionConfirmed) return { key: l.key, requestId: l.requestId, result: "not_confirmed" as const };
      try {
        const s = startResearch(ctx, l.requestId, { version: l.version });
        return { key: l.key, requestId: l.requestId, result: "started" as const, runId: s.runId };
      } catch (e) {
        return { key: l.key, requestId: l.requestId, result: "skipped" as const, code: e instanceof AppError ? e.code : "INTERNAL_ERROR" };
      }
    });
  return { projectId: id, results };
}
