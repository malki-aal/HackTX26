import type { RunwayApi } from "./client";
import type {
  AgentConfig,
  Budget,
  IntegrationStatus,
  NewRequestInput,
  Offer,
  Proposal,
  PurchaseRequest,
  Run,
  SaveProposalInput,
} from "./types";

// FIXTURE DATA. Every product, seller, price and balance below is invented
// sample data shaped like the backend contract. None of it is a search result.

interface RunEntry {
  startedAt: number;
  cancelled?: boolean;
  run: Run;
}

interface Db {
  requests: PurchaseRequest[];
  runs: Record<string, RunEntry>;
  proposals: Proposal[];
}

const KEY = "runway.fixtures.v1";
const RUN_STEP_MS = 1400;
const RUN_MESSAGES = [
  "Search started for monitors matching confirmed requirements",
  "Search completed: 3 listings returned",
  "Offers normalized to a common price basis",
  "Evaluation completed against each mandatory requirement",
  "Budget checked against the request total",
];

const configs: AgentConfig[] = [
  { id: "cfg_standard", name: "Standard buyer", version: 3, summary: "Balanced ranking, up to 5 searches." },
  { id: "cfg_frugal", name: "Frugal buyer", version: 1, summary: "Ranks by lowest known comparable cost." },
];

function delay<T>(v: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(v), ms));
}
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const now = () => new Date().toISOString();

function load(): Db {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    if (raw) return JSON.parse(raw) as Db;
  } catch {}
  return { requests: [], runs: {}, proposals: [] };
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
  if (!r) throw { code: "not_found", message: "Request not found." };
  return r;
}

function fixtureOffers(r: PurchaseRequest): Offer[] {
  const observedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const q = r.quantity;
  return [
    {
      id: "offer_1",
      title: "Sample 27in QHD IPS Monitor, Model SQ-27A",
      seller: "Example Seller One",
      url: "https://example.com/listing/sq-27a",
      observedAt,
      unitPriceCents: 18900,
      packageQuantity: 1,
      packagesRequired: q,
      listedSubtotalCents: 18900 * q,
      shippingCents: null,
      taxCents: null,
      delivery: "Delivery estimate not listed",
      eligibility: "eligible",
      findings: [
        { requirement: "27 inch screen", status: "supported", evidence: "Listing title states 27 in." },
        { requirement: "At least 1440p", status: "supported", evidence: "Listing spec table: 2560 x 1440." },
        { requirement: "HDMI input", status: "supported", evidence: "Listing spec table: 2x HDMI." },
        { requirement: "New condition", status: "supported", evidence: "Listing marked New." },
      ],
      rankNote: "Lowest known listed subtotal among eligible offers. Shipping and tax unknown.",
      unresolved: [],
      affordability: "within_budget_provisional",
      costNotes: [],
      stale: false,
      fromCache: false,
    },
    {
      id: "offer_2",
      title: "Sample 27in QHD Monitor, Model SQ-27B (open box)",
      seller: "Example Seller Two",
      url: "https://example.com/listing/sq-27b",
      observedAt,
      unitPriceCents: 16400,
      packageQuantity: 1,
      packagesRequired: q,
      listedSubtotalCents: 16400 * q,
      shippingCents: 2400,
      taxCents: null,
      delivery: "Arrives in 5 to 7 days",
      eligibility: "needs_review",
      findings: [
        { requirement: "27 inch screen", status: "supported", evidence: "Listing title states 27 in." },
        { requirement: "At least 1440p", status: "supported", evidence: "Listing spec table: 2560 x 1440." },
        { requirement: "HDMI input", status: "unknown", evidence: "Ports are not listed." },
        { requirement: "New condition", status: "contradicted", evidence: "Listing says open box." },
      ],
      rankNote: "Cheaper, but condition conflicts with the request and HDMI is unconfirmed.",
      unresolved: ["Confirm HDMI ports with the seller", "Condition is open box, request asked for new"],
      affordability: "within_budget_provisional",
      costNotes: [],
      stale: false,
      fromCache: false,
    },
    {
      id: "offer_3",
      title: "Sample 24in FHD Monitor, Model SQ-24C",
      seller: "Example Seller Three",
      url: "https://example.com/listing/sq-24c",
      observedAt,
      unitPriceCents: null,
      packageQuantity: 1,
      packagesRequired: q,
      listedSubtotalCents: null,
      shippingCents: null,
      taxCents: null,
      eligibility: "rejected",
      findings: [
        { requirement: "27 inch screen", status: "contradicted", evidence: "Listing is a 24 in panel." },
        { requirement: "At least 1440p", status: "contradicted", evidence: "Listing spec: 1920 x 1080." },
      ],
      rankNote: "Fails mandatory size and resolution requirements. No price shown in the listing.",
      unresolved: [],
      affordability: "within_budget_provisional",
      costNotes: [],
      stale: false,
      fromCache: false,
    },
  ];
}

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
  return { ...entry.run, events, state, outcome: state === "completed" ? "candidates_found" : null };
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

