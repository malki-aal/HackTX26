import type { DecisionState, ExecutionState, OfferHighlight, RequestStatus } from "./api";

export const statusLabel: Record<RequestStatus, string> = {
  clarifying: "Needs your review",
  awaiting_confirmation: "Needs your review",
  confirmed: "Ready for research",
  researching: "Research running",
  results_ready: "Offers ready",
  proposal_drafted: "Proposal drafted",
  submitted: "Awaiting executive approval",
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

/** Soft fill and readable ink per request status, so the list scans by colour as well as by words. */
export const statusTone: Record<RequestStatus, string> = {
  clarifying: "bg-accent-soft text-accent",
  awaiting_confirmation: "bg-accent-soft text-accent",
  confirmed: "bg-purple-soft text-purple-ink",
  researching: "bg-purple-soft text-purple-ink",
  results_ready: "bg-accent-soft text-accent",
  proposal_drafted: "bg-accent-soft text-accent",
  submitted: "bg-orange-soft text-orange-ink",
  approved: "bg-green-soft text-green-ink",
  changes_requested: "bg-pink-soft text-pink-ink",
  rejected: "bg-bad-soft text-bad",
};

export const stages = ["Review", "Research", "Compare", "Proposal", "Approval", "Record"] as const;

export function stageIndex(s: RequestStatus): number {
  switch (s) {
    case "clarifying":
    case "awaiting_confirmation":
      return 0;
    case "confirmed":
    case "researching":
      return 1;
    case "results_ready":
      return 2;
    case "proposal_drafted":
      return 3;
    case "submitted":
    case "changes_requested":
    case "rejected":
      return 4;
    case "approved":
      return 5;
  }
}

export const DECISION_LABEL: Record<DecisionState, string> = {
  not_submitted: "Not submitted",
  awaiting_review: "Awaiting executive approval",
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

export const EXECUTION_LABEL: Record<ExecutionState, string> = {
  not_started: "Purchase recording not started",
  queued: "Purchase recording queued",
  submitting: "Purchase recording in progress",
  recorded: "Recorded in Nessie sandbox",
  failed: "Purchase recording failed",
  uncertain: "Uncertain: needs checking",
};

export const HIGHLIGHT_LABEL: Record<OfferHighlight, string> = {
  lowest_known_cost: "Lowest known cost",
  best_deadline_fit: "Best deadline fit",
  best_overall_fit: "Best overall fit",
};
