import { describe, expect, it } from "vitest";
import { decimalStringToCents, floatToCents, parsePriceText, formatUsd } from "../src/domain/money.js";
import { extractPorts, extractProductType, extractResolution, extractScreenSize, extractPackageQuantity } from "../src/domain/extract.js";
import { deriveMonitorRequirements, validateRequirements, buildClarificationQuestions, mergeExtractedRequirements, applyClarificationAnswers } from "../src/domain/requirements.js";
import { normalizeOffer, dedupeOffers } from "../src/domain/normalize.js";
import { evaluateCandidates, evaluateRequirement, calculatePurchaseCost, rankCandidates } from "../src/domain/evaluate.js";
import { assessBudget, computeFinancialContext, reconcileReflections, type LedgerEntry } from "../src/domain/budget.js";
import { FIXTURE_MONITOR_ITEMS } from "../src/integrations/fixtures.js";
import { RequestFields } from "../src/contracts/domain.js";
import { getCategory } from "../src/domain/categories.js";
import type { Offer, RawShoppingItem } from "../src/domain/types.js";

const ctx = { runId: "run_t", queryId: "q1", observedAt: new Date("2026-10-24T12:00:00Z"), offerMaxAgeMinutes: 30, fromCache: false, category: getCategory("monitors")! };
const norm = (item: RawShoppingItem): Offer => {
  const r = normalizeOffer(item, ctx);
  if (!r.ok) throw new Error(r.reason);
  return r.offer;
};
const fields = RequestFields.parse({ title: "Four engineering monitors", description: "Find four new 27-inch monitors, at least 1440p, with HDMI.", category: "monitors", quantity: 4, currency: "USD", budgetCents: 100000 });

describe("money", () => {
  it("parses decimal strings to integer cents", () => {
    expect(decimalStringToCents("1,299.99")).toBe(129999);
    expect(decimalStringToCents("45")).toBe(4500);
    expect(decimalStringToCents("0.5")).toBe(50);
    expect(decimalStringToCents("-1")).toBeNull();
    expect(decimalStringToCents("1.234")).toBeNull();
    expect(decimalStringToCents("NaN")).toBeNull();
  });
  it("converts provider floats without float drift", () => {
    expect(floatToCents(5.88)).toBe(588);
    expect(floatToCents(0.1 + 0.2)).toBe(30);
    expect(floatToCents(Number.NaN)).toBeNull();
    expect(floatToCents(Infinity)).toBeNull();
    expect(floatToCents(-3)).toBeNull();
    expect(floatToCents("5" as unknown)).toBeNull();
  });
  it("detects currency and rejects non-USD", () => {
    expect(parsePriceText("$219.99")).toMatchObject({ currency: "USD", cents: 21999 });
    expect(parsePriceText("€219.99").currency).toBeNull();
    expect(parsePriceText("€219.99").currencyToken).toBe("€");
    expect(formatUsd(123456)).toBe("$1,234.56");
  });
});

describe("request validation", () => {
  it("rejects NaN, infinity, negative, excessive and mistyped values", () => {
    const base = { title: "x", category: "monitors", currency: "USD", quantity: 1, budgetCents: 100 };
    expect(RequestFields.safeParse({ ...base, quantity: Number.NaN }).success).toBe(false);
    expect(RequestFields.safeParse({ ...base, budgetCents: Infinity }).success).toBe(false);
    expect(RequestFields.safeParse({ ...base, budgetCents: -5 }).success).toBe(false);
    expect(RequestFields.safeParse({ ...base, quantity: 100000 }).success).toBe(false);
    expect(RequestFields.safeParse({ ...base, quantity: "4" }).success).toBe(false);
    expect(RequestFields.safeParse({ ...base, budgetCents: 10.5 }).success).toBe(false);
    expect(RequestFields.safeParse({ ...base, currency: "EUR" }).success).toBe(false);
    expect(RequestFields.safeParse(base).success).toBe(true);
  });
});

