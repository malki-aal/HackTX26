// The single agent runner. One configurable engine; per-run behavior comes from a saved
// configuration snapshot. Purchase execution is not reachable from any tool.
import type { AgentConfig } from "../contracts/domain.js";
import { ToolInputs, type ToolName } from "./toolSchemas.js";

export interface ToolHost {
  readonly enabledTools: ToolName[];
  /** Validates input, enforces enablement and limits, executes server-side. */
  call(tool: string, input: unknown): Promise<unknown>;
  /** Records a real wait for model quota (reported by the agent process) as run progress. */
  quotaWait?(waitMs: number): void;
}

export interface AgentRunInput {
  runId: string;
  config: AgentConfig;
  limits: { maxSearchCalls: number; maxSteps: number; maxDurationMs: number };
  /** Request description is user-authored and is passed as quoted data. */
  briefing: string;
  tools: ToolHost;
  signal: AbortSignal;
  onStep: (info: { step: number; detail: string }) => void;
  onSession?: (sessionId: string) => void;
}

export interface AgentRunOutput {
  runtime: "eve" | "scripted_fixture";
  steps: number;
  finalMessage: string | null;
  stopReason: "completed" | "step_limit" | "time_limit" | "cancelled";
}

export interface AgentRunner {
  readonly kind: "eve" | "scripted_fixture";
  run(input: AgentRunInput): Promise<AgentRunOutput>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class AgentStepLimitError extends Error {}

/**
 * Deterministic stand-in used in fixtures mode and tests. It follows the same tool host,
 * enablement and limit rules as the live runner but makes no model calls. It is labeled
 * "scripted_fixture" on every run it executes.
 */
export class ScriptedAgentRunner implements AgentRunner {
  readonly kind = "scripted_fixture" as const;
  async health() {
    return { ok: true, detail: "scripted fixture runner (no model calls)" };
  }
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    let steps = 0;
    const step = async (tool: ToolName, args: unknown = {}) => {
      if (input.signal.aborted) throw new DOMException("cancelled", "AbortError");
      steps++;
      if (steps > input.limits.maxSteps) return { stop: true as const };
      input.onStep({ step: steps, detail: tool });
      if (!input.tools.enabledTools.includes(tool)) return { stop: false as const, result: null };
      return { stop: false as const, result: await input.tools.call(tool, args) };
    };
    const seq: Array<[ToolName, unknown]> = [["getConfirmedRequirements", {}]];
    for (let i = 0; i < input.limits.maxSearchCalls; i++) seq.push(["searchProducts", {}]);
    seq.push(["readBudgetContext", {}], ["evaluateCandidates", {}]);
    type Ranking = { candidates?: Array<{ offerId: string; class: string; productDetails?: string; unconfirmedMandatory?: string[] }>; detailCallsRemaining?: number };
    const results: { ranking: Ranking | null } = { ranking: null };
    for (const [tool, args] of seq) {
      const r = await step(tool, args);
      if (r.stop) return { runtime: this.kind, steps: steps - 1, finalMessage: null, stopReason: "step_limit" };
      if (tool === "evaluateCandidates") results.ranking = r.result as Ranking | null;
    }
    // Fetch product details for the best needs_review candidates with unconfirmed mandatory specs, then re-evaluate.
    const remaining = results.ranking?.detailCallsRemaining ?? 0;
    const targets = (results.ranking?.candidates ?? []).filter((c) => c.class === "needs_review" && c.productDetails === "not_fetched" && (c.unconfirmedMandatory?.length ?? 0) > 0).slice(0, remaining);
    if (targets.length) {
      for (const t of targets) {
        const r = await step("getProductDetails", { offerId: t.offerId });
        if (r.stop) return { runtime: this.kind, steps: steps - 1, finalMessage: null, stopReason: "step_limit" };
      }
      const r = await step("evaluateCandidates", {});
      if (r.stop) return { runtime: this.kind, steps: steps - 1, finalMessage: null, stopReason: "step_limit" };
      results.ranking = r.result as Ranking | null;
    }
    const candidates = results.ranking?.candidates ?? [];
    const top = candidates.find((c) => c.class === "eligible") ?? candidates[0];
    if (top) {
      const r = await step("prepareProposalDraft", ToolInputs.prepareProposalDraft.parse({ recommendedOfferId: top.offerId, explanation: "Top computed candidate (scripted fixture runner; no model explanation)." }));
      if (r.stop) return { runtime: this.kind, steps: steps - 1, finalMessage: null, stopReason: "step_limit" };
    }
    return { runtime: this.kind, steps, finalMessage: "Scripted fixture run complete.", stopReason: "completed" };
  }
}
