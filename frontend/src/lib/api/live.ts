import type { RunwayApi } from "./client";
import { UNAUTHORIZED_EVENT, getAuthToken } from "../auth/token";
import { authMode } from "../auth/config";
import type {
  ActivityItem,
  Me,
  ProposalReview,
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
  const token = await getAuthToken();
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
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
  /** Backend-provided label; preferred over local formatting. */
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
  isCurrentVersionConfirmed: boolean;
  title: string;
  purpose: string;
  category: string | null;
  item: BItem;
  quantity: number;
  totalBudgetCents: number;
  allowedCondition: PurchaseRequest["condition"];
  deadline: string | null;
  deadlineType?: "hard" | "target";
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
  deadlineType?: "hard" | "target";
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

const itemsOf = (item: BItem | undefined, quantity: number) => [
  { id: "item_1", name: item ? (item.resolved ? item.plural : item.label) : "Items", quantity, unit: item?.unit ?? "units" },
];

function mapRequest(b: BRequest): PurchaseRequest {
  // Product type and condition are shown separately, so they are not listed as specs.
  const specs = b.requirements.filter((r) => r.attribute !== "product_type" && r.attribute !== "condition");
  const latestProposal = b.proposals[b.proposals.length - 1];
  return {
    id: b.id,
    version: b.version,
    title: b.title,
    purpose: b.purpose,
    category: b.category ?? "",
    items: itemsOf(b.item, b.quantity),
    budgetTotalCents: b.totalBudgetCents,
    mandatory: specs.filter((r) => r.mandatory).map(describeRequirement),
    preferences: specs.filter((r) => !r.mandatory).map(describeRequirement),
    condition: b.allowedCondition,
    deadline: b.deadline ?? undefined,
    deadlineKind: b.deadlineType === "hard" ? "hard" : "flexible",
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
    category: b.category ?? "",
    items: itemsOf(b.item, b.quantity),
    budgetTotalCents: b.totalBudgetCents,
    mandatory: [],
    preferences: [],
    condition: "any",
    deadlineKind: b.deadlineType === "hard" ? "hard" : "flexible",
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

interface BDelivery {
  status: string;
  excerpt: string | null;
  earliest: string | null;
  latest: string | null;
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
  recommendationKinds?: string[];
  delivery?: BDelivery;
  observedAt: string;
  expiresAt: string;
  stale: boolean;
  fromCache: boolean;
}
interface BRecommendation {
  offerId: string;
  kinds: string[];
  reasoning: string[];
}
interface BNoncompliant {
  offerId: string;
  reason: string;
}

const SOURCE_LABEL: Record<string, string> = {
  serpapi_google_shopping: "listing text",
  serpapi_immersive_product: "product spec page",
  user: "you",
};
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const KIND: Record<string, Offer["highlights"][number]> = {
  lowest_cost: "lowest_known_cost",
  deadline_fit: "best_deadline_fit",
  best_overall: "best_overall_fit",
};

function mapCandidate(
  c: BCandidate,
  labels: Map<string, string>,
  req: BRequest,
  rec: BRecommendation | undefined,
  noncompliant: BNoncompliant | undefined,
): Offer {
  const excerpts = new Map(c.evidence.map((e) => [e.id, e]));
  const d = c.delivery;
  const stated = !!d && d.status !== "unknown" && !!(d.excerpt || d.latest);
  let fit: Offer["deadlineFit"] = "not_applicable";
  if (req.deadline) fit = noncompliant ? "misses" : d?.latest ? (d.latest <= req.deadline ? "meets" : "misses") : "unknown";
  const kinds = rec?.kinds ?? c.recommendationKinds ?? [];
  const reasons = [...(rec?.reasoning ?? []), ...(noncompliant ? [noncompliant.reason] : [])];
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
    delivery: stated ? { status: "stated", text: d?.excerpt ?? (d?.latest ? `Arrives by ${d.latest}` : undefined) } : { status: "unknown" },
    deadlineFit: fit,
    highlights: kinds.map((k) => KIND[k]).filter(Boolean),
    tradeoff: reasons.length ? reasons.join(" ") : undefined,
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
  approvedAmountCents?: number;
  providerStoredAmountCents?: number | null;
  accountMasked?: string | null;
  merchantMapping?: { nessieMerchantId: string; merchant?: { name?: string } | null } | null;
  timestamps?: { recordedAt?: string | null };
  amountNote: string | null;
  lastError: unknown;
  disclaimer: string;
  createdAt: string;
  updatedAt: string;
}

function mapExecution(e: BExecution, seller: string | null): ExecutionDetail {
  const stored = e.providerStoredAmountCents ?? e.providerAmountCents;
  const approved = e.approvedAmountCents ?? e.amountCents;
  return {
    id: e.id,
    proposalId: e.proposalId,
    status: e.status,
    providerStatus: e.providerStatus,
    amountCents: approved,
    providerAmountCents: stored,
    amountDiscrepancyCents: e.amountDiscrepancyCents,
    amountNote: e.amountNote,
    purchaseId: e.externalReference?.purchaseId ?? null,
    merchant: {
      researchedSeller: seller,
      nessieMerchantId: e.merchantMapping?.nessieMerchantId ?? e.externalReference?.merchantId ?? null,
      nessieMerchantName: e.merchantMapping?.merchant?.name ?? null,
    },
    lastError: e.lastError == null ? null : typeof e.lastError === "string" ? e.lastError : JSON.stringify(e.lastError),
    disclaimer: e.disclaimer,
    accountMasked: e.accountMasked ?? null,
    recordedAt: e.timestamps?.recordedAt ?? null,
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
  offer: {
    id: string;
    title: string;
    seller: string | null;
    sourceUrl: string | null;
    observedAt?: string;
    expiresAt?: string;
    fromCache?: boolean;
  };
  evaluation?: {
    requirementResults: { requirementId: string; attribute: string; state: Offer["findings"][number]["status"]; reason: string }[];
    cost: {
      unitPriceCents: number | null;
      packagesRequired: number | null;
      listedSubtotalCents: number | null;
      shippingCents: number | null;
      totalStatus: string;
    };
  };
  alternatives?: { title: string; seller: string | null; eligibility: string; knownComparableCostCents: number | null }[];
  offerStale?: boolean;
  budgetAssessment?: { status: string; availableBudgetCents: number | null; notes: string[] };
  justification: string;
  technicalReviewConfirmed: boolean;
  unresolved: string[];
  amounts: {
    researchListedSubtotalCents: number | null;
    requestBudgetCeilingCents: number;
    exactAmountCents: number | null;
  };
  decisions: { version: number; decision: string; note: string; actor: string; createdAt: string }[];
  execution: BExecution | null;
  versions: { version: number; submittedAt?: string | null; exactAmountCents?: number | null }[];
}

async function mapProposal(p: BProposal): Promise<Proposal> {
  const req = await call<BRequest>(`/requests/${p.requestId}`);
  const last = p.decisions[p.decisions.length - 1];
  const v = p.versions.find((x) => x.version === p.version);
  const labels = new Map(req.requirements.map((r) => [r.id, describeRequirement(r)]));
  const unit = req.item?.unit ?? "units";
  const review: ProposalReview = {
    purpose: req.purpose,
    requirements: req.requirements
      .filter((r) => r.attribute !== "product_type")
      .map((r) => ({ label: describeRequirement(r), mandatory: r.mandatory })),
    findings: (p.evaluation?.requirementResults ?? []).map((r) => ({
      requirement: labels.get(r.requirementId) ?? r.attribute,
      status: r.state,
      evidence: r.reason,
    })),
    observedAt: p.offer.observedAt ?? null,
    expiresAt: p.offer.expiresAt ?? null,
    stale: !!p.offerStale,
    fromCache: !!p.offer.fromCache,
    cost: {
      unitPriceCents: p.evaluation?.cost.unitPriceCents ?? null,
      packagesRequired: p.evaluation?.cost.packagesRequired ?? null,
      listedSubtotalCents: p.evaluation?.cost.listedSubtotalCents ?? p.amounts.researchListedSubtotalCents,
      shippingCents: p.evaluation?.cost.shippingCents ?? null,
      taxCents: null,
      totalStatus: p.evaluation?.cost.totalStatus ?? "price_unknown",
    },
    alternatives: (p.alternatives ?? []).map((a) => ({
      title: a.title,
      seller: a.seller,
      eligibility: a.eligibility,
      costCents: a.knownComparableCostCents,
    })),
    budget: {
      status: p.budgetAssessment?.status ?? "amount_unknown",
      availableCents: p.budgetAssessment?.availableBudgetCents ?? null,
      notes: p.budgetAssessment?.notes ?? [],
    },
    history: p.decisions.map((d) => ({ version: d.version, at: d.createdAt, decision: d.decision, actor: d.actor, note: d.note })),
    revisions: p.versions.map((x) => ({ version: x.version, submittedAt: x.submittedAt ?? null, exactAmountCents: x.exactAmountCents ?? null })),
  };
  return {
    id: p.id,
    requestId: p.requestId,
    requestTitle: req.title,
    revision: p.version,
    lines: [
      {
        itemId: "item_1",
        itemName: req.item ? (req.item.resolved ? req.item.plural : req.item.label) : "Items",
        offerId: p.offer.id,
        title: p.offer.title,
        seller: p.offer.seller,
        sourceUrl: p.offer.sourceUrl,
        listedSubtotalCents: p.amounts.researchListedSubtotalCents,
        quantityText: `${p.quantity} ${unit}`,
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
    review,
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

  async getMe(): Promise<Me> {
    return call<Me>("/me");
  },

  async listRequests() {
    const rows = await call<BRequestSummary[]>("/requests?limit=50");
    return rows.map(mapSummary);
  },

  getRequest: fetchRequest,

  async createRequest(input: NewRequestInput) {
    if (input.items.length !== 1) {
      throw unsupported("This request has several item types. One request covers one item type until project requests are connected.");
    }
    const item = input.items[0];
    const b = await call<BRequest>("/requests", {
      method: "POST",
      body: {
        title: input.title,
        purpose: input.purpose,
        description: buildDescription(input),
        // No category hint: the backend resolves the item type from the text and asks when unsure.
        quantity: item.quantity,
        unit: item.unit,
        currency: "USD",
        budgetCents: input.budgetTotalCents,
        budgetBasis: "total",
        allowedCondition: input.condition,
        deadline: input.deadline ?? null,
        deadlineType: input.deadline && input.deadlineKind === "hard" ? "hard" : "target",
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
    const data = await call<{
      candidates: BCandidate[];
      recommendations?: BRecommendation[];
      noncompliantAlternatives?: BNoncompliant[];
    }>(`/requests/${requestId}/candidates?runId=${bReq.latestRunId}`);
    const labels = new Map(bReq.requirements.map((r) => [r.id, describeRequirement(r)]));
    const recs = new Map((data.recommendations ?? []).map((r) => [r.offerId, r]));
    const late = new Map((data.noncompliantAlternatives ?? []).map((r) => [r.offerId, r]));
    return data.candidates.map((c) => mapCandidate(c, labels, bReq, recs.get(c.offerId), late.get(c.offerId)));
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
          title: string;
          seller: string | null;
          exactAmountCents: number | null;
          executionId: string | null;
          updatedAt: string;
        }[]
      >("/proposals?limit=100"),
      call<BRequestSummary[]>("/requests?limit=50"),
    ]);
    const titles = new Map(requests.map((r) => [r.id, r.title]));
    const sizes = new Map(requests.map((r) => [r.id, `${r.quantity} ${r.item?.unit ?? "units"}`]));
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
          selectedTitle: r.title,
          seller: r.seller,
          quantityText: sizes.get(r.requestId) ?? "",
          requester: "employee-demo",
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
        body: {
          version: args.version,
          decision: args.decision,
          note: args.note ?? "",
          // Signed-in mode takes identity from the session; the demo actor is sent only in demo mode.
          ...(authMode === "clerk" ? {} : { actor: "executive-demo" }),
          // Approval must confirm the exact revision and amount the executive reviewed.
          ...(args.decision === "approve" && args.exactAmountCents !== undefined
            ? { confirmation: { confirmed: true, proposalVersion: args.version, exactAmountCents: args.exactAmountCents } }
            : {}),
        },
      }),
    );
  },

  async reconcile(id, action) {
    const ex = await call<BExecution>(`/executions/${id}/reconcile`, {
      method: "POST",
      body: { action, note: "", ...(authMode === "clerk" ? {} : { actor: "executive-demo" }) },
    });
    const proposal = await call<BProposal>(`/proposals/${ex.proposalId}`);
    return mapExecution(ex, proposal.offer.seller);
  },

  async createMerchantMapping(seller) {
    const m = await call<{ seller: string; nessieMerchantId: string; merchant?: { name?: string } | null }>("/merchant-mappings", {
      method: "POST",
      body: { action: "create_sandbox_merchant", seller, ...(authMode === "clerk" ? {} : { actor: "executive-demo" }) },
    });
    return { seller: m.seller, merchantName: m.merchant?.name ?? null, nessieMerchantId: m.nessieMerchantId };
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
