// Deterministic requirement checks, cost calculation, classification and ranking.
// No model or network access: the same inputs always produce the same ranking.
import type { CandidateEvaluation, Offer, PurchaseCost, Requirement, RequirementResult } from "./types.js";
import type { RankingPriority } from "../contracts/index.js";
import { addCents, multiplyCents, formatUsd } from "./money.js";
import { getCategory, withArticle } from "./categories.js";

/**
 * Evaluate one requirement against every piece of evidence for that attribute. Agreeing evidence
 * yields supported/contradicted; disagreeing sources yield unknown ("conflicting evidence").
 */
export function evaluateRequirement(req: Requirement, offer: Offer): RequirementResult {
  const ev = offer.evidence.filter((e) => e.attribute === req.attribute);
  if (ev.length <= 1 || req.attribute === "port" || req.attribute === "condition" || req.attribute === "feature") return evaluateWith(req, offer, ev);
  const verdicts = ev.map((e) => ({ e, r: evaluateWith(req, offer, [e]) }));
  const sup = verdicts.filter((v) => v.r.state === "supported");
  const con = verdicts.filter((v) => v.r.state === "contradicted");
  if (sup.length && con.length) {
    return { requirementId: req.id, attribute: req.attribute, mandatory: req.mandatory, state: "unknown", evidenceIds: ev.map((e) => e.id), reason: `Conflicting evidence: ${sup[0]!.r.reason} vs ${con[0]!.r.reason}` };
  }
  const chosen = sup.length ? sup : con.length ? con : verdicts;
  return { ...chosen[0]!.r, evidenceIds: chosen.map((v) => v.e.id) };
}

