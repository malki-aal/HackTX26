// Shared domain contracts. These Zod schemas are the source of truth for the public API
// and are exported for the frontend (see src/contracts/index.ts and docs/openapi.json).
import { z } from "zod";

export const MAX_QUANTITY = 10_000;
export const MAX_BUDGET_CENTS = 100_000_000; // $1,000,000.00

export const Id = z.string().min(1).max(100);
export const Cents = z.number().int().min(0).max(MAX_BUDGET_CENTS);
export const IsoTimestamp = z.string();

/** Registered category id (see src/domain/categories.ts); aliases such as "chairs" are accepted on input. */
export const CategoryId = z.string().trim().min(1).max(40);
export const DeadlineType = z.enum(["hard", "target"]);
export const Condition = z.enum(["new", "refurbished", "used"]);
export const AllowedCondition = z.enum(["new", "refurbished", "used", "any"]);
export const RankingPriority = z.enum(["lowest_known_total", "evidence_completeness"]);
export const EvidenceState = z.enum(["supported", "contradicted", "unknown"]);
export const CandidateClass = z.enum(["eligible", "needs_review", "rejected"]);
export const Port = z.enum(["hdmi", "displayport", "usb_c", "thunderbolt", "vga", "dvi"]);
export const PanelType = z.enum(["ips", "va", "tn", "oled"]);

export const RequestStatus = z.enum([
  "draft",
  "needs_clarification",
  "ready_to_confirm",
  "confirmed",
  "researching",
  "researched",
  "proposal_draft",
  "submitted",
  "approved",
  "changes_requested",
  "rejected",
]);

// ---------- Requirements as structured predicates ----------

const base = {
  id: Id,
  mandatory: z.boolean(),
  sourceText: z.string().max(500),
};

export const Requirement = z.discriminatedUnion("attribute", [
  // Category consistency: the listing must be the requested item (value = category id).
  z.object({ ...base, attribute: z.literal("product_type"), operator: z.literal("eq"), value: CategoryId }),
  z.object({
    ...base,
    attribute: z.literal("screen_size"),
    operator: z.literal("between"),
    value: z.object({ min: z.number().positive().max(100), max: z.number().positive().max(100) }),
    unit: z.literal("in"),
  }),
  z.object({
    ...base,
    attribute: z.literal("resolution"),
    operator: z.literal("gte"),
    value: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    unit: z.literal("px"),
  }),
  z.object({ ...base, attribute: z.literal("port"), operator: z.literal("includes"), value: Port }),
  z.object({ ...base, attribute: z.literal("condition"), operator: z.literal("in"), value: z.array(Condition).min(1) }),
  z.object({
    ...base,
    attribute: z.literal("refresh_rate"),
    operator: z.literal("gte"),
    value: z.number().int().positive().max(1000),
    unit: z.literal("hz"),
  }),
  z.object({ ...base, attribute: z.literal("panel_type"), operator: z.literal("in"), value: z.array(PanelType).min(1) }),
  z.object({ ...base, attribute: z.literal("brand"), operator: z.literal("in"), value: z.array(z.string().min(1).max(40)).min(1) }),
  z.object({ ...base, attribute: z.literal("volume"), operator: z.literal("gte"), value: z.number().positive().max(100_000), unit: z.literal("ml") }),
  z.object({
    ...base,
    attribute: z.literal("dimensions"),
    operator: z.literal("gte"),
    value: z.object({ length: z.number().positive().max(1200), width: z.number().positive().max(1200) }),
    unit: z.literal("in"),
  }),
  z.object({
    ...base,
    attribute: z.literal("thickness"),
    operator: z.literal("between"),
    value: z.object({ min: z.number().positive().max(12), max: z.number().positive().max(12) }),
    unit: z.literal("in"),
  }),
  z.object({
    ...base,
    attribute: z.literal("screw_size"),
    operator: z.literal("eq"),
    value: z.object({ gauge: z.number().int().min(0).max(24), lengthIn: z.number().positive().max(12) }),
    unit: z.literal("in"),
  }),
  // Category-specific feature keyword (e.g. self_adhesive, armrests), defined in the category profile.
  z.object({ ...base, attribute: z.literal("feature"), operator: z.literal("includes"), value: z.string().min(1).max(40), label: z.string().max(80) }),
  // Delivery by a date. mandatory=true is a hard deadline; false is a flexible target date.
  z.object({ ...base, attribute: z.literal("delivery_by"), operator: z.literal("lte"), value: z.string().date(), unit: z.literal("date") }),
  // Battery capacity in watt-hours. Output power (W) is a different quantity and never satisfies this.
  z.object({ ...base, attribute: z.literal("capacity_wh"), operator: z.literal("gte"), value: z.number().positive().max(50_000), unit: z.literal("wh") }),
  z.object({ ...base, attribute: z.literal("ac_outlets"), operator: z.literal("gte"), value: z.number().int().positive().max(12), unit: z.literal("outlets") }),
]);
export type Requirement = z.infer<typeof Requirement>;
export type RequirementAttribute = Requirement["attribute"];

