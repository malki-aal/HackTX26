import type { RunwayApi } from "./client";
import type {
  ActivityItem,
  ActivityPage,
  Me,
  AgentConfig,
  AgentConfigDetail,
  AgentConfigInput,
  IntegrationStatus,
  Budget,
  ExecutionDetail,
  NewRequestInput,
  ProjectView,
  Offer,
  OfferHighlight,
  Proposal,
  ProposalLine,
  ProposalReview,
  PurchaseRequest,
  Run,
  SaveProposalInput,
} from "./types";

// FIXTURE DATA. Every product, seller, price, delivery estimate and balance below is invented
// sample data shaped like the (proposed) contract. None of it is a search result, and no
// request made in fixture mode ever reaches a bank.

interface RunEntry {
  startedAt: number;
  cancelled?: boolean;
  run: Run;
}

interface StoredProposal extends Omit<Proposal, "executionDetail" | "execution"> {
  version: number;
  executionId?: string;
}

interface Db {
  projects?: ProjectView[];
  configs?: AgentConfigDetail[];
  requests: PurchaseRequest[];
  runs: Record<string, RunEntry>;
  proposals: StoredProposal[];
  executions: ExecutionDetail[];
}

const KEY = "runway.fixtures.v2";
const RUN_STEP_MS = 1400;
const RUN_MESSAGES = [
  "Search started for the confirmed items",
  "Search completed: listings returned for each item",
  "Offers normalized to a common price basis",
  "Evaluation completed against each must-have",
  "Budget checked against the request total",
];

const configs: AgentConfig[] = [
  { id: "cfg_default", name: "Exact-spec researcher", version: 1, summary: "Exact-spec search, up to 2 searches per item." },
  { id: "cfg_broad_scan", name: "Broad market scan", version: 1, summary: "Broad search, then filter." },
];

const ALL_TOOLS: AgentConfigDetail["enabledTools"] = [
  "getConfirmedRequirements",
  "searchProducts",
  "getProductDetails",
  "evaluateCandidates",
  "readBudgetContext",
  "prepareProposalDraft",
];

const defaultConfigs: AgentConfigDetail[] = [
  {
    ...configs[0],
    createdAt: "2026-10-24T00:00:00.000Z",
    instructions: "Search for listings that state the confirmed specifications explicitly. Prefer fewer, precise searches.",
    enabledTools: ALL_TOOLS,
    rankingPriority: "lowest_known_total",
    searchStrategy: "exact_specs",
    limits: { maxSearchCalls: 2, maxDetailCalls: 3, maxSteps: 14, maxDurationMs: 300000 },
  },
  {
    ...configs[1],
    createdAt: "2026-10-24T00:00:00.000Z",
    instructions: "Run broad queries first, then filter by the confirmed requirements.",
    enabledTools: ALL_TOOLS.filter((t) => t !== "readBudgetContext"),
    rankingPriority: "evidence_completeness",
    searchStrategy: "broad_then_filter",
    limits: { maxSearchCalls: 3, maxDetailCalls: 2, maxSteps: 14, maxDurationMs: 300000 },
  },
];

const SANDBOX_DISCLAIMER =
  "Simulated purchase in the Capital One Nessie sandbox. No real money moved and no merchant order was placed.";

function delay<T>(v: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(v), ms));
}
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const now = () => new Date().toISOString();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function load(): Db {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    if (raw) return JSON.parse(raw) as Db;
  } catch {}
  return { requests: [], runs: {}, proposals: [], executions: [] };
}
function save(db: Db) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(db));
  } catch {}
}
function mutate<T>(fn: (db: Db) => T): T {
  const db = load();
  const out = fn(db);
  save(db);
  return out;
}
function find(db: Db, id: string): PurchaseRequest {
  const r = db.requests.find((x) => x.id === id);
  if (!r) throw { code: "NOT_FOUND", message: "Request not found." };
  return r;
}

// ---------- offers ----------

const DAY = 86_400_000;

function daysUntil(date?: string): number | null {
  if (!date) return null;
  const t = new Date(`${date}T23:59:59`).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - Date.now()) / DAY));
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

