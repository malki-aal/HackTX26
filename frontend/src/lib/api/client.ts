import type {
  ActivityItem,
  AgentConfig,
  AgentConfigDetail,
  AgentConfigInput,
  IntegrationStatus,
  BackendMode,
  Budget,
  ExecutionDetail,
  NewRequestInput,
  Offer,
  Proposal,
  PurchaseRequest,
  Run,
  SaveProposalInput,
} from "./types";

// Single boundary between UI and data. Components import only `api` and never
// know whether data is fixture or live.
export interface RunwayApi {
  mode: "fixture" | "live";
  /** Mode the backend reports (fixtures means the backend itself serves sample data). */
  getBackendMode(): Promise<BackendMode>;
  listRequests(): Promise<PurchaseRequest[]>;
  getRequest(id: string): Promise<PurchaseRequest>;
  createRequest(input: NewRequestInput): Promise<PurchaseRequest>;
  answerClarifications(id: string, answers: Record<string, string>): Promise<PurchaseRequest>;
  confirmRequirements(id: string, version: number): Promise<PurchaseRequest>;
  startResearch(id: string): Promise<Run>;
  getRun(runId: string): Promise<Run>;
  cancelRun(runId: string): Promise<Run>;
  listCandidates(requestId: string): Promise<Offer[]>;
  saveAndSubmitProposal(requestId: string, input: SaveProposalInput): Promise<Proposal>;
  getProposal(id: string): Promise<Proposal>;
  /** Submitted proposals with their execution (when one exists), newest first. */
  listActivity(): Promise<ActivityItem[]>;
  getExecution(id: string): Promise<ExecutionDetail>;
  /** Executive demo role. `idempotencyKey` must be reused when retrying the same decision. */
  decide(args: {
    proposalId: string;
    version: number;
    decision: "approve" | "request_changes" | "reject";
    note?: string;
    idempotencyKey: string;
  }): Promise<Proposal>;
  /** `check` looks up the outcome; it never resends the purchase. */
  reconcile(executionId: string, action: "check" | "mark_failed"): Promise<ExecutionDetail>;
  /** `fresh: false` reads the saved snapshot instead of asking the bank again. */
  getBudget(opts?: { fresh?: boolean }): Promise<Budget>;
  listAgentConfigs(): Promise<AgentConfig[]>;
  listAgentConfigDetails(): Promise<AgentConfigDetail[]>;
  /** Without `existing` creates a configuration; with it saves a new version of that one. */
  saveAgentConfig(input: AgentConfigInput, existing?: { id: string; version: number }): Promise<AgentConfigDetail>;
  getIntegrations(): Promise<IntegrationStatus[]>;
}
