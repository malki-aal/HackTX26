// Regression tests from the saved live café-blender run (trimmed SerpApi responses, no new searches).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeOffer, applyProductDetails, featureClaims } from "../src/domain/normalize.js";
import { evaluateCandidates, calculatePurchaseCost } from "../src/domain/evaluate.js";
import { extractBrand, extractDeliveryDate, extractShipping } from "../src/domain/extract.js";
import { getCategory } from "../src/domain/categories.js";
import { resolveOfferRefs, detailGaps } from "../src/services/research.js";
import type { Offer, ProductDetails, RawShoppingItem, Requirement } from "../src/domain/types.js";

const saved = JSON.parse(readFileSync(new URL("./fixtures/blender-run-2026-10-25.json", import.meta.url), "utf8")) as {
  observedAt: string;
  items: RawShoppingItem[];
  detailsBySeller: Record<string, ProductDetails>;
};
const blender = getCategory("countertop_blender")!;
const commercial = blender.features.commercial_use!;
const observedAt = new Date(saved.observedAt);
const TZ = "America/Chicago";

// The confirmed requirements of the saved request (req_70d174514fca4fd3 v1).
const requirements: Requirement[] = [
  { id: "req_category", attribute: "product_type", operator: "eq", value: "countertop_blender", mandatory: true, sourceText: "category: countertop blenders" },
  { id: "req_volume", attribute: "volume", operator: "gte", value: 1893, unit: "ml", mandatory: true, sourceText: "At least 64 US fluid ounces pitcher capacity (required)." },
  { id: "req_feature_commercial_use", attribute: "feature", operator: "includes", value: "commercial_use", label: "Explicitly designated for commercial use", mandatory: true, sourceText: "Explicit commercial-use designation (required)." },
  { id: "req_condition", attribute: "condition", operator: "in", value: ["new"], mandatory: true, sourceText: "allowed condition: new" },
  { id: "req_delivery_by", attribute: "delivery_by", operator: "lte", value: "2026-10-28", unit: "date", mandatory: true, sourceText: "needed by (hard deadline): 2026-10-28" },
] as Requirement[];

function offers(location: string | null = null): Offer[] {
  return saved.items.flatMap((item, i) => {
    const r = normalizeOffer(item, { runId: "run_saved", queryId: `q${i}`, observedAt, offerMaxAgeMinutes: 30, fromCache: true, category: blender, timeZone: TZ, deliveryLocation: location });
    return r.ok ? [r.offer] : [];
  });
}
const find = (list: Offer[], seller: string) => list.find((o) => o.seller === seller)!;
const withDetails = (list: Offer[]) =>
  list.map((o) => {
    const d = o.seller ? saved.detailsBySeller[o.seller] : undefined;
    return d ? applyProductDetails(o, d, observedAt, true, blender, { timeZone: TZ }) : o;
  });
const check = (list: Offer[], seller: string, attribute: string) => {
  const evals = evaluateCandidates(list, requirements, 1, 30000);
  const e = evals.find((x) => x.offerId === find(list, seller).id)!;
  return { e, r: e.requirementResults.find((r) => r.attribute === attribute)! };
};