/** User-editable request fields. */
export const RequestFields = z.object({
  title: z.string().trim().min(1).max(200),
  purpose: z.string().max(2000).default(""),
  description: z.string().max(4000).default(""),
  /** Optional hint. The server resolves the category from the request text and asks when unclear. */
  category: CategoryId.nullable().default(null),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  /** Unit of `quantity`, e.g. "chair", "bottle", "sheet", "screw". Defaults to the category unit. */
  unit: z.string().trim().min(1).max(30).nullable().default(null),
  currency: z.literal("USD"),
  budgetCents: Cents.refine((v) => v > 0, "budgetCents must be positive"),
  budgetBasis: z.enum(["total", "per_item"]).default("total"),
  allowedCondition: AllowedCondition.default("new"),
  deadline: z.string().date().nullable().default(null),
  /** "hard": late offers are noncompliant. "target": late offers stay eligible but are flagged. */
  deadlineType: DeadlineType.default("target"),
  /** Deprecated: recommendations are multivariable. Accepted for compatibility; only breaks cost ties. */
  rankingPriority: RankingPriority.default("lowest_known_total"),
  agentConfigId: Id.default("cfg_default"),
  agentConfigVersion: z.number().int().positive().nullable().default(null),
  requirements: z.array(Requirement).max(30).optional(),
  /** Optional debugging metadata: the example preset the form started from. Never replaces parsing the request. */
  presetId: z.string().trim().regex(/^[a-z0-9_]{2,60}$/).nullable().default(null),
});
export type RequestFields = z.infer<typeof RequestFields>;

export const CreateRequestBody = RequestFields;
export const PatchRequestBody = RequestFields.partial().extend({ expectedVersion: z.number().int().positive() });

