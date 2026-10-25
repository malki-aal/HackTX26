// Live runner: drives the eve agent process (agent/ directory) over eve's documented client API.
// The agent's tools call back into this server's internal route, which resolves the run from the
// eve session id and dispatches to the run's ToolHost.
import { Client } from "eve/client";
import type { AgentRunInput, AgentRunOutput, AgentRunner, ToolHost } from "./runner.js";
import { IntegrationError } from "../lib/errors.js";

/** eve session id -> tool host of the run currently driving that session. */
export const sessionToolHosts = new Map<string, ToolHost>();

export class EveAgentRunner implements AgentRunner {
  readonly kind = "eve" as const;
  private readonly client: Client;

  constructor(private readonly opts: { host: string; token: string }) {
    this.client = new Client({ host: opts.host, auth: { bearer: opts.token }, redirect: "error" });
  }

  async health() {
    try {
      await this.client.health();
      return { ok: true, detail: `eve agent runtime reachable at ${this.opts.host}` };
    } catch (e) {
      return { ok: false, detail: `eve agent runtime unreachable: ${(e as Error).message.slice(0, 200)}` };
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    let sessionId: string;
    let session;
    try {
      ({ session } = await this.client.sessions.create());
      sessionId = session.state.sessionId;
    } catch (e) {
      throw new IntegrationError("agent_runtime", "INTEGRATION_NOT_CONFIGURED", `Could not start an agent session: ${(e as Error).message.slice(0, 200)}`, "definitive", false);
    }
    // Register before the first message so every tool call can be scoped to this run.
    sessionToolHosts.set(sessionId, input.tools);
    input.onSession?.(sessionId);
    let steps = 0;
    let stopReason: AgentRunOutput["stopReason"] = "completed";
    let finalMessage: string | null = null;
    const timer = setTimeout(() => {
      stopReason = "time_limit";
      void session.cancel().catch(() => {});
    }, input.limits.maxDurationMs);
    const onAbort = () => {
      stopReason = "cancelled";
      void session.cancel().catch(() => {});
    };
    input.signal.addEventListener("abort", onAbort);
    try {
      const response = await session.send(input.briefing);
      for await (const ev of response) {
        const type = (ev as { type: string }).type;
        const data = (ev as { data?: Record<string, unknown> }).data ?? {};
        if (type === "step.started") {
          steps++;
          if (steps > input.limits.maxSteps) {
            stopReason = "step_limit";
            await session.cancel().catch(() => {});
            break;
          }
          input.onStep({ step: steps, detail: "model step" });
        } else if (type === "message.completed") {
          const text = typeof data.text === "string" ? data.text : typeof data.message === "string" ? data.message : null;
          if (text) finalMessage = text.slice(0, 2000);
        } else if (type === "turn.failed" || type === "session.failed") {
          if (stopReason !== "completed") break;
          const msg = typeof data.message === "string" ? data.message : typeof (data.error as { message?: string })?.message === "string" ? (data.error as { message: string }).message : "agent turn failed";
          const quota = /exceeded your current quota|rate limit|resource_exhausted|\b429\b/i.test(msg);
          throw new IntegrationError("agent_runtime", quota ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR", `Agent turn failed: ${msg.slice(0, 300)}`, "definitive", quota);
        } else if (type === "turn.cancelled" || type === "turn.completed") {
          break;
        }
      }
      if (!finalMessage) {
        const result = await response.result().catch(() => null);
        finalMessage = result?.message?.slice(0, 2000) ?? null;
      }
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      sessionToolHosts.delete(sessionId);
    }
    return { runtime: "eve", steps: Math.min(steps, input.limits.maxSteps), finalMessage, stopReason };
  }
}
