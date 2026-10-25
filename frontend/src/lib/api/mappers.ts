// Pure mappings from backend contract shapes (backend/docs/openapi.json, CONTRACT_V3_EXECUTIVE_AUTH.md)
// to UI types. No network access here, so these are unit-tested directly.
import type { ActivityItem, DecisionState, ExecutionState, FinancialPreview, PersonRef } from "./types";

/** `actorInfo` / `employee` / `requester` as the server sends them. */
export interface BActorInfo {
  id: string;
  displayName: string;
  role: "employee" | "executive" | null;
  demoIdentity: boolean;
}

export function personOf(a: BActorInfo | null | undefined): PersonRef | null {
  return a ? { displayName: a.displayName, demo: !!a.demoIdentity } : null;
}

/** Display text for a person. Demo wording appears only for actual demo identities. */
export function personLabel(p: PersonRef | null | undefined, fallback = "Unknown"): string {
  if (!p) return fallback;
  return p.demo ? `${p.displayName} (demo identity)` : p.displayName;
}

/** One `GET /proposals` item (contract v3 §5). */
export interface BQueueItem {
  id: string;
  requestId: string;
  version: number;
  title: string;
  quantity: number;
  unit: string;
  employee: BActorInfo | null;
  decisionState: DecisionState;
  executionStatus: ExecutionState | "not_started";
  providerStatus: string | null;
  offer: { id: string; title: string; seller: string | null; sourceUrl: string | null; imageUrl: string | null; observedAt: string };
  exactAmountCents: number | null;
  eligibility: string;
  unresolved: string[];
  offerStale: boolean;
  latestDecision: { decision: string; resultingState: string; note: string; actor: BActorInfo | null; version: number; createdAt: string } | null;
  submittedAt: string | null;
  executionId: string | null;
  updatedAt: string;
}

export function mapQueueItem(b: BQueueItem): ActivityItem {
  return {
    proposalId: b.id,
    requestId: b.requestId,
    version: b.version,
    title: b.title,
    decision: b.decisionState,
    exactAmountCents: b.exactAmountCents,
    updatedAt: b.updatedAt,
    submittedAt: b.submittedAt,
    selectedTitle: b.offer.title,
    seller: b.offer.seller,
    imageUrl: b.offer.imageUrl ?? undefined,
    quantityText: `${b.quantity} ${b.unit}`,
    requester: personOf(b.employee),
    eligibility: b.eligibility,
    unresolved: b.unresolved,
    offerStale: b.offerStale,
    latestDecision: b.latestDecision
      ? { decision: b.latestDecision.decision, note: b.latestDecision.note, actor: personOf(b.latestDecision.actor), at: b.latestDecision.createdAt, version: b.latestDecision.version }
      : undefined,
    execution: b.executionId ? { id: b.executionId, status: b.executionStatus, providerStatus: b.providerStatus } : undefined,
  };
}

export const EMPTY_COUNTS: Record<DecisionState, number> = { not_submitted: 0, awaiting_review: 0, approved: 0, changes_requested: 0, rejected: 0 };

/** Pass-through of the server preview; the UI never recomputes budget figures. */
export function mapPreview(b: FinancialPreview): FinancialPreview {
  return {
    proposalId: b.proposalId,
    proposalVersion: b.proposalVersion,
    label: b.label,
    currentAvailableCents: b.currentAvailableCents,
    exactExpenseCents: b.exactExpenseCents,
    projectedAvailableCents: b.projectedAvailableCents,
    reservationIncluded: b.reservationIncluded,
    freshness: b.freshness,
    canApprove: b.canApprove,
    blockingReasons: b.blockingReasons ?? [],
    amounts: b.amounts,
    unknowns: b.unknowns ?? [],
    notes: b.notes ?? [],
  };
}

export type PreviewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; preview: FinancialPreview };

/**
 * Whether the final Approve button may be pressed. The server rechecks everything on submit; this only
 * keeps the button honest: no approval while the preview is loading, unavailable, stale against the
 * reviewed version, blocked, or unconfirmed.
 */
export function approvalGate(s: PreviewState, reviewedVersion: number, confirmed: boolean): { enabled: boolean; reason: string | null } {
  if (s.kind === "loading") return { enabled: false, reason: "Checking the budget before approval…" };
  if (s.kind === "error") return { enabled: false, reason: `Budget check unavailable: ${s.message} Refresh to try again. You can still request changes or reject.` };
  const p = s.preview;
  if (p.proposalVersion !== reviewedVersion) return { enabled: false, reason: "This proposal changed since you opened it. Reload to review the latest revision." };
  if (!p.canApprove) {
    const why = p.blockingReasons.map((r) => r.message).join("; ") || "The server reported a blocker.";
    return { enabled: false, reason: `Approval is blocked: ${why}. You can still request changes or reject.` };
  }
  if (!confirmed) return { enabled: false, reason: "Tick the confirmation to approve." };
  return { enabled: true, reason: null };
}

/**
 * The decision that describes the CURRENT revision, if any. A resubmitted revision is awaiting review even
 * though an earlier revision was decided, so older decisions never stand in for the current one.
 */
export function currentRevisionDecision<T extends { version: number }>(decisions: T[], currentVersion: number): T | undefined {
  return [...decisions].reverse().find((d) => d.version === currentVersion);
}
