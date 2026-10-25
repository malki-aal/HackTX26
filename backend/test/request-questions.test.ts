// Model clarification questions never re-ask what the request form already set.
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";
import { askedOnForm } from "../src/services/requests.js";
import type { ExtractInput, RequirementExtractor } from "../src/integrations/gemini.js";

class AskingExtractor implements RequirementExtractor {
  readonly source = "fixture" as const;
  seen: ExtractInput | null = null;
  async extract(input: ExtractInput) {
    this.seen = input;
    return {
      requirements: [],
      questions: [
        { text: "What is your budget for the commercial countertop blender?", affects: "price" },
        { text: "Does it need a sound enclosure for the café counter?", affects: "noise" },
        { text: "How many blenders do you need?", affects: "quantity" },
      ],
    };
  }
}

const body = {
  title: "Urgent replacement café blender",
  purpose: "Smoothie orders are backing up.",
  description: "Countertop blender. At least 64 US fluid ounces pitcher capacity (required). Explicit commercial-use designation (required).",
  quantity: 1, unit: "blender", currency: "USD", budgetCents: 30000, budgetBasis: "total", allowedCondition: "new",
  deadline: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), deadlineType: "hard", presetId: "cafe_blender",
};

describe("model clarification questions", () => {
  it("drops questions the form already answers and tells the model what is set", async () => {
    const h = harness();
    const extractor = new AskingExtractor();
    (h.ctx.adapters as { extractor: RequirementExtractor }).extractor = extractor;
    const r = (await h.call("POST", "/api/v1/requests", body)).body.data;
    const texts = r.questions.map((q: { text: string }) => q.text);
    expect(texts).toEqual(["Does it need a sound enclosure for the café counter?"]);
    expect(extractor.seen?.alreadySet).toEqual(expect.arrayContaining(["budget $300.00 (total)", "quantity 1 blender", "condition new"]));
  });

  it("recognizes budget, quantity, condition and deadline questions", () => {
    const f = { deadline: "2026-10-28" } as never;
    expect(askedOnForm({ text: "What is your budget?", affects: "price" }, f)).toBe(true);
    expect(askedOnForm({ text: "How much can you spend?", affects: "" }, f)).toBe(true);
    expect(askedOnForm({ text: "Would a refurbished unit be acceptable?", affects: "condition" }, f)).toBe(true);
    expect(askedOnForm({ text: "When do you need it by?", affects: "deadline" }, f)).toBe(true);
    expect(askedOnForm({ text: "Which pitcher material do you prefer?", affects: "material" }, f)).toBe(false);
  });
});