describe("extraction", () => {
  it("does not confuse 1440p with 1080p or 144Hz with a resolution", () => {
    expect(extractResolution("27in 1440p monitor")?.value).toEqual({ width: 2560, height: 1440 });
    expect(extractResolution("27in 1080p monitor")?.value).toEqual({ width: 1920, height: 1080 });
    expect(extractResolution("27in 144Hz monitor")).toBeNull();
    expect(extractResolution("3840 x 2160 panel")?.value).toEqual({ width: 3840, height: 2160 });
  });
  it("distinguishes HDMI from USB-C", () => {
    expect(extractPorts("HDMI 2.0, DisplayPort").map((p) => p.value).sort()).toEqual(["displayport", "hdmi"]);
    expect(extractPorts("USB-C 65W").map((p) => p.value)).toEqual(["usb_c"]);
  });
  it("finds screen sizes in common notations", () => {
    expect(extractScreenSize('Acme 27" QHD')?.value).toBe(27);
    expect(extractScreenSize("27-inch")?.value).toBe(27);
    expect(extractScreenSize("31.5 inch")?.value).toBe(31.5);
    expect(extractScreenSize("165Hz")).toBeNull();
  });
  it("classifies accessories versus monitors", () => {
    expect(extractProductType("Dual Monitor Arm Desk Mount for 27 inch Screens")?.value).toBe("accessory");
    expect(extractProductType("HDMI Cable for Monitor")?.value).toBe("accessory");
    expect(extractProductType('27" QHD Monitor with height adjustable stand 2560x1440')?.value).toBe("monitor");
    // Real titles observed in live SerpApi results:
    expect(extractProductType('Dell S2725ds Monitor 27" Qhd (2560x1440) 100hz - Button Board')?.value).toBe("accessory");
    expect(extractProductType("LG 27GP850 Monitor Replacement Power Board")?.value).toBe("accessory");
    expect(extractProductType("Crua 27 inch 4K UHD Monitor, IPS Flat Panel, FreeSync, hdmi & DP Ports, Hdr, Wall Mountable Black")?.value).toBe("monitor");
    expect(extractProductType("Dell 27 Monitor with VESA Wall Mount Ready, HDMI")?.value).toBe("monitor");
    expect(extractProductType("27 inch Monitor with built-in USB hub and speakers")?.value).toBe("monitor");
    expect(extractProductType("Desk Mount for 27 inch monitor with built-in USB hub")?.value).toBe("accessory");
  });
  it("detects multipacks", () => {
    expect(extractPackageQuantity("Monitor 2-Pack")).toMatchObject({ value: 2 });
    expect(extractPackageQuantity("Pack of 3 monitors")).toMatchObject({ value: 3 });
    expect(extractPackageQuantity("Monitor bundle with keyboard")).toHaveProperty("ambiguous");
  });
});

describe("requirements", () => {
  it("derives mandatory monitor predicates from the request", () => {
    const reqs = deriveMonitorRequirements(fields);
    const attrs = reqs.map((r) => r.attribute);
    expect(attrs).toEqual(expect.arrayContaining(["product_type", "screen_size", "resolution", "port", "condition"]));
    expect(validateRequirements(reqs, fields).ok).toBe(true);
  });
  it("marks preferences as non-mandatory", () => {
    const reqs = deriveMonitorRequirements({ ...fields, description: "27 inch 1440p, preferably USB-C" });
    expect(reqs.find((r) => r.attribute === "port")?.mandatory).toBe(false);
  });
  it("drops model-extracted requirements whose source text is not in the request", () => {
    const { merged, dropped } = mergeExtractedRequirements(deriveMonitorRequirements(fields), [{ id: "x", attribute: "brand", operator: "in", value: ["Dell"], mandatory: true, sourceText: "must be Dell" }], fields.description);
    expect(merged.some((r) => r.attribute === "brand")).toBe(false);
    expect(dropped.length).toBe(1);
  });
  it("asks only decision-relevant questions and applies answers", () => {
    const reqs = deriveMonitorRequirements(fields);
    const qs = buildClarificationQuestions({ fields, explicitFields: new Set(["allowedCondition"]), requirements: reqs });
    expect(qs.map((q) => q.id)).toEqual(expect.arrayContaining(["q_budget_basis", "q_mandatory_req_port_hdmi"]));
    const applied = applyClarificationAnswers(fields, reqs, [{ questionId: "q_mandatory_req_port_hdmi", value: "preferred" }, { questionId: "q_budget_basis", value: "total" }]);
    expect(applied.requirements.find((r) => r.id === "req_port_hdmi")?.mandatory).toBe(false);
    expect(applied.fields.budgetBasis).toBe("total");
  });
  it("asks nothing when all information is present", () => {
    const f = { ...fields, description: "Four new 27-inch monitors, 1440p, HDMI required, $1000 total" };
    const qs = buildClarificationQuestions({ fields: f, explicitFields: new Set(["allowedCondition", "budgetBasis"]), requirements: deriveMonitorRequirements(f) });
    expect(qs).toEqual([]);
  });
});

