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
  projectId?: string;
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
  /** Decision state of the latest proposal for this request (e.g. "changes_requested"). */
  proposalDecision?: DecisionState;
  /** Spec lines an edit form can show and resubmit (no deadline or condition lines; those are fields). */
  specLines?: { mandatory: string[]; preferences: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface NewRequestInput {
  /** Optional debugging metadata: the example preset the form started from. */
  presetId?: string;
  title: string;
  purpose: string;
  category?: string;
  items: (Omit<RequestItem, "id"> & { budgetCents?: number; specifications?: string[] })[];
  budgetTotalCents: number;
  mandatory: string[];
  preferences: string[];
  condition: Condition;
  deadline?: string;
  deadlineKind: DeadlineKind;
  agentConfigId: string;
}

export interface ProjectView {
  id: string;
  title: string;
  purpose: string;
  budgetCents: number;
  lines: { key: string; requestId: string; title: string; quantity: number; lineBudgetCents: number; status: string; isCurrentVersionConfirmed: boolean; unansweredQuestionIds: string[]; research: { runStatus: string } | null }[];
}

export interface ProjectSummary { id: string; title: string; budgetCents: number; lines: number }

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
  /** Every recorded event type in order (including internal steps), for the progress phase. */
  trace: { type: string; at: string; tool?: string; waitMs?: number }[];
  /** When the run's first event was recorded. */
  startedAt: string | null;
  error?: string;
}

export type FindingStatus = "supported" | "contradicted" | "unknown";
export type Eligibility = "eligible" | "needs_review" | "rejected";

export interface Finding {
  requirement: string;
  status: FindingStatus;
  evidence: string;
  /** Backend requirement id (live mode). */
  requirementId?: string;
  /** True for must-haves. Unknown must-haves need verification or a recorded exception before submitting. */
  mandatory?: boolean;
}

