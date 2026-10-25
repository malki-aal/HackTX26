// Requirement derivation, validation and clarification for the monitors category.
import { Requirement as RequirementSchema, type ClarificationQuestion } from "../contracts/domain.js";
import type { Requirement, RequestFields, Condition } from "./types.js";
import { extractPanelType, extractPorts, extractRefreshRate, extractResolution, extractScreenSize, extractBrand, extractModel } from "./extract.js";

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
    if (r.attribute === "screen_size" && r.value.min > r.value.max) {
      errors.push({ requirementId: r.id, code: "INVALID_RANGE", message: "screen_size min must be <= max" });
    }
  }
  if (fields.category === "monitors" && !requirements.some((r) => r.attribute === "product_type" && r.mandatory)) {
    errors.push({ requirementId: null, code: "MISSING_PRODUCT_TYPE", message: "A mandatory product_type=monitor requirement is required for the monitors category" });
  }
  const sizeReqs = requirements.filter((r) => r.attribute === "screen_size" && r.mandatory);
  if (sizeReqs.length > 1) errors.push({ requirementId: sizeReqs[1]!.id, code: "CONFLICTING_REQUIREMENTS", message: "More than one mandatory screen size" });
  const cond = requirements.find((r) => r.attribute === "condition");
  if (cond && cond.attribute === "condition" && fields.allowedCondition !== "any" && !cond.value.includes(fields.allowedCondition)) {
    warnings.push({ requirementId: cond.id, code: "CONDITION_MISMATCH", message: "Condition requirement differs from allowedCondition field" });
  }
  return { ok: errors.length === 0, errors, warnings };
}

function conditionValues(allowed: RequestFields["allowedCondition"]): Condition[] {
  if (allowed === "any") return ["new", "refurbished", "used"];
  if (allowed === "refurbished") return ["new", "refurbished"];
  if (allowed === "used") return ["new", "refurbished", "used"];
  return ["new"];
}

/**
 * Deterministically derive monitor requirements from the structured fields and description text.
 * Statements in the description are treated as mandatory unless phrased as a preference.
 */
export function deriveMonitorRequirements(fields: Pick<RequestFields, "title" | "description" | "allowedCondition">): Requirement[] {
  const text = `${fields.title}. ${fields.description}`;
  const reqs: Requirement[] = [
    { id: "req_product_type", attribute: "product_type", operator: "eq", value: "monitor", mandatory: true, sourceText: "category: monitors" },
  ];
  const preferred = (excerpt: string) => /\b(prefer|preferably|ideally|nice to have|if possible|bonus)\b/i.test(excerpt);

  const size = extractScreenSize(text);
  if (size) {
    reqs.push({
      id: "req_screen_size",
      attribute: "screen_size",
      operator: "between",
      value: { min: Math.floor(size.value), max: Math.floor(size.value) + 0.9 },
      unit: "in",
      mandatory: !preferred(size.excerpt),
      sourceText: size.excerpt,
    });
  }
  const res = extractResolution(text);
  if (res) {
    reqs.push({
      id: "req_resolution",
      attribute: "resolution",
      operator: "gte",
      value: res.value,
      unit: "px",
      mandatory: !preferred(res.excerpt),
      sourceText: res.excerpt,
    });
  }
  for (const port of extractPorts(text)) {
    reqs.push({ id: `req_port_${port.value}`, attribute: "port", operator: "includes", value: port.value, mandatory: !preferred(port.excerpt), sourceText: port.excerpt });
  }
  const hz = extractRefreshRate(text);
  if (hz) {
    reqs.push({ id: "req_refresh_rate", attribute: "refresh_rate", operator: "gte", value: hz.value, unit: "hz", mandatory: !preferred(hz.excerpt), sourceText: hz.excerpt });
  }
  const panel = extractPanelType(text);
  if (panel) {
    reqs.push({ id: "req_panel_type", attribute: "panel_type", operator: "in", value: [panel.value], mandatory: false, sourceText: panel.excerpt });
  }
  const brand = extractBrand(text);
  if (brand) {
    reqs.push({ id: "req_brand", attribute: "brand", operator: "in", value: [brand], mandatory: false, sourceText: brand });
  }
  reqs.push({
    id: "req_condition",
    attribute: "condition",
    operator: "in",
    value: conditionValues(fields.allowedCondition),
    mandatory: true,
    sourceText: `allowed condition: ${fields.allowedCondition}`,
  });
  return reqs;
}

