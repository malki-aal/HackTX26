// Nessie sandbox execution of an approval, ambiguity handling and reconciliation.
// kind "transfer" (current): company account -> the employee's sandbox account; the employee then pays the
// seller separately (services/payments.ts). kind "purchase" (older records): company paid the merchant directly.
// State machine: queued -> submitting -> recorded | failed | uncertain; uncertain -> recorded | failed (explicit).
// A POST is never repeated automatically; restarts turn "submitting" into "uncertain".
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { ReconcileBody } from "../contracts/domain.js";
import { AppError, IntegrationError, invalidState, notFound } from "../lib/errors.js";
import { scrub } from "../lib/redact.js";
import { formatUsd } from "../domain/money.js";
import { fromNessieAmount, maskAccountNumber } from "../integrations/nessie.js";
import { actorInfo } from "../auth/access.js";
import { emitEvent } from "./events.js";
import { readFinancialContext } from "./budget.js";

type ExecRow = {
  approved_at: string | null; provider_submitted_at: string | null; recorded_at: string | null; provider_retrieved_at: string | null;
  account_masked: string | null; merchant_mapping: string | null; provider_purchase_date: string | null;
  id: string; proposal_id: string; proposal_version: number; decision_id: string; mode: string; account_id: string; merchant_id: string | null; amount_cents: number; provider_amount: string | null;
  description: string; status: string; provider_status: string | null; external_id: string | null; last_error: string | null; attempts: number; created_at: string; updated_at: string;
  kind: "purchase" | "transfer"; payee_user_id: string | null; payee_account_id: string | null;
};

/** Provider operations for the execution's kind; both kinds share one state machine. */
function moves(ctx: AppContext, e: ExecRow) {
  const bank = ctx.adapters.bank;
  return e.kind === "transfer"
    ? {
        noun: "transfer",
        create: () => bank.createTransfer(e.account_id, { payeeAccountId: e.payee_account_id!, amountCents: e.amount_cents, description: e.description, date: nowIso().slice(0, 10) }),
        // Found on the employee's side: the deposit is the tracked record.
        list: () => bank.listTransfersTo(e.payee_account_id!),
        get: (id: string) => bank.getTransfer(id),
      }
    : {
        noun: "purchase",
        create: () => bank.createPurchase(e.account_id, { merchantId: e.merchant_id!, amountCents: e.amount_cents, description: e.description, date: nowIso().slice(0, 10) }),
        list: () => bank.listPurchases(e.account_id),
        get: (id: string) => bank.getPurchase(id),
      };
}

type Movement = { id: string; amountCents: number | null; rawAmount: unknown; status: string | null; description: string | null; date: string | null };

/**
 * The employee's sandbox account, created on their first approval (a Nessie customer + checking account
 * at $0). Network calls happen outside any transaction; partial progress is saved so a retry continues.
 */
export async function ensureEmployeeAccount(ctx: AppContext, userId: string): Promise<{ accountId: string; accountMasked: string | null }> {
  type Row = { customer_id: string | null; account_id: string | null; account_masked: string | null; mode: string };
  let row = ctx.db.prepare("SELECT customer_id, account_id, account_masked, mode FROM employee_accounts WHERE user_id = ?").get(userId) as Row | undefined;
  if (row?.account_id && row.mode === ctx.config.mode) return { accountId: row.account_id, accountMasked: row.account_masked };
  const now = nowIso();
  if (!row || row.mode !== ctx.config.mode) {
    ctx.db.prepare("INSERT INTO employee_accounts (user_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, customer_id = NULL, account_id = NULL, account_masked = NULL, updated_at = excluded.updated_at").run(userId, ctx.config.mode, now, now);
    row = { customer_id: null, account_id: null, account_masked: null, mode: ctx.config.mode };
  }
  const name = (actorInfo(ctx, userId)?.displayName ?? "Runway Employee").trim().split(/\s+/);
  let customerId = row.customer_id;
  if (!customerId) {
    customerId = (await ctx.adapters.bank.createCustomer(name[0] ?? "Runway", name.slice(1).join(" ") || "Employee")).id;
    ctx.db.prepare("UPDATE employee_accounts SET customer_id = ?, updated_at = ? WHERE user_id = ?").run(customerId, nowIso(), userId);
  }
  const account = await ctx.adapters.bank.createAccount(customerId, `Runway employee ${name[0] ?? ""}`.trim());
  const masked = maskAccountNumber(account.accountNumber);
  ctx.db.prepare("UPDATE employee_accounts SET account_id = ?, account_masked = ?, updated_at = ? WHERE user_id = ?").run(account.id, masked, nowIso(), userId);
  return { accountId: account.id, accountMasked: masked };
}

