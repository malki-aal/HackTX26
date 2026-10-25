// Confirmation records and pending-activity groups. Everything here is read from persisted state;
// nothing about shipping, delivery confirmation, merchant orders or receipts is ever invented.
import type { AppContext } from "../app/context.js";
import type { Offer } from "../contracts/domain.js";
import { getProposalView } from "./proposals.js";
import { getExecutionView } from "./executions.js";
import { itemView, loadVersion } from "./requests.js";
import { getMapping } from "./merchants.js";
import { actorInfo, requireMember, type Principal } from "../auth/access.js";

const BANK_RECORD_NOTICE =
  "This is a simulated purchase recorded on the company's Capital One Nessie sandbox account. It is not a merchant checkout, order, receipt, shipment or delivery confirmation.";

function actor(ctx: AppContext, id: string | null) {
  const a = actorInfo(ctx, id);
  return a ? { id: a.id, role: a.role, label: a.displayName, displayName: a.displayName, demoIdentity: a.demoIdentity } : null;
}

export function confirmationRecord(ctx: AppContext, proposalId: string) {
  const p = getProposalView(ctx, proposalId);
  const req = ctx.db.prepare("SELECT created_by, project_id, line_key FROM requests WHERE id = ?").get(p.requestId) as { created_by: string; project_id: string | null; line_key: string | null };
  const v = loadVersion(ctx, p.requestId, p.requestVersion);
  const exe = p.executionId ? getExecutionView(ctx, p.executionId) : null;
  const approval = [...p.decisions].reverse().find((d) => d.version === p.version) ?? null;
  const submittedAt = p.versions.find((x) => x.version === p.version)?.submittedAt ?? null;
  const offer = p.offer as Offer;
  const mapping = (exe?.merchantMapping as ReturnType<typeof getMapping>) ?? getMapping(ctx, offer.seller);
  const discrepancies: string[] = [];
  if (exe?.amountNote) discrepancies.push(exe.amountNote);
  return {
    proposalId: p.id,
    proposalVersion: p.version,
    requestId: p.requestId,
    projectId: req.project_id,
    lineKey: req.line_key,
    item: itemView(v.fields),
    offer: {
      offerId: offer.id,
      title: offer.title,
      researchedSeller: offer.seller,
      sourceUrl: offer.sourceUrl,
      imageUrl: offer.imageUrl,
      priceText: offer.priceText,
      observedAt: offer.observedAt,
      quantity: p.quantity,
      unit: v.fields.unit,
      packagesRequired: p.evaluation.cost.packagesRequired,
    },
    requester: actor(ctx, req.created_by),
    approver: approval ? { ...actor(ctx, approval.actor)!, decision: approval.decision, decidedAt: approval.createdAt, note: approval.note } : null,
    account: exe ? { masked: exe.accountMasked, provider: exe.mode === "live" ? "nessie" : "fixture" } : null,
    merchant: mapping
      ? { researchedSeller: offer.seller, nessieMerchantId: mapping.nessieMerchantId, nessieMerchantName: mapping.merchant?.name ?? null, provenance: mapping.provenance, mapped: true }
      : { researchedSeller: offer.seller, nessieMerchantId: null, nessieMerchantName: null, provenance: null, mapped: false },
    amounts: {
      currency: "USD",
      researchListedSubtotalCents: p.amounts.researchListedSubtotalCents,
      budgetCeilingCents: p.amounts.requestBudgetCeilingCents,
      approvedAmountCents: exe?.approvedAmountCents ?? p.amounts.exactAmountCents,
      approvedAmountSource: p.amounts.exactAmountSource,
      providerStoredAmountCents: exe?.providerStoredAmountCents ?? null,
      discrepancyCents: exe?.amountDiscrepancyCents ?? null,
    },
    provider: exe?.externalReference ? { purchaseId: exe.externalReference.purchaseId, status: exe.providerStatus, purchaseDate: exe.providerPurchaseDate } : null,
    statuses: {
      decision: p.decisionState,
      execution: exe?.status ?? "not_started",
      provider: exe?.providerStatus ?? null,
    },
    timestamps: {
      submittedAt,
      approvedAt: exe?.timestamps.approvedAt ?? (approval?.decision === "approve" ? approval.createdAt : null),
      providerSubmittedAt: exe?.timestamps.providerSubmittedAt ?? null,
      recordedAt: exe?.timestamps.recordedAt ?? null,
      providerRetrievedAt: exe?.timestamps.providerRetrievedAt ?? null,
    },
    evidenceLinks: offer.sourceUrl ? [{ label: `Listing (${offer.seller ?? "seller"}), observed ${offer.observedAt}`, url: offer.sourceUrl }] : [],
    discrepancies,
    executionId: exe?.id ?? null,
    lastError: exe?.lastError ?? null,
    notice: BANK_RECORD_NOTICE,
  };
}

/**
 * Pending and recent activity, split by where each item is waiting:
 * approval, execution start, an in-flight or uncertain write, or Nessie's own pending status.
 */
export function activity(ctx: AppContext, viewer: Principal, limit = 50) {
  requireMember(viewer);
  // Executives see their company's activity; employees see only their own proposals.
  const proposals = (viewer.role === "executive"
    ? ctx.db.prepare("SELECT p.id FROM proposals p JOIN requests r ON r.id = p.request_id WHERE r.org_id = ? ORDER BY p.updated_at DESC LIMIT ?").all(viewer.orgId, limit)
    : ctx.db.prepare("SELECT p.id FROM proposals p JOIN requests r ON r.id = p.request_id WHERE r.org_id = ? AND r.created_by = ? ORDER BY p.updated_at DESC LIMIT ?").all(viewer.orgId, viewer.userId, limit)) as Array<{ id: string }>;
  const groups = {
    awaitingApproval: [] as ReturnType<typeof confirmationRecord>[],
    approvedNotExecuted: [] as ReturnType<typeof confirmationRecord>[],
    executionInProgressOrUncertain: [] as ReturnType<typeof confirmationRecord>[],
    providerPending: [] as ReturnType<typeof confirmationRecord>[],
    providerRecorded: [] as ReturnType<typeof confirmationRecord>[],
    executionFailed: [] as ReturnType<typeof confirmationRecord>[],
  };
  for (const { id } of proposals) {
    const c = confirmationRecord(ctx, id);
    const { decision, execution, provider } = c.statuses;
    if (decision === "awaiting_review") groups.awaitingApproval.push(c);
    else if (decision !== "approved") continue;
    else if (execution === "not_started" || execution === "queued") groups.approvedNotExecuted.push(c);
    else if (execution === "submitting" || execution === "uncertain") groups.executionInProgressOrUncertain.push(c);
    else if (execution === "failed") groups.executionFailed.push(c);
    else if (execution === "recorded" && (provider ?? "pending") === "pending") groups.providerPending.push(c);
    else groups.providerRecorded.push(c);
  }
  return {
    groups,
    counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    notice: BANK_RECORD_NOTICE,
  };
}