function evaluateWith(req: Requirement, offer: Offer, ev: Offer["evidence"]): RequirementResult | never {
  const base = { requirementId: req.id, attribute: req.attribute, mandatory: req.mandatory };
  const result = (state: RequirementResult["state"], ids: string[], reason: string): RequirementResult => ({ ...base, state, evidenceIds: ids, reason });

  switch (req.attribute) {
    case "product_type": {
      // Category consistency is checked against the confirmed category, never a default.
      const wanted = getCategory(req.value);
      const label = wanted?.label ?? req.value;
      const e = ev[0];
      if (!e) return result("unknown", [], `Listing does not say whether it is ${withArticle(label)}`);
      if (e.value === req.value) return result("supported", [e.id], `Listing describes ${withArticle(label)}`);
      const other = getCategory(String(e.value));
      return result("contradicted", [e.id], e.value === "accessory_or_part" ? `Listing is a related product, accessory or part, not ${withArticle(label)}` : `Listing is ${withArticle(other?.label ?? String(e.value))}, not ${withArticle(label)}`);
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
      // "Not described as used" is not evidence of new: an inferred condition stays unknown until verified.
      return e.method === "inferred_default"
        ? result("unknown", [e.id], "Inferred new (no second-hand condition reported); not stated by the listing, verify with the seller")
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
    case "volume": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No volume stated");
      const v = e.value as number;
      return v >= req.value ? result("supported", [e.id], `States ${v} ml`) : result("contradicted", [e.id], `States ${v} ml, below ${req.value} ml`);
    }
    case "dimensions": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No dimensions stated");
      const v = e.value as { length: number; width: number };
      return v.length >= req.value.length && v.width >= req.value.width
        ? result("supported", [e.id], `States ${v.length} × ${v.width} in`)
        : result("contradicted", [e.id], `States ${v.length} × ${v.width} in, smaller than ${req.value.length} × ${req.value.width} in`);
    }
    case "thickness": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No thickness stated");
      const v = e.value as number;
      return v >= req.value.min && v <= req.value.max ? result("supported", [e.id], `States ${v} in thick`) : result("contradicted", [e.id], `States ${v} in thick`);
    }
    case "screw_size": {
      const e = ev[0];
      if (!e) return result("unknown", [], "No screw size stated");
      const v = e.value as { gauge: number; lengthIn: number };
      const ok = v.gauge === req.value.gauge && Math.abs(v.lengthIn - req.value.lengthIn) <= 1 / 32;
      return ok ? result("supported", [e.id], `States #${v.gauge} × ${v.lengthIn} in`) : result("contradicted", [e.id], `States #${v.gauge} × ${v.lengthIn} in, not #${req.value.gauge} × ${req.value.lengthIn} in`);
    }
    case "feature": {
      const absent = ev.find((x) => x.value === `!${req.value}`);
      if (absent) return result("contradicted", [absent.id], `Listing states it lacks: ${req.label} ("${absent.excerpt.slice(0, 60)}")`);
      const e = ev.find((x) => x.value === req.value);
      if (e) return result("supported", [e.id], e.source === "serpapi_immersive_product" ? `Product specs mention: ${req.label}` : `Listing mentions: ${req.label}`);
      return result("unknown", [], offer.details.status === "fetched" ? `Neither listing nor product specs mention: ${req.label}` : `Listing does not mention: ${req.label}`);
    }
    case "delivery_by": {
      // Only a date the seller states counts. Missing delivery information stays unknown.
      const e = ev[ev.length - 1];
      const kind = req.mandatory ? "hard deadline" : "target date";
      if (!e) return result("unknown", [], `No delivery date stated (${kind} ${req.value})`);
      const v = e.value as { earliest: string; latest: string };
      if (v.latest <= req.value) return result("supported", [e.id], `Seller states delivery by ${v.latest} (${kind} ${req.value})`);
      if (v.earliest > req.value) return result("contradicted", [e.id], `Seller states delivery ${v.earliest === v.latest ? `on ${v.earliest}` : `${v.earliest}–${v.latest}`}, after the ${kind} ${req.value}`);
      return result("unknown", [], `Stated delivery window ${v.earliest}–${v.latest} may end after the ${kind} ${req.value}`);
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
  if (offer.delivery.latest === null && !results.some((r) => r.attribute === "delivery_by")) unknowns.push("delivery date");

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

// ---------- Multivariable recommendations ----------

export type RecommendationKind = "lowest_cost" | "deadline_fit" | "best_overall";

export interface CandidateComparison {
  knownComparableCostCents: number | null;
  totalStatus: PurchaseCost["totalStatus"];
  packagesRequired: number | null;
  unitsCovered: number | null;
  deliveryLatest: string | null;
  deliveryState: "meets" | "late" | "unknown" | "no_deadline";
  mandatorySupported: number;
  mandatoryTotal: number;
  preferencesSupported: number;
  preferencesTotal: number;
  unknownCount: number;
  unknowns: string[];
}

export interface Recommendation {
  offerId: string;
  rank: number;
  kinds: RecommendationKind[];
  reasoning: string[];
  comparison: CandidateComparison;
}

export interface NoncompliantAlternative {
  offerId: string;
  kind: "cheaper_but_late";
  reason: string;
  comparison: CandidateComparison;
}

export interface RecommendationSet {
  recommendations: Recommendation[];
  noncompliantAlternatives: NoncompliantAlternative[];
  notes: string[];
}

function compare(e: CandidateEvaluation, offer: Offer | undefined): CandidateComparison {
  const d = e.requirementResults.find((r) => r.attribute === "delivery_by");
  const mand = e.requirementResults.filter((r) => r.mandatory && r.attribute !== "delivery_by");
  const pref = e.requirementResults.filter((r) => !r.mandatory && r.attribute !== "delivery_by");
  return {
    knownComparableCostCents: e.cost.knownComparableCostCents,
    totalStatus: e.cost.totalStatus,
    packagesRequired: e.cost.packagesRequired,
    unitsCovered: e.cost.packageQuantity && e.cost.packagesRequired ? e.cost.packageQuantity * e.cost.packagesRequired : null,
    deliveryLatest: offer?.delivery.latest ?? null,
    deliveryState: !d ? "no_deadline" : d.state === "supported" ? "meets" : d.state === "contradicted" ? "late" : "unknown",
    mandatorySupported: mand.filter((r) => r.state === "supported").length,
    mandatoryTotal: mand.length,
    preferencesSupported: pref.filter((r) => r.state === "supported").length,
    preferencesTotal: pref.length,
    unknownCount: e.unknowns.length,
    unknowns: e.unknowns,
  };
}

const byCost = (a: CandidateComparison, b: CandidateComparison) => (a.knownComparableCostCents ?? Infinity) - (b.knownComparableCostCents ?? Infinity);
const usd = (c: number | null) => (c === null ? "unknown cost" : formatUsd(c));

/**
 * Distinct alternatives among offers that pass every hard constraint (class "eligible"): lowest
 * known comparable cost, best supported deadline fit, and best overall fit with the reasoning
 * spelled out. Identical winners are merged. Offers that fail only a hard deadline but are cheaper
 * are reported separately as noncompliant alternatives, never as recommendations.
 */
export function recommend(evals: CandidateEvaluation[], offers: Offer[], requirements: Requirement[]): RecommendationSet {
  const offerById = new Map(offers.map((o) => [o.id, o]));
  const deadline = requirements.find((r) => r.attribute === "delivery_by");
  const eligible = evals.filter((e) => e.class === "eligible").map((e) => ({ e, c: compare(e, offerById.get(e.offerId)) }));
  const notes = [`Compared ${evals.length} observed offers from this research run; this is not a claim about prices elsewhere.`];
  const picks = new Map<string, Recommendation>();
  const pick = (x: { e: CandidateEvaluation; c: CandidateComparison }, kind: RecommendationKind, reasoning: string[]) => {
    const existing = picks.get(x.e.offerId);
    if (existing) {
      existing.kinds.push(kind);
      existing.reasoning.push(...reasoning);
    } else picks.set(x.e.offerId, { offerId: x.e.offerId, rank: x.e.rank, kinds: [kind], reasoning: [...reasoning], comparison: x.c });
  };
  const tie = (a: { e: CandidateEvaluation; c: CandidateComparison }, b: { e: CandidateEvaluation; c: CandidateComparison }) =>
    a.c.unknownCount - b.c.unknownCount || (a.e.offerId < b.e.offerId ? -1 : a.e.offerId > b.e.offerId ? 1 : 0);

  if (eligible.length === 0) notes.push("No offer meets every hard constraint with supporting evidence, so nothing is recommended.");

  const priced = eligible.filter((x) => x.c.knownComparableCostCents !== null).sort((a, b) => byCost(a.c, b.c) || tie(a, b));
  if (priced[0]) pick(priced[0], "lowest_cost", [`Lowest known comparable cost among compliant offers: ${usd(priced[0].c.knownComparableCostCents)} (${priced[0].c.totalStatus.replace(/_/g, " ")}; tax unknown)`]);

  if (deadline) {
    const meets = eligible.filter((x) => x.c.deliveryState === "meets").sort((a, b) => (a.c.deliveryLatest! < b.c.deliveryLatest! ? -1 : a.c.deliveryLatest! > b.c.deliveryLatest! ? 1 : 0) || byCost(a.c, b.c) || tie(a, b));
    if (meets[0]) pick(meets[0], "deadline_fit", [`Seller states delivery by ${meets[0].c.deliveryLatest}, before the ${deadline.mandatory ? "hard deadline" : "target date"} ${deadline.value}`]);
    else notes.push(`No compliant offer states delivery by ${deadline.value}; delivery for the others is unknown${deadline.mandatory ? "" : " or late"}.`);
  } else {
    const dated = eligible.filter((x) => x.c.deliveryLatest !== null).sort((a, b) => (a.c.deliveryLatest! < b.c.deliveryLatest! ? -1 : 1) || byCost(a.c, b.c) || tie(a, b));
    if (dated[0]) pick(dated[0], "deadline_fit", [`No deadline set; earliest stated delivery (${dated[0].c.deliveryLatest})`]);
  }

  // Best overall: documented lexicographic order, no opaque score.
  const deliveryRank = { meets: 0, no_deadline: 1, unknown: 1, late: 2 } as const;
  const overall = [...eligible].sort(
    (a, b) =>
      deliveryRank[a.c.deliveryState] - deliveryRank[b.c.deliveryState] ||
      a.c.unknownCount - b.c.unknownCount ||
      b.c.preferencesSupported - a.c.preferencesSupported ||
      byCost(a.c, b.c) ||
      tie(a, b),
  );
  if (overall[0]) {
    const c = overall[0].c;
    pick(overall[0], "best_overall", [
      "Best overall by, in order: delivery fit, fewest unknowns, most preferences met, then lower cost",
      `Delivery: ${c.deliveryState.replace("_", " ")}${c.deliveryLatest ? ` (stated ${c.deliveryLatest})` : ""}; unknowns: ${c.unknownCount}; preferences met: ${c.preferencesSupported}/${c.preferencesTotal}; cost: ${usd(c.knownComparableCostCents)}`,
    ]);
  }

  // Cheaper offers that fail only the hard deadline are shown, but never recommended.
  const cheapestCompliant = priced[0]?.c.knownComparableCostCents ?? Infinity;
  const noncompliantAlternatives: NoncompliantAlternative[] = [];
  if (deadline?.mandatory) {
    for (const e of evals) {
      if (e.class !== "rejected") continue;
      const contradicted = e.requirementResults.filter((r) => r.mandatory && r.state === "contradicted");
      if (contradicted.length !== 1 || contradicted[0]!.attribute !== "delivery_by") continue;
      if (e.affordability === "over_budget" || e.cost.knownComparableCostCents === null || e.cost.knownComparableCostCents >= cheapestCompliant) continue;
      noncompliantAlternatives.push({ offerId: e.offerId, kind: "cheaper_but_late", reason: `${usd(e.cost.knownComparableCostCents)} but ${contradicted[0]!.reason}`, comparison: compare(e, offerById.get(e.offerId)) });
    }
    noncompliantAlternatives.sort((a, b) => byCost(a.comparison, b.comparison));
    noncompliantAlternatives.splice(2);
  }
  return { recommendations: [...picks.values()], noncompliantAlternatives, notes };
}