export const ClarificationQuestion = z.object({
  id: Id,
  text: z.string(),
  kind: z.enum(["single_choice", "boolean", "number", "text"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  affects: z.string(),
  answer: z.unknown().nullable(),
  answeredAt: IsoTimestamp.nullable(),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestion>;

export const ClarifyBody = z.object({
  expectedVersion: z.number().int().positive(),
  answers: z.array(z.object({ questionId: Id, value: z.union([z.string(), z.number(), z.boolean()]) })).default([]),
});

export const ConfirmBody = z.object({ version: z.number().int().positive() });
export const ResearchBody = z.object({
  version: z.number().int().positive(),
  agentConfigId: Id.optional(),
});

// ---------- Offers and evidence ----------

export const ExtractionMethod = z.enum(["provider_field", "listing_text_pattern", "inferred_default", "user_confirmed"]);

export const SpecEvidence = z.object({
  id: Id,
  attribute: z.string(),
  value: z.unknown(),
  source: z.enum(["serpapi_google_shopping", "serpapi_immersive_product", "user"]),
  sourceField: z.string(),
  excerpt: z.string().max(300),
  method: ExtractionMethod,
  confidence: z.enum(["listing_evidence", "weak_inference"]),
});
export type SpecEvidence = z.infer<typeof SpecEvidence>;

export const PriceBasis = z.enum(["one_time", "installment", "from_price", "unknown"]);
export const KnownAmount = z.object({
  status: z.enum(["known", "unknown"]),
  cents: z.number().int().nullable(),
  source: z.string().nullable(),
});

export const Offer = z.object({
  id: Id,
  runId: Id,
  provider: z.literal("serpapi_google_shopping"),
  queryId: Id,
  title: z.string(),
  normalizedModel: z.string().nullable(),
  brand: z.string().nullable(),
  seller: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
  observedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  fromCache: z.boolean(),
  currency: z.literal("USD").nullable(),
  priceText: z.string().nullable(),
  listedPriceCents: z.number().int().nullable(),
  priceBasis: PriceBasis,
  packageQuantity: z.number().int().positive().nullable(),
  packageQuantityMethod: ExtractionMethod.nullable(),
  shipping: KnownAmount,
  tax: KnownAmount,
  condition: Condition.nullable(),
  availability: z.object({ status: z.enum(["in_stock", "unknown"]), excerpt: z.string().nullable() }),
  delivery: z.object({
    status: z.enum(["stated", "unknown"]),
    excerpt: z.string().nullable(),
    /** Date range the seller states (YYYY-MM-DD); null when no date is stated. */
    earliest: z.string().nullable(),
    latest: z.string().nullable(),
    source: z.enum(["listing", "product_page_store"]).nullable(),
  }),
  rating: z.number().nullable(),
  reviews: z.number().int().nullable(),
  evidence: z.array(SpecEvidence),
  needsReviewReasons: z.array(z.string()),
  /** Product-detail evidence lookup state (SerpApi immersive product page). */
  details: z.object({
    status: z.enum(["not_available", "not_fetched", "fetched", "failed"]),
    fetchedAt: IsoTimestamp.nullable(),
    fromCache: z.boolean(),
    matchedStore: z.string().nullable(),
  }),
});
export type Offer = z.infer<typeof Offer>;

export const RequirementResult = z.object({
  requirementId: Id,
  attribute: z.string(),
  mandatory: z.boolean(),
  state: EvidenceState,
  evidenceIds: z.array(Id),
  reason: z.string(),
});
export type RequirementResult = z.infer<typeof RequirementResult>;

export const TotalStatus = z.enum([
  "price_unknown",
  "listed_subtotal_only", // shipping and tax unknown
  "subtotal_plus_shipping_tax_unknown",
]);

export const PurchaseCost = z.object({
  requestedQuantity: z.number().int().positive(),
  packageQuantity: z.number().int().positive().nullable(),
  packagesRequired: z.number().int().positive().nullable(),
  unitPriceCents: z.number().int().nullable(),
  listedSubtotalCents: z.number().int().nullable(),
  shippingCents: z.number().int().nullable(),
  taxCents: z.number().int().nullable(),
  knownComparableCostCents: z.number().int().nullable(),
  totalStatus: TotalStatus,
  provisional: z.boolean(),
  notes: z.array(z.string()),
  /** Set when the request orders a total liquid volume: how many packages cover it, and the excess. */
  volume: z
    .object({
      requiredMl: z.number().int().positive(),
      perPackageMl: z.number().int().positive().nullable(),
      purchasedMl: z.number().int().positive().nullable(),
      excessMl: z.number().int().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
});
export type PurchaseCost = z.infer<typeof PurchaseCost>;

export const Affordability = z.enum(["within_budget_provisional", "over_budget", "unknown"]);

export const CandidateEvaluation = z.object({
  offerId: Id,
  rank: z.number().int().positive(),
  class: CandidateClass,
  affordability: Affordability,
  requirementResults: z.array(RequirementResult),
  unknowns: z.array(z.string()),
  cost: PurchaseCost,
  recommendationReason: z.string(),
  evidenceCompleteness: z.number().int().min(0),
});
export type CandidateEvaluation = z.infer<typeof CandidateEvaluation>;

// ---------- Agent configuration ----------

export const AgentToolName = z.enum([
  "getConfirmedRequirements",
  "searchProducts",
  "getProductDetails",
  "evaluateCandidates",
  "readBudgetContext",
  "prepareProposalDraft",
]);
export type AgentToolName = z.infer<typeof AgentToolName>;

/** Application-wide ceilings that no configuration can exceed. */
export const CONFIG_CEILINGS = { maxSearchCalls: 6, maxDetailCalls: 5, maxSteps: 24, maxDurationMs: 300_000 } as const;

export const AgentConfigFields = z.object({
  displayName: z.string().trim().min(1).max(80),
  instructions: z.string().max(4000),
  enabledTools: z.array(AgentToolName).min(1),
  rankingPriority: RankingPriority,
  searchStrategy: z.enum(["exact_specs", "broad_then_filter"]),
  limits: z.object({
    maxSearchCalls: z.number().int().min(1).max(CONFIG_CEILINGS.maxSearchCalls),
    /** Product-detail (evidence) lookups per run; each is one paid SerpApi call. */
    maxDetailCalls: z.number().int().min(0).max(CONFIG_CEILINGS.maxDetailCalls).default(3),
    maxSteps: z.number().int().min(2).max(CONFIG_CEILINGS.maxSteps),
    maxDurationMs: z.number().int().min(10_000).max(CONFIG_CEILINGS.maxDurationMs),
  }),
});
export type AgentConfigFields = z.infer<typeof AgentConfigFields>;
export const AgentConfig = AgentConfigFields.extend({
  id: Id,
  version: z.number().int().positive(),
  createdAt: IsoTimestamp,
});
export type AgentConfig = z.infer<typeof AgentConfig>;
export const CreateAgentConfigBody = AgentConfigFields.extend({ id: z.string().regex(/^cfg_[a-z0-9_]{2,40}$/).optional() });
export const PatchAgentConfigBody = AgentConfigFields.partial().extend({ expectedVersion: z.number().int().positive() });

// ---------- Runs ----------

export const RunStatus = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export const RunOutcome = z.enum(["candidates_found", "no_confirmed_match", "no_results"]).nullable();
export const RunEventType = z.enum([
  "clarification_required",
  "requirements_confirmed",
  "research_started",
  "agent_step",
  "tool_called",
  "search_started",
  "search_completed",
  "search_failed",
  "details_fetched",
  "candidates_normalized",
  "evaluation_completed",
  "model_quota_wait",
  "budget_checked",
  "research_completed",
  "research_failed",
  "research_cancelled",
  "proposal_saved",
  "proposal_submitted",
  "decision_recorded",
  "execution_queued",
  "execution_submitting",
  "execution_recorded",
  "execution_failed",
  "execution_uncertain",
  "reconciliation_completed",
]);
export type RunEventType = z.infer<typeof RunEventType>;

// ---------- Budget ----------

export const FinancialContext = z.object({
  status: z.enum(["verified", "bank_check_unavailable", "fixture"]),
  accountId: z.string().nullable(),
  source: z.enum(["nessie_live", "nessie_cached", "fixture", "none"]),
  fetchedAt: IsoTimestamp.nullable(),
  reportedBalanceCents: z.number().int().nullable(),
  obligations: z.array(z.object({ id: z.string(), payee: z.string(), status: z.string(), amountCents: z.number().int(), included: z.boolean(), reason: z.string() })),
  obligationsCents: z.number().int(),
  activeReservationsCents: z.number().int(),
  unreflectedExpensesCents: z.number().int(),
  availableBudgetCents: z.number().int().nullable(),
  reconciliationNotes: z.array(z.string()),
});
export type FinancialContext = z.infer<typeof FinancialContext>;

export const BudgetAssessment = z.object({
  status: z.enum(["within_budget", "within_budget_provisional", "exceeds_request_budget", "exceeds_available_funds", "bank_check_unavailable", "amount_unknown"]),
  amountCents: z.number().int().nullable(),
  amountBasis: z.enum(["listed_subtotal", "subtotal_plus_shipping", "user_confirmed_exact"]).nullable(),
  requestBudgetCents: z.number().int(),
  availableBudgetCents: z.number().int().nullable(),
  notes: z.array(z.string()),
});
export type BudgetAssessment = z.infer<typeof BudgetAssessment>;

// ---------- Proposals, decisions, executions ----------

export const DemoActor = z.enum(["employee-demo", "executive-demo"]);

/** Demo actor id; accepted only in fixtures demo mode. Signed-in mode rejects it (identity comes from the session). */
export const DemoActorField = z.string().max(40).optional();

export const CreateProposalBody = z.object({
  runId: Id,
  offerId: Id,
  justification: z.string().max(4000).default(""),
  alternativeOfferIds: z.array(Id).max(5).default([]),
  actor: DemoActorField,
});

/**
 * How the requester dealt with one mandatory requirement the evidence left unconfirmed: they verified it
 * themselves (with how), or they deliberately proceed anyway (with why). Both are recorded for the reviewer.
 */
export const RequirementResolution = z.object({
  requirementId: z.string().min(1).max(80),
  kind: z.enum(["verified", "exception"]),
  note: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(12, "Describe the verification source or reason for the exception (at least 12 characters)").max(500))
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Note contains control characters"),
});
export type RequirementResolution = z.infer<typeof RequirementResolution>;

export const SubmitProposalBody = z.object({
  version: z.number().int().positive(),
  technicalReviewConfirmed: z.literal(true),
  exactAmountCents: Cents.refine((v) => v > 0, "exactAmountCents must be positive"),
  amountSource: z.enum(["user_confirmed"]).default("user_confirmed"),
  /** Required for every mandatory requirement whose evidence is unknown (see UNRESOLVED_REQUIREMENTS). */
  requirementResolutions: z.array(RequirementResolution).max(30).default([]),
  actor: DemoActorField,
});

export const NOTE_MAX_CHARS = 1000;

/** Optional decision note: plain text, whitespace normalized, no control characters, at most 1000 chars. */
export const DecisionNote = z
  .string()
  .max(5000)
  .default("")
  .refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s), "Note contains control characters")
  .transform((s) =>
    s
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  )
  .refine((s) => s.length <= NOTE_MAX_CHARS, `Note must be at most ${NOTE_MAX_CHARS} characters`);

/** What an approver confirms: the exact proposal revision and the exact expense in cents. */
export const ApprovalConfirmation = z
  .object({
    confirmed: z.boolean(),
    proposalVersion: z.number().int().positive(),
    exactAmountCents: z.number().int().positive(),
  })
  .strict();

export const Decision = z.enum(["approve", "request_changes", "reject"]);
export const DecisionBody = z
  .object({
    version: z.number().int().positive(),
    decision: Decision,
    note: DecisionNote,
    /** Required (with confirmed=true) for approve; ignored for request_changes and reject. */
    confirmation: ApprovalConfirmation.optional(),
    actor: DemoActorField,
  })
  .strict();

export const ProposalDecisionState = z.enum(["not_submitted", "awaiting_review", "approved", "changes_requested", "rejected"]);
export const ExecutionStatus = z.enum(["not_started", "queued", "submitting", "recorded", "failed", "uncertain"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const ReconcileBody = z.object({
  action: z.enum(["check", "submit_queued", "mark_failed"]).default("check"),
  actor: DemoActorField,
  note: z.string().max(1000).default(""),
});

// ---------- Projects (multi-material request lines) ----------

export const SuppliedInventoryItem = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.string().trim().min(1).max(80),
  note: z.string().max(300).default(""),
});

export const ProjectLine = z.object({
  /** Stable key within the project, e.g. "glue". */
  key: z.string().regex(/^[a-z0-9_]{1,30}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  category: CategoryId.nullable().default(null),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  unit: z.string().trim().min(1).max(30).nullable().default(null),
  /** Budget allocated to this line; the project budget is the hard cap across lines. */
  budgetCents: Cents.refine((v) => v > 0, "budgetCents must be positive"),
  allowedCondition: AllowedCondition.default("new"),
  /** Overrides the project's needed-by date for this line. */
  deadline: z.string().date().nullable().optional(),
  deadlineType: DeadlineType.optional(),
});

export const CreateProjectBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    purpose: z.string().max(2000).default(""),
    sector: z.string().trim().min(1).max(60).default("general"),
    currency: z.literal("USD").default("USD"),
    budgetCents: Cents.refine((v) => v > 0, "budgetCents must be positive"),
    neededBy: z.string().date().nullable().default(null),
    deadlineType: DeadlineType.default("hard"),
    /** Materials the company already has. Recorded for context; never purchased. */
    suppliedInventory: z.array(SuppliedInventoryItem).max(20).default([]),
    lines: z.array(ProjectLine).min(1).max(10),
    agentConfigId: Id.default("cfg_default"),
  })
  .superRefine((p, ctx) => {
    const keys = new Set<string>();
    for (const l of p.lines) {
      if (keys.has(l.key)) ctx.addIssue({ code: "custom", message: `Duplicate line key ${l.key}`, path: ["lines"] });
      keys.add(l.key);
    }
    const sum = p.lines.reduce((s, l) => s + l.budgetCents, 0);
    if (sum > p.budgetCents) ctx.addIssue({ code: "custom", message: `Line budgets (${sum} cents) exceed the project budget (${p.budgetCents} cents)`, path: ["lines"] });
  });
export type CreateProjectBody = z.infer<typeof CreateProjectBody>;

/** Demo request presets (backend/demo/scenarios.json). Form inputs only: no products, prices or claims. */
export const ScenarioPreset = z.object({
  id: z.string().regex(/^[a-z0-9_]{2,60}$/),
  sector: z.string().min(1).max(40),
  menuLabel: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  purpose: z.string().min(1).max(2000),
  item: z.string().min(1).max(80),
  categoryId: CategoryId,
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  unit: z.string().min(1).max(30),
  budgetCents: Cents.refine((v) => v > 0),
  condition: AllowedCondition,
  /** Calendar days after the example is loaded; the form shows the concrete date and saves it. */
  deadlineDays: z.number().int().min(1).max(365),
  deadlineType: DeadlineType,
  /** Informational: when the event happens (power-station example). */
  eventDays: z.number().int().min(1).max(365).nullable(),
  mandatory: z.array(z.string().min(1).max(200)).max(10),
  preferences: z.array(z.string().min(1).max(200)).max(10),
});
export const ScenarioPresets = z.object({
  version: z.number().int().positive(),
  timezone: z.string().min(1),
  note: z.string(),
  scenarios: z.array(ScenarioPreset).min(1).max(10),
});
