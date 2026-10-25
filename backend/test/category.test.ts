import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";
import { FIXTURE_MONITOR_ITEMS, FixtureShopping } from "../src/integrations/fixtures.js";
import { awaitRun, buildQueryPlan } from "../src/services/research.js";
import { checkListingCategory, detectCategory, getCategory } from "../src/domain/categories.js";
import { deriveRequirements, resolveCategory } from "../src/domain/requirements.js";
import { extractDeliveryDate, extractDimensions, extractScrewSize, extractThickness, extractVolume, extractPackageQuantity } from "../src/domain/extract.js";
import { normalizeOffer } from "../src/domain/normalize.js";
import { evaluateCandidates, evaluateRequirement, recommend } from "../src/domain/evaluate.js";
import { RequestFields } from "../src/contracts/domain.js";

/** A stale client hint: category "monitors" on a request that is plainly for a blender. */
async function blenderRequest(h: ReturnType<typeof harness>) {
  return h.call("POST", "/api/v1/requests", {
    title: "Blender",
    description: "One new countertop blender for the café.",
    category: "monitors",
    quantity: 1,
    currency: "USD",
    budgetCents: 30000,
    budgetBasis: "total",
    allowedCondition: "new",
  });
}

describe("category isolation: a blender request never yields eligible monitors", () => {
  it("a 'monitors' hint on a blender request is a conflict, not a default", async () => {
    const h = harness();
    const created = await blenderRequest(h);
    expect(created.status).toBe(201);
    const req = created.body.data;
    expect(req.category).toBeNull();
    expect(req.item).toMatchObject({ resolved: false, category: null });
    const q = req.questions.find((x: any) => x.id === "q_category");
    expect(q.options.map((o: any) => o.value).sort()).toEqual(["countertop_blender", "general", "monitors"]);
    // Cannot confirm (or research) while the item type is unresolved.
    const conf = await h.call("POST", `/api/v1/requests/${req.id}/confirm`, { version: req.version });
    expect(conf.status).toBe(409);
    expect(h.shopping.calls.length).toBe(0);
  });

  it("after choosing blender, monitor listings (even if a provider returns them) are rejected and queries name blenders", async () => {
    // The provider returns only monitors: the worst case of reused or wrong-category results.
    const h = harness({ shopping: new FixtureShopping(FIXTURE_MONITOR_ITEMS) });
    const created = await blenderRequest(h);
    const id = created.body.data.id;
    const clar = await h.call("POST", `/api/v1/requests/${id}/clarify`, { expectedVersion: created.body.data.version, answers: [{ questionId: "q_category", value: "countertop_blender" }] });
    expect(clar.body.data.item).toMatchObject({ resolved: true, category: "countertop_blender", plural: "countertop blenders", unit: "blender" });
    expect(clar.body.data.requirements.find((r: any) => r.attribute === "product_type")).toMatchObject({ value: "countertop_blender", mandatory: true, display: "Is a countertop blender" });
    const conf = await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: clar.body.data.version });
    expect(conf.status).toBe(200);
    const start = await h.call("POST", `/api/v1/requests/${id}/research`, { version: conf.body.data.version });
    await awaitRun(start.body.data.runId);
    expect(h.shopping.calls.length).toBeGreaterThan(0);
    for (const c of h.shopping.calls) {
      expect(c.q).toMatch(/blender/);
      expect(c.q).not.toMatch(/monitor/i);
    }
    const data = (await h.call("GET", `/api/v1/requests/${id}/candidates`)).body.data;
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates.filter((c: any) => c.eligibility === "eligible")).toEqual([]);
    expect(data.recommendations).toEqual([]);
    for (const c of data.candidates.filter((x: any) => /monitor/i.test(x.title) && !/arm|mount/i.test(x.title))) {
      expect(c.eligibility).toBe("rejected");
      expect(c.requirementChecks.find((r: any) => r.attribute === "product_type")).toMatchObject({ state: "contradicted", reason: "Listing is a monitor, not a countertop blender" });
    }
    expect((await h.call("GET", `/api/v1/runs/${start.body.data.runId}`)).body.data.outcome).toBe("no_confirmed_match");
  });

  it("an older or unrecognized item type asks instead of defaulting, offering the supported types and general search", () => {
    const offered = ["monitors", "wood_glue", "countertop_blender", "portable_power_station", "general"];
    expect(resolveCategory(null, "Sandpaper", "120 grit")).toMatchObject({ category: null, problem: "none" });
    expect(resolveCategory(null, "Sandpaper", "").candidates).toEqual(offered);
    // Office chairs exist only for older records: recognised, but not offered for new requests.
    expect(resolveCategory(null, "Chairs", "")).toMatchObject({ category: null, problem: "unsupported", unsupported: ["office chairs"], candidates: offered });
    expect(resolveCategory("monitors", "Chairs", "")).toMatchObject({ category: null, problem: "conflict" });
    expect(resolveCategory("monitors", "27 inch monitors", "")).toMatchObject({ category: "monitors" });
    expect(resolveCategory(null, "Urgent replacement café blender", "")).toMatchObject({ category: "countertop_blender" });
    expect(resolveCategory(null, "Portable power for community outreach", "portable power station")).toMatchObject({ category: "portable_power_station" });
    expect(deriveRequirements({ title: "Sandpaper", description: "", allowedCondition: "new", category: null, deadline: null, deadlineType: "target" }).some((r) => r.attribute === "product_type")).toBe(false);
  });

  it("research results and caches are bound to the confirmed requirement version", async () => {
    const h = harness();
    const created = await h.call("POST", "/api/v1/requests", { title: "Wood glue", description: "One bottle of new wood glue, at least 8 fl oz.", quantity: 1, currency: "USD", budgetCents: 2000, allowedCondition: "new" });
    const id = created.body.data.id;
    expect(created.body.data.category).toBe("wood_glue");
    await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: 1 });
    const s1 = await h.call("POST", `/api/v1/requests/${id}/research`, { version: 1 });
    await awaitRun(s1.body.data.runId);
    const callsAfterFirst = h.shopping.calls.length;
    // Edit the request: the old results are no longer current and never show as eligible.
    const edited = await h.call("PATCH", `/api/v1/requests/${id}`, { expectedVersion: 1, description: "One bottle of new wood glue, at least 16 fl oz." });
    const stale = (await h.call("GET", `/api/v1/requests/${id}/candidates?runId=${s1.body.data.runId}`)).body.data;
    expect(stale.resultsCurrent).toBe(false);
    expect(stale.candidates.some((c: any) => c.eligibility === "eligible")).toBe(false);
    // A new run for the new version does not reuse the previous version's cache entries.
    await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: edited.body.data.version });
    const s2 = await h.call("POST", `/api/v1/requests/${id}/research`, { version: edited.body.data.version });
    await awaitRun(s2.body.data.runId);
    expect(h.shopping.calls.length).toBeGreaterThan(callsAfterFirst);
    const keys = (h.ctx.db.prepare("SELECT cache_key FROM search_cache").all() as Array<{ cache_key: string }>).map((r) => r.cache_key);
    expect(keys.some((k) => k.includes(`${id}@v1:wood_glue`))).toBe(true);
    expect(keys.some((k) => k.includes(`${id}@v${edited.body.data.version}:wood_glue`))).toBe(true);
  });
});

