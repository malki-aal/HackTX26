// The four demo scenarios, end to end on labeled fixtures (no model, search or bank calls): each preset
// is sent the way the New Request form sends it, confirmed, researched and evaluated.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";
import { FIXTURE_MONITOR_ITEMS, FixtureShopping } from "../src/integrations/fixtures.js";
import { awaitRun } from "../src/services/research.js";
import SCENARIOS from "../demo/scenarios.json" with { type: "json" };

type Preset = (typeof SCENARIOS.scenarios)[number];
const preset = (id: string) => SCENARIOS.scenarios.find((s) => s.id === id)!;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Same request body the frontend builds from the form (lib/api/live.ts buildDescription). */
function body(p: Preset) {
  const must = p.mandatory.map((l) => `${l} (required).`).join(" ");
  const nice = p.preferences.map((l) => `Nice to have: ${l}.`).join(" ");
  return {
    title: p.title,
    purpose: p.purpose,
    description: `${p.item}. ${nice ? `${must}${" ".repeat(80)}${nice}` : must}`,
    quantity: p.quantity,
    unit: p.unit,
    currency: "USD",
    budgetCents: p.budgetCents,
    budgetBasis: "total",
    allowedCondition: p.condition,
    deadline: day(p.deadlineDays),
    deadlineType: p.deadlineType,
    presetId: p.id,
  };
}

async function research(h: ReturnType<typeof harness>, p: Preset) {
  const created = await h.call("POST", "/api/v1/requests", body(p));
  expect(created.status).toBe(201);
  const r = created.body.data;
  expect(r.category).toBe(p.categoryId);
  expect(r.unansweredQuestionIds).toEqual([]);
  const conf = await h.call("POST", `/api/v1/requests/${r.id}/confirm`, { version: r.version });
  expect(conf.status).toBe(200);
  const start = await h.call("POST", `/api/v1/requests/${r.id}/research`, { version: r.version });
  expect(start.status).toBe(202);
  await awaitRun(start.body.data.runId);
  const data = (await h.call("GET", `/api/v1/requests/${r.id}/candidates`)).body.data;
  const by = (re: RegExp) => data.candidates.find((c: any) => re.test(c.title));
  const check = (c: any, attr: string) => c.requirementChecks.find((k: any) => k.attribute === attr);
  return { r, data, by, check, run: (await h.call("GET", `/api/v1/runs/${start.body.data.runId}`)).body.data };
}

describe("example presets", () => {
  it("are served read-only, validated, and identical to the frontend's sample-data copy", async () => {
    const h = harness();
    const res = await h.call("GET", "/api/v1/demo/scenarios");
    expect(res.status).toBe(200);
    expect(res.body.data.scenarios.map((s: any) => s.id)).toEqual(["manufacturing_wood_glue", "growing_business_monitors", "cafe_blender", "nonprofit_power_station"]);
    const frontendCopy = JSON.parse(readFileSync(new URL("../../frontend/src/lib/scenarios/scenarios.json", import.meta.url), "utf8"));
    expect(frontendCopy).toEqual(SCENARIOS);
    // Inputs only: never products, prices, merchants, stock or delivery claims.
    const text = JSON.stringify(SCENARIOS.scenarios).toLowerCase();
    for (const banned of ["http", "seller", "merchant", "in stock", "$"]) {
      if (banned === "$") expect(SCENARIOS.scenarios.every((s) => /\$\d/.test(s.purpose))).toBe(true); // budgets are quoted from the employee
      else expect(text).not.toContain(banned);
    }
    // Reading presets creates and researches nothing.
    expect((await h.call("GET", "/api/v1/requests")).body.data).toEqual([]);
    expect(h.shopping.calls).toHaveLength(0);
  });

  it("keep the preset id as metadata while the server still parses the edited text", async () => {
    const h = harness();
    const edited = { ...body(preset("cafe_blender")), title: "Replace the broken café blender today" };
    const r = (await h.call("POST", "/api/v1/requests", edited)).body.data;
    expect(r.category).toBe("countertop_blender");
    const row = h.ctx.db.prepare("SELECT fields FROM request_versions WHERE request_id = ?").get(r.id) as { fields: string } | undefined;
    if (row) expect(JSON.parse(row.fields).presetId).toBe("cafe_blender");
  });
});

