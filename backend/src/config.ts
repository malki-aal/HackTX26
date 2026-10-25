// Explicit environment loading and validation. Secrets are kept out of anything returned to clients.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  FRONTEND_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
  DEMO_MODE: z.string().default("true"),
  INTEGRATION_MODE: z.enum(["live", "fixtures"]).default("live"),
  DATABASE_PATH: z.string().default("./var/runway.sqlite"),
  GEMINI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  SERPAPI_API_KEY: z.string().optional(),
  NESSIE_API_KEY: z.string().optional(),
  NESSIE_BASE_URL: z.string().url().default("https://prod-api.nessieisreal.com"),
  NESSIE_CUSTOMER_ID: z.string().optional(),
  NESSIE_ACCOUNT_ID: z.string().optional(),
  MAX_SEARCH_CALLS_PER_RUN: z.coerce.number().int().min(1).max(6).default(3),
  MAX_AGENT_STEPS: z.coerce.number().int().min(2).max(24).default(14),
  MAX_RESEARCH_DURATION_MS: z.coerce.number().int().min(10_000).max(300_000).default(300_000),
  OFFER_MAX_AGE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  SERPAPI_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(60_000).default(20_000),
  SERPAPI_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  AGENT_RUNTIME_PORT: z.coerce.number().int().min(1).max(65535).default(8100),
  /** "clerk" verifies Google sign-in sessions; "demo" uses fixed demo actors and is fixtures-only. */
  AUTH_MODE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["clerk", "demo"]).optional()),
  CLERK_SECRET_KEY: z.string().optional(),
  /** Optional PEM public key for networkless session verification. */
  CLERK_JWT_KEY: z.string().optional(),
  /** Frontend origins allowed to have issued the session token (azp). Defaults to FRONTEND_ORIGINS. */
  CLERK_AUTHORIZED_PARTIES: z.string().optional(),
  /** Team-supplied allowlist mapping verified emails to company and role (gitignored). */
  ACCESS_BOOTSTRAP_FILE: z.string().default("./config/access.json"),
  /** The company that owns the configured Nessie account. */
  ACCOUNT_COMPANY_ID: z.string().default("org_demo"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  frontendOrigins: string[];
  demoMode: boolean;
  mode: "live" | "fixtures";
  databasePath: string;
  gemini: { apiKey: string | null; model: string | null };
  serpapi: { apiKey: string | null; timeoutMs: number; maxConcurrency: number };
  nessie: { apiKey: string | null; baseUrl: string; customerId: string | null; accountId: string | null };
  limits: { maxSearchCallsPerRun: number; maxAgentSteps: number; maxResearchDurationMs: number; offerMaxAgeMinutes: number };
  agentRuntimePort: number;
  auth: {
    mode: "clerk" | "demo";
    clerkSecretKey: string | null;
    clerkJwtKey: string | null;
    authorizedParties: string[];
    bootstrapFile: string;
    accountCompanyId: string;
  };
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function loadEnvFile(path = ".env"): void {
  const p = resolve(path);
  if (existsSync(p)) process.loadEnvFile(p);
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const e = Env.parse(env);
  const gemini = blank(e.GEMINI_API_KEY);
  const googleAlias = blank(e.GOOGLE_GENERATIVE_AI_API_KEY);
  if (gemini && googleAlias && gemini !== googleAlias) {
    throw new Error("GEMINI_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY are both set with different values; set only one.");
  }
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    frontendOrigins: e.FRONTEND_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    demoMode: e.DEMO_MODE !== "false",
    mode: e.INTEGRATION_MODE,
    databasePath: e.DATABASE_PATH,
    gemini: { apiKey: gemini ?? googleAlias, model: blank(e.GEMINI_MODEL) },
    serpapi: { apiKey: blank(e.SERPAPI_API_KEY), timeoutMs: e.SERPAPI_TIMEOUT_MS, maxConcurrency: e.SERPAPI_MAX_CONCURRENCY },
    nessie: {
      apiKey: blank(e.NESSIE_API_KEY),
      baseUrl: e.NESSIE_BASE_URL.replace(/\/+$/, ""),
      customerId: blank(e.NESSIE_CUSTOMER_ID),
      accountId: blank(e.NESSIE_ACCOUNT_ID),
    },
    limits: {
      maxSearchCallsPerRun: e.MAX_SEARCH_CALLS_PER_RUN,
      maxAgentSteps: e.MAX_AGENT_STEPS,
      maxResearchDurationMs: e.MAX_RESEARCH_DURATION_MS,
      offerMaxAgeMinutes: e.OFFER_MAX_AGE_MINUTES,
    },
    agentRuntimePort: e.AGENT_RUNTIME_PORT,
    auth: resolveAuth(e),
  };
}

function resolveAuth(e: z.infer<typeof Env>): AppConfig["auth"] {
  const mode = e.AUTH_MODE ?? (e.INTEGRATION_MODE === "fixtures" ? "demo" : "clerk");
  // Demo actors are an explicit fixtures-only convenience, never a fallback for live money paths.
  if (mode === "demo" && e.INTEGRATION_MODE === "live") throw new Error("AUTH_MODE=demo is only allowed with INTEGRATION_MODE=fixtures");
  // A blank value means "use FRONTEND_ORIGINS"; an empty list would let any origin's token through azp.
  const origins = (blank(e.CLERK_AUTHORIZED_PARTIES) ?? e.FRONTEND_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
  if (mode === "clerk" && origins.length === 0) throw new Error("CLERK_AUTHORIZED_PARTIES/FRONTEND_ORIGINS must list at least one frontend origin");
  return {
    mode,
    clerkSecretKey: blank(e.CLERK_SECRET_KEY),
    clerkJwtKey: blank(e.CLERK_JWT_KEY),
    authorizedParties: origins,
    bootstrapFile: e.ACCESS_BOOTSTRAP_FILE,
    accountCompanyId: e.ACCOUNT_COMPANY_ID,
  };
}

/** All secret values currently configured, used to scrub logs and errors. */
export function secretValues(config: AppConfig): string[] {
  return [config.gemini.apiKey, config.serpapi.apiKey, config.nessie.apiKey, config.auth.clerkSecretKey].filter((v): v is string => !!v && v.length >= 6);
}
