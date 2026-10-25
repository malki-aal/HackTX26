import type { RequestStatus } from "./api";

export const statusLabel: Record<RequestStatus, string> = {
  clarifying: "Needs your answers",
  awaiting_confirmation: "Confirm requirements",
  confirmed: "Ready for research",
  researching: "Research running",
  results_ready: "Offers ready",
  proposal_drafted: "Proposal drafted",
  submitted: "Awaiting executive review",
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
};

export const stages = ["Clarify", "Confirm", "Research", "Offers", "Proposal"] as const;

export function stageIndex(s: RequestStatus): number {
  switch (s) {
    case "clarifying":
      return 0;
    case "awaiting_confirmation":
      return 1;
    case "confirmed":
    case "researching":
      return 2;
    case "results_ready":
      return 3;
    default:
      return 4;
  }
}
