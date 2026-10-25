// A small, deterministic shortlist of meaningfully different options, with labels and factual
// explanations generated from the request's own requirements and each candidate's evidence.
// Shared by every sector (and general search): no category-specific tradeoffs are hardcoded.
// Prices, differences, units and dates are computed here; a model may only reword them.
import type { CandidateEvaluation, Offer, Requirement, RequirementResult } from "./types.js";
import { formatUsd } from "./money.js";
import { deadlineRiskLevel } from "./evaluate.js";
import { getCategory, withArticle } from "./categories.js";

export type ShortlistRole =
  | "closest_match"
  | "lowest_cost"
  | "spec_advantage"
  | "delivery_evidence"
  | "fewer_packages"
  | "stretch_budget"
  | "another_match"
  | "cheaper_compromise";

export type Compliance = "meets_all" | "unconfirmed" | "over_budget" | "fails_must_have";

export interface ShortlistEntry {
  offerId: string;
  rank: number;
  role: ShortlistRole;
  /** Prominent 1–5 word label. */
  label: string;
  /** Short factual status ("Meets checked requirements", "Over budget by $35.00"). */
  status: string;
  compliance: Compliance;
  /** Why this option is worth considering, compared with the others. */
  explanation: string;
  /** Its main drawback or compromise. */
  compromise: string;
  /** Important facts that remain unverified. */
  unverified: string[];
  /** Who wrote the label and sentences: deterministic code, or the research model (validated). */
  source: "deterministic" | "model";
  /** Numbers the backend computed for this entry; the only figures an explanation may use. */
  facts: ShortlistFacts;
}

export interface ShortlistFacts {
  title: string;
  seller: string | null;
  knownCostCents: number | null;
  costBasis: string;
  budgetCents: number;
  overBudgetCents: number | null;
  /** Signed difference from the closest match's known cost; null when either is unknown. */
  costVsClosestCents: number | null;
  mustHaves: Array<{ requirement: string; state: RequirementResult["state"]; reason: string }>;
  advantages: string[];
  drawbacks: string[];
}

export interface Shortlist {
  /** Shown above the shortlist when no option meets every must-have with confirmed evidence. */
  headline: string | null;
  entries: ShortlistEntry[];
  /** Everything else, in ranking order, for "More options". */
  moreOfferIds: string[];
  /** Request specifications the backend cannot check automatically (general search). */
  notEvaluated: string[];
  /** Near-duplicate offers folded into a shortlisted option (same product, no meaningful difference). */
  folded: Array<{ offerId: string; into: string }>;
}

export interface ShortlistInput {
  evals: CandidateEvaluation[];
  offers: Offer[];
  requirements: Requirement[];
  budgetCents: number;
  categoryId: string | null;
}

const MAX_ENTRIES = 4;
const ozOf = (ml: number) => Math.round((ml / 29.5735) * 10) / 10;
const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));
const PORT: Record<string, string> = { hdmi: "HDMI", displayport: "DisplayPort", usb_c: "USB-C", thunderbolt: "Thunderbolt", vga: "VGA", dvi: "DVI" };

/** Plain description of a requirement from its own values ("at least 64 fl oz", "500+ Wh"). */
export function describeRequirement(r: Requirement): string {
  const v = r.value as never;
  switch (r.attribute) {
    case "product_type":
      return withArticle(getCategory(String(v))?.label ?? String(v));
    case "volume":
      return `at least ${ozOf(v)} fl oz`;
    case "capacity_wh":
      return `at least ${v} Wh`;
    case "ac_outlets":
      return `at least ${v} AC outlets`;
    case "screen_size": {
      const { min, max } = v as { min: number; max: number };
      return max >= 100 ? `${min}" or larger screen` : `${min}–${max}" screen`;
    }
    case "resolution":
      return `${(v as { width: number }).width}×${(v as { height: number }).height} or better`;
    case "refresh_rate":
      return `${v} Hz or faster`;
    case "port":
      return PORT[v] ?? String(v);
    case "feature":
      return (r as { label?: string }).label?.toLowerCase() ?? String(v);
    case "condition":
      return (v as string[]).length === 3 ? "any condition" : `${(v as string[]).join(" or ")} condition`;
    case "brand":
      return `brand ${(v as string[]).join(" or ")}`;
    case "delivery_by":
      return `delivery by ${day(v)}`;
    default:
      return r.attribute.replace(/_/g, " ");
  }
}

