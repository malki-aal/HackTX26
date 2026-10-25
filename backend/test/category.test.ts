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

/** Drive a request the way the current frontend does: it always sends category "monitors". */
async function chairsRequest(h: ReturnType<typeof harness>) {
  const created = await h.call("POST", "/api/v1/requests", {
    title: "Chairs",
    description: "Twelve chairs for the new meeting room.",
    category: "monitors",
    quantity: 12,
    currency: "USD",
    budgetCents: 200000,
    budgetBasis: "total",
    allowedCondition: "new",
    rankingPriority: "lowest_known_total",
  });
  return created;
}

describe("category bug regression: a chair request never yields eligible monitors", () => {
  it("a frontend-style 'monitors' hint on a 'Chairs' request is a conflict, not a default", async () => {
    const h = harness();
    const created = await chairsRequest(h);
    expect(created.status).toBe(201);
    const req = created.body.data;
    expect(req.category).toBeNull();
    expect(req.item).toMatchObject({ resolved: false, category: null });
    const q = req.questions.find((x: any) => x.id === "q_category");
    expect(q.options.map((o: any) => o.value).sort()).toEqual(["monitors", "office_chairs"]);
    // Cannot confirm (or research) while the item type is unresolved.
    const conf = await h.call("POST", `/api/v1/requests/${req.id}/confirm`, { version: req.version });
    expect(conf.status).toBe(409);
    expect(h.shopping.calls.length).toBe(0);
  });

  it("after choosing chairs, monitor listings (even if a provider returns them) are rejected, queries name chairs, and the label is accurate", async () => {
    // The provider returns only monitors: the worst case of reused or wrong-category results.
    const h = harness({ shopping: new FixtureShopping(FIXTURE_MONITOR_ITEMS) });
    const created = await chairsRequest(h);
    const id = created.body.data.id;
    const clar = await h.call("POST", `/api/v1/requests/${id}/clarify`, { expectedVersion: created.body.data.version, answers: [{ questionId: "q_category", value: "office_chairs" }] });
    expect(clar.body.data.item).toMatchObject({ resolved: true, category: "office_chairs", plural: "office chairs", unit: "chair" });
    expect(clar.body.data.requirements.find((r: any) => r.attribute === "product_type")).toMatchObject({ value: "office_chairs", mandatory: true, display: "Is an office chair" });
    const conf = await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: clar.body.data.version });
    expect(conf.status).toBe(200);
    const start = await h.call("POST", `/api/v1/requests/${id}/research`, { version: conf.body.data.version });
    await awaitRun(start.body.data.runId);
    expect(h.shopping.calls.length).toBeGreaterThan(0);
    for (const c of h.shopping.calls) {
      expect(c.q).toMatch(/office chair/);
      expect(c.q).not.toMatch(/monitor/i);
    }
    const cands = await h.call("GET", `/api/v1/requests/${id}/candidates`);
    const data = cands.body.data;
    expect(data.item.plural).toBe("office chairs");
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates.filter((c: any) => c.eligibility === "eligible")).toEqual([]);
    expect(data.recommendations).toEqual([]);
    for (const c of data.candidates.filter((x: any) => /monitor/i.test(x.title) && !/arm|mount/i.test(x.title))) {
      expect(c.eligibility).toBe("rejected");
      expect(c.requirementChecks.find((r: any) => r.attribute === "product_type")).toMatchObject({ state: "contradicted", reason: "Listing is a monitor, not an office chair" });
    }
    const run = await h.call("GET", `/api/v1/runs/${start.body.data.runId}`);
    expect(run.body.data.outcome).toBe("no_confirmed_match");
  });

  it("with category-appropriate results, a real chair can qualify and a monitor in the same results cannot", async () => {
    const h = harness();
    const created = await chairsRequest(h);
    const id = created.body.data.id;
    const clar = await h.call("POST", `/api/v1/requests/${id}/clarify`, { expectedVersion: 1, answers: [{ questionId: "q_category", value: "office_chairs" }] });
    await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: clar.body.data.version });
    const start = await h.call("POST", `/api/v1/requests/${id}/research`, { version: clar.body.data.version });
    await awaitRun(start.body.data.runId);
    const data = (await h.call("GET", `/api/v1/requests/${id}/candidates`)).body.data;
    const eligible = data.candidates.filter((c: any) => c.eligibility === "eligible");
    expect(eligible.length).toBeGreaterThan(0);
    for (const c of eligible) expect(c.title).toMatch(/chair/i);
    expect(data.candidates.find((c: any) => /Monitor/.test(c.title)).eligibility).toBe("rejected");
    expect(data.candidates.find((c: any) => /Cushion/.test(c.title)).eligibility).toBe("rejected");
    expect(data.candidates.find((c: any) => /Chair Mat/.test(c.title)).eligibility).toBe("rejected");
  });

  it("an unrecognized item type asks instead of defaulting", () => {
    expect(resolveCategory(null, "Sandpaper", "120 grit")).toMatchObject({ category: null, problem: "none" });
    expect(resolveCategory(null, "Chairs", "")).toMatchObject({ category: "office_chairs", problem: null });
    expect(resolveCategory("monitors", "Chairs", "")).toMatchObject({ category: null, problem: "conflict" });
    expect(resolveCategory("monitors", "27 inch monitors", "")).toMatchObject({ category: "monitors" });
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
  it("detects categories and never defaults", () => {
    expect(detectCategory("Chairs", "").best).toBe("office_chairs");
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
    expect(extractVolume("16 oz bottle")?.value).toBe(473);
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
    const created = await h.call("POST", "/api/v1/requests", { title: "Wood screws", description: "40 new #6 x 5/8 inch wood screws", quantity: 40, unit: "screw", currency: "USD", budgetCents: 2500, budgetBasis: "total", allowedCondition: "new" });
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
      { title: "Wood Glue 8 oz", source: "B", price: "$3.49", delivery: `Delivery ${new Date(now.getTime() + 20 * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` },
      { title: "Wood Glue 16 oz", source: "C", price: "$4.10" },
    ].map((it, i) => {
      const r = normalizeOffer(it, { runId: "r", queryId: `q${i}`, observedAt: now, offerMaxAgeMinutes: 30, fromCache: false, category: glue });
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
    expect(byTitle("Wood Glue 8 oz").class).toBe("rejected");
    expect(byTitle("Wood Glue 16 oz").class).toBe("needs_review"); // no stated delivery: unknown, not assumed
    expect(byTitle("Premium Wood Glue, 8 fl oz").class).toBe("eligible");
    const recs = recommend(evals, offers, reqs);
    const recIds = recs.recommendations.map((r) => r.offerId);
    expect(recIds).not.toContain(byTitle("Wood Glue 8 oz").offerId);
    expect(recs.noncompliantAlternatives.map((a) => a.offerId)).toEqual([byTitle("Wood Glue 8 oz").offerId]);
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
    const late = evals.find((e) => offers.find((o) => o.id === e.offerId)!.title === "Wood Glue 8 oz")!;
    expect(late.class).toBe("eligible");
    expect(late.requirementResults.find((r) => r.attribute === "delivery_by")!.state).toBe("contradicted");
    const recs = recommend(evals, offers, reqs);
    const kinds = Object.fromEntries(recs.recommendations.flatMap((r) => r.kinds.map((k) => [k, offers.find((o) => o.id === r.offerId)!.title])));
    expect(kinds.lowest_cost).toBe("Wood Glue 8 oz");
    expect(kinds.deadline_fit).toBe("Premium Wood Glue, 8 fl oz");
    expect(recs.noncompliantAlternatives).toEqual([]);
  });

  it("unknown shipping, tax and stock stay unknown and are reported", () => {
    const f = fields("target");
    const offers = offersFor();
    const evals = evaluateCandidates(offers, deriveRequirements(f), 1, 2000);
    const c16 = evals.find((e) => offers.find((o) => o.id === e.offerId)!.title === "Wood Glue 16 oz")!;
    expect(c16.cost.shippingCents).toBeNull();
    expect(c16.cost.taxCents).toBeNull();
    expect(c16.unknowns).toEqual(expect.arrayContaining(["shipping cost", "sales tax", "availability"]));
    expect(evaluateRequirement(deriveRequirements(f).find((r) => r.attribute === "delivery_by")!, offers.find((o) => o.title === "Wood Glue 16 oz")!).state).toBe("unknown");
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
