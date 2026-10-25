// Shortlist selection, duplicate handling and model-wording validation/fallback (fixtures only).
import { describe, expect, it } from "vitest";
import { normalizeOffer } from "../src/domain/normalize.js";
import { evaluateCandidates } from "../src/domain/evaluate.js";
import { buildShortlist } from "../src/domain/shortlist.js";
import { applyNotes, checkNote } from "../src/domain/shortlistNotes.js";
import { getCategory } from "../src/domain/categories.js";
import { harness, EXEC } from "./helpers.js";
import { awaitRun } from "../src/services/research.js";
import { ScriptedAgentRunner, type AgentRunInput, type AgentRunOutput, type AgentRunner } from "../src/agent/runner.js";
import { IntegrationError } from "../src/lib/errors.js";
import type { Offer, RawShoppingItem, Requirement } from "../src/domain/types.js";
import SCENARIOS from "../demo/scenarios.json" with { type: "json" };

const blender = getCategory("countertop_blender")!;
const observedAt = new Date("2026-10-25T14:00:00Z");
const reqs = (deadline = "2026-10-30"): Requirement[] =>
  [
    { id: "req_category", attribute: "product_type", operator: "eq", value: "countertop_blender", mandatory: true, sourceText: "" },
    { id: "req_volume", attribute: "volume", operator: "gte", value: 1893, unit: "ml", mandatory: true, sourceText: "" },
    { id: "req_feature_commercial_use", attribute: "feature", operator: "includes", value: "commercial_use", label: "Explicitly designated for commercial use", mandatory: true, sourceText: "" },
    { id: "req_condition", attribute: "condition", operator: "in", value: ["new"], mandatory: true, sourceText: "" },
    { id: "req_delivery_by", attribute: "delivery_by", operator: "lte", value: deadline, unit: "date", mandatory: true, sourceText: "" },
  ] as Requirement[];

function offers(items: Array<Partial<RawShoppingItem> & { title: string }>, location: string | null = "Austin, Texas, United States"): Offer[] {
  return items.map((it, i) => {
    const r = normalizeOffer({ source: `Seller ${i}`, ...it }, { runId: "r", queryId: `q${i}`, observedAt, offerMaxAgeMinutes: 30, fromCache: false, category: blender, timeZone: "America/Chicago", deliveryLocation: location });
    if (!r.ok) throw new Error(r.reason);
    return r.offer;
  });
}
const shortlist = (list: Offer[], budget = 30000, deadline?: string) =>
  buildShortlist({ evals: evaluateCandidates(list, reqs(deadline), 1, budget), offers: list, requirements: reqs(deadline), budgetCents: budget, categoryId: "countertop_blender" });
const label = (sl: ReturnType<typeof shortlist>, list: Offer[]) => sl.entries.map((e) => `${e.label}: ${list.find((o) => o.id === e.offerId)!.title}`);

const GOOD = "New Blender for commercial use, 64 oz pitcher";

