// Integration status without paid calls: configuration presence plus the last observed outcome.
import type { AppContext } from "../app/context.js";
import { json } from "../db/db.js";
import { resolveAccountId } from "./budget.js";

export async function integrationStatuses(ctx: AppContext) {
  const rows = ctx.db.prepare("SELECT * FROM integration_state").all() as Array<{ service: string; state: string; last_verified_at: string | null; last_error: string | null; detail: string }>;
  const seen = new Map(rows.map((r) => [r.service, r]));
  const fixtures = ctx.config.mode === "fixtures";
  const entry = (service: string, configured: boolean, detail: Record<string, unknown>) => {
    const r = seen.get(service);
    return {
      service,
      configured,
      mode: ctx.config.mode,
      state: fixtures ? "fixture" : !configured ? "not_configured" : (r?.state ?? "unverified"),
      lastVerifiedAt: r?.last_verified_at ?? null,
      lastError: r?.last_error ?? null,
      detail: { ...(r ? json<Record<string, unknown>>(r.detail) : {}), ...detail },
    };
  };
  const agent = await ctx.agentRunner.health();
  return [
    entry("gemini", !!ctx.config.gemini.apiKey && !!ctx.config.gemini.model, { model: ctx.config.gemini.model, keyConfigured: !!ctx.config.gemini.apiKey }),
    entry("serpapi", !!ctx.config.serpapi.apiKey, { engine: "google_shopping" }),
    entry("nessie", !!ctx.config.nessie.apiKey && !!resolveAccountId(ctx), { baseUrl: ctx.config.nessie.baseUrl, accountConfigured: !!resolveAccountId(ctx), keyConfigured: !!ctx.config.nessie.apiKey }),
    { service: "agent_runtime", configured: true, mode: ctx.config.mode, state: agent.ok ? (fixtures ? "fixture" : "ok") : "error", lastVerifiedAt: agent.ok ? ctx.now().toISOString() : null, lastError: agent.ok ? null : agent.detail, detail: { runner: ctx.agentRunner.kind, info: agent.detail } },
  ];
}