describe("evaluation and ranking", () => {
  const reqs = deriveMonitorRequirements(fields);
  const offers = dedupeOffers(FIXTURE_MONITOR_ITEMS.map(norm));
  const evals = evaluateCandidates(offers, reqs, 4, 100000);
  const byTitle = (s: string) => {
    const o = offers.find((x) => x.title.includes(s))!;
    return evals.find((e) => e.offerId === o.id)!;
  };

  it("rejects contradicted mandatory requirements", () => {
    expect(byTitle("Full HD 1080p").class).toBe("rejected");
    expect(byTitle("Monitor Arm").class).toBe("rejected");
    expect(byTitle("32\"").class).toBe("rejected");
    expect(byTitle("Renewed").class).toBe("rejected");
  });
  it("treats unknown as needs_review, not false", () => {
    const usbc = byTitle("Corvo");
    expect(usbc.requirementResults.find((r) => r.attribute === "port")?.state).toBe("unknown");
    expect(usbc.class).toBe("needs_review");
  });
  it("excludes installment prices from cost", () => {
    const e = byTitle("Zenit");
    expect(e.cost.listedSubtotalCents).toBeNull();
    expect(e.class).not.toBe("eligible");
  });
  it("calculates multipack cost for requested quantity", () => {
    const e = byTitle("2-Pack");
    expect(e.cost.packagesRequired).toBe(2);
    expect(e.cost.listedSubtotalCents).toBe(83996);
    expect(e.cost.totalStatus).toBe("subtotal_plus_shipping_tax_unknown");
  });
  it("ranks eligible lowest known cost first, deterministically", () => {
    const eligible = evals.filter((e) => e.class === "eligible");
    expect(eligible.length).toBeGreaterThan(0);
    const costs = eligible.map((e) => e.cost.knownComparableCostCents!);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(evals[0]!.class).toBe("eligible");
    const again = evaluateCandidates([...offers].reverse(), reqs, 4, 100000);
    expect(again.map((e) => e.offerId)).toEqual(evals.map((e) => e.offerId));
  });
  it("breaks ties by evidence completeness then id", () => {
    const a = { ...evals[0]!, offerId: "b", evidenceCompleteness: 3 };
    const b = { ...evals[0]!, offerId: "a", evidenceCompleteness: 3 };
    const c = { ...evals[0]!, offerId: "c", evidenceCompleteness: 5 };
    expect(rankCandidates([a, b, c]).map((e) => e.offerId)).toEqual(["c", "a", "b"]);
  });
  it("rejects known budget violations and reports no confirmed match", () => {
    const tight = evaluateCandidates(offers, reqs, 4, 50000);
    expect(tight.some((e) => e.class === "eligible")).toBe(false);
  });
  it("flags missing shipping and tax as provisional", () => {
    const c = calculatePurchaseCost(offers[1]!, 4);
    expect(c.provisional).toBe(true);
    expect(c.taxCents).toBeNull();
  });
  it("evidence from a prompt-injection snippet is only data", () => {
    const o = offers.find((x) => x.title.includes("Nova"))!;
    const r = evaluateRequirement(reqs.find((x) => x.attribute === "resolution")!, o);
    expect(r.state).toBe("supported");
  });
  it("treats renewed/used storefronts as second-hand condition evidence", () => {
    const o = norm({ title: 'KTC 27" QHD Monitor', source: "Walmart - B2B Renew", price: "$95.99" });
    expect(o.condition).toBe("refurbished");
    const r = evaluateRequirement(reqs.find((x) => x.attribute === "condition")!, o);
    expect(r.state).toBe("contradicted");
  });
  it("rejects non-USD offers at normalization", () => {
    expect(normalizeOffer({ title: "27 inch monitor", price: "€199.00" }, ctx).ok).toBe(false);
  });
  it("keeps different sellers when deduplicating", () => {
    const a = norm({ title: "Monitor X 27\"", source: "A", price: "$100" });
    const b = norm({ title: "Monitor X 27\"", source: "B", price: "$100" });
    const a2 = { ...a, id: "dup" };
    expect(dedupeOffers([a, b, a2]).length).toBe(2);
  });
});

