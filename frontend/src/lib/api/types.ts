// UI-facing types. The live adapter (live.ts) maps backend/docs/openapi.json responses
// onto these; the fixture adapter produces them directly. All money is integer USD cents.

export type Condition = "new" | "refurbished" | "used" | "any";
export type RankingPriority = "lowest_known_total" | "evidence_completeness";

export type RequestStatus =
  | "clarifying"
  | "awaiting_confirmation"
  | "confirmed"
  | "researching"
  | "results_ready"
  | "proposal_drafted"
  | "submitted"
  | "approved"
  | "changes_requested"
  | "rejected";

export interface Clarification {
  id: string;
  question: string;
  options: { value: string; label: string }[];
  answer?: string;
}

export interface PurchaseRequest {
  id: string;
  version: number;
  title: string;
  purpose: string;
  category: "monitors";
  quantity: number;
  budgetTotalCents: number;
  mandatory: string[];
  preferences: string[];
  condition: Condition;
  deadline?: string;
  agentConfigId: string;
  ranking: RankingPriority;
  status: RequestStatus;
  clarifications: Clarification[];
  confirmedVersion?: number;
  runId?: string;
  agentConfigVersion?: number | null;
  selectedOfferId?: string;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewRequestInput {
  title: string;
  purpose: string;
  quantity: number;
  budgetTotalCents: number;
  mandatory: string[];
  preferences: string[];
  condition: Condition;
  deadline?: string;
  agentConfigId: string;
  ranking: RankingPriority;
}

export interface AgentConfig {
  id: string;
  name: string;
  version: number;
  summary: string;
}

export interface RunEvent {
  id: string;
  at: string;
  message: string;
}

export interface Run {
  id: string;
  requestId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  outcome: "candidates_found" | "no_confirmed_match" | "no_results" | null;
  agentConfigId: string;
  agentConfigName: string;
  agentConfigVersion: number;
  events: RunEvent[];
  error?: string;
}

export type FindingStatus = "supported" | "contradicted" | "unknown";
export type Eligibility = "eligible" | "needs_review" | "rejected";

export interface Finding {
  requirement: string;
  status: FindingStatus;
  evidence: string;
}

export interface Offer {
  id: string;
  title: string;
  seller: string;
  url: string;
  imageUrl?: string;
  observedAt: string;
  unitPriceCents: number | null;
  packageQuantity: number;
  packagesRequired: number;
  listedSubtotalCents: number | null;
  shippingCents: number | null; // null = unknown
  taxCents: number | null; // null = unknown
  delivery?: string;
  eligibility: Eligibility;
  findings: Finding[];
  rankNote: string;
  unresolved: string[];
  affordability: "within_budget_provisional" | "over_budget" | "unknown";
  costNotes: string[];
  expiresAt?: string;
  stale: boolean;
  fromCache: boolean;
}

export interface Budget {
  status: "verified" | "bank_check_unavailable" | "fixture";
  source: string;
  fetchedAt: string | null;
  reportedBalanceCents: number | null;
  obligationsCents: number;
  commitmentsCents: number;
  availableCents: number | null;
  notes: string;
}

export interface IntegrationStatus {
  name: string;
  state: "configured" | "verified" | "degraded" | "unavailable" | "fixture";
  detail: string;
}

export type DecisionState = "not_submitted" | "awaiting_review" | "approved" | "changes_requested" | "rejected";
export type ExecutionState =
  | "not_started"
  | "queued"
  | "submitting"
  | "recorded"
  | "failed"
  | "uncertain";

export interface ExecutionDetail {
  id: string;
  status: ExecutionState;
  providerStatus: string | null;
  /** Amount the executive approved (user-confirmed). */
  amountCents: number;
  /** Amount Nessie stored (whole dollars). Null until recorded. */
  providerAmountCents: number | null;
  amountDiscrepancyCents: number | null;
  amountNote: string | null;
  purchaseId: string | null;
  lastError: string | null;
  disclaimer: string;
}

export interface Proposal {
  id: string;
  requestId: string;
  revision: number;
  offerId: string;
  justification: string;
  suitabilityConfirmed: boolean;
  researchSubtotalCents: number | null;
  budgetCeilingCents: number;
  expenseCents: number;
  expenseSource: "user_confirmed";
  decision: DecisionState;
  decisionNote?: string;
  execution: ExecutionState;
  executionDetail?: ExecutionDetail;
  unresolved: string[];
  submittedAt?: string;
}

export interface SaveProposalInput {
  offerId: string;
  justification: string;
  suitabilityConfirmed: boolean;
  expenseCents: number;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
}

export type BackendMode = "live" | "fixtures" | "offline";