function loadExec(ctx: AppContext, id: string): ExecRow {
  const r = ctx.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as ExecRow | undefined;
  if (!r) throw notFound("Execution", id);
  return r;
}

function requestIdFor(ctx: AppContext, proposalId: string): string | null {
  return (ctx.db.prepare("SELECT request_id FROM proposals WHERE id = ?").get(proposalId) as { request_id: string } | undefined)?.request_id ?? null;
}

function setStatus(ctx: AppContext, e: ExecRow, status: string, patch: { providerStatus?: string | null; externalId?: string | null; error?: string | null; providerAmount?: unknown } = {}) {
  // Execution changes are proposal changes for pollers (updatedAfter / updatedAt).
  ctx.db.prepare("UPDATE proposals SET updated_at = ? WHERE id = ?").run(nowIso(), e.proposal_id);
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
    .run(`led_${randomUUID()}`, e.account_id, e.amount_cents, e.id, externalId, e.kind === "transfer" ? "Recorded Nessie sandbox transfer to the employee; subtracted locally until the reported balance reflects it" : "Recorded Nessie sandbox purchase; subtracted locally until the reported balance reflects it", now, now);
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

/** The stored provider record was read back after creation. */
function markRetrieved(ctx: AppContext, executionId: string, purchaseDate: string | null) {
  ctx.db.prepare("UPDATE executions SET provider_retrieved_at = ?, provider_purchase_date = COALESCE(?, provider_purchase_date) WHERE id = ?").run(nowIso(), purchaseDate, executionId);
}

function markRecorded(ctx: AppContext, e: ExecRow, externalId: string, providerStatus: string | null, providerAmount: unknown, how: string) {
  tx(ctx.db, () => {
    setStatus(ctx, e, "recorded", { externalId, providerStatus, providerAmount });
    ctx.db.prepare("UPDATE executions SET recorded_at = COALESCE(recorded_at, ?) WHERE id = ?").run(nowIso(), e.id);
    convertToExpense(ctx, e, externalId, providerAmount);
    emitEvent(ctx.db, { type: "execution_recorded", proposalId: e.proposal_id, requestId: requestIdFor(ctx, e.proposal_id), executionId: e.id, summary: e.kind === "transfer" ? `Nessie sandbox transfer to the employee recorded (${how})` : `Nessie sandbox purchase recorded (${how})`, payload: { externalId, providerStatus, amountCents: e.amount_cents, kind: e.kind } });
  });
}

const matchesExecution = (e: ExecRow, p: Movement) => (p.description ?? "").includes(e.id) && (p.amountCents === null || p.amountCents === e.amount_cents);

/** Submit one queued execution. Persists "submitting" before the network call. */
export async function submitExecution(ctx: AppContext, executionId: string): Promise<void> {
  let e = loadExec(ctx, executionId);
  if (e.status !== "queued") throw invalidState(`Execution is ${e.status}; only queued executions can be submitted`);
  if (e.mode !== ctx.config.mode || (e.mode === "live" && ctx.adapters.bank.source !== "nessie_live")) {
    throw new AppError("MODE_MISMATCH", "Execution mode does not match the configured bank adapter", 409);
  }
  const reqId = requestIdFor(ctx, e.proposal_id);
  if (e.kind === "transfer" && !e.payee_account_id) {
    // The payee account must exist before any money moves. If it can't be created, nothing was sent.
    try {
      const acct = await ensureEmployeeAccount(ctx, e.payee_user_id!);
      ctx.db.prepare("UPDATE executions SET payee_account_id = ?, updated_at = ? WHERE id = ?").run(acct.accountId, nowIso(), e.id);
      e = loadExec(ctx, executionId);
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : "employee account could not be created");
      tx(ctx.db, () => {
        setStatus(ctx, e, "failed", { error: `Employee sandbox account could not be created; no money was sent. ${msg}` });
        releaseReservation(ctx, e.id, "Released: employee account could not be created; no transfer was sent");
        emitEvent(ctx.db, { type: "execution_failed", proposalId: e.proposal_id, requestId: reqId, executionId: e.id, summary: "Employee sandbox account could not be created; no transfer was sent", payload: { stage: "employee_account" } });
      });
      return;
    }
  }
  const m = moves(ctx, e);
  tx(ctx.db, () => {
    ctx.db.prepare("UPDATE executions SET status = 'submitting', attempts = attempts + 1, provider_submitted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), e.id);
    emitEvent(ctx.db, { type: "execution_submitting", proposalId: e.proposal_id, requestId: reqId, executionId: e.id, summary: `Submitting ${formatUsd(e.amount_cents)} sandbox ${m.noun} to Nessie`, payload: { attempt: e.attempts + 1, kind: e.kind } });
  });
  try {
    const res = await m.create();
    if (res.externalId) {
      markRecorded(ctx, e, res.externalId, res.providerStatus, res.providerAmount, `HTTP ${res.httpStatus}`);
      await verifyReadBack(ctx, e.id);
      return;
    }
    // Success status without an id in the body: find it by our reference instead of guessing.
    const found = ((await m.list()) as Movement[]).filter((p) => matchesExecution(e, p));
    if (found.length === 1) {
      markRecorded(ctx, e, found[0]!.id, found[0]!.status, found[0]!.rawAmount, "found by reference after create");
      markRetrieved(ctx, e.id, found[0]!.date);
    }
    else markUncertain(ctx, e, `Nessie accepted the request (HTTP ${res.httpStatus}) but returned no id; ${found.length} matching ${m.noun}s found`);
  } catch (err) {
    if (err instanceof IntegrationError && err.outcome === "definitive") {
      tx(ctx.db, () => {
        setStatus(ctx, e, "failed", { error: scrub(err.message) });
        releaseReservation(ctx, e.id, `Released: Nessie rejected the ${m.noun}`);
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
    emitEvent(ctx.db, { type: "execution_uncertain", proposalId: e.proposal_id, requestId: requestIdFor(ctx, e.proposal_id), executionId: e.id, summary: `${e.kind === "transfer" ? "Transfer" : "Purchase"} outcome uncertain; reconcile before any retry`, payload: { reason: scrub(reason) } });
  });
}

async function verifyReadBack(ctx: AppContext, executionId: string) {
  const e = loadExec(ctx, executionId);
  if (!e.external_id) return;
  try {
    const p = (await moves(ctx, e).get(e.external_id)) as Movement | null;
    if (p) {
      setStatus(ctx, e, e.status, { providerStatus: p.status, providerAmount: p.rawAmount });
      recordProviderAmount(ctx, e.id, p.rawAmount);
      markRetrieved(ctx, e.id, p.date);
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

export async function reconcileExecution(ctx: AppContext, executionId: string, body: unknown, actorId = "executive-demo") {
  const parsed = { ...ReconcileBody.parse(body ?? {}), actor: actorId };
  const e = loadExec(ctx, executionId);
  const notes: string[] = [];
  if (parsed.action === "submit_queued") {
    if (e.status !== "queued") throw invalidState(`Execution is ${e.status}; only queued executions can be submitted`);
    await submitExecution(ctx, e.id);
    notes.push("Queued execution submitted once");
  } else {
    if (e.status === "queued") notes.push("Execution has not been sent; use action submit_queued to send it");
    if (["uncertain", "recorded", "submitting"].includes(e.status)) {
      const mv = moves(ctx, e);
      const purchases = (await mv.list()) as Movement[];
      const matches = purchases.filter((p) => matchesExecution(e, p));
      if (e.status === "recorded") {
        const p = matches.find((m) => m.id === e.external_id) ?? (e.external_id ? ((await mv.get(e.external_id)) as Movement | null) : null);
        if (p) {
          setStatus(ctx, e, "recorded", { providerStatus: p.status, providerAmount: p.rawAmount });
          recordProviderAmount(ctx, e.id, p.rawAmount);
          markRetrieved(ctx, e.id, p.date);
          notes.push(`External purchase ${p.id} present with status ${p.status ?? "unknown"}`);
        } else notes.push("Recorded purchase was not found in the account listing; leaving status unchanged");
        if (matches.length > 1) notes.push(`Warning: ${matches.length} purchases reference this execution`);
      } else if (matches.length === 1) {
        markRecorded(ctx, e, matches[0]!.id, matches[0]!.status, matches[0]!.rawAmount, "reconciled by reference");
        markRetrieved(ctx, e.id, matches[0]!.date);
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
  const payment = e.kind === "transfer" ? paymentView(ctx, e.id) : null;
  const payee = e.payee_user_id ? actorInfo(ctx, e.payee_user_id) : null;
  const payeeMasked = e.payee_user_id ? ((ctx.db.prepare("SELECT account_masked FROM employee_accounts WHERE user_id = ?").get(e.payee_user_id) as { account_masked: string | null } | undefined)?.account_masked ?? null) : null;
  const ledger = ctx.db.prepare("SELECT kind, amount_cents, status, note, external_id FROM budget_ledger WHERE execution_id = ? ORDER BY created_at").all(id) as Array<{ kind: string; amount_cents: number; status: string; note: string; external_id: string | null }>;
  const providerCents = e.provider_amount ? fromNessieAmount(json(e.provider_amount)) : null;
  return {
    id: e.id,
    proposalId: e.proposal_id,
    proposalVersion: e.proposal_version,
    mode: e.mode,
    status: e.status,
    providerStatus: e.provider_status,
    /** "transfer": company → employee, then the employee pays the seller (`payment`). "purchase": older, company paid the merchant. */
    kind: e.kind,
    payee: e.kind === "transfer" ? { displayName: payee?.displayName ?? null, accountMasked: payeeMasked } : null,
    payment,
    // purchaseId is always the merchant purchase (the employee's payment for transfers); transferId is the
    // company → employee transfer. Kept as one shape so older clients keep working.
    externalReference: e.external_id
      ? {
          provider: e.mode === "live" ? "nessie" : "fixture",
          purchaseId: e.kind === "transfer" ? (payment?.purchaseId ?? null) : e.external_id,
          transferId: e.kind === "transfer" ? e.external_id : null,
          accountId: e.account_id,
          merchantId: e.merchant_id,
        }
      : null,
    amountCents: e.amount_cents,
    amountSource: "user_confirmed",
    providerAmountRaw: e.provider_amount ? json(e.provider_amount) : null,
    providerAmountCents: providerCents,
    amountDiscrepancyCents: providerCents === null ? null : e.amount_cents - providerCents,
    amountNote:
      providerCents !== null && providerCents !== e.amount_cents
        ? `Nessie stored ${formatUsd(providerCents)} (it keeps whole dollars); the approved amount ${formatUsd(e.amount_cents)} remains the budget figure`
        : null,
    // Canonical names (the amountCents/providerAmountCents fields above are kept for compatibility).
    approvedAmountCents: e.amount_cents,
    providerStoredAmountCents: providerCents,
    currency: "USD",
    providerAmountConversion: "Nessie amounts are dollars; Runway sends cents/100 and reads back whole dollars x 100",
    accountMasked: e.account_masked,
    merchantMapping: e.merchant_mapping ? json(e.merchant_mapping) : null,
    providerPurchaseDate: e.provider_purchase_date,
    timestamps: {
      approvedAt: e.approved_at,
      providerSubmittedAt: e.provider_submitted_at,
      recordedAt: e.recorded_at,
      providerRetrievedAt: e.provider_retrieved_at,
    },
    description: e.description,
    lastError: e.last_error,
    attempts: e.attempts,
    ledger: ledger.map((l) => ({ kind: l.kind, amountCents: l.amount_cents, status: l.status, note: l.note, externalId: l.external_id })),
    disclaimer:
      e.kind === "transfer"
        ? "Simulated transfer and purchase in the Capital One Nessie sandbox. No real money moved and no merchant order was placed."
        : "Simulated purchase in the Capital One Nessie sandbox. No real money moved and no merchant order was placed.",
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

/** The employee's payment to the seller for one approved transfer, if they have made it. */
export function paymentView(ctx: AppContext, executionId: string) {
  const p = ctx.db.prepare("SELECT * FROM employee_payments WHERE execution_id = ?").get(executionId) as
    | { id: string; status: string; amount_cents: number; merchant_id: string; provider_status: string | null; external_id: string | null; provider_amount: string | null; last_error: string | null; created_at: string; recorded_at: string | null }
    | undefined;
  if (!p) return null;
  const stored = p.provider_amount ? fromNessieAmount(json(p.provider_amount)) : null;
  return {
    id: p.id,
    status: p.status,
    amountCents: p.amount_cents,
    providerStoredAmountCents: stored,
    merchantId: p.merchant_id,
    providerStatus: p.provider_status,
    purchaseId: p.external_id,
    lastError: p.last_error,
    createdAt: p.created_at,
    recordedAt: p.recorded_at,
  };
}
