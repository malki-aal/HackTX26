import type {
  ActivityPage,
  FinancialPreview,
  Me,
  AgentConfig,
  AgentConfigDetail,
  AgentConfigInput,
  IntegrationStatus,
  BackendMode,
  Budget,
  ExecutionDetail,
  NewRequestInput,
  ProjectView,
  ProjectSummary,
  Offer,
  Proposal,
  PurchaseRequest,
  Run,
  SaveProposalInput,
} from "./types";

// Single boundary between UI and data. Components import only `api` and never
// know whether data is fixture or live.
import type { ScenarioSet } from "../scenarios";

export interface RunwayApi {
  mode: "fixture" | "live";
  /** Example presets for the New Request form (read-only; creates nothing). */
  getScenarios(): Promise<ScenarioSet>;
  /** Mode the backend reports (fixtures means the backend itself serves sample data). */
  getBackendMode(): Promise<BackendMode>;
  /** Contract v3 `GET /me`. Works while access is pending; rejects on 401 (UNAUTHENTICATED) and network errors. */
  getMe(): Promise<Me>;
  listRequests(): Promise<PurchaseRequest[]>;
  getRequest(id: string): Promise<PurchaseRequest>;
  createRequest(input: NewRequestInput): Promise<PurchaseRequest>;
  createProject(input: NewRequestInput): Promise<ProjectView>;
  getProject(id: string): Promise<ProjectView>;
  listProjects(): Promise<ProjectSummary[]>;
  startProjectResearch(id: string): Promise<{ results: { key: string; result: string; code?: string }[] }>;
  answerClarifications(id: string, answers: Record<string, string>): Promise<PurchaseRequest>;
  confirmRequirements(id: string, version: number): Promise<PurchaseRequest>;
  /**
   * Edit a request (e.g. after changes were requested): saves a new version. Material changes need
   * confirming again, and research for the old version no longer applies. Never researches by itself.
   */
  updateRequest(id: string, input: NewRequestInput & { expectedVersion: number }): Promise<PurchaseRequest>;
  startResearch(id: string): Promise<Run>;
  getRun(runId: string): Promise<Run>;
  cancelRun(runId: string): Promise<Run>;
  listCandidates(requestId: string): Promise<Offer[]>;
  saveAndSubmitProposal(requestId: string, input: SaveProposalInput): Promise<Proposal>;
  getProposal(id: string): Promise<Proposal>;
  /** Submitted proposals with their execution status, newest first, plus server counts. */
  listActivity(): Promise<ActivityPage>;
  /** Executives: server-calculated effect of approval on available budget. `refresh` re-reads the bank (free). */
  getFinancialPreview(proposalId: string, opts?: { refresh?: boolean }): Promise<FinancialPreview>;
  getExecution(id: string): Promise<ExecutionDetail>;
  /** Executive demo role. `idempotencyKey` must be reused when retrying the same decision. */
  decide(args: {
    proposalId: string;
    version: number;
    decision: "approve" | "request_changes" | "reject";
    note?: string;
    /** Required for approve: the exact amount (cents) shown and confirmed in the review. */
    exactAmountCents?: number;
    idempotencyKey: string;
  }): Promise<Proposal>;
  /** `check` looks up the outcome; it never resends the purchase. */
  reconcile(executionId: string, action: "check" | "mark_failed"): Promise<ExecutionDetail>;
  /** `fresh: false` reads the saved snapshot instead of asking the bank again. */
  getBudget(opts?: { fresh?: boolean }): Promise<Budget>;
  /** Executive action: link a seller to a new Nessie sandbox merchant. Approval requires a mapping. */
  createMerchantMapping(seller: string): Promise<{ seller: string; merchantName: string | null; nessieMerchantId: string }>;
  listAgentConfigs(): Promise<AgentConfig[]>;
  listAgentConfigDetails(): Promise<AgentConfigDetail[]>;
  /** Without `existing` creates a configuration; with it saves a new version of that one. */
  saveAgentConfig(input: AgentConfigInput, existing?: { id: string; version: number }): Promise<AgentConfigDetail>;
  getIntegrations(): Promise<IntegrationStatus[]>;
}
