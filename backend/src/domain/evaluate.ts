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
  if (req.attribute === "volume") return volumeClaims(chosen, ev);
  return { ...chosen[0]!.r, evidenceIds: chosen.map((v) => v.e.id) };
}

const ozOf = (ml: number) => Math.round((ml / 29.5735) * 10) / 10;

/**
 * Several stated capacities that all agree with the requirement: the lowest is used, and the
 * others are named. Claims more than 10% apart are flagged as conflicting rather than silently
 * picking one ("2L/70 oz" is one size stated two ways; "64 oz / 80 oz" is not).
 */
function volumeClaims(chosen: Array<{ e: Offer["evidence"][number]; r: RequirementResult }>, ev: Offer["evidence"]): RequirementResult {
  const byValue = [...chosen].sort((a, b) => (a.e.value as number) - (b.e.value as number));
  const lowest = byValue[0]!;
  const values = [...new Set(ev.map((e) => e.value as number))].sort((a, b) => a - b);
  if (values.length < 2) return { ...lowest.r, evidenceIds: chosen.map((v) => v.e.id) };
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const sizes = values.map((v) => `${ozOf(v)} fl oz`).join(" vs ");
  const material = (max - min) / min > 0.1;
  const reason = material
    ? `${lowest.r.reason}. Capacity claims conflict (${sizes}); the lower figure is used, confirm the pitcher size`
    : `${lowest.r.reason} (also stated as ${values.filter((v) => v !== (lowest.e.value as number)).map((v) => `${ozOf(v)} fl oz`).join(", ")}; the lower figure is used)`;
  return { ...lowest.r, reason, evidenceIds: byValue.map((v) => v.e.id) };
}

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** "Wed, Oct 28" for a YYYY-MM-DD date. */
const day = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

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
      // With no condition restriction, missing condition evidence cannot disqualify an offer.
      // This confirms the request is unrestricted, not that the listing is demonstrably new.
      if (["new", "refurbished", "used"].every((c) => req.value.includes(c as "new" | "refurbished" | "used"))) {
        return result("supported", [], "Any condition accepted by the requester");
      }
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
      const oz = (ml: number) => Math.round((ml / 29.5735) * 10) / 10;
      return v >= req.value ? result("supported", [e.id], `States ${oz(v)} fl oz (${v} ml)`) : result("contradicted", [e.id], `States ${oz(v)} fl oz, below ${oz(req.value)} fl oz`);
    }
    case "capacity_wh": {
      // Only a stated watt-hour figure counts; output watts are never treated as capacity.
      const e = ev[0];
      if (!e) return result("unknown", [], "No battery capacity in Wh stated");
      const v = e.value as number;
      return v >= req.value ? result("supported", [e.id], `States ${v} Wh`) : result("contradicted", [e.id], `States ${v} Wh, below ${req.value} Wh`);
    }
    case "ac_outlets": {
      const e = ev[0];
      if (!e) return result("unknown", [], "Number of AC outlets not stated");
      const v = e.value as number;
      return v >= req.value ? result("supported", [e.id], `States ${v} AC outlet${v === 1 ? "" : "s"}`) : result("contradicted", [e.id], `States ${v} AC outlet${v === 1 ? "" : "s"}, fewer than ${req.value}`);
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
      if (absent) {
        return result("contradicted", [absent.id], absent.source === "serpapi_immersive_product" ? `Google product specs contradict: ${req.label} (${absent.excerpt.replace(/^Google product specs: /, "")})` : `Listing states it lacks: ${req.label} ("${absent.excerpt.slice(0, 60)}")`);
      }
      const yes = ev.filter((x) => x.value === req.value);
      const where = (x: Offer["evidence"][number]) => (x.source === "serpapi_immersive_product" ? "Google product specs" : "listing text");
      // Legacy features carry no claim strength: any mention counts, as before.
      const strong = yes.find((x) => x.claim === undefined || x.claim === "explicit") ?? yes.find((x) => x.claim === "certification");
      if (strong) {
        if (strong.claim === "certification") return result("supported", [strong.id], `${strong.excerpt.replace(/, as claimed in listing text:.*$/, "")} claimed in ${where(strong)} (not checked with the certifier)`);
        if (strong.claim === "explicit") return result("supported", [strong.id], strong.source === "serpapi_immersive_product" ? `${strong.excerpt}` : `Listing states it: "${strong.excerpt.slice(0, 80)}"`);
        return result("supported", [strong.id], strong.source === "serpapi_immersive_product" ? `Product specs mention: ${req.label}` : `Listing mentions: ${req.label}`);
      }
      // A keyword or marketing phrase is recorded but never confirms the requirement on its own.
      const marketing = yes.find((x) => x.claim === "marketing");
      const keyword = yes.find((x) => x.claim === "keyword");
      const lookedUp = offer.details.status === "fetched" ? "; product specs do not confirm it either" : "; no product spec or explicit statement confirms it";
      if (marketing) return result("unknown", [marketing.id], `"${marketing.excerpt.slice(0, 60)}" is marketing wording, not ${req.label.charAt(0).toLowerCase()}${req.label.slice(1)}${lookedUp}`);
      if (keyword) return result("unknown", [keyword.id], `Seller's title uses the word only ("${keyword.excerpt.slice(0, 60)}")${lookedUp}`);
      return result("unknown", [], offer.details.status === "fetched" ? `Neither listing nor product specs mention: ${req.label}` : `Listing does not mention: ${req.label}`);
    }
    case "delivery_by": {
      // Google Shopping delivery text is Google's estimate. Without a delivery location it is not an
      // arrival date for this customer, so it informs risk but cannot pass or fail the deadline. With
      // a stated search location it can pass or fail the check, but it stays an estimate: the risk is
      // never "none" and the reason says so. Only a date the requester confirmed carries no risk.
      const e = ev[ev.length - 1];
      const kind = req.mandatory ? "hard deadline" : "target date";
      const dl = day(req.value);
      const risky = (state: RequirementResult["state"], ids: string[], reason: string, deadlineRisk: NonNullable<RequirementResult["deadlineRisk"]>) => ({ ...result(state, ids, reason), deadlineRisk });
      if (!e) return risky("unknown", [], `No delivery date in the retained listing data (${kind} ${dl})`, "no_date");
      const v = e.value as { earliest: string; latest: string };
      const estimate = e.source !== "user";
      const location = offer.delivery.location ?? null;
      const checkable = !estimate || !!location;
      const who = !estimate ? "You confirmed delivery" : location ? `Google Shopping estimates delivery to ${location} (an estimate, not a guaranteed arrival)` : "Google Shopping estimates delivery (no delivery location set, so not confirmed for your address)";
      const when = v.earliest === v.latest ? day(v.latest) : `${day(v.earliest)}–${day(v.latest)}`;
      if (v.latest < req.value) return risky(checkable ? "supported" : "unknown", [e.id], `${who} by ${when}, before the ${kind} ${dl}`, estimate ? "estimate_only" : "none");
      if (v.latest === req.value) return risky(checkable ? "supported" : "unknown", [e.id], `${who} by ${when}: the same day as the ${kind}, with no margin`, "on_deadline");
      if (v.earliest > req.value) return risky(checkable ? "contradicted" : "unknown", [e.id], `${who} ${when}, after the ${kind} ${dl}`, "late_estimate");
      return risky("unknown", [e.id], `${who} ${when}, which may end after the ${kind} ${dl}`, "late_estimate");
    }
  }
}

