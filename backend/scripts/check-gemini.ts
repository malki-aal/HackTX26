// Lists Gemini models available to GEMINI_API_KEY and, if GEMINI_MODEL is set, verifies one
// structured-output call and one function-calling round trip with that model.
import { generateText, Output, stepCountIs, tool } from "ai";
import { z } from "zod";
import { loadEnvFile, parseConfig, secretValues } from "../src/config.js";
import { registerSecrets, scrub } from "../src/lib/redact.js";
import { createGeminiModel, GeminiExtractor, listGeminiModels } from "../src/integrations/gemini.js";

loadEnvFile();
const config = parseConfig(process.env);
registerSecrets(secretValues(config));
if (!config.gemini.apiKey) {
  console.error("GEMINI_API_KEY is not set in backend/.env");
  process.exit(1);
}

const models = (await listGeminiModels(config.gemini.apiKey)).filter((m) => m.methods.includes("generateContent") && m.name.startsWith("gemini"));
console.log(`Models with generateContent available to this key (${models.length}):`);
for (const m of models) console.log(`  ${m.name.padEnd(40)} ${m.displayName}`);
// Newest stable numbered Flash model (no preview/lite/media variants).
const version = (n: string) => Number(/^gemini-(\d+(?:\.\d+)?)-flash$/.exec(n)?.[1] ?? -1);
const suggestion = models.map((m) => m.name).filter((n) => version(n) >= 0).sort((a, b) => version(b) - version(a))[0];
if (suggestion) console.log(`\nSuggested GEMINI_MODEL (a non-lite Flash model): ${suggestion}`);

if (!config.gemini.model) {
  console.log("\nGEMINI_MODEL is not set; set it in backend/.env and rerun to verify tool calling.");
  process.exit(0);
}
if (!models.some((m) => m.name === config.gemini.model)) {
  console.error(`\nGEMINI_MODEL=${config.gemini.model} is not in the list above.`);
  process.exit(1);
}

console.log(`\n1) Structured output with ${config.gemini.model}`);
const extracted = await new GeminiExtractor(config.gemini.apiKey, config.gemini.model).extract({
  title: "Four engineering monitors",
  description: "Find four new 27-inch monitors, at least 1440p, with HDMI. USB-C would be nice.",
  category: "monitors",
});
console.log(JSON.stringify(extracted, null, 2));

console.log(`\n2) Function calling with ${config.gemini.model}`);
const calls: string[] = [];
const res = await generateText({
  model: createGeminiModel(config.gemini.apiKey, config.gemini.model),
  stopWhen: stepCountIs(3),
  tools: {
    lookupPrice: tool({
      description: "Look up the price of a product by id",
      inputSchema: z.object({ productId: z.string() }),
      execute: async ({ productId }) => {
        calls.push(productId);
        return { productId, priceCents: 21999 };
      },
    }),
  },
  // Tools only, no output schema: this mirrors how the eve agent uses the model. (Combining an
  // output schema with tools let Gemini answer without calling the tool in testing.)
  prompt: "Use the lookupPrice tool for product id 'fx1', then report the price in one sentence.",
}).catch((e) => {
  console.error("Function-calling check failed:", scrub(String(e?.message ?? e)));
  process.exit(1);
});
console.log(`tool calls: ${JSON.stringify(calls)}; final text: ${JSON.stringify(res.text.slice(0, 200))}; steps: ${res.steps.length}`);
console.log(calls.length ? "\nOK: Gemini structured output and tool calling verified." : "\nWARNING: the model did not call the tool.");
