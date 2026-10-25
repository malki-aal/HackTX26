// Nessie sandbox purchase execution, ambiguity handling and reconciliation.
// State machine: queued -> submitting -> recorded | failed | uncertain; uncertain -> recorded | failed (explicit).
// A POST is never repeated automatically; restarts turn "submitting" into "uncertain".
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { ReconcileBody } from "../contracts/domain.js";
import { AppError, IntegrationError, invalidState, notFound } from "../lib/errors.js";
import { scrub } from "../lib/redact.js";
import { formatUsd } from "../domain/money.js";
import type { NessiePurchase } from "../integrations/nessie.js";
import { NessieClient, fromNessieAmount } from "../integrations/nessie.js";
import { emitEvent } from "./events.js";
import { readFinancialContext } from "./budget.js";

type ExecRow = {
  id: string; proposal_id: string; proposal_version: number; decision_id: string; mode: string; account_id: string; merchant_id: string | null; amount_cents: number; provider_amount: string | null;
  description: string; status: string; provider_status: string | null; external_id: string | null; last_error: string | null; attempts: number; created_at: string; updated_at: string;
};

function loadExec(ctx: AppContext, id: string): ExecRow {
  const r = ctx.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecRow | undefined;
  if (!r) throw notFound("Execution", id);
  return r;
}

function requestIdFor(ctx: AppContext, proposalId: string): string | null {
  return (ctx.db.prepare("SELECT request_id FROM proposals WHERE id = ?").get(proposalId) as { request_id: string } | undefined)?.request_id ?? null;
}

/** Find or create the namespaced Nessie merchant that represents a seller in the sandbox. */
export async function ensureMerchant(ctx: AppContext, seller: string): Promise<string> {
  if (ctx.adapters.bank.source === "fixture") return "fixture_merchant";
  const name = `Runway sandbox: ${seller}`.slice(0, 80);
  const cached = ctx.db.prepare("SELECT external_id FROM nessie_resources WHERE kind = 'merchant' AND name = ?").get(name) as { external_id: string } | undefined;
  if (cached) return cached.external_id;
  const bank = ctx.adapters.bank;
  if (!(bank instanceof NessieClient)) throw new AppError("INTERNAL_ERROR", "Live bank adapter required to create merchants", 500);
  const created = await bank.create("/merchants", {
    name,
    // This deployment validates category as a string (an array is rejected with HTTP 400).
    category: "electronics",
    address: { street_number: "1", street_name: "Sandbox Way", city: "Austin", state: "TX", zip: "78701" },
    geocode: { lat: 30.2672, lng: -97.7431 },
  });
  const merchantId = created.object && typeof created.object._id === "string" ? created.object._id : null;
  if (!merchantId) throw new IntegrationError("nessie", "UPSTREAM_ERROR", "Nessie merchant creation returned no id", "definitive", false);
  ctx.db.prepare("INSERT OR IGNORE INTO nessie_resources (kind, name, external_id, payload, created_at) VALUES ('merchant', ?, ?, ?, ?)").run(name, merchantId, JSON.stringify({ seller }), nowIso());
  return merchantId;
}

function setStatus(ctx: AppContext, e: ExecRow, status: string, patch: { providerStatus?: string | null; externalId?: string | null; error?: string | null; providerAmount?: unknown } = {}) {
  ctx.db
    .prepare("UPDATE executions SET status = ?, provider_status = COALESCE(?, provider_status), external_id = COALESCE(?, external_id), last_error = ?, provider_amount = COALESCE(?, provider_amount), updated_at = ? WHERE id = ?")
    .run(status, patch.providerStatus ?? null, patch.externalId ?? null, patch.error ?? null, patch.providerAmount === undefined ? null : JSON.stringify(patch.providerAmount), nowIso(), e.id);
}

function releaseReservation(ctx: AppContext, executionId: string, note: string) {
  ctx.db.prepare("UPDATE budget_ledger SET status = 'released', note = ?, updated_at = ? WHERE execution_id = ? AND kind = 'reservation' AND status = 'active'").run(note, nowIso(), executionId);
}

function convertToExpense(ctx: AppContext, e: ExecRow, externalId: string, providerAmount: unknown) {
  const now = nowIso();
  ctx.db.prepare("UPDATE budget_ledger SET status = 'converted', updated_at = ? WHERE execution_id = ? AND kind = 'reservation' AND status = 'active'").run(now, e.id);
  ctx.db
    .prepare("INSERT OR IGNORE INTO budget_ledger (id, account_id, kind, amount_cents, status, execution_id, external_id, note, created_at, updated_at) VALUES (?, ?, 'expense', ?, 'unreflected', ?, ?, ?, ?, ?)")
    .run(`led_${randomUUID()}`, e.account_id, e.amount_cents, e.id, externalId, "Recorded Nessie sandbox purchase; subtracted locally until the reported balance reflects it", now, now);
  recordProviderAmount(ctx, e.id, providerAmount);
}

/**
 * Nessie stores whole-dollar amounts (observed: 587.56 sent, 587 stored). The ledger keeps the
 * approved amount (conservative) and remembers the stored amount for balance reconciliation.
 */
