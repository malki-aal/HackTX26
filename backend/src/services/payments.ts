// The employee's side of an approval: the approved amount arrives in their Nessie sandbox account (a
// transfer, executions.ts), and they pay the seller from it here. Same safety rules as executions:
// "submitting" is saved before the network call, a POST is never repeated automatically, and an
// ambiguous result stays "uncertain" until it is checked. One payment per approved transfer.
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { AppError, IntegrationError, invalidState, notFound } from "../lib/errors.js";
import { scrub } from "../lib/redact.js";
import { formatUsd } from "../domain/money.js";
import { fromNessieAmount } from "../integrations/nessie.js";
import type { Principal } from "../auth/access.js";
import { emitEvent } from "./events.js";
import { getExecutionView } from "./executions.js";

type PaymentRow = {
  id: string; execution_id: string; proposal_id: string; user_id: string; account_id: string; merchant_id: string; amount_cents: number; description: string;
  status: string; provider_status: string | null; external_id: string | null; provider_amount: string | null; last_error: string | null; attempts: number;
  idempotency_key: string; created_at: string; recorded_at: string | null; updated_at: string;
};
type ExecRow = { id: string; proposal_id: string; kind: string; status: string; payee_user_id: string | null; payee_account_id: string | null; merchant_id: string | null; amount_cents: number; merchant_mapping: string | null };

const KEY = /^[\w.:-]{8,128}$/;

type TransferRow = { id: string; proposal_id: string; amount_cents: number; status: string; recorded_at: string | null; approved_at: string | null; merchant_mapping: string | null; request_id: string };

function loadExec(ctx: AppContext, id: string): ExecRow {
  const e = ctx.db.prepare("SELECT id, proposal_id, kind, status, payee_user_id, payee_account_id, merchant_id, amount_cents, merchant_mapping FROM executions WHERE id = ?").get(id) as ExecRow | undefined;
  if (!e) throw notFound("Execution", id);
  return e;
}
const loadPayment = (ctx: AppContext, executionId: string) => ctx.db.prepare("SELECT * FROM employee_payments WHERE execution_id = ?").get(executionId) as PaymentRow | undefined;
const requestIdFor = (ctx: AppContext, proposalId: string) => (ctx.db.prepare("SELECT request_id FROM proposals WHERE id = ?").get(proposalId) as { request_id: string } | undefined)?.request_id ?? null;
const touch = (ctx: AppContext, proposalId: string) => ctx.db.prepare("UPDATE proposals SET updated_at = ? WHERE id = ?").run(nowIso(), proposalId);

function setPayment(ctx: AppContext, p: PaymentRow, status: string, patch: { externalId?: string | null; providerStatus?: string | null; providerAmount?: unknown; error?: string | null } = {}) {
  touch(ctx, p.proposal_id);
  ctx.db
    .prepare("UPDATE employee_payments SET status = ?, external_id = COALESCE(?, external_id), provider_status = COALESCE(?, provider_status), provider_amount = COALESCE(?, provider_amount), last_error = ?, recorded_at = CASE WHEN ? = 'recorded' THEN COALESCE(recorded_at, ?) ELSE recorded_at END, updated_at = ? WHERE id = ?")
    .run(status, patch.externalId ?? null, patch.providerStatus ?? null, patch.providerAmount === undefined ? null : JSON.stringify(patch.providerAmount), patch.error ?? null, status, nowIso(), nowIso(), p.id);
}

/**
 * Pay the seller from the employee's account for one approved, recorded transfer. Only the employee who
 * received the money may pay. Retrying with the same Idempotency-Key returns the same payment.
 */