describe("scenario 1: restock 128 US fl oz of wood glue", () => {
  it("covers the volume with whole packages, shows excess, and never treats weight ounces as volume", async () => {
    const { r, data, by, check } = await research(harness(), preset("manufacturing_wood_glue"));
    expect(r.quantity).toBe(128);
    expect(r.requirements.some((q: any) => q.attribute === "volume")).toBe(false); // a total, not a per-bottle size
    const gallon = by(/1 Gallon/);
    expect(gallon).toMatchObject({ eligibility: "eligible", packagesRequired: 1, listedSubtotalCents: 2799 });
    const two = by(/64 fl oz/);
    expect(two).toMatchObject({ eligibility: "eligible", packagesRequired: 2, listedSubtotalCents: 3298 });
    const four = by(/32 fl oz/);
    expect(four).toMatchObject({ eligibility: "eligible", packagesRequired: 4, listedSubtotalCents: 3796 });
    expect(four.costNotes.join(" ")).toMatch(/4 × 32 fl oz = 128 fl oz/);
    const eight = by(/Premium Wood Glue, 8 fl oz/);
    expect(eight.packagesRequired).toBe(16);
    expect(eight.costNotes.join(" ")).toMatch(/16 × 8 fl oz = 128 fl oz/);
    // "Net Wt 18 oz" is a weight: the package volume is unknown, so quantity cannot be verified.
    const weight = by(/Net Wt 18 oz/);
    expect(weight).toMatchObject({ eligibility: "needs_review", packagesRequired: null, listedSubtotalCents: null });
    expect(weight.costNotes.join(" ")).toMatch(/not stated in fluid units/);
    expect(by(/Glue Gun/).eligibility).toBe("rejected");
    // Interior suitability must be stated; it is never assumed.
    expect(check(eight, "feature")).toMatchObject({ state: "unknown" });
    const recs = data.recommendations;
    const best = recs.find((x: any) => x.kinds.includes("best_overall"));
    expect(best.offerId).toBe(gallon.offerId); // one container, same delivery fit
    expect(recs.find((x: any) => x.kinds.includes("lowest_cost")).offerId).toBe(gallon.offerId);
  });
});

