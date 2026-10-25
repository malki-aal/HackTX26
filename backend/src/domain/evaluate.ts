// Deterministic requirement checks, cost calculation, classification and ranking.
// No model or network access: the same inputs always produce the same ranking.
import type { CandidateEvaluation, Offer, PurchaseCost, Requirement, RequirementResult } from "./types.js";
import type { RankingPriority } from "../contracts/index.js";
import { addCents, multiplyCents, formatUsd } from "./money.js";

/**
 * Evaluate one requirement against every piece of evidence for that attribute. Agreeing evidence
 * yields supported/contradicted; disagreeing sources yield unknown ("conflicting evidence").
 */
export function evaluateRequirement(req: Requirement, offer: Offer): RequirementResult {
  const ev = offer.evidence.filter((e) => e.attribute === req.attribute);
  if (ev.length <= 1 || req.attribute === "port" || req.attribute === "condition") return evaluateWith(req, offer, ev);
  const verdicts = ev.map((e) => ({ e, r: evaluateWith(req, offer, [e]) }));
  const sup = verdicts.filter((v) => v.r.state === "supported");
  const con = verdicts.filter((v) => v.r.state === "contradicted");
  if (sup.length && con.length) {
    return { requirementId: req.id, attribute: req.attribute, mandatory: req.mandatory, state: "unknown", evidenceIds: ev.map((e) => e.id), reason: `Conflicting evidence: ${sup[0]!.r.reason} vs ${con[0]!.r.reason}` };
  }
  const chosen = sup.length ? sup : con.length ? con : verdicts;
  return { ...chosen[0]!.r, evidenceIds: chosen.map((v) => v.e.id) };
}

function evaluateWith(req: Requirement, offer: Offer, ev: Offer["evidence"]): RequirementResult {
  const base = { requirementId: req.id, attribute: req.attribute, mandatory: req.mandatory };
  const result = (state: RequirementResult["state"], ids: string[], reason: string): RequirementResult => ({ ...base, state, evidenceIds: ids, reason });

  switch (req.attribute) {
    case "product_type": {
      const e = ev[0];
      if (!e) return result("unknown", [], "Listing does not say whether it is a monitor");
      return e.value === "monitor" ? result("supported", [e.id], "Listing describes a monitor") : result("contradicted", [e.id], "Listing is an accessory, not a monitor");
    }
    case "screen_size": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No screen size stated in listing");
      const v = e.value as number;
      return v >= req.value.min && v <= req.value.max
        ? result("supported", [e.id], `Listing states ${v}"`)
        : result("contradicted", [e.id], `Listing states ${v}", outside ${req.value.min}–${req.value.max}"`);
    }
    case "resolution": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No resolution stated in listing");
      const v = e.value as { width: number; height: number };
      return v.width >= req.value.width && v.height >= req.value.height
        ? result("supported", [e.id], `Listing states ${v.width}×${v.height}`)
        : result("contradicted", [e.id], `Listing states ${v.width}×${v.height}, below ${req.value.width}×${req.value.height}`);
    }
    case "port": {
      const e = ev.find((x) => x.value === req.value);
      // Thunderbolt 3/4 ports are USB-C compatible.
      const tb = req.value === "usb_c" ? ev.find((x) => x.value === "thunderbolt") : undefined;
      if (e) return result("supported", [e.id], e.source === "serpapi_immersive_product" ? `Product specs list ${req.value}` : `Listing mentions ${req.value}`);
      if (tb) return result("supported", [tb.id], "Listing mentions Thunderbolt (USB-C connector)");
      // A port not being mentioned is not proof it is absent.
      return result("unknown", [], offer.details.status === "fetched" ? `Neither listing nor product specs mention ${req.value}` : `Listing does not mention ${req.value}`);
    }
    case "condition": {
      const e = ev[0];
      if (!e || offer.condition === null) return result("unknown", [], "Condition not stated");
      if (!req.value.includes(offer.condition)) return result("contradicted", [e.id], `Listing condition is ${offer.condition}`);
      return e.method === "inferred_default"
        ? result("supported", [e.id], "No second-hand condition reported (treated as new; verify at checkout)")
        : result("supported", [e.id], `Listing condition is ${offer.condition}`);
    }
    case "refresh_rate": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No refresh rate stated");
      return (e.value as number) >= req.value ? result("supported", [e.id], `Listing states ${e.value}Hz`) : result("contradicted", [e.id], `Listing states ${e.value}Hz, below ${req.value}Hz`);
    }
    case "panel_type": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No panel type stated");
      return req.value.includes(e.value as never) ? result("supported", [e.id], `Panel type ${String(e.value).toUpperCase()}`) : result("contradicted", [e.id], `Panel type ${String(e.value).toUpperCase()}`);
    }
    case "brand": {
      const e = ev[0];
      if (!e) return result("unknown", [], "Brand not identified");
      return req.value.some((b) => b.toLowerCase() === String(e.value).toLowerCase())
        ? result("supported", [e.id], `Brand ${e.value}`)
        : result("contradicted", [e.id], `Brand ${e.value}`);
    }
  }
}

