// One live Google Shopping query (uses one SerpApi search unless cached by SerpApi for 1h).
// Saves a sanitized sample under var/recordings (gitignored) for inspection.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnvFile, parseConfig, secretValues } from "../src/config.js";
import { registerSecrets, scrubValue } from "../src/lib/redact.js";
import { SerpApiShopping } from "../src/integrations/serpapi.js";
import { normalizeOffer } from "../src/domain/normalize.js";
import { evaluateCandidates } from "../src/domain/evaluate.js";
import { deriveMonitorRequirements } from "../src/domain/requirements.js";
import { formatUsd } from "../src/domain/money.js";

loadEnvFile();
const config = parseConfig(process.env);
registerSecrets(secretValues(config));
const q = process.argv[2] ?? "27 inch 1440p monitor HDMI";
const res = await new SerpApiShopping(config.serpapi.apiKey).search({ q, gl: "us", hl: "en" }, {});
console.log(`Query "${q}": ${res.items.length} items, outcome=${res.outcome}, fetchedAt=${res.fetchedAt.toISOString()}, providerSearchId=${res.providerSearchId}`);
mkdirSync("var/recordings", { recursive: true });
const file = `var/recordings/serpapi-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(scrubValue({ q, fetchedAt: res.fetchedAt, items: res.items }), null, 2));
console.log(`Sanitized sample saved to ${file}`);

const offers = res.items.flatMap((it) => {
  const n = normalizeOffer(it, { runId: "check", queryId: "q", observedAt: res.fetchedAt, offerMaxAgeMinutes: 30, fromCache: false });
  return n.ok ? [n.offer] : [];
});
const reqs = deriveMonitorRequirements({ title: "Four monitors", description: "Four new 27-inch monitors, at least 1440p, with HDMI.", allowedCondition: "new" });
const evals = evaluateCandidates(offers, reqs, 4, 100000);
const counts = { eligible: 0, needs_review: 0, rejected: 0 };
for (const e of evals) counts[e.class]++;
console.log(`Normalized ${offers.length}; ${JSON.stringify(counts)}`);
for (const e of evals.slice(0, 5)) {
  const o = offers.find((x) => x.id === e.offerId)!;
  console.log(`#${e.rank} [${e.class}] ${o.title.slice(0, 80)} | ${o.seller} | ${o.priceText} | 4x ${e.cost.knownComparableCostCents === null ? "?" : formatUsd(e.cost.knownComparableCostCents)}`);
}
