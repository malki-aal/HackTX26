// Researched seller -> Nessie sandbox merchant mapping, Nessie merchant details, and the company
// account's purchase history. A mapping is only ever created by an explicit request; execution
// refuses to record a purchase for a seller without one.
import type { AppContext } from "../app/context.js";
import { json, nowIso } from "../db/db.js";
import { z } from "zod";
import { AppError, invalidState, notFound } from "../lib/errors.js";
import type { NessieMerchant } from "../integrations/nessie.js";
import { resolveAccountId } from "./budget.js";
import type { Principal } from "../auth/access.js";

export const sellerKey = (seller: string) => seller.toLowerCase().trim().replace(/\s+/g, " ");

export const MerchantMappingBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_sandbox_merchant"),
    seller: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(40).default("general"),
    actor: z.string().max(40).optional(),
    note: z.string().max(500).default(""),
  }),
  z.object({
    action: z.literal("link_existing_merchant"),
    seller: z.string().trim().min(1).max(120),
    nessieMerchantId: z.string().trim().min(1).max(100),
    actor: z.string().max(40).optional(),
    note: z.string().max(500).default(""),
  }),
]);

type MappingRow = { seller_key: string; seller_name: string; nessie_merchant_id: string; provenance: string; merchant_snapshot: string; created_by: string; note: string; created_at: string };

export interface MerchantMapping {
  seller: string;
  sellerKey: string;
  nessieMerchantId: string;
  provenance: "created_sandbox_merchant" | "linked_existing_merchant" | "legacy_auto_created";
  provenanceNote: string;
  merchant: NessieMerchant | null;
  createdBy: string;
  createdAt: string;
  disclaimer: string;
}

const DISCLAIMER = "A Nessie sandbox merchant record that represents this seller for simulated purchases. It is not the seller's real merchant account and implies no partnership or checkout connection.";

function toMapping(r: MappingRow): MerchantMapping {
  const snap = json<NessieMerchant | Record<string, never>>(r.merchant_snapshot);
  return {
    seller: r.seller_name,
    sellerKey: r.seller_key,
    nessieMerchantId: r.nessie_merchant_id,
    provenance: r.provenance as MerchantMapping["provenance"],
    provenanceNote: r.note,
    merchant: "id" in snap ? (snap as NessieMerchant) : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    disclaimer: DISCLAIMER,
  };
}

export function getMapping(ctx: AppContext, seller: string | null): MerchantMapping | null {
  if (!seller) return null;
  const r = ctx.db.prepare("SELECT * FROM merchant_mappings WHERE seller_key = ?").get(sellerKey(seller)) as MappingRow | undefined;
  return r ? toMapping(r) : null;
}

export function listMappings(ctx: AppContext): MerchantMapping[] {
  return (ctx.db.prepare("SELECT * FROM merchant_mappings ORDER BY created_at").all() as MappingRow[]).map(toMapping);
}

/**
 * Explicitly map a researched seller to a Nessie sandbox merchant. Only the executive demo role may
 * do this because it decides where simulated money is recorded.
 */
const pendingMappings = new Set<string>();

export async function createMapping(ctx: AppContext, body: unknown, actor: Principal): Promise<MerchantMapping> {
  const parsed = MerchantMappingBody.parse(body);
  // Only executives decide where simulated money is recorded; the actor comes from the session.
  if (actor.role !== "executive") throw new AppError("FORBIDDEN_ROLE", "Only an executive can map a seller to a Nessie merchant", 403);
  const b = { ...parsed, actor: actor.userId };
  if (getMapping(ctx, b.seller)) throw invalidState(`Seller "${b.seller}" is already mapped`, { seller: b.seller });
  // One in-flight mapping per seller, so concurrent requests cannot create duplicate Nessie merchants.
  const key = sellerKey(b.seller);
  if (pendingMappings.has(key)) throw invalidState(`Seller "${b.seller}" is already mapped or being mapped`, { seller: b.seller });
  pendingMappings.add(key);
  try {
    return await createMappingNow(ctx, b);
  } finally {
    pendingMappings.delete(key);
  }
}