export function calculatePurchaseCost(offer: Offer, requestedQuantity: number): PurchaseCost {
  const notes: string[] = [];
  const priceUsable = offer.listedPriceCents !== null && offer.priceBasis === "one_time" && offer.currency === "USD";
  const packQty = offer.packageQuantity;
  const packagesRequired = packQty ? Math.ceil(requestedQuantity / packQty) : null;
  if (packQty && packQty > 1) notes.push(`Listing is a ${packQty}-pack; ${packagesRequired} package(s) needed for ${requestedQuantity}`);
  if (packQty && packagesRequired && packQty * packagesRequired > requestedQuantity) notes.push(`Buying ${packQty * packagesRequired} units to cover ${requestedQuantity}`);
  const unit = priceUsable ? offer.listedPriceCents : null;
  const subtotal = unit !== null && packagesRequired !== null ? multiplyCents(unit, packagesRequired) : null;
  const shippingCents = offer.shipping.status === "known" && packagesRequired !== null ? offer.shipping.cents : null;
  // Shipping is stated per listing; we do not assume how it scales with packages beyond the stated amount.
  if (shippingCents !== null && shippingCents > 0 && packagesRequired !== null && packagesRequired > 1) notes.push("Stated shipping may be per package; verify at checkout");
  const comparable = subtotal === null ? null : addCents(subtotal, shippingCents ?? 0);
  let totalStatus: PurchaseCost["totalStatus"] = "price_unknown";
  if (subtotal !== null) totalStatus = shippingCents === null ? "listed_subtotal_only" : "subtotal_plus_shipping_tax_unknown";
  if (subtotal !== null) notes.push("Sales tax is unknown; total is provisional");
  if (offer.priceBasis === "installment") notes.push("Monthly installment price excluded from cost comparison");
  if (offer.priceBasis === "from_price") notes.push("'From' price excluded from cost comparison");
  return {
    requestedQuantity,
    packageQuantity: packQty,
    packagesRequired,
    unitPriceCents: unit,
    listedSubtotalCents: subtotal,
    shippingCents,
    taxCents: null,
    knownComparableCostCents: comparable,
    totalStatus,
    provisional: true,
    notes,
  };
}

export interface Classification {
  class: CandidateEvaluation["class"];
  affordability: CandidateEvaluation["affordability"];
  unknowns: string[];
  reason: string;
}

