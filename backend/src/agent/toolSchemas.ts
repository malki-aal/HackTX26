// Typed inputs for the agent's tools. Shared by the eve tool files (agent/tools/*.ts) and the
// server-side tool host, which re-validates every call. Tools never accept organization, request,
// run or account ids: scope always comes from server context.
import { z } from "zod";

export const ToolInputs = {
  getConfirmedRequirements: z.object({}).strict(),
  searchProducts: z
    .object({
      query: z.string().trim().min(3).max(120).optional().describe("Optional refined Google Shopping query. Omit to use the next planned query."),
    })
    .strict(),
  getProductDetails: z
    .object({
      offerId: z.string().min(1).max(100).describe("An offer id returned by searchProducts or evaluateCandidates in this run"),
    })
    .strict(),
  evaluateCandidates: z.object({}).strict(),
  readBudgetContext: z.object({}).strict(),
  prepareProposalDraft: z
    .object({
      recommendedOfferId: z.string().min(1).max(100).describe("Must be an offer id returned by evaluateCandidates"),
      explanation: z.string().min(1).max(1000).describe("Short explanation for the employee. Cite requirement checks; do not claim certification."),
      alternativeOfferIds: z.array(z.string().max(100)).max(3).default([]),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof ToolInputs;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  getConfirmedRequirements: "Read the confirmed purchase requirements, quantity and budget for this research run.",
  searchProducts: "Run one Google Shopping search (via SerpApi) for this run. Calls are capped per run; results are normalized and stored server-side.",
  getProductDetails:
    "Fetch the product specification page for one offer in this run to gather evidence (ports, resolution, size, seller shipping and stock). Use it for top candidates whose mandatory requirements are unconfirmed. Capped per run.",
  evaluateCandidates: "Deterministically check all collected offers against the requirements and return the computed ranking. The ranking cannot be changed.",
  readBudgetContext: "Read the company bank account context (Capital One Nessie sandbox) and available budget.",
  prepareProposalDraft: "Record a short explanation for the computed recommendation. The recommended offer must exist; this does not submit or approve anything.",
};