const flOz = (ml: number) => Math.round((ml / 29.5735) * 10) / 10;

export function calculatePurchaseCost(offer: Offer, requestedQuantity: number, opts: { requiredMl?: number | null } = {}): PurchaseCost {
  const notes: string[] = [];
  const priceUsable = offer.listedPriceCents !== null && offer.priceBasis === "one_time" && offer.currency === "USD";
  const packQty = offer.packageQuantity;
  let packagesRequired: number | null;
  let volume: PurchaseCost["volume"] = null;
  if (opts.requiredMl) {
    // The order is a total volume: cover it with whole packages of the stated volume (a 2-pack of 64 fl oz = 128 fl oz).
    const each = offer.evidence.find((e) => e.attribute === "volume")?.value as number | undefined;
    const perPackageMl = each && packQty ? each * packQty : null;
    // Volumes are stored as whole ml, so 4 × 32 fl oz (946 ml each) can read 1 ml short of 128 fl oz.
    // A 0.2% tolerance absorbs that rounding; it is far below a single container.
    const target = opts.requiredMl * 0.998;
    packagesRequired = perPackageMl ? Math.ceil(target / perPackageMl) : null;
    // Purchased and excess volume are computed from each package's stated size in fl oz (to 0.1), so
    // ml rounding never shows up as a phantom 0.2 fl oz.
    const perOz = perPackageMl ? flOz(perPackageMl) : null;
    const purchasedOz = perOz !== null && packagesRequired ? Math.round(perOz * packagesRequired * 10) / 10 : null;
    const excessOz = purchasedOz === null ? null : Math.max(0, Math.round((purchasedOz - flOz(opts.requiredMl)) * 10) / 10);
    volume = {
      requiredMl: opts.requiredMl,
      perPackageMl,
      purchasedMl: purchasedOz === null ? null : Math.round(purchasedOz * 29.5735),
      excessMl: excessOz === null ? null : Math.round(excessOz * 29.5735),
    };
    if (perPackageMl === null) notes.push(`Package volume is not stated in fluid units, so it cannot be verified to cover ${flOz(opts.requiredMl)} US fl oz`);
    else notes.push(`${packagesRequired} × ${perOz} fl oz = ${purchasedOz} fl oz for ${flOz(opts.requiredMl)} fl oz needed${excessOz! > 0 ? ` (${excessOz} fl oz extra)` : ""}`);
  } else {
    packagesRequired = packQty ? Math.ceil(requestedQuantity / packQty) : null;
    if (packQty && packQty > 1) notes.push(`Listing is a ${packQty}-pack; ${packagesRequired} package(s) needed for ${requestedQuantity}`);
    if (packQty && packagesRequired && packQty * packagesRequired > requestedQuantity) notes.push(`Buying ${packQty * packagesRequired} units to cover ${requestedQuantity}`);
  }
  const unit = priceUsable ? offer.listedPriceCents : null;
  const subtotal = unit !== null && packagesRequired !== null ? multiplyCents(unit, packagesRequired) : null;
  let shippingCents = offer.shipping.status === "known" && packagesRequired !== null ? offer.shipping.cents : null;
  const threshold = offer.shipping.freeOverCents;
  if (offer.shipping.status === "unknown" && threshold && subtotal !== null) {
    if (subtotal >= threshold) {
      shippingCents = 0;
      notes.push(`Free shipping applies to orders of ${formatUsd(threshold)}+; this ${formatUsd(subtotal)} subtotal qualifies (per listing text)`);
    } else notes.push(`Free shipping only on orders of ${formatUsd(threshold)}+; this ${formatUsd(subtotal)} subtotal does not qualify, so shipping is unknown`);
  }
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
    volume,
  };
}