export function classifyCandidate(offer: Offer, results: RequirementResult[], cost: PurchaseCost, budgetCents: number): Classification {
  const unknowns: string[] = [];
  const mandatoryContradicted = results.filter((r) => r.mandatory && r.state === "contradicted");
  const mandatoryUnknown = results.filter((r) => r.mandatory && r.state === "unknown");
  for (const r of mandatoryUnknown) unknowns.push(`${r.attribute}: ${r.reason}`);
  for (const r of results.filter((x) => !x.mandatory && x.state === "unknown")) unknowns.push(`(preference) ${r.attribute}: ${r.reason}`);
  if (offer.shipping.status === "unknown") unknowns.push("shipping cost");
  unknowns.push("sales tax");
  unknowns.push(...offer.needsReviewReasons);
  if (offer.availability.status === "unknown") unknowns.push("availability");

  let affordability: CandidateEvaluation["affordability"] = "unknown";
  if (cost.knownComparableCostCents !== null) affordability = cost.knownComparableCostCents <= budgetCents ? "within_budget_provisional" : "over_budget";

  if (mandatoryContradicted.length > 0) {
    return { class: "rejected", affordability, unknowns, reason: `Mandatory mismatch: ${mandatoryContradicted.map((r) => r.reason).join("; ")}` };
  }
  // A known lower bound (subtotal without tax) above budget is a known budget violation.
  if (affordability === "over_budget") {
    return { class: "rejected", affordability, unknowns, reason: `Known cost ${formatUsd(cost.knownComparableCostCents!)} exceeds budget ${formatUsd(budgetCents)}` };
  }
  if (mandatoryUnknown.length > 0 || cost.listedSubtotalCents === null || offer.needsReviewReasons.length > 0) {
    const why = [
      ...mandatoryUnknown.map((r) => `${r.attribute} unconfirmed`),
      ...(cost.listedSubtotalCents === null ? ["cost for requested quantity unknown"] : []),
      ...offer.needsReviewReasons,
    ];
    return { class: "needs_review", affordability, unknowns, reason: `Needs review: ${why.join("; ")}` };
  }
  return { class: "eligible", affordability, unknowns, reason: `All mandatory requirements supported by listing evidence; provisional cost ${formatUsd(cost.knownComparableCostCents!)} (tax unknown)` };
}

const CLASS_ORDER = { eligible: 0, needs_review: 1, rejected: 2 } as const;

/** Stable, reproducible ranking. Inputs are not mutated. */
export function rankCandidates(evals: Array<Omit<CandidateEvaluation, "rank">>, priority: RankingPriority = "lowest_known_total"): CandidateEvaluation[] {
  const sorted = [...evals].sort((a, b) => {
    const c = CLASS_ORDER[a.class] - CLASS_ORDER[b.class];
    if (c !== 0) return c;
    const aff = (x: typeof a) => (x.affordability === "within_budget_provisional" ? 0 : x.affordability === "unknown" ? 1 : 2);
    const af = aff(a) - aff(b);
    if (af !== 0) return af;
    const costCmp = () => {
      const ac = a.cost.knownComparableCostCents;
      const bc = b.cost.knownComparableCostCents;
      if (ac === null && bc === null) return 0;
      if (ac === null) return 1;
      if (bc === null) return -1;
      return ac - bc;
    };
    const evCmp = () => b.evidenceCompleteness - a.evidenceCompleteness;
    const first = priority === "evidence_completeness" ? evCmp() : costCmp();
    if (first !== 0) return first;
    const second = priority === "evidence_completeness" ? costCmp() : evCmp();
    if (second !== 0) return second;
    return a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
  });
  return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
}

export function evaluateCandidates(offers: Offer[], requirements: Requirement[], quantity: number, budgetCents: number, priority: RankingPriority = "lowest_known_total"): CandidateEvaluation[] {
  const evals = offers.map((offer) => {
    const requirementResults = requirements.map((r) => evaluateRequirement(r, offer));
    const cost = calculatePurchaseCost(offer, quantity);
    const cls = classifyCandidate(offer, requirementResults, cost, budgetCents);
    return {
      offerId: offer.id,
      class: cls.class,
      affordability: cls.affordability,
      requirementResults,
      unknowns: cls.unknowns,
      cost,
      recommendationReason: cls.reason,
      evidenceCompleteness: requirementResults.filter((r) => r.state === "supported").length,
    };
  });
  return rankCandidates(evals, priority);
}