/** Short status for one failed requirement ("Below required capacity"). */
function failureStatus(r: RequirementResult, offer: Offer | undefined, req: Requirement | undefined): string {
  switch (r.attribute) {
    case "volume":
    case "capacity_wh":
      return "Below required capacity";
    case "ac_outlets":
      return "Too few AC outlets";
    case "screen_size":
      return "Screen size outside range";
    case "resolution":
      return "Below required resolution";
    case "refresh_rate":
      return "Below required refresh rate";
    case "port":
      return `No ${PORT[String(req?.value)] ?? "required"} port`;
    case "condition":
      return offer?.condition ? `Listed as ${offer.condition}` : "Wrong condition";
    case "delivery_by":
      return "Arrives after the deadline";
    case "product_type":
      return "Not the requested item";
    case "feature":
      return `Lacks ${req ? describeRequirement(req) : "a must-have"}`;
    default:
      return `Fails ${r.attribute.replace(/_/g, " ")}`;
  }
}

const GAP_STATUS: Record<string, string> = {
  volume: "Capacity unconfirmed",
  capacity_wh: "Capacity unconfirmed",
  ac_outlets: "Outlets unconfirmed",
  screen_size: "Screen size unconfirmed",
  resolution: "Resolution unconfirmed",
  refresh_rate: "Refresh rate unconfirmed",
  port: "Port unconfirmed",
  product_type: "Item type unconfirmed",
  brand: "Brand unconfirmed",
};

interface Cand {
  e: CandidateEvaluation;
  o: Offer;
  failed: RequirementResult[];
  specGaps: RequirementResult[];
  risk: number;
  conditionGap: boolean;
  cost: number | null;
  compliance: Compliance;
}

function analyze(e: CandidateEvaluation, o: Offer, budgetCents: number): Cand {
  const failed = e.requirementResults.filter((r) => r.mandatory && r.state === "contradicted");
  const specGaps = e.requirementResults.filter((r) => r.mandatory && r.state === "unknown" && r.attribute !== "condition" && r.attribute !== "delivery_by");
  const cost = e.cost.knownComparableCostCents;
  const over = cost !== null && cost > budgetCents;
  const compliance: Compliance = failed.length ? "fails_must_have" : over ? "over_budget" : e.class === "eligible" ? "meets_all" : "unconfirmed";
  return {
    e,
    o,
    failed,
    specGaps,
    risk: deadlineRiskLevel(e),
    conditionGap: e.requirementResults.some((r) => r.mandatory && r.attribute === "condition" && r.state === "unknown"),
    cost,
    compliance,
  };
}

/** Numeric spec values this offer states, by attribute (the lowest claim when several are stated). */
function specValue(c: Cand, attribute: string): number | null {
  const r = c.e.requirementResults.find((x) => x.attribute === attribute && x.state === "supported");
  if (!r) return null;
  const vals = c.o.evidence.filter((ev) => r.evidenceIds.includes(ev.id) && typeof ev.value === "number").map((ev) => ev.value as number);
  return vals.length ? Math.min(...vals) : null;
}

// A spec advantage must be meaningful: counts must be strictly larger, measured values at least 5% larger
// (68 against 67.6 fl oz is the same pitcher size, not an advantage).
const SPEC_ADVANTAGE: Record<string, { label: string; unit: (n: number) => string; count?: boolean }> = {
  capacity_wh: { label: "More battery capacity", unit: (n) => `${n} Wh` },
  ac_outlets: { label: "More AC outlets", unit: (n) => `${n} AC outlets`, count: true },
  volume: { label: "Larger capacity", unit: (n) => `${ozOf(n)} fl oz` },
  refresh_rate: { label: "Higher refresh rate", unit: (n) => `${n} Hz` },
  screen_size: { label: "Larger screen", unit: (n) => `${n}"` },
};
const clearlyMore = (attribute: string, value: number | null, than: number) => value !== null && (SPEC_ADVANTAGE[attribute]?.count ? value > than : value >= than * 1.05);

