import type { RunwayApi } from "./client";
import type {
  AgentConfig,
  ApiError,
  BackendMode,
  Budget,
  Clarification,
  DecisionState,
  ExecutionDetail,
  ExecutionState,
  IntegrationStatus,
  NewRequestInput,
  Offer,
  Proposal,
  PurchaseRequest,
  RequestStatus,
  Run,
  SaveProposalInput,
} from "./types";

// Live adapter for backend/docs/openapi.json. Every response is
// { data, meta }; every error is { error: { code, message, retryable, requestId } }.
// Money is already integer cents on the wire.

const BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000/api/v1").replace(/\/$/, "");

// ---------- transport ----------

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    const e: ApiError = {
      code: "BACKEND_UNREACHABLE",
      message: "Can't reach the backend. Check that it is running and that this origin is allowed by CORS.",
      retryable: true,
    };
    throw e;
  }
  const json = (await res.json().catch(() => null)) as
    | { data: T }
    | { error: { code: string; message: string; retryable?: boolean; requestId?: string } }
    | null;
  if (!res.ok || !json || "error" in json) {
    const err = json && "error" in json ? json.error : null;
    const e: ApiError = {
      code: err?.code ?? `HTTP_${res.status}`,
      message: err?.message ?? "The backend returned an unexpected response.",
      requestId: err?.requestId,
      retryable: err?.retryable,
    };
    throw e;
  }
  return json.data;
}

// ---------- backend shapes (only the fields the UI reads) ----------