describe("scenario 2: four monitors for incoming interns", () => {
  it("prices four units, rejects accessories, keeps 'at least 27 in' as a minimum, and keeps unknown delivery and stock unknown", async () => {
    const { data, by, check } = await research(harness(), preset("growing_business_monitors"));
    const big = by(/32" QHD/);
    expect(check(big, "screen_size").state).toBe("supported"); // 32 in meets "at least 27 in"
    const two = by(/2-Pack/);
    expect(two).toMatchObject({ packageQuantity: 2, packagesRequired: 2 });
    expect(by(/Monitor Arm/).eligibility).toBe("rejected");
    expect(by(/Full HD 1080p/).eligibility).toBe("rejected");
    // Fixture listings state no delivery date: against a hard deadline that is not proof of on-time arrival.
    const qhd = by(/Acme View 27" QHD 2560x1440 IPS/);
    expect(check(qhd, "delivery_by").state).toBe("unknown");
    expect(qhd.eligibility).toBe("needs_review");
    expect(qhd.unknowns.join(" ")).toMatch(/stock for 4 units not confirmed/);
    expect(data.recommendations).toEqual([]);
  });
});

describe("scenario 3: urgent café blender", () => {
  it("accepts only complete, explicitly commercial blenders with a 64 fl oz pitcher that arrive in time", async () => {
    const { data, by, check, run } = await research(harness(), preset("cafe_blender"));
    const ok = by(/Commercial Countertop Blender, 64 fl oz/);
    expect(ok.eligibility).toBe("eligible");
    // "Professional" and wattage are not a commercial-use designation.
    const pro = by(/Professional 72 oz/);
    expect(pro.eligibility).toBe("needs_review");
    expect(check(pro, "feature")).toMatchObject({ state: "unknown" });
    expect(check(pro, "volume").state).toBe("supported"); // 72 oz pitcher read as fluid ounces
    // The bare word "Commercial" in a seller's title is a keyword, not a designation.
    expect(check(ok, "feature")).toMatchObject({ state: "supported" });
    expect(check(ok, "feature").reason).toMatch(/rated for commercial use/i);
    expect(by(/Replacement 64 oz Pitcher/).eligibility).toBe("rejected");
    expect(by(/Personal Blender/).eligibility).toBe("rejected");
    expect(by(/48 oz/).eligibility).toBe("rejected");
    expect(by(/Monitor/).eligibility).toBe("rejected"); // category isolation
    // A cheaper blender that misses the hard deadline is a noncompliant alternative, never a recommendation.
    const late = by(/64 oz Jar/);
    expect(late.eligibility).toBe("rejected");
    expect(data.recommendations.map((x: any) => x.offerId)).toEqual([ok.offerId]);
    expect(data.noncompliantAlternatives.map((x: any) => x.offerId)).toContain(late.offerId);
    expect(run.outcome).toBe("candidates_found");
  });
});

describe("scenario 4: portable power for a community event", () => {
  it("keeps Wh capacity and W output distinct and excludes power banks, panels and fuel generators", async () => {
    const { data, by, check } = await research(harness(), preset("nonprofit_power_station"));
    expect(by(/518Wh/)).toMatchObject({ eligibility: "eligible" });
    expect(by(/1024Wh/)).toMatchObject({ eligibility: "eligible" });
    const small = by(/288Wh/);
    expect(small.eligibility).toBe("rejected");
    expect(check(small, "capacity_wh")).toMatchObject({ state: "contradicted" });
    // 600 W of output says nothing about stored energy.
    const wattsOnly = by(/600W Output/);
    expect(check(wattsOnly, "capacity_wh")).toMatchObject({ state: "unknown" });
    expect(wattsOnly.eligibility).toBe("needs_review");
    expect(by(/Power Bank/).eligibility).toBe("rejected");
    expect(by(/Solar Panel/).eligibility).toBe("rejected");
    expect(by(/Gas Generator/).eligibility).toBe("rejected");
    const late = by(/512Wh/);
    expect(late.eligibility).toBe("rejected");
    expect(data.noncompliantAlternatives.map((x: any) => x.offerId)).toContain(late.offerId);
    expect(data.recommendations.find((x: any) => x.kinds.includes("lowest_cost")).offerId).toBe(by(/518Wh/).offerId);
  });
});

describe("outside the four sectors", () => {
  it("general search is explicit, and every result stays needs-review with nothing recommended", async () => {
    const h = harness({ shopping: new FixtureShopping(FIXTURE_MONITOR_ITEMS) });
    const created = (await h.call("POST", "/api/v1/requests", { title: "Car rocket boosters", description: "Compressed-air boosters for a fun car project", quantity: 1, currency: "USD", budgetCents: 100000, budgetBasis: "total", allowedCondition: "any" })).body.data;
    expect(created.category).toBeNull();
    const q = created.questions.find((x: any) => x.id === "q_category");
    expect(q.options.at(-1)).toMatchObject({ value: "general", label: expect.stringMatching(/general search/) });
    const clar = (await h.call("POST", `/api/v1/requests/${created.id}/clarify`, { expectedVersion: created.version, answers: [{ questionId: "q_category", value: "general" }] })).body.data;
    expect(clar.category).toBe("general");
    await h.call("POST", `/api/v1/requests/${created.id}/confirm`, { version: clar.version });
    const start = await h.call("POST", `/api/v1/requests/${created.id}/research`, { version: clar.version });
    await awaitRun(start.body.data.runId);
    expect(h.shopping.calls[0]!.q).toBe("Car rocket boosters"); // the request's own words, no category term
    const data = (await h.call("GET", `/api/v1/requests/${created.id}/candidates`)).body.data;
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates.some((c: any) => c.eligibility === "eligible")).toBe(false);
    expect(data.recommendations).toEqual([]);
    expect((await h.call("GET", `/api/v1/runs/${start.body.data.runId}`)).body.data.outcome).toBe("no_confirmed_match");
  });
});

describe("dates and runs", () => {
  it("a saved deadline stays fixed, and starting research again while a run is active does not launch another", async () => {
    const h = harness({ shopping: new FixtureShopping(null, { delayMs: 300 }) });
    const b = body(preset("cafe_blender"));
    const r = (await h.call("POST", "/api/v1/requests", b)).body.data;
    expect(r.deadline).toBe(b.deadline);
    await h.call("POST", `/api/v1/requests/${r.id}/confirm`, { version: r.version });
    const first = await h.call("POST", `/api/v1/requests/${r.id}/research`, { version: r.version });
    const again = await h.call("POST", `/api/v1/requests/${r.id}/research`, { version: r.version });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("RUN_ALREADY_ACTIVE");
    await awaitRun(first.body.data.runId);
    expect((await h.call("GET", `/api/v1/requests/${r.id}`)).body.data.deadline).toBe(b.deadline);
  });
});
