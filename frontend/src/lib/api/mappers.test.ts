import { describe, expect, it } from "vitest";
import { approvalGate, mapQueueItem, personLabel, type BQueueItem } from "./mappers";
import type { FinancialPreview } from "./types";

const row = (over: Partial<BQueueItem> = {}): BQueueItem => ({
  id: "prop_1",
  requestId: "req_1",
  version: 2,
  title: "Engineering monitors",
  quantity: 4,
  unit: "units",
  employee: { id: "usr_1", displayName: "Sam Lee", role: "employee", demoIdentity: false },
  decisionState: "awaiting_review",
  executionStatus: "not_started",
  providerStatus: null,
  offer: { id: "off_1", title: "Acme 27in QHD Monitor", seller: "Acme Store", sourceUrl: "https://example.com/p", imageUrl: "https://example.com/i.png", observedAt: "2026-10-25T00:00:00Z" },
  exactAmountCents: 58756,
  eligibility: "needs_review",
  unresolved: ["Mandatory condition unconfirmed"],
  offerStale: false,
  latestDecision: null,
  submittedAt: "2026-10-25T01:00:00Z",
  executionId: null,
  updatedAt: "2026-10-25T01:00:00Z",
  ...over,
});

describe("queue mapping", () => {
  it("keeps the request title and the selected product apart, and uses the verified requester", () => {
    const a = mapQueueItem(row());
    expect(a.title).toBe("Engineering monitors");
    expect(a.selectedTitle).toBe("Acme 27in QHD Monitor");
    expect(a.requester).toEqual({ displayName: "Sam Lee", demo: false });
    expect(personLabel(a.requester)).toBe("Sam Lee");
    expect(a.imageUrl).toBe("https://example.com/i.png");
    expect(a.quantityText).toBe("4 units");
    expect(a.exactAmountCents).toBe(58756);
    expect(a.unresolved).toHaveLength(1);
    expect(a.execution).toBeUndefined();
  });
  it("labels demo identities only when they are demo identities", () => {
    const a = mapQueueItem(row({ employee: { id: "employee-demo", displayName: "Demo Employee", role: "employee", demoIdentity: true } }));
    expect(personLabel(a.requester)).toBe("Demo Employee (demo identity)");
    expect(personLabel(null, "Unknown requester")).toBe("Unknown requester");
  });
  it("carries execution status and the latest decision note from the server", () => {
    const a = mapQueueItem(row({
      decisionState: "approved", executionId: "exe_1", executionStatus: "uncertain", providerStatus: null,
      latestDecision: { decision: "approve", resultingState: "approved", note: "Go", actor: { id: "u2", displayName: "Erin", role: "executive", demoIdentity: false }, version: 2, createdAt: "2026-10-25T02:00:00Z" },
    }));
    expect(a.execution).toEqual({ id: "exe_1", status: "uncertain", providerStatus: null });
    expect(a.latestDecision).toMatchObject({ note: "Go", actor: { displayName: "Erin", demo: false }, version: 2 });
  });
});

const preview = (over: Partial<FinancialPreview> = {}): FinancialPreview => ({
  proposalId: "prop_1", proposalVersion: 2, label: "Available budget from Runway's ledger",
  currentAvailableCents: 200000, exactExpenseCents: 58756, projectedAvailableCents: 141244, reservationIncluded: false,
  freshness: { source: "nessie_live", fetchedAt: "2026-10-25T00:00:00Z", refreshedNow: true, status: "verified" },
  canApprove: true, blockingReasons: [],
  amounts: { researchListedSubtotalCents: 50000, budgetCeilingCents: 100000, exactExpenseCents: 58756, amountSource: "user_confirmed", approvedAmountCents: null, providerStoredAmountCents: null, discrepancyCents: null },
  unknowns: ["Sales tax"], notes: [], ...over,
});

describe("approval gate", () => {
  it("is closed while loading or when the preview is unavailable", () => {
    expect(approvalGate({ kind: "loading" }, 2, true).enabled).toBe(false);
    const e = approvalGate({ kind: "error", message: "Can't reach the backend." }, 2, true);
    expect(e.enabled).toBe(false);
    expect(e.reason).toMatch(/Change or Deny/);
  });
  it("is closed when the server reports blockers, naming them", () => {
    const g = approvalGate({ kind: "ready", preview: preview({ canApprove: false, blockingReasons: [{ code: "exceeds_available_budget", message: "$587.56 exceeds available $100.00" }] }) }, 2, true);
    expect(g.enabled).toBe(false);
    expect(g.reason).toContain("exceeds available");
  });
  it("is closed for a stale reviewed version and until the confirmation is ticked", () => {
    expect(approvalGate({ kind: "ready", preview: preview({ proposalVersion: 3 }) }, 2, true).enabled).toBe(false);
    expect(approvalGate({ kind: "ready", preview: preview() }, 2, false)).toEqual({ enabled: false, reason: "Tick the confirmation to approve." });
    expect(approvalGate({ kind: "ready", preview: preview() }, 2, true)).toEqual({ enabled: true, reason: null });
  });
  it("an existing reservation is shown by the server, never subtracted by the UI", () => {
    const p = preview({ reservationIncluded: true, projectedAvailableCents: 200000 });
    expect(p.projectedAvailableCents).toBe(p.currentAvailableCents);
  });
});