describe("shortlist selection", () => {
  it("folds the same product from several sellers unless their terms differ meaningfully", () => {
    const list = offers([
      { title: GOOD, price: "$200.00", delivery: "Free delivery by Tue", source: "A" },
      { title: GOOD, price: "$201.00", delivery: "Free delivery by Tue", source: "B" }, // $1 apart: same option
      { title: GOOD, price: "$150.00", delivery: "Free delivery by Tue", source: "C" }, // $50 cheaper: a real alternative
    ]);
    const sl = shortlist(list);
    expect(sl.folded).toEqual([{ offerId: list[1]!.id, into: list[0]!.id }]);
    expect(sl.entries.map((e) => e.offerId)).not.toContain(list[1]!.id);
    // C is cheaper with the same evidence, so it ranks first; A is the backup.
    expect(label(sl, list)).toEqual([`Closest match: ${GOOD}`, `Another full match: ${GOOD}`]);
    expect(sl.entries[1]!.explanation).toMatch(/Costs \$50\.00 more than the closest match/);
  });

  it("never offers a failed must-have as a match, and computes the price difference", () => {
    const list = offers([
      { title: GOOD, price: "$200.00", delivery: "Free delivery by Tue" },
      { title: "New Blender for commercial use, 48 oz pitcher", price: "$160.00", delivery: "Free delivery by Tue" },
    ]);
    const sl = shortlist(list);
    const comp = sl.entries.find((e) => e.role === "cheaper_compromise")!;
    expect(comp).toMatchObject({ label: "Cheaper, misses a must-have", status: "Below required capacity", compliance: "fails_must_have" });
    expect(comp.explanation).toBe("Costs $40.00 less than the closest match, but states 48 fl oz, below 64 fl oz.");
    expect(comp.facts.costVsClosestCents).toBe(-4000);
  });

  it("shows delivery as unconfirmed when the listing has no date, and an estimate without location as an estimate", () => {
    const list = offers([{ title: GOOD, price: "$200.00" }], null);
    const sl = shortlist(list);
    expect(sl.entries[0]).toMatchObject({ status: "Delivery unconfirmed", compliance: "unconfirmed" });
    expect(sl.entries[0]!.compromise).toMatch(/^No delivery date in the listing data/);
    expect(sl.headline).toMatch(/No option meets every must-have with confirmed evidence yet/);
    const est = shortlist(offers([{ title: GOOD, price: "$200.00", delivery: "Free delivery by Tue" }], null));
    expect(est.entries[0]!.status).toBe("Delivery estimate only");
    expect(est.entries[0]!.compromise).toMatch(/delivery is a Google estimate, not confirmed for your address/i);
  });

  it("prefers stronger delivery evidence when the closest match lacks it", () => {
    const list = offers([
      { title: GOOD, price: "$150.00" },
      { title: GOOD.replace("New Blender", "New Pro Blender"), price: "$190.00", delivery: "Free delivery by Tue" },
    ]);
    const sl = shortlist(list);
    // The dated estimate ranks first because deadline risk outranks price.
    expect(label(sl, list)[0]).toMatch(/^Closest match: New Pro Blender/);
    const dated = shortlist(list.slice(0, 1).concat(list[1]!));
    expect(dated.entries.map((e) => e.role)).not.toContain("delivery_evidence"); // nothing stronger than the closest match
  });

  it("returns fewer options when nothing else is meaningfully different", () => {
    const list = offers([{ title: GOOD, price: "$200.00", delivery: "Free delivery by Tue" }]);
    expect(shortlist(list).entries).toHaveLength(1);
  });
});

describe("model wording is validated against computed facts", () => {
  const list = offers([
    { title: GOOD, price: "$200.00", delivery: "Free delivery by Tue" },
    { title: "New Blender for commercial use, 48 oz pitcher", price: "$160.00", delivery: "Free delivery by Tue" },
  ]);
  const sl = shortlist(list);
  const [top, comp] = sl.entries;
  const opts = { locationSet: true };

  it("accepts wording that uses only computed numbers", () => {
    expect(checkNote({ offerId: comp!.offerId, label: "Cheaper, smaller pitcher", why: "Costs $40 less than the closest match.", drawback: "Its 48 oz pitcher is below your required 64 oz." }, comp, opts)).toBeNull();
  });

  it.each([
    [{ label: "Best value", why: "Costs $55 less.", drawback: "Smaller." }, /number 55/],
    [{ label: "Premium quality pick", why: "Higher quality build.", drawback: "Costs more." }, /quality/],
    [{ label: "Fast", why: "Will arrive before your deadline.", drawback: "None." }, /confirmed arrival/],
    [{ label: "One two three four five six", why: "x", drawback: "y" }, /1–5 words/],
    [{ label: "NSF option", why: "NSF certified for cafés.", drawback: "None." }, /certification/],
  ])("rejects %j", (bad, why) => {
    expect(checkNote({ offerId: top!.offerId, ...bad }, top, opts)).toMatch(why);
  });

  it("rejects invented ids and match labels on failed must-haves, falling back per entry", () => {
    const { shortlist: out, verdicts } = applyNotes(
      sl,
      [
        { offerId: "off_invented", label: "Great pick", why: "Fine.", drawback: "None." },
        { offerId: comp!.offerId, label: "Close match", why: "Costs $40 less than the closest match.", drawback: "Smaller pitcher." },
        { offerId: top!.offerId, label: "Closest fit", why: "Meets the 64 fl oz and commercial-use checks.", drawback: "Tax is unknown." },
      ],
      opts,
    );
    expect(verdicts.map((v) => [v.accepted, v.reason])).toEqual([
      [false, "offerId is not on the shortlist"],
      [false, "a failed must-have cannot be labelled a match"],
      [true, null],
    ]);
    expect(out.entries[0]).toMatchObject({ label: "Closest fit", source: "model", status: top!.status });
    expect(out.entries[1]).toEqual(comp); // deterministic wording kept
  });

  it("requires an unconfirmed delivery date to be called an estimate", () => {
    const noLoc = shortlist(offers([{ title: GOOD, price: "$200.00", delivery: "Free delivery by Tue" }], null));
    const e = noLoc.entries[0]!;
    expect(checkNote({ offerId: e.offerId, label: "Closest match", why: "Arrives by Tuesday.", drawback: "Condition unknown." }, e, { locationSet: false })).toMatch(/estimate/);
    expect(checkNote({ offerId: e.offerId, label: "Closest match", why: "Google estimates delivery by Tuesday.", drawback: "Condition unknown." }, e, { locationSet: false })).toBeNull();
  });
});