describe("category registry and listing checks", () => {
  const chairs = getCategory("office_chairs")!;
  it("detects categories (older ones too, so conflicts are caught) and never defaults", () => {
    expect(detectCategory("Chairs", "").best).toBe("office_chairs");
    expect(detectCategory("Commercial blender", "").best).toBe("countertop_blender");
    expect(detectCategory("Portable power station", "").best).toBe("portable_power_station");
    expect(detectCategory("Self-adhesive cork sheets", "").best).toBe("cork_sheets");
    expect(detectCategory("Wood screws", "#6 x 5/8 inch").best).toBe("wood_screws");
    expect(detectCategory("Supplies", "").best).toBeNull();
  });
  it("checks category consistency of listings", () => {
    expect(checkListingCategory("Ergonomic Office Chair", chairs).state).toBe("supported");
    expect(checkListingCategory("27 inch QHD Monitor", chairs)).toMatchObject({ state: "contradicted", detected: "monitors" });
    expect(checkListingCategory("Seat Cushion for Office Chair", chairs)).toMatchObject({ state: "contradicted", detected: "accessory_or_part" });
    expect(checkListingCategory("Something unrelated", chairs).state).toBe("unknown");
    expect(checkListingCategory("Natural Wine Corks, 100 pcs", getCategory("cork_sheets")!).state).toBe("contradicted");
    expect(checkListingCategory("Hot Glue Gun with Glue Sticks", getCategory("wood_glue")!).state).toBe("contradicted");
    expect(checkListingCategory("Precision Screwdriver Set", getCategory("wood_screws")!).state).toBe("contradicted");
  });
  it("builds queries from the confirmed category and specs only", () => {
    const reqs = deriveRequirements({ title: "Wood screws", description: "#6 x 5/8 inch flat head wood screws", allowedCondition: "new", category: "wood_screws", deadline: null, deadlineType: "target" });
    const plan = buildQueryPlan(reqs, "exact_specs", "new", getCategory("wood_screws")!);
    expect(plan[0]).toBe("#6 x 5/8 inch wood screws flat (countersunk) head".replace(" (countersunk)", ""));
    for (const q of plan) expect(q).toMatch(/wood screws/);
  });
});