async function createMappingNow(ctx: AppContext, b: z.infer<typeof MerchantMappingBody> & { actor: string }): Promise<MerchantMapping> {
  let merchant: NessieMerchant;
  let note: string;
  if (b.action === "link_existing_merchant") {
    const m = await ctx.adapters.bank.getMerchant(b.nessieMerchantId);
    if (!m) throw notFound("Nessie merchant", b.nessieMerchantId);
    merchant = m;
    note = `Linked to existing Nessie merchant "${m.name}" by ${b.actor}${b.note ? `: ${b.note}` : ""}`;
  } else {
    // The name states it is a sandbox representation; Runway never creates real-world identities.
    merchant = await ctx.adapters.bank.createMerchant(`Runway sandbox: ${b.seller}`.slice(0, 80), b.category);
    note = `Sandbox merchant created on request by ${b.actor}${b.note ? `: ${b.note}` : ""}`;
  }
  ctx.db
    .prepare("INSERT INTO merchant_mappings (seller_key, seller_name, nessie_merchant_id, provenance, merchant_snapshot, created_by, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sellerKey(b.seller), b.seller, merchant.id, b.action === "link_existing_merchant" ? "linked_existing_merchant" : "created_sandbox_merchant", JSON.stringify(merchant), b.actor, note, nowIso());
  return getMapping(ctx, b.seller)!;
}

/** Live Nessie merchant details, plus any sellers mapped to it. */
export async function getMerchantDetails(ctx: AppContext, nessieMerchantId: string) {
  const m = await ctx.adapters.bank.getMerchant(nessieMerchantId);
  if (!m) throw notFound("Nessie merchant", nessieMerchantId);
  const mapped = listMappings(ctx).filter((x) => x.nessieMerchantId === nessieMerchantId).map((x) => ({ seller: x.seller, provenance: x.provenance }));
  return { merchant: m, source: ctx.adapters.bank.source, fetchedAt: ctx.now().toISOString(), mappedSellers: mapped };
}

/**
 * Company account purchase history from Nessie (GET /accounts/{id}/purchases), joined with Runway's
 * executions by external purchase id. A bank record is not a merchant order or delivery.
 */
export async function purchaseHistory(ctx: AppContext) {
  const accountId = resolveAccountId(ctx);
  if (!accountId) throw new AppError("BANK_CHECK_UNAVAILABLE", "No Nessie account configured", 503, false);
  const purchases = await ctx.adapters.bank.listPurchases(accountId);
  // Approvals now transfer to the employee; their payment to the seller is from the employee's account.
  const transfers = await ctx.adapters.bank.listTransfers(accountId).catch(() => []);
  const execs = ctx.db.prepare("SELECT e.id, e.external_id, e.proposal_id, e.amount_cents, p.request_id FROM executions e JOIN proposals p ON p.id = e.proposal_id WHERE e.external_id IS NOT NULL").all() as Array<{ id: string; external_id: string; proposal_id: string; amount_cents: number; request_id: string }>;
  const byExternal = new Map(execs.map((e) => [e.external_id, e]));
  const mappings = listMappings(ctx);
  const merchantCache = new Map<string, NessieMerchant | null>();
  let lookups = 0;
  const merchantFor = async (id: string | null) => {
    if (!id) return null;
    const mapped = mappings.find((m) => m.nessieMerchantId === id);
    if (mapped?.merchant) return { id, name: mapped.merchant.name, mappedSeller: mapped.seller };
    if (!merchantCache.has(id) && lookups < 10) {
      lookups++;
      merchantCache.set(id, await ctx.adapters.bank.getMerchant(id).catch(() => null));
    }
    const m = merchantCache.get(id);
    return { id, name: m?.name ?? null, mappedSeller: mapped?.seller ?? null };
  };
  const items = [];
  for (const p of purchases) {
    const e = byExternal.get(p.id);
    items.push({
      purchaseId: p.id,
      providerStatus: p.status,
      purchaseDate: p.date,
      providerStoredAmountCents: p.amountCents,
      providerAmountRaw: p.rawAmount,
      description: p.description,
      merchant: await merchantFor(p.merchantId),
      origin: e ? ("runway" as const) : ("external" as const),
      runway: e ? { executionId: e.id, proposalId: e.proposal_id, requestId: e.request_id, approvedAmountCents: e.amount_cents, amountDiscrepancyCents: p.amountCents === null ? null : e.amount_cents - p.amountCents } : null,
    });
  }
  const payments = new Map(
    (ctx.db.prepare("SELECT execution_id, status, external_id, amount_cents FROM employee_payments").all() as Array<{ execution_id: string; status: string; external_id: string | null; amount_cents: number }>).map((p) => [p.execution_id, p]),
  );
  const transferItems = transfers.map((t) => {
    const e = byExternal.get(t.id);
    const pay = e ? payments.get(e.id) : undefined;
    return {
      transferId: t.id,
      payeeAccountId: t.payeeId,
      providerStatus: t.status,
      transferDate: t.date,
      providerStoredAmountCents: t.amountCents,
      description: t.description,
      origin: e ? ("runway" as const) : ("external" as const),
      runway: e ? { executionId: e.id, proposalId: e.proposal_id, requestId: e.request_id, approvedAmountCents: e.amount_cents } : null,
      employeePayment: pay ? { status: pay.status, purchaseId: pay.external_id, amountCents: pay.amount_cents } : null,
    };
  });
  return {
    accountId,
    source: ctx.adapters.bank.source,
    fetchedAt: ctx.now().toISOString(),
    purchases: items,
    transfers: transferItems,
    disclaimer: "Records of simulated purchases on the company's Nessie sandbox account. They are not merchant orders, receipts, shipments or deliveries.",
  };
}
