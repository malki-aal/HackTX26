import type {
  AgentConfig,
  BackendMode,
  Budget,
  IntegrationStatus,
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
  getBudget(): Promise<Budget>;
  listAgentConfigs(): Promise<AgentConfig[]>;
  getIntegrations(): Promise<IntegrationStatus[]>;
}
