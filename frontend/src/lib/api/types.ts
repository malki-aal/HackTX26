// UI-facing types. The live adapter (live.ts) maps backend/docs/openapi.json responses
// onto these; the fixture adapter produces them directly. All money is integer USD cents.
//
// Fields marked "PROPOSED" are not in the backend contract yet (see
// docs/FRONTEND_CONTRACT_REQUESTS.md). Fixtures provide them; the live adapter fills them
// with explicit "unknown" values and never invents data.

export type Condition = "new" | "refurbished" | "used" | "any";
export type DeadlineKind = "flexible" | "hard";

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

/** One thing to buy. PROPOSED: the backend currently supports a single item (monitors) per request. */
export interface RequestItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
}

export interface PurchaseRequest {
  id: string;
  version: number;
  title: string;
  purpose: string;
  /** Free text in the UI; the backend currently accepts only "monitors". */
  category: string;
  items: RequestItem[];
  budgetTotalCents: number;
  mandatory: string[];
  preferences: string[];
  condition: Condition;
  deadline?: string;
  /** PROPOSED: hard deadlines can exclude offers; flexible ones are only a target. */
  deadlineKind: DeadlineKind;
  agentConfigId: string;
  status: RequestStatus;
  clarifications: Clarification[];
  confirmedVersion?: number;
  runId?: string;
  agentConfigVersion?: number | null;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewRequestInput {
  title: string;
  purpose: string;
  category: string;
  items: Omit<RequestItem, "id">[];
  budgetTotalCents: number;
  mandatory: string[];
  preferences: string[];
  condition: Condition;
  deadline?: string;
  deadlineKind: DeadlineKind;
  agentConfigId: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  version: number;
  summary: string;
}

export type ToolName =
  | "getConfirmedRequirements"
  | "searchProducts"
  | "getProductDetails"
  | "evaluateCandidates"
  | "readBudgetContext"
  | "prepareProposalDraft";

export interface AgentConfigDetail extends AgentConfig {
  createdAt: string;
  instructions: string;
  enabledTools: ToolName[];
  rankingPriority: "lowest_known_total" | "evidence_completeness";
  searchStrategy: "exact_specs" | "broad_then_filter";
  limits: { maxSearchCalls: number; maxDetailCalls: number; maxSteps: number; maxDurationMs: number };
}

export type AgentConfigInput = Pick<AgentConfigDetail, "name" | "instructions" | "enabledTools" | "rankingPriority" | "searchStrategy" | "limits">;

export interface IntegrationStatus {
  name: string;
  state: "configured" | "verified" | "degraded" | "unavailable" | "fixture";
  detail: string;
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

/** PROPOSED: backend-generated tradeoff labels. An offer may carry more than one. */
export type OfferHighlight = "lowest_known_cost" | "best_deadline_fit" | "best_overall_fit";

export interface DeliveryInfo {
  status: "stated" | "unknown";
  /** Text as the seller stated it. Never computed by the UI. */
  text?: string;
}

export interface Offer {
  id: string;
  /** Which requested item this offer covers. */
  itemId: string;
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
  delivery: DeliveryInfo;
  /** PROPOSED: backend's verdict against the request deadline. */
  deadlineFit: "meets" | "misses" | "unknown" | "not_applicable";
  highlights: OfferHighlight[];
  /** PROPOSED: backend-written plain-language tradeoff; falls back to rankNote. */
  tradeoff?: string;
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

export type DecisionState = "not_submitted" | "awaiting_review" | "approved" | "changes_requested" | "rejected";
export type ExecutionState =
  | "not_started"
  | "queued"
  | "submitting"
  | "recorded"
  | "failed"
  | "uncertain";

export interface MerchantInfo {
  /** Seller found by research. */
  researchedSeller: string | null;
  /** Nessie sandbox merchant the purchase was booked against. Null means mapping is required. */
  nessieMerchantId: string | null;
  /** PROPOSED: sandbox merchant name from Nessie. */
  nessieMerchantName?: string | null;
}

export interface ExecutionDetail {
  id: string;
  proposalId: string;
  status: ExecutionState;
  providerStatus: string | null;
  /** Amount the executive approved (user-confirmed). */
  amountCents: number;
  /** Amount Nessie stored (whole dollars). Null until recorded. */
  providerAmountCents: number | null;
  amountDiscrepancyCents: number | null;
  amountNote: string | null;
  purchaseId: string | null;
  merchant: MerchantInfo;
  lastError: string | null;
  disclaimer: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalLine {
  itemId: string;
  itemName: string;
  offerId: string;
  title: string;
  seller: string | null;
  sourceUrl: string | null;
  listedSubtotalCents: number | null;
  quantityText: string;
}

export interface Proposal {
  id: string;
  requestId: string;
  requestTitle: string;
  revision: number;
  lines: ProposalLine[];
  justification: string;
  suitabilityConfirmed: boolean;
  researchSubtotalCents: number | null;
  budgetCeilingCents: number;
  expenseCents: number;
  expenseSource: "user_confirmed";
  decision: DecisionState;
  decisionNote?: string;
  /** Who requested it and who decided, as the backend records them (demo roles, not accounts). */
  requester: string;
  approval?: { actor: string; at: string; decision: string };
  execution: ExecutionState;
  executionDetail?: ExecutionDetail;
  unresolved: string[];
  submittedAt?: string;
}

export interface SaveProposalInput {
  selections: { itemId: string; offerId: string }[];
  justification: string;
  suitabilityConfirmed: boolean;
  expenseCents: number;
}

/** One row of purchasing activity: a submitted proposal and, once approved, its execution. */
export interface ActivityItem {
  proposalId: string;
  requestId: string;
  title: string;
  decision: DecisionState;
  exactAmountCents: number;
  updatedAt: string;
  execution?: ExecutionDetail;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
}

export type BackendMode = "live" | "fixtures" | "offline";