function recordProviderAmount(ctx: AppContext, executionId: string, providerAmount: unknown) {
  const cents = fromNessieAmount(providerAmount);
  if (cents === null) return;
  ctx.db.prepare("UPDATE budget_ledger SET provider_amount_cents = ?, updated_at = ? WHERE execution_id = ? AND kind = 'expense'").run(cents, nowIso(), executionId);
}

function markRecorded(ctx: AppContext, e: ExecRow, externalId: string, providerStatus: string | null, providerAmount: unknown, how: string) {
  tx(ctx.db, () => {
    setStatus(ctx, e, "recorded", { externalId, providerStatus, providerAmount });
    convertToExpense(ctx, e, externalId, providerAmount);
    emitEvent(ctx.db, { type: "execution_recorded", proposalId: e.proposal_id, requestId: requestIdFor(ctx, e.proposal_id), executionId: e.id, summary: `Nessie sandbox purchase recorded (${how})`, payload: { externalId, providerStatus, amountCents: e.amount_cents } });
  });
}

const matchesExecution = (e: ExecRow, p: NessiePurchase) => (p.description ?? "").includes(e.id) && (p.amountCents === null || p.amountCents === e.amount_cents);

/** Submit one queued execution. Persists "submitting" before the network call. */
export async function submitExecution(ctx: AppContext, executionId: string): Promise<void> {
  const e = loadExec(ctx, executionId);
  if (e.status !== "queued") throw invalidState(`Execution is ${e.status}; only queued executions can be submitted`);
  if (e.mode !== ctx.config.mode || (e.mode === "live" && ctx.adapters.bank.source !== "nessie_live")) {
    throw new AppError("MODE_MISMATCH", "Execution mode does not match the configured bank adapter", 409);
  }
  const reqId = requestIdFor(ctx, e.proposal_id);
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE executions SET status = 'submitting', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(nowIso(), e.id);
    emitEvent(ctx.db, { type: "execution_submitting", proposalId: e.proposal_id, requestId: reqId, executionId: e.id, summary: `Submitting ${formatUsd(e.amount_cents)} sandbox purchase to Nessie`, payload: { attempt: e.attempts + 1 } });
  });
  try {
    const res = await ctx.adapters.bank.createPurchase(e.account_id, { merchantId: e.merchant_id!, amountCents: e.amount_cents, description: e.description, date: nowIso().slice(0, 10) });
    if (res.externalId) {
      markRecorded(ctx, e, res.externalId, res.providerStatus, res.providerAmount, `HTTP ${res.httpStatus}`);
      await verifyReadBack(ctx, e.id);
      return;
    }
    // Success status without an id in the body: find it by our reference instead of guessing.
    const found = (await ctx.adapters.bank.listPurchases(e.account_id)).filter((p) => matchesExecution(e, p));
    if (found.length === 1) markRecorded(ctx, e, found[0]!.id, found[0]!.status, found[0]!.rawAmount, "found by reference after create");
    else markUncertain(ctx, e, `Nessie accepted the request (HTTP ${res.httpStatus}) but returned no id; ${found.length} matching purchases found`);
  } catch (err) {
    if (err instanceof IntegrationError && err.outcome === "definitive") {
      tx(ctx.db, () => {
        setStatus(ctx, e, "failed", { error: scrub(err.message) });
        releaseReservation(ctx, e.id, "Released: Nessie rejected the purchase");
        emitEvent(ctx.db, { type: "execution_failed", proposalId: e.proposal_id, requestId: reqId, executionId: e.id, summary: scrub(err.message), payload: { code: err.code, httpStatus: err.httpStatus } });
      });
      return;
    }
    markUncertain(ctx, e, err instanceof Error ? err.message : "unknown error");
  }
}

function markUncertain(ctx: AppContext, e: ExecRow, reason: string) {
  tx(ctx.db, () => {
    setStatus(ctx, e, "uncertain", { error: scrub(reason) });
    ctx.db.prepare("UPDATE budget_ledger SET note = ?, updated_at = ? WHERE execution_id = ? AND kind = 'reservation' AND status = 'active'").run("Hold retained: sandbox purchase outcome uncertain; reconcile before retrying", nowIso(), e.id);
    emitEvent(ctx.db, { type: "execution_uncertain", proposalId: e.proposal_id, requestId: requestIdFor(ctx, e.proposal_id), executionId: e.id, summary: "Purchase outcome uncertain; reconcile before any retry", payload: { reason: scrub(reason) } });
  });
}

async function verifyReadBack(ctx: AppContext, executionId: string) {
  const e = loadExec(ctx, executionId);
  if (!e.external_id) return;
  try {
    const p = await ctx.adapters.bank.getPurchase(e.external_id);
    if (p) {
      setStatus(ctx, e, e.status, { providerStatus: p.status, providerAmount: p.rawAmount });
      recordProviderAmount(ctx, e.id, p.rawAmount);
    }
  } catch {
    // Read-back is informational; the record is already confirmed by the create response.
  }
}

