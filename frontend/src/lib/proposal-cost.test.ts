import { describe, expect, it } from "vitest";
import { proposedCost } from "./proposal-cost";
import { CONDITION_LABEL } from "./labels";

describe("proposal costs and display", () => {
  it("uses the four-chair subtotal, not the $2400 budget", () => {
    expect(proposedCost([{ listedSubtotalCents: 19996, shippingCents: 0 }])).toBe(19996);
  });
  it("adds known shipping and explicitly entered extras exactly once", () => {
    expect(proposedCost([{ listedSubtotalCents: 19996, shippingCents: 500 }], 1650)).toBe(22146);
  });
  it("does not invent an unknown price or accept negative extras", () => {
    expect(proposedCost([{ listedSubtotalCents: null, shippingCents: null }])).toBeNull();
    expect(proposedCost([{ listedSubtotalCents: 19996, shippingCents: null }], -1)).toBeNull();
    expect(proposedCost([])).toBeNull();
  });
  it("formats unrestricted condition for people", () => {
    expect(CONDITION_LABEL.any).toBe("Any condition");
  });
});
