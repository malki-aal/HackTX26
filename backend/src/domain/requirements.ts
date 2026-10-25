// Requirement derivation, validation and clarification. Category-specific knowledge comes from
// the category registry; nothing here assumes a particular item type.
import { Requirement as RequirementSchema, type ClarificationQuestion } from "../contracts/domain.js";
import type { Requirement, RequestFields, Condition } from "./types.js";
import {
  extractBrand,
  extractDimensions,
  extractModel,
  extractPanelType,
  extractPorts,
  extractRefreshRate,
  extractResolution,
  extractScreenSize,
  extractScrewSize,
  extractThickness,
  extractVolume,
  statesMinimum,
  extractCapacityWh,
  extractAcOutlets,
} from "./extract.js";
import { CATEGORIES, GENERAL_CATEGORY, SELECTABLE_CATEGORIES, detectCategory, getCategory, withArticle, type CategoryProfile } from "./categories.js";

export interface ValidationIssue {
  requirementId: string | null;
  code: string;
  message: string;
}

export interface RequirementValidation {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Pure validation of a requirement set against the request fields. */
export function validateRequirements(requirements: Requirement[], fields: Pick<RequestFields, "category" | "quantity" | "budgetCents" | "allowedCondition">): RequirementValidation {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const r of requirements) {
    const parsed = RequirementSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ requirementId: (r as { id?: string }).id ?? null, code: "INVALID_PREDICATE", message: parsed.error.issues.map((i) => i.message).join("; ") });
      continue;
    }
    if (ids.has(r.id)) errors.push({ requirementId: r.id, code: "DUPLICATE_ID", message: `Duplicate requirement id ${r.id}` });
    ids.add(r.id);
    if ((r.attribute === "screen_size" || r.attribute === "thickness") && r.value.min > r.value.max) {
      errors.push({ requirementId: r.id, code: "INVALID_RANGE", message: `${r.attribute} min must be <= max` });
    }
  }
  const profile = getCategory(fields.category);
  if (!profile) {
    errors.push({ requirementId: null, code: "CATEGORY_UNRESOLVED", message: "The item category is not resolved; answer the category question" });
  } else {
    const pt = requirements.find((r) => r.attribute === "product_type");
    if (!pt || !pt.mandatory || pt.value !== profile.id) {
      errors.push({ requirementId: pt?.id ?? null, code: "MISSING_PRODUCT_TYPE", message: `A mandatory category requirement for ${profile.plural} is required` });
    }
  }
  for (const attr of ["screen_size", "screw_size", "dimensions"] as const) {
    const many = requirements.filter((r) => r.attribute === attr && r.mandatory);
    if (many.length > 1) errors.push({ requirementId: many[1]!.id, code: "CONFLICTING_REQUIREMENTS", message: `More than one mandatory ${attr}` });
  }
  const cond = requirements.find((r) => r.attribute === "condition");
  if (cond && cond.attribute === "condition" && fields.allowedCondition !== "any" && !cond.value.includes(fields.allowedCondition)) {
    warnings.push({ requirementId: cond.id, code: "CONDITION_MISMATCH", message: "Condition requirement differs from allowedCondition field" });
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function conditionValues(allowed: RequestFields["allowedCondition"]): Condition[] {
  if (allowed === "any") return ["new", "refurbished", "used"];
  if (allowed === "refurbished") return ["new", "refurbished"];
  if (allowed === "used") return ["new", "refurbished", "used"];
  return ["new"];
}

const PREFERENCE = /\b(prefer|preferably|preferred|ideally|nice to have|if possible|bonus|optional)\b/i;
const preferred = (excerpt: string) => PREFERENCE.test(excerpt);

export interface CategoryResolution {
  category: string | null;
  /** Why the category is unresolved: none found, several found, the hint conflicts, or only unsupported items found. */
  problem: "none" | "ambiguous" | "conflict" | "unsupported" | null;
  candidates: string[];
  /** Recognised item types this version does not offer (for the question text). */
  unsupported?: string[];
}

const NEW_REQUEST_OPTIONS = () => [...SELECTABLE_CATEGORIES().map((c) => c.id), GENERAL_CATEGORY.id];

/**
 * Resolve the item category from an explicit hint plus the request text. A hint that the text
 * contradicts (e.g. category "monitors" on a request titled "Chairs") is a conflict, never a default.
 * Only selectable categories (plus general search) are chosen from text; an explicit API hint may still
 * name an older category so existing clients keep working.
 */
export function resolveCategory(hint: string | null, title: string, description: string): CategoryResolution {
  const det = detectCategory(title, description);
  const hinted = getCategory(hint);
  const selectable = new Set(NEW_REQUEST_OPTIONS());
  if (hinted) {
    const hintedInText = det.matches.some((m) => m.id === hinted.id);
    const otherInText = det.matches.filter((m) => m.id !== hinted.id);
    if (!hintedInText && otherInText.length) {
      const opts = [...new Set([...otherInText.map((m) => m.id), hinted.id])].filter((id) => selectable.has(id));
      return { category: null, problem: "conflict", candidates: opts.length ? [...opts, GENERAL_CATEGORY.id] : NEW_REQUEST_OPTIONS() };
    }
    return { category: hinted.id, problem: null, candidates: [hinted.id] };
  }
  const usable = det.matches.filter((m) => selectable.has(m.id));
  const legacy = det.matches.filter((m) => !selectable.has(m.id)).map((m) => getCategory(m.id)!.plural);
  if (usable.length === 1) return { category: usable[0]!.id, problem: null, candidates: [usable[0]!.id] };
  if (usable.length > 1) {
    if (det.best && selectable.has(det.best)) return { category: det.best, problem: null, candidates: [det.best] };
    return { category: null, problem: "ambiguous", candidates: [...usable.map((m) => m.id), GENERAL_CATEGORY.id] };
  }
  // Nothing supported recognised: offer the supported item types plus an explicit general search. Never force a fit.
  return legacy.length
    ? { category: null, problem: "unsupported", candidates: NEW_REQUEST_OPTIONS(), unsupported: legacy }
    : { category: null, problem: "none", candidates: NEW_REQUEST_OPTIONS() };
}

/**
 * Deterministically derive requirements for a category from the structured fields and text.
 * Statements are mandatory unless phrased as a preference. Without a resolved category only the
 * condition (and deadline) are derived; the request cannot be confirmed until the category is set.
 */
export function deriveRequirements(fields: Pick<RequestFields, "title" | "description" | "allowedCondition" | "category" | "deadline" | "deadlineType"> & Partial<Pick<RequestFields, "unit" | "quantity">>): Requirement[] {
  const text = `${fields.title}. ${fields.description}`;
  const profile = getCategory(fields.category);
  const reqs: Requirement[] = [];
  if (profile) {
    reqs.push({ id: "req_category", attribute: "product_type", operator: "eq", value: profile.id, mandatory: true, sourceText: `category: ${profile.plural}` });
    // A total ordered volume (128 US fl oz of glue) is a quantity, not a per-container size requirement.
    const skip = requestedVolumeMl(fields) !== null ? new Set(["volume"]) : new Set<string>();
    reqs.push(...deriveSpecs(text, profile).filter((r) => !skip.has(r.attribute)));
  }
  reqs.push({ id: "req_condition", attribute: "condition", operator: "in", value: conditionValues(fields.allowedCondition), mandatory: true, sourceText: `allowed condition: ${fields.allowedCondition}` });
  if (fields.deadline) {
    reqs.push({
      id: "req_delivery_by",
      attribute: "delivery_by",
      operator: "lte",
      value: fields.deadline,
      unit: "date",
      mandatory: fields.deadlineType === "hard",
      sourceText: `${fields.deadlineType === "hard" ? "needed by (hard deadline)" : "target date"}: ${fields.deadline}`,
    });
  }
  return reqs;
}

const FLUID_UNIT = /^(?:us\s+)?(?:fl\.?\s*oz\.?|fluid\s+ounces?|ml|milliliters?|millilitres?|l|liters?|litres?|gal(?:lons?)?|qt|quarts?|pt|pints?)$/i;

/**
 * Total liquid volume the request orders, in ml, when its quantity is stated as a volume
 * ("128" + "US fluid ounces") for a category that supports it. Null when the quantity counts containers.
 */
export function requestedVolumeMl(fields: Partial<Pick<RequestFields, "category" | "unit" | "quantity">>): number | null {
  const profile = getCategory(fields.category ?? null);
  if (!profile?.volumeQuantity || !fields.unit || !fields.quantity || !FLUID_UNIT.test(fields.unit.trim())) return null;
  return extractVolume(`${fields.quantity} ${fields.unit.trim()}`)?.value ?? null;
}

function deriveSpecs(text: string, profile: CategoryProfile): Requirement[] {
  const reqs: Requirement[] = [];
  for (const kind of profile.specs) {
    switch (kind) {
      case "screen_size": {
        const m = extractScreenSize(text);
        // "At least 27 inches" is a minimum; a bare "27 inch" means the 27-inch class.
        if (m) reqs.push({ id: "req_screen_size", attribute: "screen_size", operator: "between", value: { min: Math.floor(m.value), max: statesMinimum(m.excerpt) ? 100 : Math.floor(m.value) + 0.9 }, unit: "in", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "resolution": {
        const m = extractResolution(text);
        if (m) reqs.push({ id: "req_resolution", attribute: "resolution", operator: "gte", value: m.value, unit: "px", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "port":
        for (const p of extractPorts(text)) reqs.push({ id: `req_port_${p.value}`, attribute: "port", operator: "includes", value: p.value, mandatory: !preferred(p.excerpt), sourceText: p.excerpt });
        break;
      case "refresh_rate": {
        const m = extractRefreshRate(text);
        if (m) reqs.push({ id: "req_refresh_rate", attribute: "refresh_rate", operator: "gte", value: m.value, unit: "hz", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "panel_type": {
        const m = extractPanelType(text);
        if (m) reqs.push({ id: "req_panel_type", attribute: "panel_type", operator: "in", value: [m.value], mandatory: false, sourceText: m.excerpt });
        break;
      }
      case "brand": {
        const b = extractBrand(text);
        if (b) reqs.push({ id: "req_brand", attribute: "brand", operator: "in", value: [b], mandatory: false, sourceText: b });
        break;
      }
      case "volume": {
        const m = extractVolume(text, { bareOzIsFluid: profile.bareOzIsFluid });
        if (m) reqs.push({ id: "req_volume", attribute: "volume", operator: "gte", value: m.value, unit: "ml", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "dimensions": {
        const m = extractDimensions(text);
        if (m) reqs.push({ id: "req_dimensions", attribute: "dimensions", operator: "gte", value: m.value, unit: "in", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "thickness": {
        const m = extractThickness(text);
        // A stated thickness accepts listings within ±1/32 in.
        if (m) reqs.push({ id: "req_thickness", attribute: "thickness", operator: "between", value: { min: Math.max(0.001, m.value - 0.032), max: m.value + 0.032 }, unit: "in", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "screw_size": {
        const m = extractScrewSize(text);
        if (m) reqs.push({ id: "req_screw_size", attribute: "screw_size", operator: "eq", value: m.value, unit: "in", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "capacity_wh": {
        const m = extractCapacityWh(text);
        if (m) reqs.push({ id: "req_capacity_wh", attribute: "capacity_wh", operator: "gte", value: m.value, unit: "wh", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
      case "ac_outlets": {
        const m = extractAcOutlets(text);
        if (m) reqs.push({ id: "req_ac_outlets", attribute: "ac_outlets", operator: "gte", value: m.value, unit: "outlets", mandatory: !preferred(m.excerpt), sourceText: m.excerpt });
        break;
      }
    }
  }
  for (const [id, f] of Object.entries(profile.features)) {
    const m = f.pattern.exec(text);
    if (!m) continue;
    const window = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30);
    reqs.push({ id: `req_feature_${id}`, attribute: "feature", operator: "includes", value: id, label: f.label, mandatory: !preferred(window), sourceText: window.trim() });
  }
  return reqs;
}

/** Back-compat helper used by older tests and scripts. */
export function deriveMonitorRequirements(fields: Pick<RequestFields, "title" | "description" | "allowedCondition">): Requirement[] {
  return deriveRequirements({ ...fields, category: "monitors", deadline: null, deadlineType: "target" });
}

/**
 * Merge model-extracted requirements into deterministic ones. A model requirement is kept only if
 * its attribute was not already derived, it applies to the resolved category, and its sourceText
 * is literally present in the user text, so the model cannot invent requirements.
 */
export function mergeExtractedRequirements(base: Requirement[], extracted: unknown[], userText: string, category?: string | null): { merged: Requirement[]; dropped: string[] } {
  const merged = [...base];
  const dropped: string[] = [];
  const profile = getCategory(category ?? (base.find((r) => r.attribute === "product_type")?.value as string | undefined));
  const key = (r: Requirement) => (r.attribute === "port" || r.attribute === "feature" ? `${r.attribute}:${r.value}` : r.attribute);
  const haveAttr = new Set(base.map(key));
  const lowered = userText.toLowerCase();
  for (const raw of extracted) {
    const parsed = RequirementSchema.safeParse(raw);
    if (!parsed.success) {
      dropped.push("invalid predicate shape");
      continue;
    }
    const r = parsed.data;
    if (haveAttr.has(key(r)) || r.attribute === "product_type" || r.attribute === "condition" || r.attribute === "delivery_by") continue;
    if (!profile || (r.attribute !== "brand" && r.attribute !== "feature" && !profile.specs.includes(r.attribute as never))) {
      dropped.push(`${r.attribute}: not applicable to this category`);
      continue;
    }
    if (!r.sourceText || !lowered.includes(r.sourceText.toLowerCase())) {
      dropped.push(`${r.attribute}: source text not found in request`);
      continue;
    }
    haveAttr.add(key(r));
    merged.push({ ...r, id: `req_${key(r).replace(":", "_")}` } as Requirement);
  }
  return { merged, dropped };
}

export interface ClarificationInput {
  fields: RequestFields;
  explicitFields: Set<string>;
  requirements: Requirement[];
  categoryResolution?: CategoryResolution;
}

/** Only decision-relevant questions, with stable ids. Returns [] when everything needed is present. */
export function buildClarificationQuestions({ fields, explicitFields, requirements, categoryResolution }: ClarificationInput): Array<Omit<ClarificationQuestion, "answer" | "answeredAt">> {
  const qs: Array<Omit<ClarificationQuestion, "answer" | "answeredAt">> = [];
  const text = `${fields.title} ${fields.description}`;
  if (categoryResolution && categoryResolution.problem) {
    const opts = categoryResolution.candidates.map((id) => getCategory(id)!).filter(Boolean);
    const why =
      categoryResolution.problem === "conflict"
        ? "The request text and the selected category disagree."
        : categoryResolution.problem === "ambiguous"
          ? "The request mentions more than one kind of item."
          : categoryResolution.problem === "unsupported"
            ? `${(categoryResolution.unsupported ?? ["This item"]).join(", ").replace(/^./, (c) => c.toUpperCase())} ${(categoryResolution.unsupported?.length ?? 1) > 1 ? "aren't" : "isn't"} a supported item type in this version.`
            : "The item type isn't one Runway has checks for.";
    qs.push({
      id: "q_category",
      text: `${why} What item is this request for?`,
      kind: "single_choice",
      options: opts.map((c) => ({
        value: c.id,
        label: c.id === GENERAL_CATEGORY.id ? "Something else (general search, every result needs review)" : c.plural.charAt(0).toUpperCase() + c.plural.slice(1),
      })),
      affects: "category",
    });
  }
  const unit = getCategory(fields.category)?.unit ?? "item";
  if (fields.quantity > 1 && !explicitFields.has("budgetBasis") && !/\b(total|overall|in total|all together|combined|each|per (?:unit|item|piece|\w+))\b/i.test(text)) {
    qs.push({
      id: "q_budget_basis",
      text: `Is the budget for all ${fields.quantity} ${fields.unit ?? `${unit}s`} together, or per ${fields.unit ?? unit}?`,
      kind: "single_choice",
      options: [
        { value: "total", label: "Total for all" },
        { value: "per_item", label: `Per ${fields.unit ?? unit}` },
      ],
      affects: "budgetBasis",
    });
  }
  for (const r of requirements) {
    if ((r.attribute === "port" || r.attribute === "feature") && !/\b(must|required|need|needs|requires?)\b/i.test(text) && !PREFERENCE.test(r.sourceText)) {
      const name = r.attribute === "port" ? r.value.toUpperCase().replace("_", "-") : r.label;
      qs.push({
        id: `q_mandatory_${r.id}`,
        text: `Is "${name}" required, or only preferred?`,
        kind: "single_choice",
        options: [
          { value: "mandatory", label: "Required" },
          { value: "preferred", label: "Preferred" },
        ],
        affects: r.id,
      });
    }
  }
  if (!explicitFields.has("allowedCondition") && !/\b(new|refurbished|renewed|used|pre-?owned|any condition)\b/i.test(text)) {
    qs.push({
      id: "q_condition",
      text: "Which item conditions are acceptable?",
      kind: "single_choice",
      options: [
        { value: "new", label: "New only" },
        { value: "refurbished", label: "New or refurbished" },
        { value: "any", label: "Any condition" },
      ],
      affects: "allowedCondition",
    });
  }
  const model = fields.category === "monitors" ? extractModel(text) : null;
  if (model) {
    qs.push({
      id: "q_substitutes",
      text: `Must it be exactly model ${model}, or are equivalent substitutes acceptable?`,
      kind: "single_choice",
      options: [
        { value: "exact", label: "Exact model only" },
        { value: "substitutes", label: "Substitutes OK" },
      ],
      affects: "model",
    });
  }
  return qs;
}

export interface AnswerEffect {
  fields: Partial<RequestFields>;
  requirements: Requirement[];
  /** Set when the answer changes the category: requirements were re-derived for it. */
  categoryChanged: boolean;
}

/** Apply clarification answers, producing new fields and requirements. Pure. */
export function applyClarificationAnswers(fields: RequestFields, requirements: Requirement[], answers: Array<{ questionId: string; value: string | number | boolean }>): AnswerEffect {
  const patch: Partial<RequestFields> = {};
  let reqs = requirements.map((r) => ({ ...r })) as Requirement[];
  let categoryChanged = false;
  const cat = answers.find((a) => a.questionId === "q_category");
  if (cat && getCategory(String(cat.value))) {
    const id = getCategory(String(cat.value))!.id;
    patch.category = id;
    categoryChanged = id !== fields.category;
    reqs = deriveRequirements({ ...fields, category: id });
  }
  for (const a of answers) {
    if (a.questionId === "q_budget_basis" && (a.value === "total" || a.value === "per_item")) patch.budgetBasis = a.value;
    else if (a.questionId === "q_condition" && (a.value === "new" || a.value === "refurbished" || a.value === "any")) {
      patch.allowedCondition = a.value;
      reqs = reqs.map((r) => (r.attribute === "condition" ? { ...r, value: conditionValues(a.value as RequestFields["allowedCondition"]), sourceText: `allowed condition: ${a.value}` } : r));
    } else if (a.questionId.startsWith("q_mandatory_")) {
      const id = a.questionId.slice("q_mandatory_".length);
      reqs = reqs.map((r) => (r.id === id ? { ...r, mandatory: a.value === "mandatory" } : r));
    }
    // q_substitutes is recorded for human review; exact-model matching is not automated.
  }
  return { fields: patch, requirements: reqs, categoryChanged };
}

/** Effective total budget in cents for the requested quantity. */
export function totalBudgetCents(fields: Pick<RequestFields, "budgetCents" | "budgetBasis" | "quantity">): number {
  return fields.budgetBasis === "per_item" ? fields.budgetCents * fields.quantity : fields.budgetCents;
}

/** Human-readable label for a requirement (used by API views so clients need no per-category code). */
export function describeRequirement(r: Requirement): string {
  switch (r.attribute) {
    case "product_type": {
      const c = getCategory(r.value);
      return c ? `Is ${withArticle(c.label)}` : `Category: ${r.value}`;
    }
    case "screen_size":
      return r.value.max >= 100 ? `At least ${Math.floor(r.value.min)} inch screen` : `${Math.floor(r.value.min)} inch screen`;
    case "resolution":
      return `At least ${r.value.width} × ${r.value.height}`;
    case "port":
      return `${({ hdmi: "HDMI", displayport: "DisplayPort", usb_c: "USB-C", thunderbolt: "Thunderbolt", vga: "VGA", dvi: "DVI" } as Record<string, string>)[r.value] ?? r.value} input`;
    case "condition":
      return `Condition: ${r.value.join(" or ")}`;
    case "refresh_rate":
      return `At least ${r.value} Hz`;
    case "panel_type":
      return `${r.value.map((x) => x.toUpperCase()).join(" or ")} panel`;
    case "brand":
      return `Brand: ${r.value.join(" or ")}`;
    case "volume":
      return `At least ${Math.round((r.value / 29.5735) * 10) / 10} US fl oz (${r.value} ml)`;
    case "capacity_wh":
      return `At least ${r.value} Wh battery capacity`;
    case "ac_outlets":
      return `At least ${r.value} AC outlet${r.value === 1 ? "" : "s"}`;
    case "dimensions":
      return `At least ${r.value.length} × ${r.value.width} in`;
    case "thickness":
      return `Thickness ${Math.round(((r.value.min + r.value.max) / 2) * 1000) / 1000} in`;
    case "screw_size":
      return `#${r.value.gauge} × ${r.value.lengthIn} in`;
    case "feature":
      return r.label;
    case "delivery_by":
      return `${r.mandatory ? "Must arrive by" : "Target arrival"} ${r.value}`;
  }
}
