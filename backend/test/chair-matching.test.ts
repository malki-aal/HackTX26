import { describe, expect, it } from "vitest";
import { RequestFields } from "../src/contracts/domain.js";
import { getCategory } from "../src/domain/categories.js";
import { deriveRequirements } from "../src/domain/requirements.js";
import { normalizeOffer } from "../src/domain/normalize.js";
import { evaluateCandidates, evaluateRequirement } from "../src/domain/evaluate.js";
import { enforceRequiredFeatures } from "../src/services/research.js";

const profile = getCategory("office_chairs")!;
const fields = RequestFields.parse({ title: "Chairs", description: "Ergonomic required", category: profile.id, quantity: 4, budgetCents: 240000, currency: "USD", allowedCondition: "any" });
const requirements = deriveRequirements(fields);
function offer(title: string, price: string) {
  const r = normalizeOffer({ title, price, source: "Target" }, { runId: "r", queryId: "q", observedAt: new Date(), offerMaxAgeMinutes: 30, fromCache: false, category: profile });
  if (!r.ok) throw new Error(r.reason);
  return r.offer;
}

describe("chair-search regressions", () => {
  it("Any condition does not require listing proof, but New still does", () => {
    const chair = offer("Ergonomic office chair", "$49.99");
    const any = requirements.find((r) => r.attribute === "condition")!;
    expect(evaluateRequirement(any, chair)).toMatchObject({ state: "supported", evidenceIds: [] });
    const restricted = deriveRequirements({ ...fields, allowedCondition: "new" }).find((r) => r.attribute === "condition")!;
    expect(evaluateRequirement(restricted, chair).state).toBe("unknown");
  });
  it("ranks a listing with ergonomic evidence over a cheap generic chair without inventing evidence", () => {
    const offers = [offer("Basic office chair", "$39.99"), offer("Ergonomic office chair", "$69.99")];
    const ranked = evaluateCandidates(offers, requirements, 4, 240000);
    expect(ranked[0]!.offerId).toBe(offers[1]!.id);
    expect(ranked[0]!.cost.listedSubtotalCents).toBe(27996);
    expect(ranked[1]!.requirementResults.find((r) => r.attribute === "feature")!.state).toBe("unknown");
  });
  it("keeps ergonomic in even model-proposed generic queries", () => {
    expect(enforceRequiredFeatures("cheap office chairs", requirements, profile)).toMatch(/ergonomic/);
    expect(enforceRequiredFeatures("ergonomic office chair", requirements, profile)).toBe("ergonomic office chair");
  });
});