interface Draft extends Omit<Offer, "deadlineFit" | "highlights" | "tradeoff"> {
  deliveryDays: number | null;
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function draftOffers(r: PurchaseRequest): Draft[] {
  const observedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const specs = r.mandatory.length ? r.mandatory : ["Matches the item description"];
  const out: Draft[] = [];
  for (const item of r.items) {
    const base = 300 + (hash(item.name) % 700); // 3.00 to 9.99 per unit
    const mk = (
      n: number,
      title: string,
      seller: string,
      factor: number,
      shipping: number | null,
      deliveryDays: number | null,
      eligibility: Offer["eligibility"],
      unknownSpec: number,
    ): Draft => {
      const unit = Math.round(base * factor);
      const subtotal = unit * item.quantity;
      const delivery =
        deliveryDays === null
          ? ({ status: "unknown" } as const)
          : ({ status: "stated", text: `Arrives in ${deliveryDays} days` } as const);
      return {
        id: `${item.id}_off${n}`,
        itemId: item.id,
        title,
        seller,
        url: `https://example.com/listing/${slug(item.name)}-${n}`,
        observedAt,
        unitPriceCents: unit,
        packageQuantity: 1,
        packagesRequired: item.quantity,
        listedSubtotalCents: subtotal,
        shippingCents: shipping,
        taxCents: null,
        delivery,
        deliveryDays,
        eligibility,
        findings: specs.map((s, i) => ({
          requirement: s,
          status: eligibility === "rejected" && i === 0 ? "contradicted" : i === unknownSpec ? "unknown" : "supported",
          evidence:
            eligibility === "rejected" && i === 0
              ? "Listing describes a different size or type."
              : i === unknownSpec
                ? "The listing does not say."
                : "Listing text matches.",
        })),
        rankNote:
          eligibility === "rejected"
            ? "Fails a must-have."
            : `Known listed cost ${money(subtotal)}; shipping and tax are not both known.`,
        unresolved: [
          ...(shipping === null ? ["Shipping cost"] : []),
          "Sales tax",
          ...(deliveryDays === null ? ["Delivery date"] : []),
          ...(unknownSpec >= 0 && unknownSpec < specs.length && eligibility !== "rejected" ? [`${specs[unknownSpec]} not confirmed`] : []),
        ],
        affordability: subtotal <= r.budgetTotalCents ? "within_budget_provisional" : "over_budget",
        costNotes: ["Sales tax is unknown; total is provisional"],
        stale: false,
        fromCache: false,
      };
    };
    out.push(
      mk(1, `Sample ${item.name}, value pack`, "Example Supply Co", 0.8, null, null, "eligible", -1),
      mk(2, `Sample ${item.name}, standard`, "Example Hardware", 1.0, 599, 3, "eligible", -1),
      mk(3, `Sample ${item.name}, bulk lot`, "Example Wholesale", 0.7, 799, 12, "needs_review", 0),
      mk(4, `Sample ${item.name}, wrong size`, "Example Depot", 0.6, null, null, "rejected", -1),
    );
  }
  return out;
}

/** Stand-in for the backend's proposed tradeoff generation. */
function fixtureOffers(r: PurchaseRequest): Offer[] {
  const drafts = draftOffers(r);
  const limit = daysUntil(r.deadline);
  const withFit = drafts.map((d) => {
    const fit: Offer["deadlineFit"] =
      limit === null ? "not_applicable" : d.deliveryDays === null ? "unknown" : d.deliveryDays <= limit ? "meets" : "misses";
    return { d, fit };
  });
  const highlights = new Map<string, OfferHighlight[]>();
  const add = (id: string, h: OfferHighlight) => highlights.set(id, [...(highlights.get(id) ?? []), h]);
  for (const item of r.items) {
    const mine = withFit.filter((x) => x.d.itemId === item.id && x.d.eligibility === "eligible");
    const usable = mine.filter((x) => !(r.deadlineKind === "hard" && x.fit === "misses"));
    const priced = usable.filter((x) => x.d.listedSubtotalCents !== null);
    if (priced.length) add([...priced].sort((a, b) => a.d.listedSubtotalCents! - b.d.listedSubtotalCents!)[0].d.id, "lowest_known_cost");
    const timed = usable.filter((x) => x.fit === "meets" && x.d.deliveryDays !== null);
    if (timed.length) add([...timed].sort((a, b) => a.d.deliveryDays! - b.d.deliveryDays!)[0].d.id, "best_deadline_fit");
    const overall = priced.filter((x) => x.fit === "meets" || x.fit === "not_applicable");
    if (overall.length) {
      const score = (x: (typeof overall)[number]) => x.d.findings.filter((f) => f.status === "supported").length * 100000 - x.d.listedSubtotalCents! / 10 + (x.d.deliveryDays !== null ? 5000 : 0);
      add([...overall].sort((a, b) => score(b) - score(a))[0].d.id, "best_overall_fit");
    }
  }
  return withFit.map(({ d, fit }) => {
    const { deliveryDays, ...rest } = d;
    void deliveryDays;
    const supported = d.findings.filter((f) => f.status === "supported").length;
    const unknown = d.findings.filter((f) => f.status === "unknown").length;
    const delivery = d.delivery.status === "stated" ? d.delivery.text : "Delivery unknown";
    const fitText =
      fit === "misses" ? (r.deadlineKind === "hard" ? "Arrives after your hard deadline." : "Arrives after your target date.") : fit === "meets" ? "Arrives by your date." : "";
    const missing = [d.shippingCents === null ? "shipping" : "", "tax"].filter(Boolean).join(" and ");
    const tradeoff = `${delivery}. ${supported} of ${d.findings.length} must-haves supported${unknown ? `, ${unknown} unconfirmed` : ""}. Covers all ${d.packagesRequired}. Missing: ${missing}. ${fitText}`.replace(/\s+/g, " ").trim();
    return { ...rest, deadlineFit: fit, highlights: highlights.get(d.id) ?? [], tradeoff };
  });
}

// ---------- runs ----------

// Events are derived from elapsed time so a reload resumes the same run
// instead of starting another one.
function buildRun(entry: RunEntry): Run {
  const elapsed = Date.now() - entry.startedAt;
  const done = Math.min(RUN_MESSAGES.length, Math.floor(elapsed / RUN_STEP_MS));
  const events = RUN_MESSAGES.slice(0, done).map((message, i) => ({
    id: `${entry.run.id}_e${i}`,
    at: new Date(entry.startedAt + (i + 1) * RUN_STEP_MS).toISOString(),
    message,
  }));
  const state = entry.cancelled ? "cancelled" : done >= RUN_MESSAGES.length ? "completed" : "running";
  // Sample data has no recorded event types; progress shows the generic phase.
  return { ...entry.run, events, trace: [], startedAt: events[0]?.at ?? null, state, outcome: state === "completed" ? "candidates_found" : null };
}

function syncStatus(db: Db, r: PurchaseRequest) {
  if (r.status === "researching" && r.runId) {
    const entry = db.runs[r.runId];
    if (entry) {
      const run = buildRun(entry);
      if (run.state === "completed") r.status = "results_ready";
      if (run.state === "cancelled") r.status = "confirmed";
    }
  }
}

// ---------- proposals / executions ----------

function buildReview(db: Db, p: StoredProposal): ProposalReview | undefined {
  const r = db.requests.find((x) => x.id === p.requestId);
  if (!r) return undefined;
  const offers = fixtureOffers(r);
  const chosen = p.lines.map((l) => offers.find((o) => o.id === l.offerId)).filter((o): o is Offer => !!o);
  const first = chosen[0];
  const taken = new Set(chosen.map((o) => o.id));
  return {
    purpose: r.purpose,
    requirements: [
      ...r.mandatory.map((label) => ({ label, mandatory: true })),
      ...r.preferences.map((label) => ({ label, mandatory: false })),
    ],
    findings: first ? first.findings : [],
    observedAt: first?.observedAt ?? null,
    expiresAt: first?.expiresAt ?? null,
    stale: false,
    fromCache: false,
    cost: {
      unitPriceCents: first?.unitPriceCents ?? null,
      packagesRequired: first?.packagesRequired ?? null,
      listedSubtotalCents: p.researchSubtotalCents,
      shippingCents: first?.shippingCents ?? null,
      taxCents: null,
      totalStatus: "subtotal_plus_shipping_tax_unknown",
    },
    alternatives: offers
      .filter((o) => !taken.has(o.id) && o.eligibility !== "rejected" && chosen.some((c) => c.itemId === o.itemId))
      .slice(0, 3)
      .map((o) => ({ title: o.title, seller: o.seller, eligibility: o.eligibility, costCents: o.listedSubtotalCents })),
    budget: { status: "within_budget", availableCents: null, notes: [] },
    history: p.approval ? [{ version: p.version, at: p.approval.at, decision: p.approval.decision, actor: p.approval.actor, note: p.decisionNote ?? "" }] : [],
    revisions: [{ version: p.version, submittedAt: p.submittedAt ?? null, exactAmountCents: p.expenseCents }],
  };
}

function proposalView(db: Db, p: StoredProposal): Proposal {
  const ex = p.executionId ? db.executions.find((e) => e.id === p.executionId) : undefined;
  const { version, executionId, ...rest } = p;
  void version;
  void executionId;
  return { ...rest, execution: ex?.status ?? "not_started", executionDetail: ex, review: buildReview(db, p) };
}

const DEMO_EMPLOYEE = { displayName: "Demo Employee", demo: true };
const DEMO_EXECUTIVE = { displayName: "Demo Executive", demo: true };

function activity(db: Db): ActivityPage {
  const counts = { not_submitted: 0, awaiting_review: 0, approved: 0, changes_requested: 0, rejected: 0 };
  for (const p of db.proposals) counts[p.decision]++;
  const items = [...db.proposals]
    .filter((p) => p.decision !== "not_submitted")
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))
    .map((p): ActivityItem => {
      const ex = p.executionId ? db.executions.find((e) => e.id === p.executionId) : undefined;
      return {
        proposalId: p.id,
        requestId: p.requestId,
        version: p.version,
        title: p.requestTitle,
        decision: p.decision,
        exactAmountCents: p.expenseCents,
        updatedAt: p.approval?.at ?? p.submittedAt ?? now(),
        submittedAt: p.submittedAt ?? null,
        selectedTitle: p.lines.map((l) => l.title).join(", "),
        seller: p.lines[0]?.seller ?? null,
        quantityText: p.lines.map((l) => l.quantityText).join(" · "),
        requester: p.requester,
        eligibility: "eligible",
        unresolved: p.unresolved,
        offerStale: false,
        latestDecision: p.approval ? { decision: p.approval.decision, note: p.decisionNote ?? "", actor: p.approval.actor, at: p.approval.at, version: p.version } : undefined,
        execution: ex ? { id: ex.id, status: ex.status, providerStatus: ex.providerStatus } : undefined,
      };
    });
  return { items, counts, truncated: false };
}