/**
 * Merge model-extracted requirements into deterministic ones. A model requirement is kept only if
 * its attribute was not already derived and its sourceText is literally present in the user text,
 * so the model cannot invent requirements the user never stated.
 */
export function mergeExtractedRequirements(base: Requirement[], extracted: unknown[], userText: string): { merged: Requirement[]; dropped: string[] } {
  const merged = [...base];
  const dropped: string[] = [];
  const haveAttr = new Set(base.map((r) => (r.attribute === "port" ? `port:${r.value}` : r.attribute)));
  const lowered = userText.toLowerCase();
  for (const raw of extracted) {
    const parsed = RequirementSchema.safeParse(raw);
    if (!parsed.success) {
      dropped.push("invalid predicate shape");
      continue;
    }
    const r = parsed.data;
    const key = r.attribute === "port" ? `port:${r.value}` : r.attribute;
    if (haveAttr.has(key) || r.attribute === "product_type" || r.attribute === "condition") continue;
    if (!r.sourceText || !lowered.includes(r.sourceText.toLowerCase())) {
      dropped.push(`${r.attribute}: source text not found in request`);
      continue;
    }
    haveAttr.add(key);
    merged.push({ ...r, id: `req_${key.replace(":", "_")}` } as Requirement);
  }
  return { merged, dropped };
}

export interface ClarificationInput {
  fields: RequestFields;
  explicitFields: Set<string>;
  requirements: Requirement[];
}

/** Only decision-relevant questions, with stable ids. Returns [] when everything needed is present. */
export function buildClarificationQuestions({ fields, explicitFields, requirements }: ClarificationInput): Array<Omit<ClarificationQuestion, "answer" | "answeredAt">> {
  const qs: Array<Omit<ClarificationQuestion, "answer" | "answeredAt">> = [];
  const text = `${fields.title} ${fields.description}`;
  if (fields.quantity > 1 && !explicitFields.has("budgetBasis") && !/\b(total|overall|in total|all together|combined|each|per (?:unit|item|monitor))\b/i.test(text)) {
    qs.push({
      id: "q_budget_basis",
      text: `Is the budget for all ${fields.quantity} items together, or per item?`,
      kind: "single_choice",
      options: [
        { value: "total", label: "Total for all items" },
        { value: "per_item", label: "Per item" },
      ],
      affects: "budgetBasis",
    });
  }
  for (const r of requirements) {
    if (r.attribute === "port" && !/\b(must|required|need|needs|requires?)\b/i.test(text)) {
      qs.push({
        id: `q_mandatory_${r.id}`,
        text: `Is ${r.value.toUpperCase().replace("_", "-")} required, or only preferred?`,
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
  const model = extractModel(text);
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
}

/** Apply clarification answers, producing new fields and requirements. Pure. */
export function applyClarificationAnswers(fields: RequestFields, requirements: Requirement[], answers: Array<{ questionId: string; value: string | number | boolean }>): AnswerEffect {
  const patch: Partial<RequestFields> = {};
  let reqs = requirements.map((r) => ({ ...r })) as Requirement[];
  for (const a of answers) {
    if (a.questionId === "q_budget_basis" && (a.value === "total" || a.value === "per_item")) patch.budgetBasis = a.value;
    else if (a.questionId === "q_condition" && (a.value === "new" || a.value === "refurbished" || a.value === "any")) {
      patch.allowedCondition = a.value;
      reqs = reqs.map((r) => (r.attribute === "condition" ? { ...r, value: conditionValues(a.value as RequestFields["allowedCondition"]), sourceText: `allowed condition: ${a.value}` } : r));
    } else if (a.questionId.startsWith("q_mandatory_")) {
      const id = a.questionId.slice("q_mandatory_".length);
      reqs = reqs.map((r) => (r.id === id ? { ...r, mandatory: a.value === "mandatory" } : r));
    }
    // q_substitutes is recorded with the request for human review; exact-model matching is not
    // automated in the MVP, so it does not change predicates.
  }
  return { fields: patch, requirements: reqs };
}

/** Effective total budget in cents for the requested quantity. */
export function totalBudgetCents(fields: Pick<RequestFields, "budgetCents" | "budgetBasis" | "quantity">): number {
  return fields.budgetBasis === "per_item" ? fields.budgetCents * fields.quantity : fields.budgetCents;
}
