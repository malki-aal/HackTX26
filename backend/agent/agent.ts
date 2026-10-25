// Runway purchasing-agent engine. One agent; per-run behavior comes from the saved configuration
// the Runway server sends with each run. Gemini is called directly with the team's API key
// through a provider-authored LanguageModel, not an AI Gateway model string.
import { defineAgent } from "eve";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { wrapLanguageModel } from "ai";

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });

// Client-side pacing for rate-limited tiers (the Gemini free tier allows 5 requests/minute for
// Flash models). 0 disables pacing. Calls wait for a slot instead of failing with HTTP 429.
const maxRpm = Number(process.env.GEMINI_MAX_RPM || 0);
const recent: number[] = [];
async function rateSlot(): Promise<void> {
  if (!maxRpm) return;
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0]! >= 60_000) recent.shift();
    if (recent.length < maxRpm) {
      recent.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 60_000 - (now - recent[0]!) + 250));
  }
}

const model = wrapLanguageModel({
  model: google(process.env.GEMINI_MODEL || "gemini-model-not-configured"),
  middleware: {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      await rateSlot();
      return doGenerate();
    },
    wrapStream: async ({ doStream }) => {
      await rateSlot();
      return doStream();
    },
  },
});

export default defineAgent({
  model,
  modelContextWindowTokens: 1_000_000,
  // No shell, file system, web fetch, web search or subagents: only the six authored tools.
  defaultTools: false,
  tool: false,
  limits: {
    // Runway enforces step, search and time limits per run; this is a coarse backstop.
    sessionUsage: ({ window }) => window.inputTokens - window.cacheReadTokens >= 2_000_000,
    sessionTimeoutMs: 24 * 60 * 60 * 1000,
  },
});