export const fixtureApi: RunwayApi = {
  async createProject(input) {
    const id = uid("prj");
    const lines: ProjectView["lines"] = [];
    for (const [i, item] of input.items.entries()) {
      const r = await this.createRequest({ ...input, title: item.name, items: [item], budgetTotalCents: item.budgetCents! });
      mutate((db) => { find(db, r.id).projectId = id; });
      lines.push({ key: `item_${i + 1}`, requestId: r.id, title: item.name, quantity: item.quantity, lineBudgetCents: item.budgetCents!, status: r.status, isCurrentVersionConfirmed: false, unansweredQuestionIds: [], research: null });
    }
    const project: ProjectView = { id, title: input.title, purpose: input.purpose, budgetCents: input.budgetTotalCents, lines };
    mutate((db) => { (db.projects ??= []).push(project); });
    return project;
  },
  async listProjects() {
    return mutate((db) => (db.projects ?? []).map((p) => ({ id: p.id, title: p.title, budgetCents: p.budgetCents, lines: p.lines.length })));
  },
  async getProject(id) {
    return mutate((db) => {
      const p = db.projects?.find((p) => p.id === id);
      if (!p) throw { code: "NOT_FOUND", message: "Request group not found." };
      return { ...p, lines: p.lines.map((line) => {
        const r = find(db, line.requestId);
        syncStatus(db, r);
        return { ...line, status: r.status, isCurrentVersionConfirmed: r.confirmedVersion === r.version, unansweredQuestionIds: r.clarifications.filter((c) => !c.answer).map((c) => c.id), research: r.status === "researching" ? { runStatus: "running" } : null };
      }) };
    });
  },
  async startProjectResearch(id) {
    const p = await this.getProject(id);
    const results = [];
    for (const line of p.lines) {
      if (line.unansweredQuestionIds.length) { results.push({ key: line.key, result: "not_confirmed" }); continue; }
      const r = await this.getRequest(line.requestId);
      if (r.status === "researching" || r.status === "results_ready" || r.status === "submitted" || r.status === "approved") { results.push({ key: line.key, result: "skipped" }); continue; }
      await this.confirmRequirements(r.id, r.version);
      await this.startResearch(r.id);
      results.push({ key: line.key, result: "started" });
    }
    return { results };
  },
  mode: "fixture",

  async getBackendMode() {
    return "fixtures";
  },

  async getMe(): Promise<Me> {
    // Fixture mode has no accounts; the demo role is a label chosen by the screen.
    throw { code: "NO_ACCOUNTS", message: "Sample data has no accounts." };
  },

  async listRequests() {
    return delay(
      mutate((db) => {
        db.requests.forEach((r) => syncStatus(db, r));
        return [...db.requests].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }),
    );
  },

  async getRequest(id) {
    return delay(
      mutate((db) => {
        const r = find(db, id);
        syncStatus(db, r);
        return r;
      }),
    );
  },

  async createRequest(input: NewRequestInput) {
    return delay(
      mutate((db) => {
        const r: PurchaseRequest = {
          id: uid("req"),
          version: 1,
          ...input,
          category: input.category ?? "",
          items: input.items.map((it, i) => ({ ...it, id: `item_${i + 1}` })),
          status: "awaiting_confirmation",
          clarifications: [],
          createdAt: now(),
          updatedAt: now(),
        };
        db.requests.push(r);
        return r;
      }),
    );
  },

  async answerClarifications(id, answers) {
    return delay(
      mutate((db) => {
        const r = find(db, id);
        r.clarifications = r.clarifications.map((c) => ({ ...c, answer: answers[c.id] ?? c.answer }));
        r.status = "awaiting_confirmation";
        r.updatedAt = now();
        return r;
      }),
    );
  },

  async confirmRequirements(id, version) {
    return delay(
      mutate((db) => {
        const r = find(db, id);
        if (r.version !== version) {
          throw { code: "VERSION_CONFLICT", message: "Requirements changed. Review the latest version." };
        }
        r.confirmedVersion = version;
        r.status = "confirmed";
        r.updatedAt = now();
        return r;
      }),
    );
  },

  async startResearch(id) {
    return delay(
      mutate((db) => {
        const r = find(db, id);
        if (r.confirmedVersion !== r.version) {
          throw { code: "REQUIREMENTS_UNCONFIRMED", message: "Confirm the requirements before research." };
        }
        if (r.runId && db.runs[r.runId] && buildRun(db.runs[r.runId]).state === "running") {
          throw { code: "RUN_ALREADY_ACTIVE", message: "A research run is already active." };
        }
        const cfg = (db.configs ?? defaultConfigs).find((c) => c.id === r.agentConfigId) ?? configs[0];
        const run: Run = {
          id: uid("run"),
          requestId: id,
          state: "running",
          outcome: null,
          agentConfigId: cfg.id,
          agentConfigName: cfg.name,
          agentConfigVersion: cfg.version,
          events: [],
          trace: [],
          startedAt: null,
        };
        db.runs[run.id] = { startedAt: Date.now(), run };
        r.runId = run.id;
        r.status = "researching";
        r.updatedAt = now();
        return buildRun(db.runs[run.id]);
      }),
    );
  },

  async getRun(runId) {
    return delay(
      mutate((db) => {
        const entry = db.runs[runId];
        if (!entry) throw { code: "NOT_FOUND", message: "Run not found." };
        return buildRun(entry);
      }),
      120,
    );
  },

  async cancelRun(runId) {
    return delay(
      mutate((db) => {
        const entry = db.runs[runId];
        if (!entry) throw { code: "NOT_FOUND", message: "Run not found." };
        entry.cancelled = true;
        find(db, entry.run.requestId).status = "confirmed";
        return buildRun(entry);
      }),
    );
  },

  async listCandidates(requestId) {
    return delay(mutate((db) => fixtureOffers(find(db, requestId))));
  },

  async saveAndSubmitProposal(requestId, input: SaveProposalInput) {
    return delay(
      mutate((db) => {
        const r = find(db, requestId);
        if (!input.suitabilityConfirmed) {
          throw { code: "CONFIRMATION_REQUIRED", message: "Confirm technical suitability to submit." };
        }
        const offers = fixtureOffers(r);
        const lines: ProposalLine[] = [];
        for (const item of r.items) {
          const sel = input.selections.find((s) => s.itemId === item.id);
          const offer = sel && offers.find((o) => o.id === sel.offerId && o.itemId === item.id);
          if (!offer || offer.eligibility === "rejected") {
            throw { code: "NO_CONFIRMED_MATCH", message: `Choose an eligible offer for ${item.name}.` };
          }
          lines.push({
            itemId: item.id,
            itemName: item.name,
            offerId: offer.id,
            title: offer.title,
            seller: offer.seller,
            sourceUrl: offer.url,
            listedSubtotalCents: offer.listedSubtotalCents,
            quantityText: `${item.quantity} ${item.unit}`,
          });
        }
        const known = lines.every((l) => l.listedSubtotalCents !== null);
        const subtotal = known ? lines.reduce((s, l) => s + (l.listedSubtotalCents ?? 0), 0) : null;
        if (subtotal !== null && input.expenseCents < subtotal) {
          throw { code: "VALIDATION_ERROR", message: `Exact amount ${money(input.expenseCents)} is below the listed subtotal ${money(subtotal)}` };
        }
        const existing = db.proposals.find((p) => p.requestId === requestId);
        if (existing && existing.decision !== "changes_requested") {
          throw { code: "VERSION_CONFLICT", message: "A proposal was already submitted." };
        }
        const p: StoredProposal = {
          id: existing?.id ?? uid("prop"),
          requestId,
          requestTitle: r.title,
          version: (existing?.version ?? 0) + 1,
          revision: (existing?.revision ?? 0) + 1,
          lines,
          justification: input.justification,
          suitabilityConfirmed: true,
          researchSubtotalCents: subtotal,
          budgetCeilingCents: r.budgetTotalCents,
          expenseCents: input.expenseCents,
          expenseSource: "user_confirmed",
          decision: "awaiting_review",
          requester: DEMO_EMPLOYEE,
          unresolved: [...(input.selections.some((s) => offers.find((o) => o.id === s.offerId)?.shippingCents == null) ? ["Shipping cost unknown"] : []), "Sales tax unknown"],
          requirementResolutions: [],
          submittedAt: now(),
        };
        db.proposals = [...db.proposals.filter((x) => x.requestId !== requestId), p];
        r.proposalId = p.id;
        r.status = "submitted";
        r.updatedAt = now();
        return proposalView(db, p);
      }),
    );
  },

  async getProposal(id) {
    return delay(
      mutate((db) => {
        const p = db.proposals.find((x) => x.id === id);
        if (!p) throw { code: "NOT_FOUND", message: "Proposal not found." };
        return proposalView(db, p);
      }),
    );
  },

  async listActivity() {
    return delay(mutate((db) => activity(db)));
  },

  async getFinancialPreview(proposalId) {
    // Sample data has no ledger: say so instead of inventing a balance.
    return delay(
      mutate((db) => {
        const p = db.proposals.find((x) => x.id === proposalId);
        if (!p) throw { code: "NOT_FOUND", message: "Proposal not found." };
        const blocking = p.decision !== "awaiting_review" ? [{ code: "not_awaiting_review", message: `Proposal is ${p.decision}` }] : [];
        return {
          proposalId: p.id,
          proposalVersion: p.version,
          label: "Sample data. No ledger or bank figures.",
          currentAvailableCents: null,
          exactExpenseCents: p.expenseCents,
          projectedAvailableCents: null,
          reservationIncluded: !!p.executionId,
          freshness: { source: "fixture", fetchedAt: null, refreshedNow: false, status: "fixture" },
          canApprove: blocking.length === 0,
          blockingReasons: blocking,
          amounts: { researchListedSubtotalCents: p.researchSubtotalCents, budgetCeilingCents: p.budgetCeilingCents, exactExpenseCents: p.expenseCents, amountSource: "user_confirmed", approvedAmountCents: null, providerStoredAmountCents: null, discrepancyCents: null },
          unknowns: ["Sales tax", "Shipping"],
          notes: ["Sample data: nothing here is a real balance or purchase."],
        };
      }),
    );
  },

  async getExecution(id) {
    return delay(
      mutate((db) => {
        const e = db.executions.find((x) => x.id === id);
        if (!e) throw { code: "NOT_FOUND", message: "Purchase record not found." };
        return e;
      }),
    );
  },

  async decide({ proposalId, version, decision, note }) {
    return delay(
      mutate((db) => {
        const p = db.proposals.find((x) => x.id === proposalId);
        if (!p) throw { code: "NOT_FOUND", message: "Proposal not found." };
        if (p.version !== version) throw { code: "VERSION_CONFLICT", message: "This proposal changed. Reload to review the latest version." };
        if (p.decision !== "awaiting_review") throw { code: "INVALID_STATE", message: "This proposal was already decided." };
        const r = find(db, p.requestId);
        const at = now();
        p.decision = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested";
        p.decisionNote = note || undefined;
        p.approval = { actor: DEMO_EXECUTIVE, at, decision: p.decision };
        r.status = p.decision;
        r.updatedAt = at;
        if (decision === "approve") {
          const stored = Math.floor(p.expenseCents / 100) * 100; // Nessie keeps whole dollars
          const diff = p.expenseCents - stored;
          const seller = p.lines[0]?.seller ?? null;
          const ex: ExecutionDetail = {
            id: uid("exe"),
            proposalId: p.id,
            status: "recorded",
            providerStatus: "pending",
            amountCents: p.expenseCents,
            providerAmountCents: stored,
            amountDiscrepancyCents: diff,
            amountNote: diff ? "Nessie stores whole dollars, so the cents were dropped." : null,
            purchaseId: uid("fixture_purchase"),
            merchant: {
              researchedSeller: seller,
              nessieMerchantId: seller ? `fixture_merchant_${slug(seller)}` : null,
              nessieMerchantName: seller ? `[FIXTURE] ${seller}` : null,
            },
            lastError: null,
            disclaimer: SANDBOX_DISCLAIMER,
            createdAt: at,
            updatedAt: at,
          };
          db.executions.push(ex);
          p.executionId = ex.id;
        }
        return proposalView(db, p);
      }),
    );
  },

  async reconcile(executionId, action) {
    return delay(
      mutate((db) => {
        const e = db.executions.find((x) => x.id === executionId);
        if (!e) throw { code: "NOT_FOUND", message: "Purchase record not found." };
        if (action === "mark_failed" && e.status === "uncertain") e.status = "failed";
        e.updatedAt = now();
        return e;
      }),
    );
  },

  async getBudget(): Promise<Budget> {
    return delay(
      mutate((db) => {
        const reported = 2_500_000;
        const obligations = 150_000;
        const commitments = db.executions.filter((e) => e.status === "recorded").reduce((s, e) => s + e.amountCents, 0);
        return {
          status: "fixture" as const,
          source: "Fixture sample, not Nessie",
          fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          reportedBalanceCents: reported,
          obligationsCents: obligations,
          commitmentsCents: commitments,
          availableCents: reported - obligations - commitments,
          notes: "Sample figures. The backend supplies the canonical available budget.",
        };
      }),
    );
  },

  async listAgentConfigs() {
    return delay(mutate((db) => (db.configs ?? defaultConfigs).map(({ id, name, version, summary }) => ({ id, name, version, summary }))), 100);
  },

  async listAgentConfigDetails() {
    return delay(mutate((db) => db.configs ?? defaultConfigs), 100);
  },

  async saveAgentConfig(input: AgentConfigInput, existing) {
    return delay(
      mutate((db) => {
        const list = db.configs ?? defaultConfigs.map((c) => ({ ...c }));
        const summary = `${input.searchStrategy === "exact_specs" ? "Exact-spec search" : "Broad search, then filter"}, up to ${input.limits.maxSearchCalls} searches and ${input.limits.maxDetailCalls} product lookups.`;
        let saved: AgentConfigDetail;
        if (existing) {
          const cur = list.find((c) => c.id === existing.id);
          if (!cur) throw { code: "NOT_FOUND", message: "Configuration not found." };
          if (cur.version !== existing.version) throw { code: "VERSION_CONFLICT", message: "This configuration changed. Reload to edit the latest version." };
          saved = { ...cur, ...input, summary, version: cur.version + 1, createdAt: now() };
          db.configs = list.map((c) => (c.id === saved.id ? saved : c));
        } else {
          saved = { ...input, id: `cfg_${slug(input.name).slice(0, 30) || uid("c")}`, version: 1, createdAt: now(), summary };
          db.configs = [...list, saved];
        }
        return saved;
      }),
    );
  },

  async createMerchantMapping(seller) {
    return delay({ seller, merchantName: `[FIXTURE] ${seller}`, nessieMerchantId: `fixture_merchant_${slug(seller)}` });
  },

  async getIntegrations(): Promise<IntegrationStatus[]> {
    return delay(
      [
        { name: "Gemini", state: "fixture", detail: "Sample clarification questions." },
        { name: "SerpApi", state: "fixture", detail: "Sample offers, not live search." },
        { name: "Nessie", state: "fixture", detail: "Sample balance. No purchases are recorded." },
      ],
      100,
    );
  },
};