const preset = SCENARIOS.scenarios.find((s) => s.id === "cafe_blender")!;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function runWith(runner: AgentRunner) {
  const h = harness({ runner });
  const r = (await h.call("POST", "/api/v1/requests", { title: preset.title, purpose: preset.purpose, description: `${preset.item}. ${preset.mandatory.map((l) => `${l} (required).`).join(" ")}`, quantity: preset.quantity, unit: preset.unit, currency: "USD", budgetCents: preset.budgetCents, budgetBasis: "total", allowedCondition: preset.condition, deadline: day(preset.deadlineDays), deadlineType: preset.deadlineType, presetId: preset.id })).body.data;
  await h.call("POST", `/api/v1/requests/${r.id}/confirm`, { version: r.version });
  const start = await h.call("POST", `/api/v1/requests/${r.id}/research`, { version: r.version });
  await awaitRun(start.body.data.runId);
  const get = async () => (await h.call("GET", `/api/v1/requests/${r.id}/candidates`, undefined, EXEC)).body.data;
  return { h, runId: start.body.data.runId as string, get };
}

/** A runner that searches, then writes shortlist notes the way the model would (one valid, one not). */
class NotesRunner implements AgentRunner {
  readonly kind = "scripted_fixture" as const;
  async health() {
    return { ok: true, detail: "test" };
  }
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const res = (await input.tools.call("searchProducts", {})) as { evaluation: { candidates: Array<{ offerId: string }>; shortlist: { entries: Array<{ offerId: string; role: string }> } } };
    const [top, second] = res.evaluation.shortlist.entries;
    await input.tools.call("prepareProposalDraft", {
      recommendedOfferId: res.evaluation.candidates[0]!.offerId,
      explanation: `Pick off_${"0".repeat(10)}garbled first.`,
      alternativeOfferIds: [],
      shortlistNotes: [
        { offerId: top!.offerId, label: "Meets every check", why: "Has the 64 fl oz pitcher and a commercial-use statement.", drawback: "Tax is unknown.", unverified: ["Sales tax"] },
        { offerId: second!.offerId, label: "Cheapest", why: "Costs $75 less and ships free.", drawback: "Commercial use unconfirmed.", unverified: [] },
      ],
    });
    return { runtime: this.kind, steps: 2, finalMessage: null, stopReason: "completed" };
  }
}

describe("saved shortlist and fallback", () => {
  it("saves validated model wording once per run and serves it unchanged on refresh", async () => {
    const { h, runId, get } = await runWith(new NotesRunner());
    const first = await get();
    expect(first.shortlist.source).toBe("saved");
    expect(first.shortlist.entries[0]).toMatchObject({ label: "Meets every check", source: "model" });
    // "$75 less" was not computed by the backend, so that entry keeps the deterministic wording.
    expect(first.shortlist.entries[1]).toMatchObject({ label: "Lowest-cost alternative", source: "deterministic" });
    const saved = JSON.parse((h.ctx.db.prepare("SELECT shortlist FROM runs WHERE id = ?").get(runId) as { shortlist: string }).shortlist);
    expect(saved.noteVerdicts).toEqual([
      { offerId: first.shortlist.entries[0].offerId, accepted: true, reason: null },
      { offerId: first.shortlist.entries[1].offerId, accepted: false, reason: "number 75 is not in the computed facts" },
    ]);
    expect(await get()).toEqual(first);
    // The garbled id in the agent's explanation is never shown.
    expect(first.agentExplanation.text).toBe("Pick an offer first.");
  });

  it("falls back to deterministic wording when the model fails", async () => {
    class Failing extends ScriptedAgentRunner {
      override async run(input: AgentRunInput): Promise<AgentRunOutput> {
        await input.tools.call("searchProducts", {});
        throw new IntegrationError("agent_runtime", "UPSTREAM_RATE_LIMITED", "model quota exhausted", "definitive", true);
      }
    }
    const { get } = await runWith(new Failing());
    const data = await get();
    expect(data.shortlist.source).toBe("saved");
    expect(data.shortlist.entries.length).toBeGreaterThan(0);
    expect(data.shortlist.entries.every((e: any) => e.source === "deterministic")).toBe(true);
    expect(data.shortlist.entries[0].label).toBe("Closest match");
  });
});