const GAP_LABEL: Record<string, string> = {
  product_type: "item type unconfirmed",
  volume: "capacity unconfirmed",
  feature: "unconfirmed",
  brand: "brand unconfirmed",
};

/**
 * Plain review summary for an offer with no confirmed failure: which specs are confirmed, what
 * still has to be confirmed, and the delivery-deadline risk, most decisive first. Unknown facts are
 * named as unconfirmed, never as failures.
 */
export function reviewSummary(results: RequirementResult[], cost: PurchaseCost, offer: Offer): string[] {
  const unknown = results.filter((r) => r.mandatory && r.state === "unknown");
  const specGaps = unknown.filter((r) => r.attribute !== "condition" && r.attribute !== "delivery_by");
  const parts: string[] = [];
  if (specGaps.length === 0) parts.push("Specs match");
  for (const r of specGaps) parts.push(r.attribute === "feature" ? `${featureLabel(r)} unconfirmed` : GAP_LABEL[r.attribute] ?? `${r.attribute.replace(/_/g, " ")} unconfirmed`);
  if (unknown.some((r) => r.attribute === "condition")) parts.push("confirm new condition");
  const d = results.find((r) => r.attribute === "delivery_by");
  const risk = d?.deadlineRisk;
  const hard = d?.mandatory;
  if (d && d.state !== "supported") {
    if (risk === "no_date") parts.push(hard ? "no delivery date for the hard deadline" : "no delivery date");
    else if (risk === "late_estimate") parts.push("delivery estimate is after the deadline");
    else if (risk === "on_deadline") parts.push("delivery estimate lands on the deadline day");
    else if (risk === "estimate_only") parts.push("delivery is a Google estimate (location not set)");
  } else if (risk === "on_deadline") parts.push("arrives on the deadline day, no margin");
  if (cost.listedSubtotalCents === null) parts.push("cost for requested quantity unknown");
  parts.push(...offer.needsReviewReasons);
  return parts;
}

const featureLabel = (r: RequirementResult) => (r.requirementId.replace(/^req_feature_/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

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
  if (cost.shippingCents === null) unknowns.push("shipping cost");
  unknowns.push("sales tax");
  unknowns.push(...offer.needsReviewReasons);
  if (offer.availability.status === "unknown") unknowns.push("availability");
  // One listing does not show that several units are in stock.
  if (!cost.volume && cost.requestedQuantity > 1) unknowns.push(`stock for ${cost.requestedQuantity} units not confirmed by the seller`);
  if (cost.volume && cost.volume.perPackageMl === null) unknowns.push("package volume (fluid ounces) not stated");
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
    return { class: "needs_review", affordability, unknowns, reason: `Needs review: ${reviewSummary(results, cost, offer).join(" · ")}` };
  }
  const d = results.find((r) => r.attribute === "delivery_by");
  const estimateNote = d && d.state === "supported" && d.deadlineRisk && d.deadlineRisk !== "none" ? `; delivery date is a Google estimate${d.deadlineRisk === "on_deadline" ? " on the deadline day, with no margin" : ""}` : "";
  return { class: "eligible", affordability, unknowns, reason: `All mandatory requirements supported by listing evidence; provisional cost ${formatUsd(cost.knownComparableCostCents!)} (tax unknown)${estimateNote}` };
}

