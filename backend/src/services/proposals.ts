// Immutable proposal versions, employee submission and executive decisions.
import { createHash, randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { CreateProposalBody, DecisionBody, SubmitProposalBody, type CandidateEvaluation, type Offer, type FinancialContext } from "../contracts/domain.js";
import { assessBudget, computeFinancialContext } from "../domain/budget.js";
import { totalBudgetCents } from "../domain/requirements.js";
import { formatUsd } from "../domain/money.js";
import { AppError, invalidState, notFound, versionConflict } from "../lib/errors.js";
import { emitEvent } from "./events.js";
import { loadRequest, loadVersion, setRequestStatus } from "./requests.js";
import { loadRun } from "./research.js";
import { loadLedger, readFinancialContext, resolveAccountId } from "./budget.js";
import { ensureMerchant, getExecutionView, submitExecution } from "./executions.js";

type ProposalRow = { id: string; request_id: string; current_version: number; decision_state: string; created_at: string; updated_at: string };
type VersionRow = { proposal_id: string; version: number; payload: string; status: string; exact_amount_cents: number | null; amount_source: string | null; technical_review_confirmed: number; mode: string; created_at: string; submitted_at: string | null };

export interface ProposalPayload {
  requestId: string;
  requestVersion: number;
  runId: string;
  agentConfig: { id: string; version: number };
  offer: Offer;
  evaluation: CandidateEvaluation;
  quantity: number;
  requestBudgetCents: number;
  requirements: unknown[];
  justification: string;
  alternatives: Array<{ offerId: string; title: string; eligibility: string; knownComparableCostCents: number | null; seller: string | null }>;
  unresolved: string[];
  budgetAssessmentAtCreation: ReturnType<typeof assessBudget>;
  createdBy: string;
}

function loadProposal(ctx: AppContext, id: string): ProposalRow {
  const r = ctx.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
  if (!r) throw notFound("Proposal", id);
  return r;
}

function loadProposalVersion(ctx: AppContext, id: string, version: number): VersionRow & { data: ProposalPayload } {
  const r = ctx.db.prepare("SELECT * FROM proposal_versions WHERE proposal_id = ? AND version = ?").get(id, version) as VersionRow | undefined;
  if (!r) throw notFound("Proposal version", `${id}@${version}`);
  return { ...r, data: json<ProposalPayload>(r.payload) };
}

function cachedFinancial(ctx: AppContext): FinancialContext {
  const accountId = resolveAccountId(ctx);
  if (!accountId) return computeFinancialContext(null, []);
  const snap = ctx.db.prepare("SELECT balance_cents, bills, fetched_at, source FROM financial_snapshots WHERE account_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1").get(accountId) as { balance_cents: number; bills: string; fetched_at: string; source: string } | undefined;
  return computeFinancialContext(snap ? { accountId, balanceCents: snap.balance_cents, bills: json(snap.bills), fetchedAt: snap.fetched_at, source: snap.source === "fixture" ? "fixture" : "nessie_cached" } : null, loadLedger(ctx, accountId));
}

export function createProposal(ctx: AppContext, requestId: string, body: unknown & { proposalId?: string }) {
  const parsed = CreateProposalBody.extend({ proposalId: CreateProposalBody.shape.runId.optional() }).parse(body);
  const req = loadRequest(ctx, requestId);
  const run = loadRun(ctx, parsed.runId);
  if (run.request_id !== requestId) throw new AppError("VALIDATION_ERROR", "Run does not belong to this request", 422);
  if (run.status !== "completed") throw invalidState(`Run is ${run.status}; proposals require a completed run`);
  if (run.request_version !== req.current_version) throw new AppError("VERSION_CONFLICT", "Requirements changed since this run; rerun research for the current version", 409, false, { runRequestVersion: run.request_version, currentVersion: req.current_version });
  const evRow = ctx.db.prepare("SELECT e.payload AS ev, o.payload AS offer FROM evaluations e JOIN offers o ON o.id = e.offer_id WHERE e.run_id = ? AND e.offer_id = ?").get(parsed.runId, parsed.offerId) as { ev: string; offer: string } | undefined;
  if (!evRow) throw notFound("Candidate", parsed.offerId);
  const evaluation = json<CandidateEvaluation>(evRow.ev);
  const offer = json<Offer>(evRow.offer);
  if (evaluation.class === "rejected") throw new AppError("VALIDATION_ERROR", `Candidate is rejected and cannot be proposed: ${evaluation.recommendationReason}`, 422, false, { offerId: offer.id });
  const v = loadVersion(ctx, requestId, run.request_version);
  const alternatives = parsed.alternativeOfferIds.flatMap((aid) => {
    const r = ctx.db.prepare("SELECT e.payload AS ev, o.payload AS offer FROM evaluations e JOIN offers o ON o.id = e.offer_id WHERE e.run_id = ? AND e.offer_id = ?").get(parsed.runId, aid) as { ev: string; offer: string } | undefined;
    if (!r) return [];
    const e = json<CandidateEvaluation>(r.ev);
    const o = json<Offer>(r.offer);
    return [{ offerId: o.id, title: o.title, eligibility: e.class, knownComparableCostCents: e.cost.knownComparableCostCents, seller: o.seller }];
  });
  const unresolved = [
    ...evaluation.requirementResults.filter((r) => r.mandatory && r.state === "unknown").map((r) => `Mandatory ${r.attribute} unconfirmed: ${r.reason}`),
    ...offer.needsReviewReasons,
    ...(offer.shipping.status === "unknown" ? ["Shipping cost unknown"] : []),
    "Sales tax unknown",
  ];
  const requestBudget = totalBudgetCents(v.fields);
  const payload: ProposalPayload = {
    requestId,
    requestVersion: run.request_version,
    runId: run.id,
    agentConfig: { id: run.config_id, version: run.config_version },
    offer,
    evaluation,
    quantity: v.fields.quantity,
    requestBudgetCents: requestBudget,
    requirements: v.requirements,
    justification: parsed.justification,
    alternatives,
    unresolved,
    budgetAssessmentAtCreation: assessBudget({
      amountCents: evaluation.cost.knownComparableCostCents,
      amountBasis: evaluation.cost.shippingCents === null ? "listed_subtotal" : "subtotal_plus_shipping",
      requestBudgetCents: requestBudget,
      financial: cachedFinancial(ctx),
    }),
    createdBy: parsed.actor,
  };
  const now = nowIso();
  const id = tx(ctx.db, () => {
    if (parsed.proposalId) {
      const p = loadProposal(ctx, parsed.proposalId);
      if (p.request_id !== requestId) throw new AppError("VALIDATION_ERROR", "Proposal belongs to another request", 422);
      if (!["changes_requested", "not_submitted"].includes(p.decision_state)) throw invalidState(`Proposal is ${p.decision_state}; a new revision is only allowed after changes are requested`);
      const next = p.current_version + 1;
      ctx.db.prepare("INSERT INTO proposal_versions (proposal_id, version, payload, status, mode, created_at) VALUES (?, ?, ?, 'needs_confirmation', ?, ?)").run(p.id, next, JSON.stringify(payload), ctx.config.mode, now);
      ctx.db.prepare("UPDATE proposals SET current_version = ?, decision_state = 'not_submitted', updated_at = ? WHERE id = ?").run(next, now, p.id);
      return p.id;
    }
    const pid = `prop_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    ctx.db.prepare("INSERT INTO proposals (id, request_id, current_version, decision_state, created_at, updated_at) VALUES (?, ?, 1, 'not_submitted', ?, ?)").run(pid, requestId, now, now);
    ctx.db.prepare("INSERT INTO proposal_versions (proposal_id, version, payload, status, mode, created_at) VALUES (?, 1, ?, 'needs_confirmation', ?, ?)").run(pid, JSON.stringify(payload), ctx.config.mode, now);
    return pid;
  });
  setRequestStatus(ctx, requestId, "proposal_draft");
  emitEvent(ctx.db, { type: "proposal_saved", requestId, runId: run.id, proposalId: id, summary: `Proposal saved for ${offer.title.slice(0, 80)}`, payload: { offerId: offer.id, eligibility: evaluation.class } });
  return getProposalView(ctx, id);
}

export function submitProposal(ctx: AppContext, id: string, body: unknown) {
  const parsed = SubmitProposalBody.parse(body);
  const p = loadProposal(ctx, id);
  if (parsed.version !== p.current_version) throw versionConflict(parsed.version, p.current_version);
  const pv = loadProposalVersion(ctx, id, parsed.version);
  if (pv.status === "submitted") {
    if (pv.exact_amount_cents === parsed.exactAmountCents) return getProposalView(ctx, id);
    throw new AppError("IDEMPOTENCY_CONFLICT", "This proposal version was already submitted with a different amount; create a new revision", 409);
  }
  const req = loadRequest(ctx, pv.data.requestId);
  if (req.current_version !== pv.data.requestVersion) throw new AppError("VERSION_CONFLICT", "Requirements changed after this proposal was created", 409, false, { proposalRequestVersion: pv.data.requestVersion, currentVersion: req.current_version });
  const subtotal = pv.data.evaluation.cost.listedSubtotalCents;
  if (subtotal !== null && parsed.exactAmountCents < subtotal) throw new AppError("VALIDATION_ERROR", `Exact amount ${formatUsd(parsed.exactAmountCents)} is below the listed subtotal ${formatUsd(subtotal)}`, 422);
  const now = nowIso();
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE proposal_versions SET status = 'submitted', exact_amount_cents = ?, amount_source = ?, technical_review_confirmed = 1, submitted_at = ? WHERE proposal_id = ? AND version = ?").run(parsed.exactAmountCents, parsed.amountSource, now, id, parsed.version);
    ctx.db.prepare("UPDATE proposals SET decision_state = 'awaiting_review', updated_at = ? WHERE id = ?").run(now, id);
    setRequestStatus(ctx, pv.data.requestId, "submitted");
    emitEvent(ctx.db, { type: "proposal_submitted", requestId: pv.data.requestId, proposalId: id, summary: `Submitted for ${formatUsd(parsed.exactAmountCents)} (user-confirmed amount)`, payload: { version: parsed.version, exactAmountCents: parsed.exactAmountCents, amountSource: parsed.amountSource } });
  });
  return getProposalView(ctx, id);
}

// ---------- Decisions ----------

function hashBody(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

export async function decideProposal(ctx: AppContext, id: string, body: unknown, idempotencyKey: string | undefined): Promise<{ status: number; body: unknown }> {
  if (!idempotencyKey || !/^[\w.:-]{8,128}$/.test(idempotencyKey)) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header (8-128 chars of [A-Za-z0-9_.:-]) is required", 400);
  const parsed = DecisionBody.parse(body);
  const scope = `decision:${id}`;
  const hash = hashBody({ id, ...parsed });
  const existing = ctx.db.prepare("SELECT request_hash, status_code, response FROM idempotency_records WHERE scope = ? AND idem_key = ?").get(scope, idempotencyKey) as { request_hash: string; status_code: number | null; response: string | null } | undefined;
  if (existing) {
    if (existing.request_hash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request", 409);
    if (existing.response === null) throw new AppError("IDEMPOTENCY_CONFLICT", "A request with this Idempotency-Key is still in progress", 409, true);
    return { status: existing.status_code!, body: json(existing.response) };
  }
  ctx.db.prepare("INSERT INTO idempotency_records (scope, idem_key, request_hash, created_at) VALUES (?, ?, ?, ?)").run(scope, idempotencyKey, hash, nowIso());
  try {
    const result = await decide(ctx, id, parsed);
    ctx.db.prepare("UPDATE idempotency_records SET status_code = ?, response = ? WHERE scope = ? AND idem_key = ?").run(200, JSON.stringify(result), scope, idempotencyKey);
    return { status: 200, body: result };
  } catch (e) {
    // Failed validation is not a logical result; allow the key to be reused after fixing the cause.
    ctx.db.prepare("DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ? AND response IS NULL").run(scope, idempotencyKey);
    throw e;
  }
}

async function decide(ctx: AppContext, id: string, parsed: ReturnType<typeof DecisionBody.parse>) {
  const p = loadProposal(ctx, id);
  if (parsed.version !== p.current_version) throw versionConflict(parsed.version, p.current_version);
  const pv = loadProposalVersion(ctx, id, parsed.version);
  if (p.decision_state !== "awaiting_review" || pv.status !== "submitted") throw invalidState(`Proposal is ${p.decision_state}; only submitted proposals awaiting review can be decided`, { decisionState: p.decision_state });
  const req = loadRequest(ctx, pv.data.requestId);
  if (req.current_version !== pv.data.requestVersion) throw new AppError("VERSION_CONFLICT", "Requirements changed after this proposal was submitted; a new proposal is required", 409);
  const now = nowIso();
  const decisionId = `dec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  if (parsed.decision !== "approve") {
    const state = parsed.decision === "reject" ? "rejected" : "changes_requested";
    tx(ctx.db, () => {
      ctx.db.prepare("INSERT INTO decisions (id, proposal_id, proposal_version, actor, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(decisionId, id, parsed.version, parsed.actor, parsed.decision, parsed.note, now);
      ctx.db.prepare("UPDATE proposals SET decision_state = ?, updated_at = ? WHERE id = ?").run(state, now, id);
      setRequestStatus(ctx, pv.data.requestId, state);
      emitEvent(ctx.db, { type: "decision_recorded", requestId: pv.data.requestId, proposalId: id, summary: `Executive ${state.replace("_", " ")}`, payload: { decision: parsed.decision, version: parsed.version, actor: parsed.actor } });
    });
    return getProposalView(ctx, id);
  }

  // ---- Approval: checks first, then an atomic reservation, then exactly one provider write. ----
  if (pv.mode !== ctx.config.mode) throw new AppError("MODE_MISMATCH", `Proposal was created in ${pv.mode} mode and cannot execute in ${ctx.config.mode} mode`, 409);
  const amount = pv.exact_amount_cents!;
  if (Date.parse(pv.data.offer.expiresAt) < ctx.now().getTime()) {
    throw new AppError("OFFER_STALE", `Offer evidence observed at ${pv.data.offer.observedAt} has expired; rerun research and resubmit`, 409, false, { observedAt: pv.data.offer.observedAt, expiresAt: pv.data.offer.expiresAt });
  }
  if (amount > pv.data.requestBudgetCents) throw new AppError("BUDGET_EXCEEDED", `Exact amount ${formatUsd(amount)} exceeds the request budget ${formatUsd(pv.data.requestBudgetCents)}`, 409);
  const fin = await readFinancialContext(ctx, { refresh: true });
  if (!fin.fresh || fin.context.availableBudgetCents === null || !fin.context.accountId) {
    throw new AppError("BANK_CHECK_UNAVAILABLE", `Bank context could not be refreshed: ${fin.error ?? "unavailable"}`, 503, true);
  }
  const accountId = fin.context.accountId;
  const merchantId = await ensureMerchant(ctx, pv.data.offer.seller ?? "Unknown seller");
  const executionId = `exe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  tx(ctx.db, () => {
    // Recompute availability inside the write lock so concurrent approvals serialize.
    const snapCtx = computeFinancialContext(
      { accountId, balanceCents: fin.context.reportedBalanceCents!, bills: [], fetchedAt: fin.context.fetchedAt!, source: "nessie_live" },
      loadLedger(ctx, accountId),
    );
    const available = snapCtx.availableBudgetCents! - fin.context.obligationsCents;
    if (amount > available) throw new AppError("BUDGET_EXCEEDED", `Exact amount ${formatUsd(amount)} exceeds available funds ${formatUsd(Math.max(0, available))}`, 409, false, { availableBudgetCents: available });
    const already = ctx.db.prepare("SELECT 1 FROM decisions WHERE proposal_id = ? AND proposal_version = ?").get(id, parsed.version);
    if (already) throw invalidState("This proposal version already has a decision");
    ctx.db.prepare("INSERT INTO decisions (id, proposal_id, proposal_version, actor, decision, note, created_at) VALUES (?, ?, ?, ?, 'approve', ?, ?)").run(decisionId, id, parsed.version, parsed.actor, parsed.note, now);
    const description = `Runway ${executionId} | ${pv.data.offer.title.replace(/\[FIXTURE\]\s*/, "").slice(0, 60)} x${pv.data.quantity} | seller ${pv.data.offer.seller ?? "unknown"}`.slice(0, 200);
    ctx.db
      .prepare("INSERT INTO executions (id, proposal_id, proposal_version, decision_id, mode, account_id, merchant_id, amount_cents, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
      .run(executionId, id, parsed.version, decisionId, ctx.config.mode, accountId, merchantId, amount, description, now, now);
    ctx.db
      .prepare("INSERT INTO budget_ledger (id, account_id, kind, amount_cents, status, execution_id, note, created_at, updated_at) VALUES (?, ?, 'reservation', ?, 'active', ?, ?, ?, ?)")
      .run(`led_${randomUUID()}`, accountId, amount, executionId, "Application budget hold for approved sandbox purchase", now, now);
    ctx.db.prepare("UPDATE proposals SET decision_state = 'approved', updated_at = ? WHERE id = ?").run(now, id);
    setRequestStatus(ctx, pv.data.requestId, "approved");
    emitEvent(ctx.db, { type: "decision_recorded", requestId: pv.data.requestId, proposalId: id, executionId, summary: `Executive approved ${formatUsd(amount)}`, payload: { decision: "approve", version: parsed.version, actor: parsed.actor, amountCents: amount } });
    emitEvent(ctx.db, { type: "execution_queued", requestId: pv.data.requestId, proposalId: id, executionId, summary: "Sandbox purchase queued", payload: { amountCents: amount, accountId } });
  });
  await submitExecution(ctx, executionId);
  return { ...getProposalView(ctx, id), execution: getExecutionView(ctx, executionId) };
}

// ---------- Views ----------

export function getProposalView(ctx: AppContext, id: string) {
  const p = loadProposal(ctx, id);
  const versions = (ctx.db.prepare("SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version").all(id) as VersionRow[]).map((v) => ({ ...v, data: json<ProposalPayload>(v.payload) }));
  const cur = versions[versions.length - 1]!;
  const decisions = ctx.db.prepare("SELECT * FROM decisions WHERE proposal_id = ? ORDER BY created_at").all(id) as Array<{ id: string; proposal_version: number; actor: string; decision: string; note: string; created_at: string }>;
  const exec = ctx.db.prepare("SELECT id FROM executions WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as { id: string } | undefined;
  const now = ctx.now().getTime();
  return {
    id,
    requestId: p.request_id,
    version: p.current_version,
    status: cur.status,
    decisionState: p.decision_state,
    needsConfirmation: cur.status !== "submitted",
    mode: cur.mode,
    offer: cur.data.offer,
    evaluation: cur.data.evaluation,
    quantity: cur.data.quantity,
    requestVersion: cur.data.requestVersion,
    runId: cur.data.runId,
    agentConfig: cur.data.agentConfig,
    justification: cur.data.justification,
    alternatives: cur.data.alternatives,
    unresolved: cur.data.unresolved,
    amounts: {
      researchListedSubtotalCents: cur.data.evaluation.cost.listedSubtotalCents,
      researchKnownComparableCostCents: cur.data.evaluation.cost.knownComparableCostCents,
      totalStatus: cur.data.evaluation.cost.totalStatus,
      requestBudgetCeilingCents: cur.data.requestBudgetCents,
      exactAmountCents: cur.exact_amount_cents,
      exactAmountSource: cur.amount_source,
    },
    technicalReviewConfirmed: !!cur.technical_review_confirmed,
    offerStale: Date.parse(cur.data.offer.expiresAt) < now,
    budgetAssessment: assessBudget({
      amountCents: cur.exact_amount_cents ?? cur.data.evaluation.cost.knownComparableCostCents,
      amountBasis: cur.exact_amount_cents ? "user_confirmed_exact" : cur.data.evaluation.cost.shippingCents === null ? "listed_subtotal" : "subtotal_plus_shipping",
      requestBudgetCents: cur.data.requestBudgetCents,
      financial: cachedFinancial(ctx),
    }),
    decisions: decisions.map((d) => ({ id: d.id, version: d.proposal_version, actor: d.actor, decision: d.decision, note: d.note, createdAt: d.created_at, demoIdentity: true })),
    executionId: exec?.id ?? null,
    versions: versions.map((v) => ({ version: v.version, status: v.status, offerId: v.data.offer.id, exactAmountCents: v.exact_amount_cents, createdAt: v.created_at, submittedAt: v.submitted_at })),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export function listProposals(ctx: AppContext, opts: { decisionState?: string; limit: number }) {
  const rows = (opts.decisionState
    ? ctx.db.prepare("SELECT id FROM proposals WHERE decision_state = ? ORDER BY updated_at DESC LIMIT ?").all(opts.decisionState, opts.limit)
    : ctx.db.prepare("SELECT id FROM proposals ORDER BY updated_at DESC LIMIT ?").all(opts.limit)) as Array<{ id: string }>;
  return rows.map((r) => {
    const v = getProposalView(ctx, r.id);
    return { id: v.id, requestId: v.requestId, version: v.version, decisionState: v.decisionState, title: v.offer.title, seller: v.offer.seller, imageUrl: v.offer.imageUrl, exactAmountCents: v.amounts.exactAmountCents, eligibility: v.evaluation.class, executionId: v.executionId, updatedAt: v.updatedAt };
  });
}
