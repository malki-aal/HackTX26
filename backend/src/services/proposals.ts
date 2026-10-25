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
import { itemView, loadRequest, loadVersion, setRequestStatus } from "./requests.js";
import { loadRun } from "./research.js";
import { loadLedger, readFinancialContext, resolveAccountId } from "./budget.js";
import { getExecutionView, submitExecution } from "./executions.js";
import { getMapping } from "./merchants.js";
import { actorInfo, requireExecutive, requireMember, type Principal } from "../auth/access.js";
import { proposalAccess } from "../auth/scope.js";
import { describeRequirement } from "../domain/requirements.js";
import { projectCommittedCents } from "./projects.js";

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
  /** Set at submission: the requester's verification or deliberate exception per unconfirmed mandatory requirement. */
  requirementResolutions?: Array<{ requirementId: string; attribute: string; evidenceReason: string; kind: "verified" | "exception"; note: string; recordedAt: string }>;
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

export function createProposal(ctx: AppContext, requestId: string, body: unknown & { proposalId?: string }, actorId = "employee-demo") {
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
    createdBy: actorId,
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
  // Unconfirmed mandatory requirements are never treated as met. Each needs the requester's documented
  // verification or a deliberate exception, recorded with this version for the reviewer.
  const open = pv.data.evaluation.requirementResults.filter((r) => r.mandatory && r.state === "unknown");
  const given = new Map(parsed.requirementResolutions.map((r) => [r.requirementId, r]));
  const extra = parsed.requirementResolutions.filter((r) => !open.some((o) => o.requirementId === r.requirementId));
  if (extra.length) throw new AppError("VALIDATION_ERROR", "requirementResolutions may only cover mandatory requirements the evidence left unconfirmed", 422, false, { requirementIds: extra.map((r) => r.requirementId) });
  const missing = open.filter((o) => !given.has(o.requirementId));
  if (missing.length) {
    throw new AppError("UNRESOLVED_REQUIREMENTS", `Verify or record an exception for ${missing.length} unconfirmed mandatory requirement${missing.length === 1 ? "" : "s"} before submitting`, 422, false, {
      requirements: missing.map((m) => ({ requirementId: m.requirementId, attribute: m.attribute, reason: m.reason })),
    });
  }
  const now = nowIso();
  const resolutions = open.map((o) => ({ requirementId: o.requirementId, attribute: o.attribute, evidenceReason: o.reason, kind: given.get(o.requirementId)!.kind, note: given.get(o.requirementId)!.note, recordedAt: now }));
  tx(ctx.db, () => {
    // The version is still a draft here, so recording the resolutions with it rewrites no submitted history.
    if (resolutions.length) ctx.db.prepare("UPDATE proposal_versions SET payload = ? WHERE proposal_id = ? AND version = ?").run(JSON.stringify({ ...pv.data, requirementResolutions: resolutions }), id, parsed.version);
    ctx.db.prepare("UPDATE proposal_versions SET status = 'submitted', exact_amount_cents = ?, amount_source = ?, technical_review_confirmed = 1, submitted_at = ? WHERE proposal_id = ? AND version = ?").run(parsed.exactAmountCents, parsed.amountSource, now, id, parsed.version);
    ctx.db.prepare("UPDATE proposals SET decision_state = 'awaiting_review', updated_at = ? WHERE id = ?").run(now, id);
    setRequestStatus(ctx, pv.data.requestId, "submitted");
    emitEvent(ctx.db, { type: "proposal_submitted", requestId: pv.data.requestId, proposalId: id, summary: `Submitted for ${formatUsd(parsed.exactAmountCents)} (user-confirmed amount)`, payload: { version: parsed.version, exactAmountCents: parsed.exactAmountCents, amountSource: parsed.amountSource, resolutions: resolutions.map((r) => ({ requirementId: r.requirementId, kind: r.kind })) } });
  });
  return getProposalView(ctx, id);
}

// ---------- Decisions ----------