const CLASS_ORDER = { eligible: 0, needs_review: 1, rejected: 2 } as const;
const RISK_LEVEL = { none: 0, estimate_only: 1, on_deadline: 2, late_estimate: 3, no_date: 4 } as const;

type Ranked = Pick<CandidateEvaluation, "requirementResults">;
const specGaps = (x: Ranked) => x.requirementResults.filter((r) => r.mandatory && r.state !== "supported" && r.attribute !== "condition" && r.attribute !== "delivery_by").length;
const conditionGap = (x: Ranked) => (x.requirementResults.some((r) => r.mandatory && r.attribute === "condition" && r.state !== "supported") ? 1 : 0);
/** Only a hard deadline carries risk in ranking; a target date is a preference. */
export function deadlineRiskLevel(x: Ranked): number {
  const d = x.requirementResults.find((r) => r.attribute === "delivery_by");
  if (!d || !d.mandatory) return 0;
  if (d.deadlineRisk) return RISK_LEVEL[d.deadlineRisk];
  return d.state === "supported" ? 0 : 4;
}

/** Stable, reproducible ranking. Inputs are not mutated. */
export function rankCandidates(evals: Array<Omit<CandidateEvaluation, "rank">>, priority: RankingPriority = "lowest_known_total"): CandidateEvaluation[] {
  const sorted = [...evals].sort((a, b) => {
    const c = CLASS_ORDER[a.class] - CLASS_ORDER[b.class];
    if (c !== 0) return c;
    const aff = (x: typeof a) => (x.affordability === "within_budget_provisional" ? 0 : x.affordability === "unknown" ? 1 : 2);
    const af = aff(a) - aff(b);
    if (af !== 0) return af;
    // Among uncertain options, in order: fewer unconfirmed specs, then lower hard-deadline risk, then
    // condition evidence, before price. A deadline risk outranks a missing condition statement.
    if (a.class === "needs_review") {
      const gap = specGaps(a) - specGaps(b) || deadlineRiskLevel(a) - deadlineRiskLevel(b) || conditionGap(a) - conditionGap(b);
      if (gap !== 0) return gap;
    }
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

export function evaluateCandidates(offers: Offer[], requirements: Requirement[], quantity: number, budgetCents: number, priority: RankingPriority = "lowest_known_total", opts: { requiredMl?: number | null } = {}): CandidateEvaluation[] {
  const evals = offers.map((offer) => {
    const requirementResults = requirements.map((r) => evaluateRequirement(r, offer));
    const cost = calculatePurchaseCost(offer, quantity, opts);
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
    if (meets[0]) pick(meets[0], "deadline_fit", [meets[0].e.requirementResults.find((r) => r.attribute === "delivery_by")?.reason ?? `Delivery by ${meets[0].c.deliveryLatest}`]);
    else notes.push(`No compliant offer has a confirmed delivery by ${deadline.value}; delivery for the others is unknown or only a Google estimate.`);
  } else {
    const dated = eligible.filter((x) => x.c.deliveryLatest !== null).sort((a, b) => (a.c.deliveryLatest! < b.c.deliveryLatest! ? -1 : 1) || byCost(a.c, b.c) || tie(a, b));
    if (dated[0]) pick(dated[0], "deadline_fit", [`No deadline set; earliest stated delivery (${dated[0].c.deliveryLatest})`]);
  }

  // Best overall: documented lexicographic order, no opaque score.
  const deliveryRank = { meets: 0, no_deadline: 1, unknown: 1, late: 2 } as const;
  // For a total-volume order, fewer containers to handle is better when everything above is equal.
  const fewerPackages = (x: CandidateEvaluation, y: CandidateEvaluation) =>
    x.cost.volume && y.cost.volume ? (x.cost.packagesRequired ?? Infinity) - (y.cost.packagesRequired ?? Infinity) : 0;
  const overall = [...eligible].sort(
    (a, b) =>
      deliveryRank[a.c.deliveryState] - deliveryRank[b.c.deliveryState] ||
      a.c.unknownCount - b.c.unknownCount ||
      b.c.preferencesSupported - a.c.preferencesSupported ||
      fewerPackages(a.e, b.e) ||
      byCost(a.c, b.c) ||
      tie(a, b),
  );
  if (overall[0]) {
    const c = overall[0].c;
    pick(overall[0], "best_overall", [
      "Best overall by, in order: delivery fit, fewest unknowns, most preferences met, fewer containers (volume orders), then lower cost",
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
