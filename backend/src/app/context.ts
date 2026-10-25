import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import type { ShoppingSearch } from "../integrations/serpapi.js";
import type { BankAdapter } from "../integrations/nessie.js";
import type { RequirementExtractor } from "../integrations/gemini.js";
import type { AgentRunner } from "../agent/runner.js";
import type { IdentityProvider } from "../auth/identity.js";

export interface Adapters {
  shopping: ShoppingSearch;
  bank: BankAdapter;
  extractor: RequirementExtractor;
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  adapters: Adapters;
  agentRunner: AgentRunner;
  /** In-flight research runs, keyed by run id, for cancellation. */
  activeRuns: Map<string, AbortController>;
  now: () => Date;
  /** End-user identity verification; null in demo mode or when Clerk is not configured (fail closed). */
  identity: IdentityProvider | null;
}