/** Startup recovery: a crash during submission leaves the outcome unknown. Never resend blindly. */
export function recoverInterruptedExecutions(ctx: AppContext) {
  const rows = ctx.db.prepare("SELECT * FROM executions WHERE status = 'submitting'").all() as ExecRow[];
  for (const e of rows) markUncertain(ctx, e, "Server restarted while the purchase was being submitted");
}

export async function reconcileExecution(ctx: AppContext, executionId: string, body: unknown) {
  const parsed = ReconcileBody.parse(body ?? {});
  const e = loadExec(ctx, executionId);
  const notes: string[] = [];
  if (parsed.action === "submit_queued") {
    if (e.status !== "queued") throw invalidState(`Execution is ${e.status}; only queued executions can be submitted`);
    await submitExecution(ctx, e.id);
    notes.push("Queued execution submitted once");
  } else {
    if (e.status === "queued") notes.push("Execution has not been sent; use action submit_queued to send it");
    if (["uncertain", "recorded", "submitting"].includes(e.status)) {
      const purchases = await ctx.adapters.bank.listPurchases(e.account_id);
      const matches = purchases.filter((p) => matchesExecution(e, p));
      if (e.status === "recorded") {
        const p = matches.find((m) => m.id === e.external_id) ?? (e.external_id ? await ctx.adapters.bank.getPurchase(e.external_id) : null);
        if (p) {
          setStatus(ctx, e, "recorded", { providerStatus: p.status, providerAmount: p.rawAmount });
          recordProviderAmount(ctx, e.id, p.rawAmount);
          notes.push(`External purchase ${p.id} present with status ${p.status ?? "unknown"}`);
        } else notes.push("Recorded purchase was not found in the account listing; leaving status unchanged");
        if (matches.length > 1) notes.push(`Warning: ${matches.length} purchases reference this execution`);
      } else if (matches.length === 1) {
        markRecorded(ctx, e, matches[0]!.id, matches[0]!.status, matches[0]!.rawAmount, "reconciled by reference");
        notes.push(`Found purchase ${matches[0]!.id} by execution reference; marked recorded`);
      } else if (matches.length > 1) {
        notes.push(`${matches.length} purchases reference this execution; left uncertain for manual review`);
      } else if (parsed.action === "mark_failed") {
        tx(ctx.db, () => {
          setStatus(ctx, e, "failed", { error: `Marked failed by ${parsed.actor} after reconciliation found no purchase. ${parsed.note}`.trim() });
          releaseReservation(ctx, e.id, "Released after explicit reconciliation");
        });
        notes.push("No matching purchase found; marked failed and released the hold");
      } else {
        notes.push("No matching purchase found. The hold remains. If you have confirmed in Nessie that no purchase exists, call again with action mark_failed.");
      }
    } else if (parsed.action === "mark_failed") {
      throw invalidState(`Execution is ${e.status}; only uncertain executions can be marked failed`);
    }
  }
  const fin = await readFinancialContext(ctx, { refresh: true }).catch(() => null);
  if (fin?.context.reconciliationNotes.length) notes.push(...fin.context.reconciliationNotes);
  emitEvent(ctx.db, { type: "reconciliation_completed", proposalId: e.proposal_id, requestId: requestIdFor(ctx, e.proposal_id), executionId: e.id, summary: notes[0] ?? "Reconciled", payload: { action: parsed.action, notes } });
  return { ...getExecutionView(ctx, e.id), reconciliationNotes: notes };
}

export function getExecutionView(ctx: AppContext, id: string) {
  const e = loadExec(ctx, id);
  const ledger = ctx.db.prepare("SELECT kind, amount_cents, status, note, external_id FROM budget_ledger WHERE execution_id = ? ORDER BY created_at").all(id) as Array<{ kind: string; amount_cents: number; status: string; note: string; external_id: string | null }>;
  const providerCents = e.provider_amount ? fromNessieAmount(json(e.provider_amount)) : null;
  return {
    id: e.id,
    proposalId: e.proposal_id,
    proposalVersion: e.proposal_version,
    mode: e.mode,
    status: e.status,
    providerStatus: e.provider_status,
    externalReference: e.external_id ? { provider: e.mode === "live" ? "nessie" : "fixture", purchaseId: e.external_id, accountId: e.account_id, merchantId: e.merchant_id } : null,
    amountCents: e.amount_cents,
    amountSource: "user_confirmed",
    providerAmountRaw: e.provider_amount ? json(e.provider_amount) : null,
    providerAmountCents: providerCents,
    amountDiscrepancyCents: providerCents === null ? null : e.amount_cents - providerCents,
    amountNote:
      providerCents !== null && providerCents !== e.amount_cents
        ? `Nessie stored ${formatUsd(providerCents)} (it keeps whole dollars); the approved amount ${formatUsd(e.amount_cents)} remains the budget figure`
        : null,
    description: e.description,
    lastError: e.last_error,
    attempts: e.attempts,
    ledger: ledger.map((l) => ({ kind: l.kind, amountCents: l.amount_cents, status: l.status, note: l.note, externalId: l.external_id })),
    disclaimer: "Simulated purchase in the Capital One Nessie sandbox. No real money moved and no merchant order was placed.",
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}
