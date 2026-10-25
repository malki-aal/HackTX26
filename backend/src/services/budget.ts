// Financial context: verified Nessie account reads + a labeled local budget ledger.
import { randomUUID } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { computeFinancialContext, reconcileReflections, type BankSnapshot, type BillSnapshot, type LedgerEntry } from "../domain/budget.js";
import type { FinancialContext } from "../contracts/domain.js";
import { IntegrationError } from "../lib/errors.js";

export const DEMO_ACCOUNT_RESOURCE = "runway_demo_operating";

export function resolveAccountId(ctx: AppContext): string | null {
  if (ctx.adapters.bank.source === "fixture") return "fixture_account";
  if (ctx.config.nessie.accountId) return ctx.config.nessie.accountId;
  const row = ctx.db.prepare("SELECT external_id FROM nessie_resources WHERE kind = 'account' AND name = ?").get(DEMO_ACCOUNT_RESOURCE) as { external_id: string } | undefined;
  return row?.external_id ?? null;
}

export function loadLedger(ctx: AppContext, accountId: string): LedgerEntry[] {
  const rows = ctx.db.prepare("SELECT id, kind, amount_cents, provider_amount_cents, status, created_at FROM budget_ledger WHERE account_id = ?").all(accountId) as Array<{ id: string; kind: LedgerEntry["kind"]; amount_cents: number; provider_amount_cents: number | null; status: LedgerEntry["status"]; created_at: string }>;
  return rows.map((r) => ({ id: r.id, kind: r.kind, amountCents: r.amount_cents, providerAmountCents: r.provider_amount_cents, status: r.status, createdAt: r.created_at }));
}

function latestSnapshot(ctx: AppContext, accountId: string): BankSnapshot | null {
  const r = ctx.db.prepare("SELECT * FROM financial_snapshots WHERE account_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1").get(accountId) as { balance_cents: number; bills: string; fetched_at: string; source: string } | undefined;
  if (!r) return null;
  return { accountId, balanceCents: r.balance_cents, bills: json<BillSnapshot[]>(r.bills), fetchedAt: r.fetched_at, source: r.source === "fixture" ? "fixture" : "nessie_cached" };
}

export interface FinancialRead {
  context: FinancialContext;
  fresh: boolean;
  error: string | null;
}

/**
 * Read the account. With refresh=true, calls Nessie (or the fixture bank), stores a snapshot and
 * reconciles recorded expenses against the observed balance change. Never invents a balance.
 */
export async function readFinancialContext(ctx: AppContext, opts: { refresh: boolean }): Promise<FinancialRead> {
  const accountId = resolveAccountId(ctx);
  if (!accountId) {
    return { context: computeFinancialContext(null, [], ["No Nessie account configured; set NESSIE_ACCOUNT_ID or run npm run seed:nessie"]), fresh: false, error: "not_configured" };
  }
  if (!opts.refresh) {
    const snap = latestSnapshot(ctx, accountId);
    const notes = snap ? [`Cached snapshot from ${snap.fetchedAt}`] : ["No snapshot yet; refresh to read the bank account"];
    return { context: computeFinancialContext(snap, loadLedger(ctx, accountId), notes), fresh: false, error: null };
  }
  let account, bills: BillSnapshot[];
  try {
    account = await ctx.adapters.bank.getAccount(accountId);
    bills = await ctx.adapters.bank.listBills(accountId);
  } catch (e) {
    const msg = e instanceof IntegrationError ? e.message : "Bank read failed";
    markIntegration(ctx, "nessie", "error", msg);
    const snap = latestSnapshot(ctx, accountId);
    const ctxOut = computeFinancialContext(null, loadLedger(ctx, accountId), [msg, ...(snap ? [`Last verified snapshot ${snap.fetchedAt} not used for decisions`] : [])]);
    return { context: { ...ctxOut, accountId }, fresh: false, error: msg };
  }
  const source = ctx.adapters.bank.source === "fixture" ? "fixture" : "nessie_live";
  const fetchedAt = nowIso();
  const notes = tx(ctx.db, () => {
    const prev = latestSnapshot(ctx, accountId);
    const unreflected = loadLedger(ctx, accountId).filter((l) => l.kind === "expense" && l.status === "unreflected");
    const rec = reconcileReflections(prev ? prev.balanceCents : null, account.balanceCents, unreflected);
    for (const lid of rec.reflectedIds) ctx.db.prepare("UPDATE budget_ledger SET status = 'reflected', updated_at = ? WHERE id = ?").run(fetchedAt, lid);
    ctx.db.prepare("INSERT INTO financial_snapshots (id, account_id, source, balance_cents, bills, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").run(`fs_${randomUUID()}`, accountId, source, account.balanceCents, JSON.stringify(bills), fetchedAt);
    return rec.notes;
  });
  markIntegration(ctx, "nessie", source === "fixture" ? "fixture" : "ok", null, { accountId, balanceUnit: "dollars (converted to cents)" });
  const snapshot: BankSnapshot = { accountId, balanceCents: account.balanceCents, bills, fetchedAt, source };
  return { context: computeFinancialContext(snapshot, loadLedger(ctx, accountId), notes), fresh: true, error: null };
}

export function markIntegration(ctx: AppContext, service: string, state: string, error: string | null, detail: Record<string, unknown> = {}) {
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO integration_state (service, state, last_verified_at, last_error, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET state = excluded.state, last_verified_at = COALESCE(excluded.last_verified_at, integration_state.last_verified_at), last_error = excluded.last_error, detail = excluded.detail, updated_at = excluded.updated_at`,
    )
    .run(service, state, state === "ok" || state === "fixture" ? now : null, error, JSON.stringify(detail), now);
}