interface BRequirement {
  id: string;
  attribute: string;
  operator: string;
  value: unknown;
  mandatory: boolean;
  /** Backend-provided label; preferred over local formatting so new categories need no UI code. */
  display?: string;
}
interface BItem {
  resolved: boolean;
  category: string | null;
  label: string;
  plural: string;
  unit: string;
}
interface BQuestion {
  id: string;
  text: string;
  options: { value: string; label: string }[];
  answer: unknown;
}
interface BRequest {
  id: string;
  version: number;
  status: string;
  confirmedVersion: number | null;
  isCurrentVersionConfirmed: boolean;
  title: string;
  purpose: string;
  category: string | null;
  item: BItem;
  quantity: number;
  totalBudgetCents: number;
  allowedCondition: PurchaseRequest["condition"];
  deadline: string | null;
  rankingPriority?: PurchaseRequest["ranking"];
  agentConfigId: string;
  agentConfigVersion: number | null;
  requirements: BRequirement[];
  questions: BQuestion[];
  latestRunId: string | null;
  proposals: { id: string; version: number; decisionState: string }[];
  createdAt: string;
  updatedAt: string;
}
interface BRequestSummary {
  id: string;
  version: number;
  title: string;
  category?: string | null;
  item?: BItem;
  status: string;
  quantity: number;
  totalBudgetCents: number;
  latestRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- mapping ----------

const PORT_LABEL: Record<string, string> = {
  hdmi: "HDMI",
  displayport: "DisplayPort",
  usb_c: "USB-C",
  thunderbolt: "Thunderbolt",
  vga: "VGA",
  dvi: "DVI",
};

export function describeRequirement(r: BRequirement): string {
  if (r.display) return r.display;
  switch (r.attribute) {
    case "product_type":
      return `Category: ${String(r.value)}`;
    case "screen_size":
      return `${Math.floor((r.value as { min: number }).min)} inch screen`;
    case "resolution":
      return `At least ${(r.value as { width: number }).width} × ${(r.value as { height: number }).height}`;
    case "port":
      return `${PORT_LABEL[String(r.value)] ?? String(r.value)} input`;
    case "condition":
      return `Condition: ${(r.value as string[]).join(" or ")}`;
    case "refresh_rate":
      return `At least ${String(r.value)} Hz`;
    case "panel_type":
      return `${(r.value as string[]).map((x) => x.toUpperCase()).join(" or ")} panel`;
    case "brand":
      return `Brand: ${(r.value as string[]).join(" or ")}`;
    default:
      return r.attribute;
  }
}

const REQUEST_STATUS: Record<string, RequestStatus> = {
  draft: "clarifying",
  needs_clarification: "clarifying",
  ready_to_confirm: "awaiting_confirmation",
  confirmed: "confirmed",
  researching: "researching",
  researched: "results_ready",
  proposal_draft: "proposal_drafted",
  submitted: "submitted",
  approved: "approved",
  changes_requested: "changes_requested",
  rejected: "rejected",
};

function mapRequest(b: BRequest): PurchaseRequest {
  // Product type and condition are shown separately, so they are not listed as specs.
  const specs = b.requirements.filter((r) => r.attribute !== "product_type" && r.attribute !== "condition");
  const latestProposal = b.proposals[b.proposals.length - 1];
  return {
    id: b.id,
    version: b.version,
    title: b.title,
    purpose: b.purpose,
    category: b.category,
    itemLabel: b.item.resolved ? b.item.plural : b.item.label,
    unit: b.item.unit,
    quantity: b.quantity,
    budgetTotalCents: b.totalBudgetCents,
    mandatory: specs.filter((r) => r.mandatory).map(describeRequirement),
    preferences: specs.filter((r) => !r.mandatory).map(describeRequirement),
    condition: b.allowedCondition,
    deadline: b.deadline ?? undefined,
    agentConfigId: b.agentConfigId,
    agentConfigVersion: b.agentConfigVersion,
    ranking: b.rankingPriority,
    status: REQUEST_STATUS[b.status] ?? "clarifying",
    clarifications: b.questions.map(
      (q): Clarification => ({
        id: q.id,
        question: q.text,
        options: q.options,
        answer: q.answer == null ? undefined : String(q.answer),
      }),
    ),
    confirmedVersion: b.isCurrentVersionConfirmed ? b.version : undefined,
    runId: b.latestRunId ?? undefined,
    proposalId: latestProposal?.id,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

function mapSummary(b: BRequestSummary): PurchaseRequest {
  return {
    id: b.id,
    version: b.version,
    title: b.title,
    purpose: "",
    category: b.category ?? null,
    itemLabel: b.item ? (b.item.resolved ? b.item.plural : b.item.label) : undefined,
    unit: b.item?.unit,
    quantity: b.quantity,
    budgetTotalCents: b.totalBudgetCents,
    mandatory: [],
    preferences: [],
    condition: "any",
    agentConfigId: "",
    status: REQUEST_STATUS[b.status] ?? "clarifying",
    clarifications: [],
    runId: b.latestRunId ?? undefined,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

/**
 * Request body text: the backend derives requirements from this description and treats a
 * statement as a preference only when "nice to have" sits within ~30 characters of the match.
 * Must-haves go first and nice-to-haves last, separated by enough padding that the two never
 * share an excerpt window, so a preference cannot demote a must-have (or the reverse).
 */
const SECTION_GAP = " ".repeat(80);
function buildDescription(input: NewRequestInput): string {
  const clean = (l: string) => l.replace(/[.\s]+$/, "");
  // "(required)" tells the backend these are must-haves, so it does not ask again.
  const must = input.mandatory.map(clean).filter(Boolean).map((l) => `${l} (required).`).join(" ");
  const nice = input.preferences.map(clean).filter(Boolean).map((l) => `Nice to have: ${l}.`).join(" ");
  return nice ? `${must}${SECTION_GAP}${nice}` : must;
}

interface BEvent {
  id: string;
  type: string;
  summary: string;
  createdAt: string;
}
interface BRun {
  id: string;
  requestId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  outcome: Run["outcome"];
  agentConfig: { id: string; version: number; displayName: string };
  error: { code?: string; message?: string } | string | null;
}

// Internal agent steps and raw tool calls are noise for an employee; every other
// backend event is shown as written.
const HIDDEN_EVENTS = new Set(["agent_step", "tool_called"]);

async function mapRun(b: BRun): Promise<Run> {
  const events = await call<BEvent[]>(`/runs/${b.id}/events`);
  const err = b.error == null ? undefined : typeof b.error === "string" ? b.error : (b.error.message ?? b.error.code);
  return {
    id: b.id,
    requestId: b.requestId,
    state: b.status === "queued" || b.status === "running" ? "running" : b.status,
    outcome: b.outcome ?? null,
    agentConfigId: b.agentConfig.id,
    agentConfigName: b.agentConfig.displayName,
    agentConfigVersion: b.agentConfig.version,
    events: events
      .filter((e) => !HIDDEN_EVENTS.has(e.type))
      .map((e) => ({ id: e.id, at: e.createdAt, message: e.summary })),
    error: err,
  };
}

interface BCandidate {
  offerId: string;
  eligibility: Offer["eligibility"];
  affordability: Offer["affordability"];
  title: string;
  imageUrl: string | null;
  seller: string | null;
  sourceUrl: string | null;
  unitPriceCents: number | null;
  packageQuantity: number | null;
  packagesRequired: number | null;
  listedSubtotalCents: number | null;
  shippingCents: number | null;
  costNotes: string[];
  requirementChecks: { requirementId: string; attribute: string; state: Offer["findings"][number]["status"]; evidenceIds: string[]; reason: string }[];
  evidence: { id: string; excerpt: string; source: string }[];
  unknowns: string[];
  recommendationReason: string;
  recommendationKinds?: string[];
  observedAt: string;
  expiresAt: string;
  stale: boolean;
  fromCache: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  serpapi_google_shopping: "listing text",
  serpapi_immersive_product: "product spec page",
  user: "you",
};
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function mapCandidate(c: BCandidate, labels: Map<string, string>, quantity: number): Offer {
  const excerpts = new Map(c.evidence.map((e) => [e.id, e]));
  return {
    id: c.offerId,
    title: c.title,
    seller: c.seller ?? "Unknown seller",
    url: c.sourceUrl ?? "",
    imageUrl: c.imageUrl ?? undefined,
    observedAt: c.observedAt,
    unitPriceCents: c.unitPriceCents,
    packageQuantity: c.packageQuantity ?? 1,
    packagesRequired: c.packagesRequired ?? quantity,
    listedSubtotalCents: c.listedSubtotalCents,
    shippingCents: c.shippingCents,
    taxCents: null, // the backend never knows tax
    eligibility: c.eligibility,
    findings: c.requirementChecks.map((k) => {
      const ev = k.evidenceIds.map((id) => excerpts.get(id)).find(Boolean);
      return {
        requirement: labels.get(k.requirementId) ?? k.attribute,
        status: k.state,
        evidence: ev ? `${k.reason} — “${ev.excerpt}” (${SOURCE_LABEL[ev.source] ?? ev.source})` : k.reason,
      };
    }),
    rankNote: c.recommendationReason,
    recommendationKinds: c.recommendationKinds ?? [],
    unresolved: c.unknowns.map(sentence),
    affordability: c.affordability,
    costNotes: c.costNotes,
    expiresAt: c.expiresAt,
    stale: c.stale,
    fromCache: c.fromCache,
  };
}

interface BExecution {
  id: string;
  status: ExecutionState;
  providerStatus: string | null;
  externalReference: { purchaseId?: string | null } | null;
  amountCents: number;
  providerAmountCents: number | null;
  amountDiscrepancyCents: number | null;
  amountNote: string | null;
  lastError: unknown;
  disclaimer: string;
}

function mapExecution(e: BExecution): ExecutionDetail {
  return {
    id: e.id,
    status: e.status,
    providerStatus: e.providerStatus,
    amountCents: e.amountCents,
    providerAmountCents: e.providerAmountCents,
    amountDiscrepancyCents: e.amountDiscrepancyCents,
    amountNote: e.amountNote,
    purchaseId: e.externalReference?.purchaseId ?? null,
    lastError: e.lastError == null ? null : typeof e.lastError === "string" ? e.lastError : JSON.stringify(e.lastError),
    disclaimer: e.disclaimer,
  };
}

interface BProposal {
  id: string;
  requestId: string;
  version: number;
  decisionState: DecisionState;
  offer: { id: string };
  justification: string;
  technicalReviewConfirmed: boolean;
  unresolved: string[];
  amounts: {
    researchListedSubtotalCents: number | null;
    requestBudgetCeilingCents: number;
    exactAmountCents: number | null;
  };
  decisions: { decision: string; note: string }[];
  execution: BExecution | null;
  versions: { version: number; submittedAt?: string | null }[];
}

function mapProposal(p: BProposal): Proposal {
  const last = p.decisions[p.decisions.length - 1];
  const v = p.versions.find((x) => x.version === p.version);
  return {
    id: p.id,
    requestId: p.requestId,
    revision: p.version,
    offerId: p.offer.id,
    justification: p.justification,
    suitabilityConfirmed: p.technicalReviewConfirmed,
    researchSubtotalCents: p.amounts.researchListedSubtotalCents,
    budgetCeilingCents: p.amounts.requestBudgetCeilingCents,
    expenseCents: p.amounts.exactAmountCents ?? 0,
    expenseSource: "user_confirmed",
    decision: p.decisionState,
    decisionNote: last?.note || undefined,
    execution: p.execution?.status ?? "not_started",
    executionDetail: p.execution ? mapExecution(p.execution) : undefined,
    unresolved: p.unresolved,
    submittedAt: v?.submittedAt ?? undefined,
  };
}

// ---------- adapter ----------

async function fetchRequest(id: string): Promise<PurchaseRequest> {
  return mapRequest(await call<BRequest>(`/requests/${id}`));
}

export const liveApi: RunwayApi = {
  mode: "live",

  async getBackendMode(): Promise<BackendMode> {
    try {
      const res = await fetch(`${BASE}/health`, { cache: "no-store" });
      const json = (await res.json()) as { meta?: { mode?: "live" | "fixtures" } };
      return json.meta?.mode ?? "live";
    } catch {
      return "offline";
    }
  },

  async listRequests() {
    const rows = await call<BRequestSummary[]>("/requests?limit=50");
    return rows.map(mapSummary);
  },

  getRequest: fetchRequest,

  async createRequest(input: NewRequestInput) {
    const b = await call<BRequest>("/requests", {
      method: "POST",
      body: {
        title: input.title,
        purpose: input.purpose,
        description: buildDescription(input),
        // No category hint: the backend resolves the item type from the text and asks when unsure.
        quantity: input.quantity,
        currency: "USD",
        budgetCents: input.budgetTotalCents,
        budgetBasis: "total",
        allowedCondition: input.condition,
        deadline: input.deadline ?? null,
        ...(input.ranking ? { rankingPriority: input.ranking } : {}),
        agentConfigId: input.agentConfigId,
      },
    });
    return mapRequest(b);
  },

  async answerClarifications(id, answers) {
    const current = await fetchRequest(id);
    const b = await call<BRequest>(`/requests/${id}/clarify`, {
      method: "POST",
      body: {
        expectedVersion: current.version,
        answers: Object.entries(answers)
          .filter(([, value]) => value !== "")
          .map(([questionId, value]) => ({ questionId, value })),
      },
    });
    return mapRequest(b);
  },

  async confirmRequirements(id, version) {
    return mapRequest(await call<BRequest>(`/requests/${id}/confirm`, { method: "POST", body: { version } }));
  },

  async startResearch(id) {
    const req = await fetchRequest(id);
    const started = await call<{ runId: string }>(`/requests/${id}/research`, {
      method: "POST",
      body: { version: req.version, agentConfigId: req.agentConfigId },
    });
    return this.getRun(started.runId);
  },

  async getRun(runId) {
    return mapRun(await call<BRun>(`/runs/${runId}`));
  },

  async cancelRun(runId) {
    await call(`/runs/${runId}/cancel`, { method: "POST", body: {} });
    return this.getRun(runId);
  },

  async listCandidates(requestId) {
    const [bReq, runId] = await call<BRequest>(`/requests/${requestId}`).then((r) => [r, r.latestRunId] as const);
    if (!runId) return [];
    const data = await call<{ candidates: BCandidate[] }>(`/requests/${requestId}/candidates?runId=${runId}`);
    const labels = new Map(bReq.requirements.map((r) => [r.id, describeRequirement(r)]));
    return data.candidates.map((c) => mapCandidate(c, labels, bReq.quantity));
  },

  async saveAndSubmitProposal(requestId, input: SaveProposalInput) {
    const bReq = await call<BRequest>(`/requests/${requestId}`);
    if (!bReq.latestRunId) throw { code: "INVALID_STATE", message: "Run research before proposing an offer." } satisfies ApiError;
    // Reuse an unsubmitted draft (or add a revision after changes were requested) so a
    // failed submit never leaves duplicate drafts.
    const reusable = [...bReq.proposals].reverse().find((p) => p.decisionState === "not_submitted" || p.decisionState === "changes_requested");
    const draft = await call<BProposal>(`/requests/${requestId}/proposals`, {
      method: "POST",
      body: {
        runId: bReq.latestRunId,
        offerId: input.offerId,
        justification: input.justification,
        ...(reusable ? { proposalId: reusable.id } : {}),
      },
    });
    const submitted = await call<BProposal>(`/proposals/${draft.id}/submit`, {
      method: "POST",
      body: { version: draft.version, technicalReviewConfirmed: true, exactAmountCents: input.expenseCents },
    });
    return mapProposal(submitted);
  },

  async getProposal(id) {
    return mapProposal(await call<BProposal>(`/proposals/${id}`));
  },

  async getBudget(): Promise<Budget> {
    const b = await call<{
      status: Budget["status"];
      source: string;
      fetchedAt: string | null;
      reportedBalanceCents: number | null;
      obligationsCents: number;
      activeReservationsCents: number;
      unreflectedExpensesCents: number;
      availableBudgetCents: number | null;
      reconciliationNotes: string[];
    }>("/budget?refresh=true");
    const source =
      b.source === "nessie_live" ? "Nessie sandbox, just fetched" : b.source === "nessie_cached" ? "Nessie sandbox, cached" : b.source === "fixture" ? "Fixture sample, not Nessie" : "No bank data";
    return {
      status: b.status,
      source,
      fetchedAt: b.fetchedAt,
      reportedBalanceCents: b.reportedBalanceCents,
      obligationsCents: b.obligationsCents,
      commitmentsCents: b.activeReservationsCents + b.unreflectedExpensesCents,
      availableCents: b.availableBudgetCents,
      notes: b.reconciliationNotes.join(" "),
    };
  },

  async listAgentConfigs(): Promise<AgentConfig[]> {
    const rows = await call<
      { id: string; version: number; displayName: string; searchStrategy: string; limits: { maxSearchCalls: number; maxDetailCalls: number } }[]
    >("/agent-configs");
    return rows
      .map((c) => ({
        id: c.id,
        name: c.displayName,
        version: c.version,
        summary: `${c.searchStrategy === "exact_specs" ? "Exact-spec search" : "Broad search, then filter"}, up to ${c.limits.maxSearchCalls} searches and ${c.limits.maxDetailCalls} product lookups.`,
      }))
      .sort((a, b) => (a.id === "cfg_default" ? -1 : b.id === "cfg_default" ? 1 : a.name.localeCompare(b.name)));
  },

  async getIntegrations(): Promise<IntegrationStatus[]> {
    const rows = await call<
      { service: string; configured: boolean; mode: string; state: string; lastError: string | null }[]
    >("/integrations/status");
    const names: Record<string, string> = { gemini: "Gemini", serpapi: "SerpApi", nessie: "Nessie", agent_runtime: "Agent runtime" };
    return rows.map((r) => {
      const state: IntegrationStatus["state"] =
        r.state === "ok" ? "verified" : r.state === "fixture" ? "fixture" : r.state === "degraded" ? "degraded" : r.state === "unverified" ? "configured" : "unavailable";
      const detail =
        r.lastError ??
        (r.state === "not_configured" ? "Not configured on the backend." : r.state === "unverified" ? "Configured, not yet verified." : r.state === "fixture" ? "Sample data, no live calls." : "");
      return { name: names[r.service] ?? r.service, state, detail };
    });
  },
};

// ---------- executive demo role (adapter only; no screen uses these yet) ----------

export const executiveApi = {
  async listAwaitingReview(): Promise<{ id: string; requestId: string; title: string; seller: string | null; exactAmountCents: number }[]> {
    return call(`/proposals?decisionState=awaiting_review`);
  },

  getProposal: liveApi.getProposal,

  /** Reuse `idempotencyKey` when retrying the same logical decision; create a new one for a new decision. */
  async decide(args: {
    proposalId: string;
    version: number;
    decision: "approve" | "request_changes" | "reject";
    note?: string;
    idempotencyKey: string;
  }): Promise<Proposal> {
    return mapProposal(
      await call<BProposal>(`/proposals/${args.proposalId}/decision`, {
        method: "POST",
        headers: { "Idempotency-Key": args.idempotencyKey },
        body: { version: args.version, decision: args.decision, actor: "executive-demo", note: args.note ?? "" },
      }),
    );
  },

  async getExecution(id: string): Promise<ExecutionDetail> {
    return mapExecution(await call<BExecution>(`/executions/${id}`));
  },

  /** `check` asks the backend to look up the outcome; it never resends the purchase. */
  async reconcile(id: string, action: "check" | "mark_failed", note = ""): Promise<ExecutionDetail> {
    return mapExecution(
      await call<BExecution>(`/executions/${id}/reconcile`, {
        method: "POST",
        body: { action, actor: "executive-demo", note },
      }),
    );
  },
};