describe("saved café-blender run: parsing", () => {
  it("reads horsepower as horsepower, not the HP brand", () => {
    expect(find(offers(), "Walmart - TERUISI").brand).toBeNull(); // "…2.95 HP, 9 Speeds…"
    expect(find(offers(), "Walmart - ClearBuys").brand).toBeNull(); // "Wuzstar 3 HP Commercial…"
    expect(extractBrand("HP 27\" Monitor")).toBe("HP");
    expect(extractBrand("3 HP motor blender")).toBeNull();
  });

  it("keeps both capacity claims and uses the lower one, naming the other", () => {
    const list = offers();
    const t = find(list, "Walmart - TERUISI");
    expect(t.evidence.filter((e) => e.attribute === "volume").map((e) => e.value)).toEqual([2000, 2070]); // "2l/70 oz"
    const { r } = check(list, "Walmart - TERUISI", "volume");
    expect(r.state).toBe("supported");
    expect(r.reason).toMatch(/67\.6 fl oz.*also stated as 70 fl oz/);
    expect(check(list, "Walmart - Reliable Home Supply", "volume").r.reason).toMatch(/^States 68 fl oz/);
  });

  it("flags materially conflicting capacity claims instead of taking the first number", () => {
    const [o] = [normalizeOffer({ title: "Commercial Blender 64 oz / 80 oz pitcher", source: "X", price: "$100" }, { runId: "r", queryId: "q", observedAt, offerMaxAgeMinutes: 30, fromCache: false, category: blender })].map((r) => (r.ok ? r.offer : null));
    const e = evaluateCandidates([o!], requirements, 1, 30000)[0]!;
    expect(e.requirementResults.find((r) => r.attribute === "volume")!.reason).toMatch(/Capacity claims conflict \(64 fl oz vs 80 fl oz\)/);
    const straddle = normalizeOffer({ title: "Blender 1.5L / 72 oz jar", source: "X", price: "$100" }, { runId: "r", queryId: "q", observedAt, offerMaxAgeMinutes: 30, fromCache: false, category: blender });
    const s = evaluateCandidates([(straddle as { offer: Offer }).offer], requirements, 1, 30000)[0]!;
    expect(s.requirementResults.find((r) => r.attribute === "volume")!).toMatchObject({ state: "unknown", reason: expect.stringMatching(/Conflicting evidence/) });
  });

  it("reads conditional free shipping by its minimum order", () => {
    const omcan = offers().find((o) => o.title.startsWith("Omcan 48005") && o.priceText === "$796.29")!;
    expect(omcan.delivery.excerpt).toBe("Free delivery on $1,500+");
    expect(omcan.shipping).toMatchObject({ status: "unknown", cents: null, freeOverCents: 150000 });
    const cost = calculatePurchaseCost(omcan, 1);
    expect(cost.shippingCents).toBeNull();
    expect(cost.notes.join(" ")).toMatch(/only on orders of \$1,500\.00\+; this \$796\.29 subtotal does not qualify/);
    expect(calculatePurchaseCost(omcan, 2).shippingCents).toBe(0); // 2 × $796.29 clears the threshold
    expect(extractShipping("Free shipping with Walmart+")).toMatchObject({ kind: "conditional" });
    expect(extractShipping("Free delivery")).toMatchObject({ kind: "free" });
  });

  it("anchors relative delivery days to the company time zone", () => {
    // Observed Sunday 9:08 AM in Chicago: "by Wed" is Wednesday Oct 28.
    expect(find(offers(), "Walmart - TERUISI").delivery).toMatchObject({ latest: "2026-10-28", basis: "google_estimate", location: null, timeZone: TZ });
    // Saturday 11:30 PM in Chicago is already Sunday in UTC: "by Sun" means tomorrow, not next week.
    const sat = new Date("2026-10-25T04:30:00Z");
    expect(extractDeliveryDate("Free delivery by Sun", sat, TZ)?.value.latest).toBe("2026-10-25");
    expect(extractDeliveryDate("Free delivery by Sun", sat, "UTC")?.value.latest).toBe("2026-11-01");
    expect(extractDeliveryDate("Get it tomorrow", sat, TZ)?.value.latest).toBe("2026-10-25");
  });
});