export async function payForExecution(ctx: AppContext, executionId: string, actor: Principal, idempotencyKey: string | undefined) {
  if (!idempotencyKey || !KEY.test(idempotencyKey)) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header (8-128 chars of [A-Za-z0-9_.:-]) is required", 400);
  const e = loadExec(ctx, executionId);
  if (e.kind !== "transfer") throw invalidState("This approval was recorded before employee payments existed; the company paid the merchant directly");
  if (e.payee_user_id !== actor.userId) throw new AppError("FORBIDDEN_ROLE", "Only the employee who received this money can pay the seller", 403);
  if (e.status !== "recorded") throw invalidState(`The transfer to your account is ${e.status}; you can pay once it is recorded`);
  if (!e.merchant_id || !e.payee_account_id) throw invalidState("No sandbox merchant or employee account is linked to this approval");

  const existing = loadPayment(ctx, executionId);
  if (existing) {
    if (existing.idempotency_key === idempotencyKey || existing.status === "recorded") return getPaymentResult(ctx, executionId);
    if (existing.status === "uncertain" || existing.status === "submitting") throw new AppError("PAYMENT_UNCERTAIN", "A payment for this approval may already exist; check its status instead of paying again", 409);
    // A definitively failed payment may be tried again (nothing was paid).
  }

  const seller = e.merchant_mapping ? ((json(e.merchant_mapping) as { seller?: string }).seller ?? "seller") : "seller";
  const now = nowIso();
  const id = existing?.id ?? `pay_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const description = `Runway ${id} | ${executionId} | paid ${seller}`.slice(0, 200);
  tx(ctx.db, () => {
    if (existing) {
      ctx.db.prepare("UPDATE employee_payments SET status = 'submitting', attempts = attempts + 1, idempotency_key = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(idempotencyKey, now, id);
    } else {
      ctx.db
        .prepare("INSERT INTO employee_payments (id, execution_id, proposal_id, user_id, account_id, merchant_id, amount_cents, description, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting', ?, ?, ?)")
        .run(id, executionId, e.proposal_id, actor.userId, e.payee_account_id, e.merchant_id, e.amount_cents, description, idempotencyKey, now, now);
    }
    touch(ctx, e.proposal_id);
    emitEvent(ctx.db, { type: "execution_submitting", proposalId: e.proposal_id, requestId: requestIdFor(ctx, e.proposal_id), executionId, summary: `Employee paying ${seller} ${formatUsd(e.amount_cents)} (sandbox)`, payload: { paymentId: id } });
  });
  const p = loadPayment(ctx, executionId)!;
  try {
    const res = await ctx.adapters.bank.createPurchase(p.account_id, { merchantId: p.merchant_id, amountCents: p.amount_cents, description: p.description, date: now.slice(0, 10) });
    if (res.externalId) {
      record(ctx, p, res.externalId, res.providerStatus, res.providerAmount, seller);
    } else {
      const found = (await ctx.adapters.bank.listPurchases(p.account_id)).filter((x) => (x.description ?? "").includes(p.id));
      if (found.length === 1) record(ctx, p, found[0]!.id, found[0]!.status, found[0]!.rawAmount, seller);
      else setPayment(ctx, p, "uncertain", { error: `Nessie accepted the payment (HTTP ${res.httpStatus}) but returned no id; ${found.length} matching purchases found` });
    }
  } catch (err) {
    if (err instanceof IntegrationError && err.outcome === "definitive") setPayment(ctx, p, "failed", { error: scrub(err.message) });
    else setPayment(ctx, p, "uncertain", { error: scrub(err instanceof Error ? err.message : "unknown error") });
  }
  return getPaymentResult(ctx, executionId);
}

function record(ctx: AppContext, p: PaymentRow, externalId: string, providerStatus: string | null, providerAmount: unknown, seller: string) {
  tx(ctx.db, () => {
    setPayment(ctx, p, "recorded", { externalId, providerStatus, providerAmount });
    emitEvent(ctx.db, { type: "execution_recorded", proposalId: p.proposal_id, requestId: requestIdFor(ctx, p.proposal_id), executionId: p.execution_id, summary: `Employee paid ${seller} ${formatUsd(p.amount_cents)} (Nessie sandbox purchase)`, payload: { paymentId: p.id, externalId } });
  });
}

/** Look up an uncertain payment by its reference; never resends. `mark_failed` only when nothing was found. */
export async function checkPayment(ctx: AppContext, executionId: string, actor: Principal, action: "check" | "mark_failed") {
  const e = loadExec(ctx, executionId);
  const p = loadPayment(ctx, executionId);
  if (!p) throw notFound("Payment for execution", executionId);
  if (e.payee_user_id !== actor.userId && actor.role !== "executive") throw new AppError("FORBIDDEN_ROLE", "Not your payment", 403);
  if (p.status !== "uncertain" && p.status !== "submitting") return getPaymentResult(ctx, executionId);
  const found = (await ctx.adapters.bank.listPurchases(p.account_id)).filter((x) => (x.description ?? "").includes(p.id));
  if (found.length === 1) record(ctx, p, found[0]!.id, found[0]!.status, found[0]!.rawAmount, "seller");
  else if (found.length === 0 && action === "mark_failed") setPayment(ctx, p, "failed", { error: "Marked failed after a check found no purchase" });
  return getPaymentResult(ctx, executionId);
}

function getPaymentResult(ctx: AppContext, executionId: string) {
  return getExecutionView(ctx, executionId);
}

/**
 * The employee's sandbox account: money received from approvals (+) and paid to sellers (−). The running
 * figure is Runway's record; Nessie's reported balance is shown separately and may lag.
 */
export async function walletView(ctx: AppContext, userId: string) {
  const acct = ctx.db.prepare("SELECT account_id, account_masked, mode FROM employee_accounts WHERE user_id = ?").get(userId) as { account_id: string | null; account_masked: string | null; mode: string } | undefined;
  const received = ctx.db
    .prepare(
      // Titles live in the request's current version.
      "SELECT e.id, e.proposal_id, e.amount_cents, e.status, e.recorded_at, e.approved_at, e.merchant_mapping, rv.fields, r.id AS request_id FROM executions e JOIN proposals p ON p.id = e.proposal_id JOIN requests r ON r.id = p.request_id JOIN request_versions rv ON rv.request_id = r.id AND rv.version = r.current_version WHERE e.kind = 'transfer' AND e.payee_user_id = ? ORDER BY e.created_at DESC",
    )
    .all(userId)
    .map((r) => {
      const row = r as TransferRow & { fields: string };
      return { ...row, title: (json(row.fields) as { title?: string }).title ?? "Request" };
    });
  const paid = ctx.db.prepare("SELECT * FROM employee_payments WHERE user_id = ? ORDER BY created_at DESC").all(userId) as PaymentRow[];
  const sellerOf = (m: string | null) => (m ? ((json(m) as { seller?: string }).seller ?? null) : null);
  const entries = [
    ...received.map((r) => {
      const pay = paid.find((p) => p.execution_id === r.id);
      return {
        type: "received" as const,
        executionId: r.id,
        proposalId: r.proposal_id,
        requestId: r.request_id,
        title: r.title,
        amountCents: r.amount_cents,
        status: r.status,
        at: r.recorded_at ?? r.approved_at,
        seller: sellerOf(r.merchant_mapping),
        payment: pay ? { status: pay.status, at: pay.recorded_at ?? pay.created_at } : null,
        canPay: r.status === "recorded" && (!pay || pay.status === "failed"),
      };
    }),
    ...paid.map((p) => {
      const r = received.find((x) => x.id === p.execution_id);
      return {
        type: "paid" as const,
        executionId: p.execution_id,
        proposalId: p.proposal_id,
        requestId: r?.request_id ?? null,
        title: r?.title ?? null,
        amountCents: p.amount_cents,
        status: p.status,
        at: p.recorded_at ?? p.created_at,
        seller: sellerOf(r?.merchant_mapping ?? null),
        providerStoredAmountCents: p.provider_amount ? fromNessieAmount(json(p.provider_amount)) : null,
      };
    }),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  const inCents = received.filter((r) => r.status === "recorded").reduce((n, r) => n + r.amount_cents, 0);
  // A payment that may have gone through counts as spent until it is checked.
  const outCents = paid.filter((p) => p.status !== "failed").reduce((n, p) => n + p.amount_cents, 0);
  let reported: { balanceCents: number; fetchedAt: string } | null = null;
  if (acct?.account_id && acct.mode === ctx.config.mode) {
    try {
      const a = await ctx.adapters.bank.getAccount(acct.account_id);
      reported = { balanceCents: a.balanceCents, fetchedAt: ctx.now().toISOString() };
    } catch {
      reported = null;
    }
  }
  return {
    account: acct?.account_id ? { masked: acct.account_masked, mode: acct.mode } : null,
    runwayBalanceCents: inCents - outCents,
    receivedCents: inCents,
    paidCents: outCents,
    reportedBalance: reported,
    entries,
    disclaimer: "Capital One Nessie sandbox: simulated accounts and transfers. No real money moves and no supplier order is placed.",
  };
}