const meaningfulCostGap = (a: number, b: number) => Math.abs(a - b) >= Math.max(500, Math.round(Math.min(a, b) * 0.05));

function statusOf(c: Cand, reqs: Map<string, Requirement>, budgetCents: number): string {
  if (c.failed.length) return failureStatus(c.failed[0]!, c.o, reqs.get(c.failed[0]!.requirementId));
  if (c.compliance === "over_budget") return `Over budget by ${formatUsd(c.cost! - budgetCents)}`;
  if (c.compliance === "meets_all") return c.risk >= 2 ? "Meets requirements, no deadline margin" : "Meets checked requirements";
  const gap = c.specGaps[0];
  if (gap) return gap.attribute === "feature" ? `${shortName(gap, reqs)} unconfirmed` : GAP_STATUS[gap.attribute] ?? `${capital(gap.attribute.replace(/_/g, " "))} unconfirmed`;
  if (c.risk >= 4) return "Delivery unconfirmed";
  if (c.risk === 3) return "Delivery estimate late";
  if (c.risk === 2) return "Estimate on deadline day";
  if (c.risk === 1) return "Delivery estimate only";
  if (c.conditionGap) return "Confirm new condition";
  return "Needs review";
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Short name for a requirement in statuses: a feature by its id ("Commercial use"), others by description. */
function shortName(r: RequirementResult, reqs: Map<string, Requirement>): string {
  if (r.attribute === "feature") return capital(r.requirementId.replace(/^req_feature_/, "").replace(/_/g, " "));
  return capital(describeRequirement(reqs.get(r.requirementId)!));
}

function costBasis(e: CandidateEvaluation): string {
  const s = e.cost.totalStatus;
  if (s === "price_unknown") return "price unknown";
  if (s === "listed_subtotal_only") return "listed price only; shipping and tax unknown";
  return "listed price plus stated shipping; tax unknown";
}

/** Short reasons for what remains unverified, most decisive first. */
function unverifiedOf(c: Cand, reqs: Map<string, Requirement>): string[] {
  const out: string[] = [];
  for (const r of c.specGaps) out.push(`${shortName(r, reqs)}: ${r.reason}`);
  const d = c.e.requirementResults.find((r) => r.attribute === "delivery_by");
  if (d && d.state !== "supported") out.push(d.reason);
  if (c.conditionGap) out.push("New condition is not stated by the listing");
  if (c.e.cost.shippingCents === null && c.e.cost.listedSubtotalCents !== null) out.push("Shipping cost");
  out.push("Sales tax");
  if (c.o.availability.status === "unknown") out.push("Stock");
  return out.slice(0, 5);
}

function confirmedList(c: Cand, reqs: Map<string, Requirement>): string[] {
  return c.e.requirementResults
    .filter((r) => r.mandatory && r.state === "supported" && r.attribute !== "product_type" && r.attribute !== "condition" && r.attribute !== "delivery_by")
    .map((r) => describeRequirement(reqs.get(r.requirementId)!));
}

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function compromiseOf(c: Cand, reqs: Map<string, Requirement>, budgetCents: number): string {
  if (c.failed.length) return `${c.failed.map((r) => r.reason).join("; ")}. It does not meet the request as written.`;
  if (c.compliance === "over_budget") return `Exceeds your ${formatUsd(budgetCents)} budget by ${formatUsd(c.cost! - budgetCents)}; it cannot be approved within this budget.`;
  const parts: string[] = [];
  if (c.specGaps.length) parts.push(`${join(c.specGaps.map((r) => shortName(r, reqs)))} not confirmed`);
  const d = c.e.requirementResults.find((r) => r.attribute === "delivery_by");
  const loc = c.o.delivery.location;
  if (d && d.mandatory && c.risk >= 1)
    parts.push(
      c.risk >= 4
        ? "no delivery date in the listing data"
        : c.risk === 3
          ? "Google's delivery estimate is after your deadline"
          : c.risk === 2
            ? "Google's delivery estimate lands on your deadline day"
            : loc
              ? `the delivery date is Google's estimate for ${loc}, not a guaranteed arrival`
              : "delivery is a Google estimate, not confirmed for your address",
    );
  if (c.conditionGap) parts.push("new condition remains unconfirmed");
  const totals = c.e.cost.shippingCents === null ? "Shipping and tax are unknown, so the final total is not known." : "Tax is unknown, so the final total is not known.";
  if (!parts.length) return totals;
  if (c.compliance === "meets_all") return `${capital(parts.join("; "))}. ${totals}`;
  return `${capital(parts.join("; "))}.`;
}

/**
 * Pick up to four meaningfully different options. Order of roles: closest match, lowest-cost
 * alternative, a spec or package advantage taken from the request's own numeric requirements,
 * stronger delivery evidence, a stretch-budget option, and a cheaper option that fails a must-have
 * (clearly labelled as a compromise). A role is filled only when a candidate genuinely differs;
 * one offer appears once, with its strongest role.
 */
export function buildShortlist(input: ShortlistInput): Shortlist {
  const { evals, offers, requirements, budgetCents } = input;
  const byId = new Map(offers.map((o) => [o.id, o]));
  const reqs = new Map(requirements.map((r) => [r.id, r]));
  const all = evals.flatMap((e) => (byId.has(e.offerId) ? [analyze(e, byId.get(e.offerId)!, budgetCents)] : []));
  const profile = getCategory(input.categoryId);
  const notEvaluated = profile && !profile.searchTerm ? ["The specifications in your request description: general search has no automatic checks, so a person must compare each listing against them"] : [];

  // Near-duplicates: the same product from several sellers is one option unless price, delivery,
  // condition or stock differ meaningfully. The better-ranked offer represents the product.
  const folded: Shortlist["folded"] = [];
  const reps: Cand[] = [];
  for (const c of all) {
    const twin = reps.find(
      (r) =>
        r.o.productKey &&
        r.o.productKey === c.o.productKey &&
        r.compliance === c.compliance &&
        r.risk === c.risk &&
        r.o.condition === c.o.condition &&
        r.o.availability.status === c.o.availability.status &&
        !(r.cost !== null && c.cost !== null && meaningfulCostGap(r.cost, c.cost)),
    );
    if (twin) folded.push({ offerId: c.e.offerId, into: twin.e.offerId });
    else reps.push(c);
  }

  const usable = reps.filter((c) => c.compliance === "meets_all" || c.compliance === "unconfirmed");
  const picks: Array<{ c: Cand; role: ShortlistRole; label: string; advantage: string[] }> = [];
  const taken = (c: Cand) => picks.some((p) => p.c.e.offerId === c.e.offerId);
  const add = (c: Cand | undefined, role: ShortlistRole, label: string, advantage: string[] = []) => {
    if (!c || taken(c) || picks.length >= MAX_ENTRIES) return;
    picks.push({ c, role, label, advantage });
  };

  const closest = usable[0];
  if (closest) add(closest, "closest_match", closest.compliance === "meets_all" ? "Closest match" : "Closest match so far");

  // Lowest-cost alternative: no failed must-have, within budget, meaningfully cheaper, and not
  // weaker on confirmed specs than the closest match by more than one unconfirmed item.
  if (closest) {
    const cheaper = usable
      .filter((c) => c !== closest && c.cost !== null && closest.cost !== null && c.cost < closest.cost && meaningfulCostGap(c.cost, closest.cost) && c.specGaps.length <= closest.specGaps.length + 1)
      .sort((a, b) => a.cost! - b.cost! || a.e.rank - b.e.rank)[0];
    if (cheaper) add(cheaper, "lowest_cost", "Lowest-cost alternative", [`Costs ${formatUsd(closest.cost! - cheaper.cost!)} less than the closest match`]);
  } else {
    const cheapest = usable.filter((c) => c.cost !== null).sort((a, b) => a.cost! - b.cost!)[0];
    add(cheapest, "lowest_cost", "Lowest-cost option");
  }

  // Spec advantage: a numeric requirement this request actually has, where another usable offer
  // states a strictly larger value than the closest match.
  if (closest) {
    for (const r of requirements.filter((x) => x.mandatory && SPEC_ADVANTAGE[x.attribute])) {
      const mine = specValue(closest, r.attribute);
      if (mine === null) continue;
      const better = usable
        .filter((c) => !taken(c) && clearlyMore(r.attribute, specValue(c, r.attribute), mine) && c.specGaps.length <= closest.specGaps.length)
        .sort((a, b) => specValue(b, r.attribute)! - specValue(a, r.attribute)! || (a.cost ?? Infinity) - (b.cost ?? Infinity))[0];
      if (!better) continue;
      const adv = SPEC_ADVANTAGE[r.attribute]!;
      const diff = better.cost !== null && closest.cost !== null ? better.cost - closest.cost : null;
      add(better, "spec_advantage", adv.label, [
        `States ${adv.unit(specValue(better, r.attribute)!)} against ${adv.unit(mine)} for the closest match`,
        ...(diff !== null && diff !== 0 ? [`Costs ${formatUsd(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than the closest match`] : []),
      ]);
      break;
    }
    // Volume orders: fewer containers to cover the same amount.
    if (closest.e.cost.volume && closest.e.cost.packagesRequired) {
      const fewer = usable
        .filter((c) => !taken(c) && c.e.cost.volume && c.e.cost.packagesRequired !== null && c.e.cost.packagesRequired < closest.e.cost.packagesRequired! && c.specGaps.length <= closest.specGaps.length)
        .sort((a, b) => a.e.cost.packagesRequired! - b.e.cost.packagesRequired! || (a.cost ?? Infinity) - (b.cost ?? Infinity))[0];
      if (fewer) add(fewer, "fewer_packages", "Fewer containers", [`${fewer.e.cost.packagesRequired} containers instead of ${closest.e.cost.packagesRequired} for the same amount`]);
    }
  }

  // Stronger delivery evidence than the closest match, against a hard deadline.
  if (closest && closest.risk > 0) {
    const sooner = usable.filter((c) => !taken(c) && c.risk < closest.risk && c.specGaps.length <= closest.specGaps.length + 1).sort((a, b) => a.risk - b.risk || a.e.rank - b.e.rank)[0];
    if (sooner) {
      const d = sooner.e.requirementResults.find((r) => r.attribute === "delivery_by");
      add(sooner, "delivery_evidence", "Stronger delivery evidence", d ? [d.reason] : []);
    }
  }

  // Stretch budget: meets or nearly meets the specs, only the budget is exceeded (by at most 25%).
  const stretch = reps
    .filter((c) => c.compliance === "over_budget" && c.specGaps.length <= (closest?.specGaps.length ?? 0) && c.cost! - budgetCents <= budgetCents * 0.25)
    .sort((a, b) => a.cost! - b.cost!)[0];
  add(stretch, "stretch_budget", "Stretch-budget option", stretch ? [`Over your budget by ${formatUsd(stretch.cost! - budgetCents)}`] : []);

  // Another product that also meets every checked requirement: a real backup when the closest match
  // falls through (stock, seller), described by how it differs.
  if (closest?.compliance === "meets_all") {
    const other = usable.find((c) => !taken(c) && c.compliance === "meets_all");
    if (other) {
      const diff = other.cost !== null && closest.cost !== null ? other.cost - closest.cost : null;
      const packs = other.e.cost.volume && other.e.cost.packagesRequired && closest.e.cost.packagesRequired && other.e.cost.packagesRequired !== closest.e.cost.packagesRequired ? [`${other.e.cost.packagesRequired} containers instead of ${closest.e.cost.packagesRequired}`] : [];
      add(other, "another_match", "Another full match", [...(diff ? [`Costs ${formatUsd(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than the closest match`] : []), ...packs]);
    }
  }

  // A cheaper option that fails exactly one must-have is shown as an explicit compromise: the
  // nearest miss first (48 oz against 64 oz before 20 oz), then the cheaper.
  const ref = closest?.cost ?? null;
  const compromise = reps
    .filter((c) => c.compliance === "fails_must_have" && c.failed.length === 1 && c.cost !== null && c.cost <= budgetCents && (ref === null || (c.cost < ref && meaningfulCostGap(c.cost, ref))) && c.failed[0]!.attribute !== "product_type")
    .sort((a, b) => a.specGaps.length - b.specGaps.length || nearness(b, reqs) - nearness(a, reqs) || a.cost! - b.cost!)[0];
  if (compromise) add(compromise, "cheaper_compromise", "Cheaper, misses a must-have", ref !== null ? [`Costs ${formatUsd(ref - compromise.cost!)} less than the closest match`] : []);

  const entries: ShortlistEntry[] = picks.map(({ c, role, label, advantage }) => {
    const costVsClosest = closest && c !== closest && c.cost !== null && closest.cost !== null ? c.cost - closest.cost : null;
    const confirmed = confirmedList(c, reqs);
    const why =
      c.compliance === "fails_must_have"
        ? `${advantage.join(". ") || "A cheaper option"}, but ${lower(c.failed[0]!.reason)}.`
        : [
            confirmed.length ? `Confirmed: ${join(confirmed)}` : notEvaluated.length ? "Matches the item you searched for; its specifications need a manual check" : "",
            ...advantage,
            ...c.e.cost.notes.filter((n) => /fl oz/.test(n)),
            c.cost !== null ? `Known cost ${formatUsd(c.cost)} (${costBasis(c.e)})` : "Price for your quantity is unknown",
          ]
            .filter(Boolean)
            .join(". ") + ".";
    return {
      offerId: c.e.offerId,
      rank: c.e.rank,
      role,
      label,
      status: statusOf(c, reqs, budgetCents),
      compliance: c.compliance,
      explanation: why,
      compromise: compromiseOf(c, reqs, budgetCents),
      unverified: unverifiedOf(c, reqs),
      source: "deterministic",
      facts: {
        title: c.o.title,
        seller: c.o.seller,
        knownCostCents: c.cost,
        costBasis: costBasis(c.e),
        budgetCents,
        overBudgetCents: c.cost !== null && c.cost > budgetCents ? c.cost - budgetCents : null,
        costVsClosestCents: costVsClosest,
        mustHaves: c.e.requirementResults.filter((r) => r.mandatory).map((r) => ({ requirement: describeRequirement(reqs.get(r.requirementId)!), state: r.state, reason: r.reason })),
        advantages: advantage,
        drawbacks: [compromiseOf(c, reqs, budgetCents)],
      },
    };
  });

  const shortlisted = new Set(entries.map((x) => x.offerId));
  const anyMeetsAll = all.some((c) => c.compliance === "meets_all");
  const headline = anyMeetsAll
    ? null
    : usable.length
      ? "No option meets every must-have with confirmed evidence yet. Each option below names what still needs checking."
      : "No option meets your must-haves. The options below are compromises and can't be proposed as they are.";
  return { headline, entries, moreOfferIds: evals.map((e) => e.offerId).filter((id) => !shortlisted.has(id)), notEvaluated, folded };
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** How close a failed numeric must-have comes to the requirement (stated ÷ required, at most 1); 0 otherwise. */
function nearness(c: Cand, reqs: Map<string, Requirement>): number {
  const f = c.failed[0];
  if (!f) return 0;
  const req = reqs.get(f.requirementId);
  const stated = c.o.evidence.filter((ev) => f.evidenceIds.includes(ev.id) && typeof ev.value === "number").map((ev) => ev.value as number);
  if (!req || !stated.length || typeof req.value !== "number" || req.value <= 0) return 0;
  return Math.min(1, Math.max(...stated) / req.value);
}