describe("saved café-blender run: commercial-use evidence", () => {
  it("treats the bare title word and 'commercial grade' as unconfirmed, naming the gap", () => {
    const list = offers();
    const keyword = check(list, "Walmart - TERUISI", "feature").r;
    expect(keyword.state).toBe("unknown");
    expect(keyword.reason).toMatch(/Seller's title uses the word only/);
    const marketing = check(list, "Walmart - Reliable Home Supply", "feature").r;
    expect(marketing.state).toBe("unknown");
    expect(marketing.reason).toMatch(/"Commercial Grade.*" is marketing wording/i);
  });

  it("accepts structured Google product specs and keeps their source", () => {
    const list = withDetails(offers());
    const wuz = check(list, "Walmart - ClearBuys", "feature").r;
    expect(wuz).toMatchObject({ state: "supported" });
    expect(wuz.reason).toBe("Google product specs: Rec. use = Commercial");
    expect(check(list, "Walmart - Reliable Home Supply", "feature").r.reason).toBe("Google product specs: Commercial = Yes");
  });

  it("handles negations, generic safety marks and certifications by their scope", () => {
    const claims = (t: string) => featureClaims(t, "commercial_use", commercial).map((c) => `${c.value}:${c.claim ?? ""}`);
    expect(claims("Countertop blender, not for commercial use")).toEqual(["!commercial_use:"]);
    expect(claims("Household use only blender (non-commercial)")).toEqual(["!commercial_use:"]);
    expect(claims("ETL listed 64 oz blender")).toEqual([]); // electrical safety says nothing about commercial use
    expect(claims("NSF certified 64 oz bar blender")).toEqual(["commercial_use:certification"]);
    expect(claims("Blender for commercial use, 64 oz")).toEqual(["commercial_use:explicit"]);
    expect(claims("Commercial Grade Blender")).toEqual(["commercial_use:marketing"]);
    const o = normalizeOffer({ title: "NSF Certified Bar Blender 64 oz", source: "X", price: "$200" }, { runId: "r", queryId: "q", observedAt, offerMaxAgeMinutes: 30, fromCache: false, category: blender });
    const r = evaluateCandidates([(o as { offer: Offer }).offer], requirements, 1, 30000)[0]!.requirementResults.find((x) => x.attribute === "feature")!;
    expect(r.state).toBe("supported");
    expect(r.reason).toMatch(/^NSF food-equipment sanitation certification claimed in listing text \(not checked with the certifier\)/);
    // A product spec stating household use contradicts the requirement.
    const household = applyProductDetails((o as { offer: Offer }).offer, { title: null, features: [{ title: "Rec. use", value: "Household" }], stores: [] }, observedAt, false, blender);
    expect(household.evidence.some((e) => e.value === "!commercial_use")).toBe(true);
  });
});

describe("saved café-blender run: delivery, ranking and enrichment", () => {
  it("never treats a Google estimate without a delivery location as confirmed arrival", () => {
    const { r, e } = check(offers(), "Walmart - TERUISI", "delivery_by");
    expect(r).toMatchObject({ state: "unknown", deadlineRisk: "on_deadline" });
    expect(r.reason).toMatch(/no delivery location set, so not confirmed for your address\) by Wed, Oct 28: the same day as the hard deadline, with no margin/);
    expect(e.class).toBe("needs_review");
  });

  it("with a delivery location, an estimate on the deadline day passes but is flagged", () => {
    const { r } = check(offers("Austin, Texas, United States"), "Walmart - TERUISI", "delivery_by");
    expect(r).toMatchObject({ state: "supported", deadlineRisk: "on_deadline" });
    expect(r.reason).toMatch(/estimates delivery to Austin, Texas, United States \(an estimate, not a guaranteed arrival\) by Wed, Oct 28/);
  });

  it("a stated search location lets an estimate pass the deadline check without becoming a guarantee", () => {
    const list = offers("Austin, Texas, United States");
    const located = list.find((o) => o.delivery.excerpt === "Free delivery by Wed")!;
    const early = { ...located, evidence: located.evidence.map((e) => (e.attribute === "delivery_by" ? { ...e, value: { earliest: "2026-10-27", latest: "2026-10-27" } } : e)) };
    const e = evaluateCandidates([early], requirements, 1, 30000)[0]!;
    const d = e.requirementResults.find((r) => r.attribute === "delivery_by")!;
    expect(d).toMatchObject({ state: "supported", deadlineRisk: "estimate_only" }); // never "none" for a Google estimate
    expect(d.reason).toMatch(/an estimate, not a guaranteed arrival/);
  });

  it("keeps unknown condition unknown and ranks deadline risk above missing condition", () => {
    const list = withDetails(offers());
    const evals = evaluateCandidates(list, requirements, 1, 30000);
    const reason = (seller: string) => evals.find((x) => x.offerId === find(list, seller).id)!;
    // Specs confirmed by product specs; condition and delivery date are the remaining gaps.
    expect(reason("Walmart - ClearBuys").recommendationReason).toBe("Needs review: Specs match · confirm new condition · no delivery date for the hard deadline");
    expect(reason("Walmart - ClearBuys").requirementResults.find((r) => r.attribute === "condition")!.state).toBe("unknown");
    expect(reason("Walmart - TERUISI").recommendationReason).toMatch(/^Needs review: Commercial use unconfirmed · confirm new condition · delivery estimate lands on the deadline day/);
    // Confirmed specs come first; among equal specs, a dated estimate outranks no date.
    const order = evals.filter((e) => e.class === "needs_review").map((e) => list.find((o) => o.id === e.offerId)!.seller);
    expect(order.indexOf("Walmart - Reliable Home Supply")).toBeLessThan(order.indexOf("Walmart - TERUISI"));
    expect(order.indexOf("Walmart - ClearBuys")).toBeLessThan(order.indexOf("Walmart - TERUISI"));
  });

  it("an offer differing only in condition evidence reads 'Specs match · confirm new condition'", () => {
    const list = withDetails(offers("Austin, Texas, United States"));
    const t = list.find((o) => o.seller === "Walmart - TERUISI")!;
    const confirmed = { ...t, evidence: [...t.evidence, { id: "u1", attribute: "feature", value: "commercial_use", source: "user" as const, sourceField: "verification", excerpt: "Seller confirmed commercial use", method: "user_confirmed" as const, confidence: "listing_evidence" as const, claim: "explicit" as const }] };
    const e = evaluateCandidates([confirmed], requirements, 1, 30000)[0]!;
    expect(e.class).toBe("needs_review");
    expect(e.recommendationReason).toBe("Needs review: Specs match · confirm new condition · arrives on the deadline day, no margin");
  });

  it("shares product specs across sellers of one product but never their seller terms", () => {
    const list = offers();
    const clear = find(list, "Walmart - ClearBuys");
    const shop = find(list, "Walmart - ShopEase Store");
    expect(clear.productKey).toBe(shop.productKey);
    // ShopEase receives the specs from ClearBuys's product page, but that page lists only ClearBuys.
    const shared = applyProductDetails(shop, saved.detailsBySeller["Walmart - ClearBuys"]!, observedAt, true, blender, { timeZone: TZ, sharedFromOfferId: clear.id });
    expect(shared.details).toMatchObject({ status: "fetched", matchedStore: null, sharedFromOfferId: clear.id });
    expect(shared.evidence.some((e) => e.source === "serpapi_immersive_product" && e.attribute === "volume")).toBe(true);
    expect(shared.availability).toEqual(shop.availability); // stock not copied from ClearBuys
    expect(shared.shipping).toEqual(shop.shipping);
    // A first-party "Walmart" store entry is a different seller from "Walmart - ClearBuys".
    const firstParty = applyProductDetails(clear, { title: null, features: [], stores: [{ name: "Walmart", extractedPrice: 80, shipping: "Free", shippingExtracted: null, details: ["In stock online", "Free delivery by Tue"] }] }, observedAt, true, blender, { timeZone: TZ });
    expect(firstParty.details.matchedStore).toBeNull();
    expect(firstParty.delivery.latest).toBeNull();
  });

  it("spends lookups only on gaps a product page can resolve", () => {
    const list = offers();
    const evals = evaluateCandidates(list, requirements, 1, 30000);
    const of = (seller: string) => evals.find((x) => x.offerId === find(list, seller).id)!;
    expect(detailGaps(of("Walmart - TERUISI"), { locationSet: false })).toEqual(["feature"]);
    expect(detailGaps(of("Walmart - ClearBuys"), { locationSet: false })).toEqual(["feature"]);
    expect(detailGaps(of("Walmart - ClearBuys"), { locationSet: false, specsKnown: true })).toEqual([]);
    expect(detailGaps(of("Walmart - NU AGE"), { locationSet: true })).toEqual(["volume", "feature", "delivery_by"]);
  });

  it("resolves agent offer references and never shows garbled ids", () => {
    const list = offers();
    const t = find(list, "Walmart - TERUISI");
    const map = new Map(list.map((o) => [o.id, o]));
    expect(resolveOfferRefs(`The top candidate is offer ${t.id.slice(0, 15)}ter at $161.49.`, map)).toBe("The top candidate is offer an offer at $161.49.");
    expect(resolveOfferRefs(`Pick \`${t.id}\` first.`, map)).toBe("Pick the Walmart - TERUISI listing ($161.49) first.");
  });
});
