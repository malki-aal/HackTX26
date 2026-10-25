import type { RunwayApi } from "./client";
import type {
  ActivityItem,
  AgentConfig,
  AgentConfigDetail,
  AgentConfigInput,
  IntegrationStatus,
  ApiError,
  BackendMode,
  Budget,
  Clarification,
  DecisionState,
  ExecutionDetail,
  ExecutionState,
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
//
// The backend currently supports one item type (monitors) per request, no deadline kinds and no
// tradeoff alternatives. Anything the UI offers beyond that is refused here with an explicit
// error rather than approximated. See docs/FRONTEND_CONTRACT_REQUESTS.md.

const BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000/api/v1").replace(/\/$/, "");

const unsupported = (message: string): ApiError => ({ code: "UNSUPPORTED_BY_BACKEND", message });

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
  isCurrentVersionConfirmed: boolean;
  title: string;
  purpose: string;
  quantity: number;
  totalBudgetCents: number;
  allowedCondition: PurchaseRequest["condition"];
  deadline: string | null;
  rankingPriority: string;
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
  switch (r.attribute) {
    case "product_type":
      return "Monitor";
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

const MONITOR_ITEM = (quantity: number) => [{ id: "item_1", name: "Monitors", quantity, unit: "units" }];

function mapRequest(b: BRequest): PurchaseRequest {
  // Product type and condition are shown separately, so they are not listed as specs.
  const specs = b.requirements.filter((r) => r.attribute !== "product_type" && r.attribute !== "condition");
  const latestProposal = b.proposals[b.proposals.length - 1];
  return {
    id: b.id,
    version: b.version,
    title: b.title,
    purpose: b.purpose,
    category: "monitors",
    items: MONITOR_ITEM(b.quantity),
    budgetTotalCents: b.totalBudgetCents,
    mandatory: specs.filter((r) => r.mandatory).map(describeRequirement),
    preferences: specs.filter((r) => !r.mandatory).map(describeRequirement),
    condition: b.allowedCondition,
    deadline: b.deadline ?? undefined,
    deadlineKind: "flexible", // the backend stores a date but has no hard/flexible distinction
    agentConfigId: b.agentConfigId,
    agentConfigVersion: b.agentConfigVersion,
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
    category: "monitors",
    items: MONITOR_ITEM(b.quantity),
    budgetTotalCents: b.totalBudgetCents,
    mandatory: [],
    preferences: [],
    condition: "any",
    deadlineKind: "flexible",
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
  const must = input.mandatory.map(clean).filter(Boolean).map((l) => `${l}.`).join(" ");
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
  rank: number;
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

function mapCandidate(c: BCandidate, labels: Map<string, string>, req: BRequest): Offer {
  const excerpts = new Map(c.evidence.map((e) => [e.id, e]));
  // The backend ranks by eligibility, then affordability, then lowest known cost. With its
  // default ranking priority, the first eligible, priced candidate is the lowest known cost.
  const lowest = c.rank === 1 && c.eligibility === "eligible" && c.listedSubtotalCents !== null && req.rankingPriority === "lowest_known_total";
  return {
    id: c.offerId,
    itemId: "item_1",
    title: c.title,
    seller: c.seller ?? "Unknown seller",
    url: c.sourceUrl ?? "",
    imageUrl: c.imageUrl ?? undefined,
    observedAt: c.observedAt,
    unitPriceCents: c.unitPriceCents,
    packageQuantity: c.packageQuantity ?? 1,
    packagesRequired: c.packagesRequired ?? req.quantity,
    listedSubtotalCents: c.listedSubtotalCents,
    shippingCents: c.shippingCents,
    taxCents: null, // the backend never knows tax
    delivery: { status: "unknown" }, // candidates carry no delivery data yet
    deadlineFit: req.deadline ? "unknown" : "not_applicable",
    highlights: lowest ? ["lowest_known_cost"] : [],
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
  proposalId: string;
  status: ExecutionState;
  providerStatus: string | null;
  externalReference: { purchaseId?: string | null; merchantId?: string | null } | null;
  amountCents: number;
  providerAmountCents: number | null;
  amountDiscrepancyCents: number | null;
  amountNote: string | null;
  lastError: unknown;
  disclaimer: string;
  createdAt: string;
  updatedAt: string;
}

function mapExecution(e: BExecution, seller: string | null): ExecutionDetail {
  return {
    id: e.id,
    proposalId: e.proposalId,
    status: e.status,
    providerStatus: e.providerStatus,
    amountCents: e.amountCents,
    providerAmountCents: e.providerAmountCents,
    amountDiscrepancyCents: e.amountDiscrepancyCents,
    amountNote: e.amountNote,
    purchaseId: e.externalReference?.purchaseId ?? null,
    merchant: {
      researchedSeller: seller,
      nessieMerchantId: e.externalReference?.merchantId ?? null,
      // The backend does not return the sandbox merchant's name yet.
    },
    lastError: e.lastError == null ? null : typeof e.lastError === "string" ? e.lastError : JSON.stringify(e.lastError),
    disclaimer: e.disclaimer,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

interface BProposal {
  id: string;
  requestId: string;
  version: number;
  decisionState: DecisionState;
  quantity: number;
  offer: { id: string; title: string; seller: string | null; sourceUrl: string | null };
  justification: string;
  technicalReviewConfirmed: boolean;
  unresolved: string[];
  amounts: {
    researchListedSubtotalCents: number | null;
    requestBudgetCeilingCents: number;
    exactAmountCents: number | null;
  };
  decisions: { decision: string; note: string; actor: string; createdAt: string }[];
  execution: BExecution | null;
  versions: { version: number; submittedAt?: string | null }[];
}

async function mapProposal(p: BProposal): Promise<Proposal> {
  const req = await call<BRequest>(`/requests/${p.requestId}`);
  const last = p.decisions[p.decisions.length - 1];
  const v = p.versions.find((x) => x.version === p.version);
  return {
    id: p.id,
    requestId: p.requestId,
    requestTitle: req.title,
    revision: p.version,
    lines: [
      {
        itemId: "item_1",
        itemName: "Monitors",
        offerId: p.offer.id,
        title: p.offer.title,
        seller: p.offer.seller,
        sourceUrl: p.offer.sourceUrl,
        listedSubtotalCents: p.amounts.researchListedSubtotalCents,
        quantityText: `${p.quantity} units`,
      },
    ],
    justification: p.justification,
    suitabilityConfirmed: p.technicalReviewConfirmed,
    researchSubtotalCents: p.amounts.researchListedSubtotalCents,
    budgetCeilingCents: p.amounts.requestBudgetCeilingCents,
    expenseCents: p.amounts.exactAmountCents ?? 0,
    expenseSource: "user_confirmed",
    decision: p.decisionState,
    decisionNote: last?.note || undefined,
    requester: "employee-demo",
    approval: last ? { actor: last.actor, at: last.createdAt, decision: last.decision } : undefined,
    execution: p.execution?.status ?? "not_started",
    executionDetail: p.execution ? mapExecution(p.execution, p.offer.seller) : undefined,
    unresolved: p.unresolved,
    submittedAt: v?.submittedAt ?? undefined,
  };
}

interface BAgentConfig {
  id: string;
  version: number;
  createdAt: string;
  displayName: string;
  instructions: string;
  enabledTools: AgentConfigDetail["enabledTools"];
  rankingPriority: AgentConfigDetail["rankingPriority"];
  searchStrategy: AgentConfigDetail["searchStrategy"];
  limits: AgentConfigDetail["limits"];
}

function mapConfig(c: BAgentConfig): AgentConfigDetail {
  return {
    id: c.id,
    name: c.displayName,
    version: c.version,
    createdAt: c.createdAt,
    instructions: c.instructions,
    enabledTools: c.enabledTools,
    rankingPriority: c.rankingPriority,
    searchStrategy: c.searchStrategy,
    limits: c.limits,
    summary: `${c.searchStrategy === "exact_specs" ? "Exact-spec search" : "Broad search, then filter"}, up to ${c.limits.maxSearchCalls} searches and ${c.limits.maxDetailCalls} product lookups.`,
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
    if (input.category !== "monitors") {
      throw unsupported("The backend can only research monitors right now. Other categories need a backend contract change.");
    }
    if (input.items.length !== 1) {
      throw unsupported("The backend supports one item type per request. Split this into one request per item, or wait for multi-item support.");
    }
    if (input.deadline && input.deadlineKind === "hard") {
      throw unsupported("The backend can't enforce hard deadlines yet. Choose a flexible target date.");
    }
    const b = await call<BRequest>("/requests", {
      method: "POST",
      body: {
        title: input.title,
        purpose: input.purpose,
        description: buildDescription(input),
        category: "monitors",
        quantity: input.items[0].quantity,
        currency: "USD",
        budgetCents: input.budgetTotalCents,
        budgetBasis: "total",
        allowedCondition: input.condition,
        deadline: input.deadline ?? null,
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
    const bReq = await call<BRequest>(`/requests/${requestId}`);
    if (!bReq.latestRunId) return [];
    const data = await call<{ candidates: BCandidate[] }>(`/requests/${requestId}/candidates?runId=${bReq.latestRunId}`);
    const labels = new Map(bReq.requirements.map((r) => [r.id, describeRequirement(r)]));
    return data.candidates.map((c) => mapCandidate(c, labels, bReq));
  },

  async saveAndSubmitProposal(requestId, input: SaveProposalInput) {
    if (input.selections.length !== 1) throw unsupported("The backend can propose one offer per request.");
    const offerId = input.selections[0].offerId;
    const bReq = await call<BRequest>(`/requests/${requestId}`);
    if (!bReq.latestRunId) throw { code: "INVALID_STATE", message: "Run research before proposing an offer." } satisfies ApiError;
    // Reuse an unsubmitted draft (or add a revision after changes were requested) so a
    // failed submit never leaves duplicate drafts.
    const reusable = [...bReq.proposals].reverse().find((p) => p.decisionState === "not_submitted" || p.decisionState === "changes_requested");
    const draft = await call<BProposal>(`/requests/${requestId}/proposals`, {
      method: "POST",
      body: {
        runId: bReq.latestRunId,
        offerId,
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

  async listActivity(): Promise<ActivityItem[]> {
    const [rows, requests] = await Promise.all([
      call<
        {
          id: string;
          requestId: string;
          decisionState: DecisionState;
          seller: string | null;
          exactAmountCents: number | null;
          executionId: string | null;
          updatedAt: string;
        }[]
      >("/proposals?limit=50"),
      call<BRequestSummary[]>("/requests?limit=50"),
    ]);
    const titles = new Map(requests.map((r) => [r.id, r.title]));
    const submitted = rows.filter((r) => r.decisionState !== "not_submitted");
    return Promise.all(
      submitted.map(async (r): Promise<ActivityItem> => {
        const ex = r.executionId ? await call<BExecution>(`/executions/${r.executionId}`) : null;
        return {
          proposalId: r.id,
          requestId: r.requestId,
          title: titles.get(r.requestId) ?? "Request",
          decision: r.decisionState,
          exactAmountCents: r.exactAmountCents ?? 0,
          updatedAt: r.updatedAt,
          execution: ex ? mapExecution(ex, r.seller) : undefined,
        };
      }),
    );
  },

  async getExecution(id) {
    const ex = await call<BExecution>(`/executions/${id}`);
    const proposal = await call<BProposal>(`/proposals/${ex.proposalId}`);
    return mapExecution(ex, proposal.offer.seller);
  },

  /** Reuse `idempotencyKey` when retrying the same logical decision; create a new one for a new decision. */
  async decide(args) {
    return mapProposal(
      await call<BProposal>(`/proposals/${args.proposalId}/decision`, {
        method: "POST",
        headers: { "Idempotency-Key": args.idempotencyKey },
        body: { version: args.version, decision: args.decision, actor: "executive-demo", note: args.note ?? "" },
      }),
    );
  },

  async reconcile(id, action) {
    const ex = await call<BExecution>(`/executions/${id}/reconcile`, {
      method: "POST",
      body: { action, actor: "executive-demo", note: "" },
    });
    const proposal = await call<BProposal>(`/proposals/${ex.proposalId}`);
    return mapExecution(ex, proposal.offer.seller);
  },

  async getBudget(opts): Promise<Budget> {
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
    }>(opts?.fresh === false ? "/budget" : "/budget?refresh=true");
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

  async listAgentConfigDetails(): Promise<AgentConfigDetail[]> {
    const rows = await call<BAgentConfig[]>("/agent-configs");
    return rows.map(mapConfig).sort((a, b) => (a.id === "cfg_default" ? -1 : b.id === "cfg_default" ? 1 : a.name.localeCompare(b.name)));
  },

  async saveAgentConfig(input: AgentConfigInput, existing) {
    const body = {
      displayName: input.name,
      instructions: input.instructions,
      enabledTools: input.enabledTools,
      rankingPriority: input.rankingPriority,
      searchStrategy: input.searchStrategy,
      limits: input.limits,
    };
    const saved = existing
      ? await call<BAgentConfig>(`/agent-configs/${existing.id}`, { method: "PATCH", body: { ...body, expectedVersion: existing.version } })
      : await call<BAgentConfig>("/agent-configs", { method: "POST", body });
    return mapConfig(saved);
  },

  async getIntegrations(): Promise<IntegrationStatus[]> {
    const rows = await call<{ service: string; configured: boolean; mode: string; state: string; lastError: string | null }[]>("/integrations/status");
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
};