function hashBody(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

export function approvalStatement(amountCents: number): string {
  return `I approve this simulated purchase for ${formatUsd(amountCents)} and understand that it commits this amount from the available company budget.`;
}

function insertDecision(
  ctx: AppContext,
  d: { id: string; proposalId: string; version: number; actor: Principal; decision: string; note: string; now: string; confirmedAmountCents?: number },
) {
  const approve = d.decision === "approve";
  ctx.db
    .prepare(
      "INSERT INTO decisions (id, proposal_id, proposal_version, actor, decision, note, created_at, actor_display, confirmed_version, confirmed_amount_cents, confirmed_at, confirmation_statement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      d.id,
      d.proposalId,
      d.version,
      d.actor.userId,
      d.decision,
      d.note,
      d.now,
      d.actor.displayName,
      approve ? d.version : null,
      approve ? (d.confirmedAmountCents ?? null) : null,
      approve ? d.now : null,
      approve ? approvalStatement(d.confirmedAmountCents!) : null,
    );
}

/**
 * Record an executive decision. Idempotency is bound to the signed-in actor and the exact intended
 * operation: the same key and payload replays the stored result; changed terms conflict.
 */
export async function decideProposal(ctx: AppContext, id: string, body: unknown, idempotencyKey: string | undefined, actor: Principal): Promise<{ status: number; body: unknown }> {
  if (!idempotencyKey || !/^[\w.:-]{8,128}$/.test(idempotencyKey)) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header (8-128 chars of [A-Za-z0-9_.:-]) is required", 400);
  requireExecutive(actor);
  proposalAccess(ctx, actor, id, "read");
  const parsed = DecisionBody.parse(body);
  const scope = `decision:${id}:${actor.userId}`;
  const { actor: _declared, ...intended } = parsed;
  const hash = hashBody({ id, actor: actor.userId, ...intended });
  const existing = ctx.db.prepare("SELECT request_hash, status_code, response FROM idempotency_records WHERE scope = ? AND idem_key = ?").get(scope, idempotencyKey) as { request_hash: string; status_code: number | null; response: string | null } | undefined;
  if (existing) {
    if (existing.request_hash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with different terms", 409);
    if (existing.response === null) throw new AppError("IDEMPOTENCY_CONFLICT", "A request with this Idempotency-Key is still in progress", 409, true);
    return { status: existing.status_code!, body: json(existing.response) };
  }
  ctx.db.prepare("INSERT INTO idempotency_records (scope, idem_key, request_hash, created_at) VALUES (?, ?, ?, ?)").run(scope, idempotencyKey, hash, nowIso());
  try {
    const result = await decide(ctx, id, parsed, actor);
    ctx.db.prepare("UPDATE idempotency_records SET status_code = ?, response = ? WHERE scope = ? AND idem_key = ?").run(200, JSON.stringify(result), scope, idempotencyKey);
    return { status: 200, body: result };
  } catch (e) {
    // Failed validation is not a logical result; allow the key to be reused after fixing the cause.
    ctx.db.prepare("DELETE FROM idempotency_records WHERE scope = ? AND idem_key = ? AND response IS NULL").run(scope, idempotencyKey);
    throw e;
  }
}

async function decide(ctx: AppContext, id: string, parsed: ReturnType<typeof DecisionBody.parse>, actor: Principal) {
  const p = loadProposal(ctx, id);
  if (parsed.version !== p.current_version) throw versionConflict(parsed.version, p.current_version);
  const pv = loadProposalVersion(ctx, id, parsed.version);
  if (p.decision_state !== "awaiting_review" || pv.status !== "submitted") throw invalidState(`Proposal is ${p.decision_state}; only submitted proposals awaiting review can be decided`, { decisionState: p.decision_state });
  const reqRow = ctx.db.prepare("SELECT created_by FROM requests WHERE id = ?").get(pv.data.requestId) as { created_by: string };
  // Separation of duties: nobody decides on their own proposal.
  if (actor.kind === "user" && reqRow.created_by === actor.userId) throw new AppError("SELF_APPROVAL_NOT_ALLOWED", "You cannot decide on your own proposal", 403);
  const req = loadRequest(ctx, pv.data.requestId);
  if (req.current_version !== pv.data.requestVersion) throw new AppError("VERSION_CONFLICT", "Requirements changed after this proposal was submitted; a new proposal is required", 409);
  const now = nowIso();
  const decisionId = `dec_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  if (parsed.decision !== "approve") {
    // Request changes and reject never create a purchase or a spending reservation.
    const state = parsed.decision === "reject" ? "rejected" : "changes_requested";
    tx(ctx.db, () => {
      insertDecision(ctx, { id: decisionId, proposalId: id, version: parsed.version, actor, decision: parsed.decision, note: parsed.note, now });
      ctx.db.prepare("UPDATE proposals SET decision_state = ?, updated_at = ? WHERE id = ?").run(state, now, id);
      setRequestStatus(ctx, pv.data.requestId, state);
      emitEvent(ctx.db, { type: "decision_recorded", requestId: pv.data.requestId, proposalId: id, summary: `Executive ${state.replace("_", " ")}`, payload: { decision: parsed.decision, version: parsed.version, actor: actor.userId, hasNote: parsed.note.length > 0 } });
    });
    return getProposalView(ctx, id, actor);
  }

  // The approver must confirm exactly the terms the server holds for this revision.
  const c = parsed.confirmation;
  if (!c || c.confirmed !== true) {
    throw new AppError("CONFIRMATION_REQUIRED", "Approval requires confirming the exact proposal revision and amount", 422, false, { proposalVersion: parsed.version, exactAmountCents: pv.exact_amount_cents, statement: approvalStatement(pv.exact_amount_cents!) });
  }
  if (c.proposalVersion !== parsed.version || c.exactAmountCents !== pv.exact_amount_cents) {
    throw new AppError("TERMS_CHANGED", "The confirmed revision or amount does not match the proposal; review it again and re-confirm", 409, false, { proposalVersion: parsed.version, exactAmountCents: pv.exact_amount_cents });
  }

  // ---- Approval: checks first, then an atomic reservation, then exactly one provider write. ----
  if (pv.mode !== ctx.config.mode) throw new AppError("MODE_MISMATCH", `Proposal was created in ${pv.mode} mode and cannot execute in ${ctx.config.mode} mode`, 409);
  const amount = pv.exact_amount_cents!;
  if (Date.parse(pv.data.offer.expiresAt) < ctx.now().getTime()) {
    throw new AppError("OFFER_STALE", `Offer evidence observed at ${pv.data.offer.observedAt} has expired; rerun research and resubmit`, 409, false, { observedAt: pv.data.offer.observedAt, expiresAt: pv.data.offer.expiresAt });
  }
  if (amount > pv.data.requestBudgetCents) throw new AppError("BUDGET_EXCEEDED", `Exact amount ${formatUsd(amount)} exceeds the request budget ${formatUsd(pv.data.requestBudgetCents)}`, 409);
  // The researched seller must already be explicitly mapped to a Nessie sandbox merchant.
  const mapping = getMapping(ctx, pv.data.offer.seller);
  if (!mapping) {
    throw new AppError("MERCHANT_MAPPING_REQUIRED", `Seller "${pv.data.offer.seller ?? "unknown"}" has no Nessie sandbox merchant mapping; create one before approving`, 409, false, {
      seller: pv.data.offer.seller,
      endpoint: "POST /api/v1/merchant-mappings",
    });
  }
  const fin = await readFinancialContext(ctx, { refresh: true });
  if (!fin.fresh || fin.context.availableBudgetCents === null || !fin.context.accountId) {
    throw new AppError("BANK_CHECK_UNAVAILABLE", `Bank context could not be refreshed: ${fin.error ?? "unavailable"}`, 503, true);
  }
  const accountId = fin.context.accountId;
  const merchantId = mapping.nessieMerchantId;
  const executionId = `exe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const projectId = (ctx.db.prepare("SELECT project_id FROM requests WHERE id = ?").get(pv.data.requestId) as { project_id: string | null }).project_id;
  tx(ctx.db, () => {
    // A project's budget is a hard cap across its lines, checked under the same write lock.
    if (projectId) {
      const cap = (ctx.db.prepare("SELECT budget_cents FROM projects WHERE id = ?").get(projectId) as { budget_cents: number }).budget_cents;
      const committed = projectCommittedCents(ctx, projectId);
      if (committed + amount > cap) {
        throw new AppError("BUDGET_EXCEEDED", `Approving ${formatUsd(amount)} would exceed the project budget ${formatUsd(cap)} (${formatUsd(committed)} already committed)`, 409, false, { projectId, projectBudgetCents: cap, committedCents: committed });
      }
    }
    // Recompute availability inside the write lock so concurrent approvals serialize.
    const snapCtx = computeFinancialContext(
      { accountId, balanceCents: fin.context.reportedBalanceCents!, bills: [], fetchedAt: fin.context.fetchedAt!, source: "nessie_live" },
      loadLedger(ctx, accountId),
    );
    const available = snapCtx.availableBudgetCents! - fin.context.obligationsCents;
    if (amount > available) throw new AppError("BUDGET_EXCEEDED", `Exact amount ${formatUsd(amount)} exceeds available funds ${formatUsd(Math.max(0, available))}`, 409, false, { availableBudgetCents: available });
    const already = ctx.db.prepare("SELECT 1 FROM decisions WHERE proposal_id = ? AND proposal_version = ?").get(id, parsed.version);
    if (already) throw invalidState("This proposal version already has a decision");
    insertDecision(ctx, { id: decisionId, proposalId: id, version: parsed.version, actor, decision: "approve", note: parsed.note, now, confirmedAmountCents: amount });
    const description = `Runway ${executionId} | ${pv.data.offer.title.replace(/\[FIXTURE\]\s*/, "").slice(0, 60)} x${pv.data.quantity} | seller ${pv.data.offer.seller ?? "unknown"}`.slice(0, 200);
    ctx.db
      .prepare(
        "INSERT INTO executions (id, proposal_id, proposal_version, decision_id, mode, account_id, merchant_id, amount_cents, description, status, created_at, updated_at, approved_at, account_masked, merchant_mapping) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
      )
      .run(executionId, id, parsed.version, decisionId, ctx.config.mode, accountId, merchantId, amount, description, now, now, now, fin.accountMasked ?? null, JSON.stringify(mapping));
    ctx.db
      .prepare("INSERT INTO budget_ledger (id, account_id, kind, amount_cents, status, execution_id, note, created_at, updated_at) VALUES (?, ?, 'reservation', ?, 'active', ?, ?, ?, ?)")
      .run(`led_${randomUUID()}`, accountId, amount, executionId, "Application budget hold for approved sandbox purchase", now, now);
    ctx.db.prepare("UPDATE proposals SET decision_state = 'approved', updated_at = ? WHERE id = ?").run(now, id);
    setRequestStatus(ctx, pv.data.requestId, "approved");
    emitEvent(ctx.db, { type: "decision_recorded", requestId: pv.data.requestId, proposalId: id, executionId, summary: `Executive approved ${formatUsd(amount)}`, payload: { decision: "approve", version: parsed.version, actor: actor.userId, amountCents: amount, hasNote: parsed.note.length > 0 } });
    emitEvent(ctx.db, { type: "execution_queued", requestId: pv.data.requestId, proposalId: id, executionId, summary: "Sandbox purchase queued", payload: { amountCents: amount, accountId } });
  });
  await submitExecution(ctx, executionId);
  return { ...getProposalView(ctx, id, actor), execution: getExecutionView(ctx, executionId) };
}

// ---------- Financial preview ----------

export interface FinancialPreview {
  proposalId: string;
  proposalVersion: number;
  currency: "USD";
  label: string;
  currentAvailableCents: number | null;
  exactExpenseCents: number | null;
  projectedAvailableCents: number | null;
  reservationIncluded: boolean;
  freshness: { source: string; fetchedAt: string | null; refreshedNow: boolean; status: string };
  canApprove: boolean;
  blockingReasons: Array<{ code: string; message: string }>;
  amounts: {
    researchListedSubtotalCents: number | null;
    budgetCeilingCents: number;
    exactExpenseCents: number | null;
    amountSource: string | null;
    approvedAmountCents: number | null;
    providerStoredAmountCents: number | null;
    discrepancyCents: number | null;
  };
  unknowns: string[];
  project: { id: string; budgetCents: number; committedCents: number; projectedCommittedCents: number } | null;
  notes: string[];
}

/**
 * What approving this proposal would do to the application's available budget. Uses the canonical
 * ledger; a proposal whose reservation or expense is already in the ledger is never subtracted again.
 */
export async function financialPreview(ctx: AppContext, id: string, opts: { refresh: boolean }): Promise<FinancialPreview> {
  const p = loadProposal(ctx, id);
  const pv = loadProposalVersion(ctx, id, p.current_version);
  const read = opts.refresh ? await readFinancialContext(ctx, { refresh: true }) : { context: cachedFinancial(ctx), fresh: false };
  const fin = read.context;
  const exec = ctx.db.prepare("SELECT id, status FROM executions WHERE proposal_id = ? AND proposal_version = ? AND status != 'failed'").get(id, p.current_version) as { id: string; status: string } | undefined;
  const reservationIncluded = !!exec;
  const exact = pv.exact_amount_cents;
  const available = fin.availableBudgetCents;
  const projected = available === null || exact === null ? null : reservationIncluded ? available : available - exact;
  const blocking: Array<{ code: string; message: string }> = [];
  if (p.decision_state !== "awaiting_review") blocking.push({ code: "not_awaiting_review", message: `Proposal is ${p.decision_state}` });
  if (exact === null) blocking.push({ code: "no_exact_amount", message: "The employee has not confirmed an exact amount" });
  if (available === null) blocking.push({ code: "bank_check_unavailable", message: "No verified bank context; refresh before approving" });
  else if (exact !== null && !reservationIncluded && exact > available) blocking.push({ code: "exceeds_available_budget", message: `${formatUsd(exact)} exceeds available ${formatUsd(Math.max(0, available))}` });
  if (exact !== null && exact > pv.data.requestBudgetCents) blocking.push({ code: "exceeds_request_budget", message: `${formatUsd(exact)} exceeds the request budget ${formatUsd(pv.data.requestBudgetCents)}` });
  const projectRow = ctx.db.prepare("SELECT r.project_id, pr.budget_cents FROM requests r LEFT JOIN projects pr ON pr.id = r.project_id WHERE r.id = ?").get(pv.data.requestId) as { project_id: string | null; budget_cents: number | null };
  let project: FinancialPreview["project"] = null;
  if (projectRow.project_id) {
    const committed = projectCommittedCents(ctx, projectRow.project_id);
    const projectedCommitted = committed + (reservationIncluded || exact === null ? 0 : exact);
    project = { id: projectRow.project_id, budgetCents: projectRow.budget_cents!, committedCents: committed, projectedCommittedCents: projectedCommitted };
    if (projectedCommitted > projectRow.budget_cents!) blocking.push({ code: "exceeds_project_budget", message: `Would commit ${formatUsd(projectedCommitted)} of the ${formatUsd(projectRow.budget_cents!)} project budget` });
  }
  if (Date.parse(pv.data.offer.expiresAt) < ctx.now().getTime()) blocking.push({ code: "offer_stale", message: "Offer evidence has expired; the employee must rerun research" });
  if (!getMapping(ctx, pv.data.offer.seller)) blocking.push({ code: "merchant_mapping_required", message: `Seller "${pv.data.offer.seller ?? "unknown"}" has no Nessie sandbox merchant mapping` });
  const req = loadRequest(ctx, pv.data.requestId);
  if (req.current_version !== pv.data.requestVersion) blocking.push({ code: "requirements_changed", message: "Requirements changed after submission" });
  const execView = exec ? getExecutionView(ctx, exec.id) : null;
  return {
    proposalId: id,
    proposalVersion: p.current_version,
    currency: "USD",
    label: "Available budget from Runway's ledger (balance minus pending bills, reservations and unreflected expenses). Not a bank balance.",
    currentAvailableCents: available,
    exactExpenseCents: exact,
    projectedAvailableCents: projected,
    reservationIncluded,
    freshness: { source: fin.source, fetchedAt: fin.fetchedAt, refreshedNow: opts.refresh && read.fresh, status: fin.status },
    canApprove: blocking.length === 0,
    blockingReasons: blocking,
    amounts: {
      researchListedSubtotalCents: pv.data.evaluation.cost.listedSubtotalCents,
      budgetCeilingCents: pv.data.requestBudgetCents,
      exactExpenseCents: exact,
      amountSource: pv.amount_source,
      approvedAmountCents: execView?.approvedAmountCents ?? null,
      providerStoredAmountCents: execView?.providerStoredAmountCents ?? null,
      discrepancyCents: execView?.amountDiscrepancyCents ?? null,
    },
    unknowns: ["Sales tax", ...(pv.data.offer.shipping.status === "unknown" ? ["Shipping"] : [])],
    project,
    notes: fin.reconciliationNotes,
  };
}

// ---------- Views ----------

type DecisionRow = {
  id: string; proposal_version: number; actor: string; decision: string; note: string; created_at: string; actor_display: string | null;
  confirmed_version: number | null; confirmed_amount_cents: number | null; confirmed_at: string | null; confirmation_statement: string | null;
};

/**
 * Full proposal detail. Executives (and demo views) see the budget assessment; employees see their
 * own proposal without company account figures.
 */
export function getProposalView(ctx: AppContext, id: string, viewer?: Principal) {
  const p = loadProposal(ctx, id);
  const versions = (ctx.db.prepare("SELECT * FROM proposal_versions WHERE proposal_id = ? ORDER BY version").all(id) as VersionRow[]).map((v) => ({ ...v, data: json<ProposalPayload>(v.payload) }));
  const cur = versions[versions.length - 1]!;
  const decisions = ctx.db.prepare("SELECT * FROM decisions WHERE proposal_id = ? ORDER BY created_at").all(id) as DecisionRow[];
  const exec = ctx.db.prepare("SELECT id FROM executions WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as { id: string } | undefined;
  const reqRow = ctx.db.prepare("SELECT created_by, project_id FROM requests WHERE id = ?").get(p.request_id) as { created_by: string; project_id: string | null };
  const reqVersion = loadVersion(ctx, p.request_id, cur.data.requestVersion);
  const now = ctx.now().getTime();
  const seesAccount = !viewer || viewer.role === "executive";
  const assessment = assessBudget({
    amountCents: cur.exact_amount_cents ?? cur.data.evaluation.cost.knownComparableCostCents,
    amountBasis: cur.exact_amount_cents ? "user_confirmed_exact" : cur.data.evaluation.cost.shippingCents === null ? "listed_subtotal" : "subtotal_plus_shipping",
    requestBudgetCents: cur.data.requestBudgetCents,
    financial: cachedFinancial(ctx),
  });
  return {
    id,
    requestId: p.request_id,
    projectId: reqRow.project_id,
    version: p.current_version,
    status: cur.status,
    decisionState: p.decision_state,
    needsConfirmation: cur.status !== "submitted",
    mode: cur.mode,
    requester: actorInfo(ctx, reqRow.created_by),
    request: {
      title: reqVersion.fields.title,
      purpose: reqVersion.fields.purpose,
      item: itemView(reqVersion.fields),
      quantity: reqVersion.fields.quantity,
      unit: reqVersion.fields.unit,
      deadline: reqVersion.fields.deadline,
      deadlineType: reqVersion.fields.deadlineType,
      requirements: reqVersion.requirements.map((r) => ({ ...r, display: describeRequirement(r) })),
    },
    offer: cur.data.offer,
    evaluation: cur.data.evaluation,
    quantity: cur.data.quantity,
    requestVersion: cur.data.requestVersion,
    runId: cur.data.runId,
    agentConfig: cur.data.agentConfig,
    justification: cur.data.justification,
    alternatives: cur.data.alternatives,
    unresolved: cur.data.unresolved,
    requirementResolutions: cur.data.requirementResolutions ?? [],
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
    budgetAssessment: seesAccount ? assessment : { ...assessment, availableBudgetCents: null, notes: ["Company account figures are visible to executives"] },
    decisions: decisions.map((d) => ({
      id: d.id,
      version: d.proposal_version,
      decision: d.decision,
      resultingState: d.decision === "approve" ? "approved" : d.decision === "reject" ? "rejected" : "changes_requested",
      note: d.note,
      actor: d.actor,
      actorInfo: actorInfo(ctx, d.actor) ?? { id: d.actor, displayName: d.actor_display ?? d.actor, role: null, demoIdentity: false },
      createdAt: d.created_at,
      confirmation: d.confirmed_at ? { proposalVersion: d.confirmed_version, exactAmountCents: d.confirmed_amount_cents, confirmedAt: d.confirmed_at, statement: d.confirmation_statement } : null,
      demoIdentity: d.actor === "executive-demo" || d.actor === "employee-demo",
    })),
    executionId: exec?.id ?? null,
    versions: versions.map((v) => ({ version: v.version, status: v.status, offerId: v.data.offer.id, exactAmountCents: v.exact_amount_cents, createdAt: v.created_at, submittedAt: v.submitted_at })),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const DECISION_STATES = ["not_submitted", "awaiting_review", "approved", "changes_requested", "rejected"] as const;

/**
 * Review queue and submission list. Executives see their company; employees see their own.
 * Ordered by last update (newest first) with a cursor; `updatedAfter` supports cheap polling.
 */
export function listProposals(ctx: AppContext, viewer: Principal, opts: { decisionState?: string; limit: number; cursor?: string | null; updatedAfter?: string | null }) {
  requireMember(viewer);
  if (opts.decisionState && !DECISION_STATES.includes(opts.decisionState as never)) throw new AppError("VALIDATION_ERROR", `decisionState must be one of ${DECISION_STATES.join(", ")}`, 422);
  const where: string[] = ["r.org_id = ?"];
  const params: Array<string | number> = [viewer.orgId];
  if (viewer.role !== "executive") {
    where.push("r.created_by = ?");
    params.push(viewer.userId);
  }
  const scopeWhere = where.join(" AND ");
  const scopeParams = [...params];
  if (opts.decisionState) {
    where.push("p.decision_state = ?");
    params.push(opts.decisionState);
  }
  if (opts.updatedAfter) {
    // Inclusive so an update in the same millisecond as serverTime is never missed; clients dedupe by id.
    where.push("p.updated_at >= ?");
    params.push(opts.updatedAfter);
  }
  if (opts.cursor) {
    const [u, pid] = Buffer.from(opts.cursor, "base64url").toString().split("|");
    where.push("(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))");
    params.push(u!, u!, pid!);
  }
  const rows = ctx.db
    .prepare(`SELECT p.id, p.updated_at FROM proposals p JOIN requests r ON r.id = p.request_id WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.id DESC LIMIT ?`)
    .all(...params, opts.limit + 1) as Array<{ id: string; updated_at: string }>;
  const page = rows.slice(0, opts.limit);
  const countRows = ctx.db.prepare(`SELECT p.decision_state AS s, COUNT(*) AS n FROM proposals p JOIN requests r ON r.id = p.request_id WHERE ${scopeWhere} GROUP BY p.decision_state`).all(...scopeParams) as Array<{ s: string; n: number }>;
  const counts = Object.fromEntries(DECISION_STATES.map((s) => [s, countRows.find((c) => c.s === s)?.n ?? 0]));
  const items = page.map((r) => {
    const v = getProposalView(ctx, r.id, viewer);
    const exec = v.executionId ? (ctx.db.prepare("SELECT status, provider_status FROM executions WHERE id = ?").get(v.executionId) as { status: string; provider_status: string | null }) : null;
    const last = v.decisions[v.decisions.length - 1] ?? null;
    return {
      id: v.id,
      requestId: v.requestId,
      projectId: v.projectId,
      version: v.version,
      title: v.request.title,
      item: v.request.item,
      quantity: v.request.quantity,
      unit: v.request.unit,
      deadline: v.request.deadline,
      deadlineType: v.request.deadlineType,
      employee: v.requester,
      decisionState: v.decisionState,
      executionStatus: exec?.status ?? "not_started",
      providerStatus: exec?.provider_status ?? null,
      offer: { id: v.offer.id, title: v.offer.title, seller: v.offer.seller, sourceUrl: v.offer.sourceUrl, imageUrl: v.offer.imageUrl, observedAt: v.offer.observedAt },
      exactAmountCents: v.amounts.exactAmountCents,
      eligibility: v.evaluation.class,
      unresolved: v.unresolved,
      offerStale: v.offerStale,
      latestDecision: last ? { decision: last.decision, resultingState: last.resultingState, note: last.note, actor: last.actorInfo, version: last.version, createdAt: last.createdAt } : null,
      submittedAt: v.versions.find((x) => x.version === v.version)?.submittedAt ?? null,
      executionId: v.executionId,
      // Back-compat fields from v1 list items.
      seller: v.offer.seller,
      imageUrl: v.offer.imageUrl,
      updatedAt: v.updatedAt,
    };
  });
  return {
    items,
    counts,
    nextCursor: rows.length > opts.limit ? Buffer.from(`${page[page.length - 1]!.updated_at}|${page[page.length - 1]!.id}`).toString("base64url") : null,
    // Same clock as proposals.updated_at, so it can be passed back as updatedAfter.
    serverTime: nowIso(),
  };
}