describe("budget", () => {
  const snapshot = { accountId: "acc", balanceCents: 500000, fetchedAt: "t", source: "nessie_live" as const, bills: [{ id: "b1", payee: "Lease", status: "pending", amountCents: 120000 }, { id: "b2", payee: "Old", status: "completed", amountCents: 9999 }] };
  const expense = (id: string, amount: number, createdAt: string): LedgerEntry => ({ id, kind: "expense", amountCents: amount, status: "unreflected", createdAt });

  it("subtracts pending obligations, reservations and unreflected expenses, not posted bills", () => {
    const ctx2 = computeFinancialContext(snapshot, [{ id: "r1", kind: "reservation", amountCents: 50000, status: "active", createdAt: "1" }, expense("e1", 20000, "2")]);
    expect(ctx2.availableBudgetCents).toBe(500000 - 120000 - 50000 - 20000);
  });
  it("released reservations do not count", () => {
    expect(computeFinancialContext(snapshot, [{ id: "r1", kind: "reservation", amountCents: 50000, status: "released", createdAt: "1" }]).availableBudgetCents).toBe(380000);
  });
  it("remote balance unchanged: expense stays subtracted", () => {
    const r = reconcileReflections(500000, 500000, [expense("e1", 20000, "1")]);
    expect(r.reflectedIds).toEqual([]);
  });
  it("remote balance drops by exactly the expense: no double subtraction", () => {
    const r = reconcileReflections(500000, 480000, [expense("e1", 20000, "1"), expense("e2", 5000, "2")]);
    expect(r.reflectedIds).toEqual(["e1"]);
  });
  it("unexplained balance change keeps expenses subtracted (conservative)", () => {
    const r = reconcileReflections(500000, 470000, [expense("e1", 20000, "1")]);
    expect(r.reflectedIds).toEqual([]);
    expect(r.notes[0]).toMatch(/does not match/);
  });
  it("assesses budget states", () => {
    const fc = computeFinancialContext(snapshot, []);
    expect(assessBudget({ amountCents: 90000, amountBasis: "listed_subtotal", requestBudgetCents: 100000, financial: fc }).status).toBe("within_budget_provisional");
    expect(assessBudget({ amountCents: 110000, amountBasis: "listed_subtotal", requestBudgetCents: 100000, financial: fc }).status).toBe("exceeds_request_budget");
    expect(assessBudget({ amountCents: 90000, amountBasis: "user_confirmed_exact", requestBudgetCents: 1000000, financial: computeFinancialContext({ ...snapshot, balanceCents: 100000 }, []) }).status).toBe("exceeds_available_funds");
    expect(assessBudget({ amountCents: 90000, amountBasis: "listed_subtotal", requestBudgetCents: 100000, financial: computeFinancialContext(null, []) }).status).toBe("bank_check_unavailable");
  });
});