export const fixtureApi: RunwayApi = {
  mode: "fixture",

  async getBackendMode() {
    return "fixtures";
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
          category: "monitors",
          ...input,
          status: "clarifying",
          clarifications: [
            {
              id: "q1",
              question: "Will these monitors be mounted on arms or used on desk stands?",
              options: [{ value: "arms", label: "Arms" }, { value: "stands", label: "Desk stands" }],
            },
            {
              id: "q2",
              question: "Do you need any ports beyond HDMI, such as DisplayPort or USB-C?",
              options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }],
            },
          ],
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
          throw { code: "version_conflict", message: "Requirements changed. Review the latest version." };
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
          throw { code: "requirements_unconfirmed", message: "Confirm the requirements before research." };
        }
        if (r.runId && db.runs[r.runId] && buildRun(db.runs[r.runId]).state === "running") {
          throw { code: "run_already_active", message: "A research run is already active." };
        }
        const cfg = configs.find((c) => c.id === r.agentConfigId) ?? configs[0];
        const run: Run = {
          id: uid("run"),
          requestId: id,
          state: "running",
          outcome: null,
          agentConfigId: cfg.id,
          agentConfigName: cfg.name,
          agentConfigVersion: cfg.version,
          events: [],
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
        if (!entry) throw { code: "not_found", message: "Run not found." };
        return buildRun(entry);
      }),
      120,
    );
  },

  async cancelRun(runId) {
    return delay(
      mutate((db) => {
        const entry = db.runs[runId];
        if (!entry) throw { code: "not_found", message: "Run not found." };
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
          throw { code: "confirmation_required", message: "Confirm technical suitability to submit." };
        }
        const offer = fixtureOffers(r).find((o) => o.id === input.offerId);
        if (!offer || offer.eligibility === "rejected") {
          throw { code: "no_confirmed_match", message: "That offer cannot be proposed." };
        }
        const existing = db.proposals.find((p) => p.requestId === requestId);
        if (existing && existing.decision !== "changes_requested") {
          throw { code: "version_conflict", message: "A proposal was already submitted." };
        }
        const p: Proposal = {
          id: existing?.id ?? uid("prop"),
          requestId,
          revision: (existing?.revision ?? 0) + 1,
          offerId: input.offerId,
          justification: input.justification,
          suitabilityConfirmed: true,
          researchSubtotalCents: offer.listedSubtotalCents,
          budgetCeilingCents: r.budgetTotalCents,
          expenseCents: input.expenseCents,
          expenseSource: "user_confirmed",
          decision: "awaiting_review",
          execution: "not_started",
          unresolved: ["Shipping cost unknown", "Sales tax unknown"],
          submittedAt: now(),
        };
        db.proposals = [...db.proposals.filter((x) => x.requestId !== requestId), p];
        r.proposalId = p.id;
        r.selectedOfferId = input.offerId;
        r.status = "submitted";
        r.updatedAt = now();
        return p;
      }),
    );
  },

  async getProposal(id) {
    return delay(
      mutate((db) => {
        const p = db.proposals.find((x) => x.id === id);
        if (!p) throw { code: "not_found", message: "Proposal not found." };
        return p;
      }),
    );
  },

  async getBudget(): Promise<Budget> {
    return delay({
      status: "fixture",
      source: "Fixture sample, not Nessie",
      fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      reportedBalanceCents: 1_250_000,
      obligationsCents: 180_000,
      commitmentsCents: 0,
      availableCents: 1_070_000,
      notes: "Sample figures. The backend will supply the canonical available budget.",
    });
  },

  async listAgentConfigs() {
    return delay(configs, 100);
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
