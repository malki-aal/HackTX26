// Build an AppContext from configuration. Fixture mode never constructs live adapters, so it
// cannot write to Nessie or spend SerpApi/Gemini quota.
import type { AppConfig } from "../config.js";
import { openDatabase, nowIso } from "../db/db.js";
import type { AppContext, Adapters } from "./context.js";
import { SerpApiShopping } from "../integrations/serpapi.js";
import { NessieClient } from "../integrations/nessie.js";
import { GeminiExtractor } from "../integrations/gemini.js";
import { FixtureBank, FixtureExtractor, FixtureShopping } from "../integrations/fixtures.js";
import { ScriptedAgentRunner, type AgentRunner } from "../agent/runner.js";
import { EveAgentRunner } from "../agent/eveRunner.js";
import { seedDefaultConfigs } from "../services/agentConfigs.js";
import { failInterruptedRuns } from "../services/research.js";
import { recoverInterruptedExecutions } from "../services/executions.js";

export function buildAdapters(config: AppConfig): Adapters {
  if (config.mode === "fixtures") return { shopping: new FixtureShopping(), bank: new FixtureBank(), extractor: new FixtureExtractor() };
  return {
    shopping: new SerpApiShopping(config.serpapi.apiKey),
    bank: new NessieClient({ apiKey: config.nessie.apiKey, baseUrl: config.nessie.baseUrl }),
    extractor: new GeminiExtractor(config.gemini.apiKey, config.gemini.model),
  };
}

export function createContext(config: AppConfig, opts: { adapters?: Adapters; agentRunner?: AgentRunner; internalToken?: string; now?: () => Date } = {}): AppContext {
  const db = openDatabase(config.databasePath);
  db.prepare("INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES ('org_demo', 'Runway Demo Co (fictional)', ?)").run(nowIso());
  db.prepare("INSERT OR IGNORE INTO actors (id, org_id, role, label) VALUES ('employee-demo', 'org_demo', 'employee', 'Demo Employee')").run();
  db.prepare("INSERT OR IGNORE INTO actors (id, org_id, role, label) VALUES ('executive-demo', 'org_demo', 'executive', 'Demo Executive')").run();
  seedDefaultConfigs(db);
  const agentRunner =
    opts.agentRunner ??
    (config.mode === "fixtures" ? new ScriptedAgentRunner() : new EveAgentRunner({ host: `http://127.0.0.1:${config.agentRuntimePort}`, token: opts.internalToken ?? "" }));
  const ctx: AppContext = { config, db, adapters: opts.adapters ?? buildAdapters(config), agentRunner, activeRuns: new Map(), now: opts.now ?? (() => new Date()) };
  failInterruptedRuns(ctx);
  recoverInterruptedExecutions(ctx);
  return ctx;
}