describe("material extraction and quantities", () => {
  it("parses volumes, dimensions, thickness, screw sizes and piece counts", () => {
    expect(extractVolume("Wood Glue, 8 fl oz")?.value).toBe(237);
    // A bare "oz" can be weight, so it is not a volume; explicit fluid units are.
    expect(extractVolume("16 oz bottle")).toBeNull();
    expect(extractVolume("Net Wt 18 oz")).toBeNull();
    expect(extractVolume("16 fl oz bottle")?.value).toBe(473);
    expect(extractVolume("1 Gallon")?.value).toBe(3785);
    // ...except for a pitcher's capacity, which cannot be a weight.
    expect(extractVolume("64 oz pitcher", { bareOzIsFluid: true })?.value).toBe(1893);
    expect(extractVolume("500 ml")?.value).toBe(500);
    expect(extractDimensions('Cork Sheets 12" x 12"')?.value).toEqual({ length: 12, width: 12 });
    expect(extractDimensions("Cork Roll 12 in x 4 ft")?.value).toEqual({ length: 48, width: 12 });
    expect(extractDimensions("300 x 200 mm")?.value).toEqual({ length: 11.81, width: 7.87 });
    expect(extractThickness('1/8" Thick')?.value).toBe(0.125);
    expect(extractThickness("3mm thick")?.value).toBe(0.118);
    expect(extractScrewSize('#6 x 5/8" Wood Screws')?.value).toEqual({ gauge: 6, lengthIn: 0.625 });
    expect(extractScrewSize("No. 8 x 1-1/4 in")?.value).toEqual({ gauge: 8, lengthIn: 1.25 });
    expect(extractScrewSize("#6 x 5/8 inch")?.value).toEqual({ gauge: 6, lengthIn: 0.625 });
    expect(extractPackageQuantity("Wood Screws, 100 Pcs")).toMatchObject({ value: 100 });
    expect(extractPackageQuantity("Box of 250 screws")).toMatchObject({ value: 250 });
    expect(extractPackageQuantity("Screws Assortment Kit, 500 pcs")).toMatchObject({ value: 500 });
  });

  it("computes packs needed for the requested unit quantity", async () => {
    const h = harness();
    const created = await h.call("POST", "/api/v1/requests", { title: "Wood screws", description: "40 new #6 x 5/8 inch wood screws", category: "wood_screws", quantity: 40, unit: "screw", currency: "USD", budgetCents: 2500, budgetBasis: "total", allowedCondition: "new" });
    expect(created.body.data.item).toMatchObject({ category: "wood_screws", unit: "screw", quantity: 40 });
    await h.call("POST", `/api/v1/requests/${created.body.data.id}/confirm`, { version: created.body.data.version });
    const s = await h.call("POST", `/api/v1/requests/${created.body.data.id}/research`, { version: created.body.data.version });
    await awaitRun(s.body.data.runId);
    const c = (await h.call("GET", `/api/v1/requests/${created.body.data.id}/candidates`)).body.data.candidates;
    const hundred = c.find((x: any) => /100 Pcs/.test(x.title));
    expect(hundred).toMatchObject({ eligibility: "eligible", packageQuantity: 100, packagesRequired: 1, listedSubtotalCents: 698 });
    expect(c.find((x: any) => /#8 x 1 inch/.test(x.title)).eligibility).toBe("rejected");
    expect(c.find((x: any) => /Assortment/.test(x.title)).eligibility).not.toBe("eligible");
    expect(c.find((x: any) => /Screwdriver/.test(x.title)).eligibility).toBe("rejected");
  });
});

describe("deadlines and multivariable recommendations", () => {
  const glue = getCategory("wood_glue")!;
  const now = new Date();
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const fields = (deadlineType: "hard" | "target") =>
    RequestFields.parse({ title: "Wood glue", description: "New wood glue, at least 8 fl oz", category: "wood_glue", quantity: 1, currency: "USD", budgetCents: 2000, deadline: day(10), deadlineType });
  const offersFor = () =>
    [
      { title: "Premium Wood Glue, 8 fl oz", source: "A", price: "$5.97", delivery: `Free delivery by ${new Date(now.getTime() + 2 * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` },
      { title: "Wood Glue 8 fl oz", source: "B", price: "$3.49", delivery: `Delivery ${new Date(now.getTime() + 20 * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` },
      { title: "Wood Glue 16 fl oz", source: "C", price: "$4.10" },
    ].map((it, i) => {
      // Each listing states its condition; condition inference is covered in domain.test.ts.
      const r = normalizeOffer({ ...it, extensions: ["Condition: New"] }, { runId: "r", queryId: `q${i}`, observedAt: now, offerMaxAgeMinutes: 30, fromCache: false, category: glue });
      if (!r.ok) throw new Error(r.reason);
      return r.offer;
    });

  it("parses stated delivery dates and keeps missing ones unknown", () => {
    expect(extractDeliveryDate("Free delivery between Oct 27 – Nov 4", new Date("2026-10-24T12:00:00Z"))?.value).toEqual({ earliest: "2026-10-27", latest: "2026-11-04" });
    expect(extractDeliveryDate("Get it tomorrow", new Date("2026-10-24T12:00:00Z"))?.value.latest).toBe("2026-10-25");
    expect(extractDeliveryDate("Free delivery by Mon", new Date("2026-10-24T12:00:00Z"))?.value.latest).toBe("2026-10-26");
    expect(extractDeliveryDate("Free delivery", new Date("2026-10-24T12:00:00Z"))).toBeNull();
  });

  it("a hard deadline makes a cheaper late offer noncompliant: shown, never recommended", () => {
    const f = fields("hard");
    const reqs = deriveRequirements(f);
    const offers = offersFor();
    const evals = evaluateCandidates(offers, reqs, 1, 2000);
    const byTitle = (t: string) => evals.find((e) => offers.find((o) => o.id === e.offerId)!.title === t)!;
    expect(byTitle("Wood Glue 8 fl oz").class).toBe("rejected");
    expect(byTitle("Wood Glue 16 fl oz").class).toBe("needs_review"); // no stated delivery: unknown, not assumed
    expect(byTitle("Premium Wood Glue, 8 fl oz").class).toBe("eligible");
    const recs = recommend(evals, offers, reqs);
    const recIds = recs.recommendations.map((r) => r.offerId);
    expect(recIds).not.toContain(byTitle("Wood Glue 8 fl oz").offerId);
    expect(recs.noncompliantAlternatives.map((a) => a.offerId)).toEqual([byTitle("Wood Glue 8 fl oz").offerId]);
    expect(recs.noncompliantAlternatives[0]!.reason).toMatch(/after the hard deadline/);
    // One compliant winner takes every role: merged, not duplicated.
    expect(recs.recommendations).toHaveLength(1);
    expect(recs.recommendations[0]!.kinds.sort()).toEqual(["best_overall", "deadline_fit", "lowest_cost"]);
  });

  it("a target date keeps a late offer eligible but it loses the deadline-fit role", () => {
    const f = fields("target");
    const reqs = deriveRequirements(f);
    const offers = offersFor();
    const evals = evaluateCandidates(offers, reqs, 1, 2000);
    const late = evals.find((e) => offers.find((o) => o.id === e.offerId)!.title === "Wood Glue 8 fl oz")!;
    expect(late.class).toBe("eligible");
    expect(late.requirementResults.find((r) => r.attribute === "delivery_by")!.state).toBe("contradicted");
    const recs = recommend(evals, offers, reqs);
    const kinds = Object.fromEntries(recs.recommendations.flatMap((r) => r.kinds.map((k) => [k, offers.find((o) => o.id === r.offerId)!.title])));
    expect(kinds.lowest_cost).toBe("Wood Glue 8 fl oz");
    expect(kinds.deadline_fit).toBe("Premium Wood Glue, 8 fl oz");
    expect(recs.noncompliantAlternatives).toEqual([]);
  });

  it("unknown shipping, tax and stock stay unknown and are reported", () => {
    const f = fields("target");
    const offers = offersFor();
    const evals = evaluateCandidates(offers, deriveRequirements(f), 1, 2000);
    const c16 = evals.find((e) => offers.find((o) => o.id === e.offerId)!.title === "Wood Glue 16 fl oz")!;
    expect(c16.cost.shippingCents).toBeNull();
    expect(c16.cost.taxCents).toBeNull();
    expect(c16.unknowns).toEqual(expect.arrayContaining(["shipping cost", "sales tax", "availability"]));
    expect(evaluateRequirement(deriveRequirements(f).find((r) => r.attribute === "delivery_by")!, offers.find((o) => o.title === "Wood Glue 16 fl oz")!).state).toBe("unknown");
  });
});

describe("extraction regressions found in the end-to-end UI run", () => {
  it("does not read a dimension as a multipack", () => {
    expect(extractPackageQuantity("Chair Mat for Carpet, 36 x 48 inch")).toBeNull();
    expect(extractPackageQuantity('2 x 27" Monitors')).toMatchObject({ value: 2 });
  });
  it("an explicit absence contradicts a required feature", () => {
    const chairs = getCategory("office_chairs")!;
    const r = normalizeOffer({ title: "Task Chair, Armless, Fabric Seat", source: "S", price: "$54.99" }, { runId: "r", queryId: "q", observedAt: new Date(), offerMaxAgeMinutes: 30, fromCache: false, category: chairs });
    if (!r.ok) throw new Error(r.reason);
    const req = deriveRequirements({ title: "Chairs", description: "Armrests required", allowedCondition: "new", category: "office_chairs", deadline: null, deadlineType: "target" }).find((x) => x.attribute === "feature")!;
    expect(evaluateRequirement(req, r.offer)).toMatchObject({ state: "contradicted" });
  });
});