/** The requester's handling of one unconfirmed must-have: verified themselves, or a deliberate exception. */
export interface RequirementResolution {
  requirementId: string;
  kind: "verified" | "exception";
  note: string;
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

export interface ProposalReview {
  purpose: string;
  requirements: { label: string; mandatory: boolean }[];
  findings: Finding[];
  observedAt: string | null;
  expiresAt: string | null;
  stale: boolean;
  fromCache: boolean;
  cost: {
    unitPriceCents: number | null;
    packagesRequired: number | null;
    listedSubtotalCents: number | null;
    shippingCents: number | null;
    taxCents: number | null; // always null: the backend never knows tax
    totalStatus: string;
  };
  alternatives: { title: string; seller: string | null; eligibility: string; costCents: number | null }[];
  budget: { status: string; availableCents: number | null; notes: string[] };
  history: { version: number; at: string; decision: string; actor: PersonRef; note: string }[];
  revisions: { version: number; submittedAt: string | null; exactAmountCents: number | null }[];
}

export interface MerchantInfo {
  /** Seller found by research. */
  researchedSeller: string | null;
  /** Nessie sandbox merchant the purchase was booked against. Null means mapping is required. */
  nessieMerchantId: string | null;
  /** PROPOSED: sandbox merchant name from Nessie. */
  nessieMerchantName?: string | null;
}

/** The employee paying the seller from their account (after an approval's transfer). */
export interface EmployeePayment {
  status: ExecutionState;
  amountCents: number;
  purchaseId: string | null;
  lastError: string | null;
  recordedAt: string | null;
}

export interface ExecutionDetail {
  id: string;
  proposalId: string;
  status: ExecutionState;
  /** "transfer": company → employee, then the employee pays the seller. "purchase": older, company paid the merchant. */
  kind: "transfer" | "purchase";
  /** Who the money was sent to (transfers only). */
  payee?: { displayName: string | null; accountMasked: string | null } | null;
  payment?: EmployeePayment | null;
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
  accountMasked?: string | null;
  recordedAt?: string | null;
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
  imageUrl?: string;
  listedSubtotalCents: number | null;
  quantityText: string;
}

/** A person as the server identifies them. `demo` is true only for fixed demo identities (sample-data mode). */
export interface PersonRef {
  displayName: string;
  demo: boolean;
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
  /**
   * Who requested it, and who decided the CURRENT revision (absent while it awaits review). Decisions on
   * earlier revisions are in `review.history`. Verified accounts, or demo identities.
   */
  requester: PersonRef | null;
  approval?: { actor: PersonRef; at: string; decision: string };
  execution: ExecutionState;
  executionDetail?: ExecutionDetail;
  unresolved: string[];
  /** How the requester verified, or deliberately excepted, each unconfirmed must-have (recorded at submission). */
  requirementResolutions: { requirement: string; kind: "verified" | "exception"; note: string; evidenceReason: string }[];
  review?: ProposalReview;
  submittedAt?: string;
  /** Executives only: the server's financial preview (cached bank context). Null for employees. */
  financialAssessment?: FinancialPreview | null;
}

export interface BlockingReason {
  code: string;
  message: string;
}

/** `GET /proposals/:id/financial-preview`: what approval would do to Runway's available budget. Integer cents. */
export interface FinancialPreview {
  proposalId: string;
  proposalVersion: number;
  label: string;
  /** Runway's available budget (ledger), not the bank's reported balance. */
  currentAvailableCents: number | null;
  exactExpenseCents: number | null;
  projectedAvailableCents: number | null;
  /** True when this proposal's reservation is already in the ledger, so it is not subtracted again. */
  reservationIncluded: boolean;
  freshness: { source: string; fetchedAt: string | null; refreshedNow: boolean; status: string };
  canApprove: boolean;
  blockingReasons: BlockingReason[];
  amounts: {
    researchListedSubtotalCents: number | null;
    budgetCeilingCents: number;
    exactExpenseCents: number | null;
    amountSource: string | null;
    approvedAmountCents: number | null;
    providerStoredAmountCents: number | null;
    discrepancyCents: number | null;
  };
  unknowns: string[];
  notes: string[];
}

export interface SaveProposalInput {
  selections: { itemId: string; offerId: string }[];
  justification: string;
  suitabilityConfirmed: boolean;
  expenseCents: number;
  requirementResolutions?: RequirementResolution[];
}

/** One row of purchasing activity (`GET /proposals` item): a submitted proposal and its execution status. */
export interface ActivityItem {
  proposalId: string;
  requestId: string;
  version: number;
  /** The request's title. */
  title: string;
  decision: DecisionState;
  /** Requester-confirmed expense; null if not confirmed. */
  exactAmountCents: number | null;
  updatedAt: string;
  submittedAt: string | null;
  /** The selected product (offer) title, not the request title. */
  selectedTitle: string;
  seller: string | null;
  imageUrl?: string;
  quantityText: string;
  requester: PersonRef | null;
  eligibility: string;
  unresolved: string[];
  offerStale: boolean;
  latestDecision?: { decision: string; note: string; actor: PersonRef | null; at: string; version: number };
  execution?: { id: string; status: ExecutionState; providerStatus: string | null };
}

/** Activity plus server-computed totals per decision state (over the whole scope, not just this page). */
export interface ActivityPage {
  items: ActivityItem[];
  counts: Record<DecisionState, number>;
  /** True if the server had more rows than were fetched. */
  truncated: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  requestId?: string;
  retryable?: boolean;
}

export type BackendMode = "live" | "fixtures" | "offline";

/** `GET /me` (contract v3): who the server says this is. Role and company come from its allowlist only. */
export interface Me {
  userId: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  /** "pending" means signed in with a Google account that is not on the allowlist. */
  status: "active" | "pending";
  role: "employee" | "executive" | null;
  company: { id: string; name: string } | null;
}

export interface WalletEntry {
  type: "received" | "paid";
  executionId: string;
  proposalId: string;
  requestId: string | null;
  title: string | null;
  amountCents: number;
  status: ExecutionState;
  at: string | null;
  seller: string | null;
  /** Received entries: the money is here and the seller hasn't been paid yet. */
  canPay?: boolean;
}

/** The signed-in employee's Nessie sandbox account (Runway's record; Nessie's balance shown separately). */
export interface Wallet {
  account: { masked: string | null } | null;
  runwayBalanceCents: number;
  receivedCents: number;
  paidCents: number;
  reportedBalanceCents: number | null;
  entries: WalletEntry[];
  disclaimer: string;
}
