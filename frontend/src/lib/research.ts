// Research progress from the run's recorded events only: no invented percentages or timers.
import type { Run } from "./api";

export interface Progress {
  label: string;
  detail?: string;
  done: boolean;
}

/** The current phase, read from the latest meaningful event. `now` is passed in for testability. */
export function researchProgress(run: Pick<Run, "state" | "outcome" | "trace">, now: number): Progress {
  if (run.state === "completed") {
    if (run.outcome === "candidates_found") return { label: "Finished", detail: "Options are ranked. You choose and verify suitability.", done: true };
    if (run.outcome === "no_confirmed_match") return { label: "Finished, review needed", detail: "No offer has evidence for every must-have. Review the closest options and what is unconfirmed.", done: true };
    return { label: "Finished, no results", done: true };
  }
  if (run.state === "failed") return { label: "Research failed", done: true };
  if (run.state === "cancelled") return { label: "Research cancelled", done: true };
  for (let i = run.trace.length - 1; i >= 0; i--) {
    const e = run.trace[i]!;
    switch (e.type) {
      case "model_quota_wait": {
        const left = e.waitMs ? Math.ceil((Date.parse(e.at) + e.waitMs - now) / 1000) : 0;
        if (left > 0) return { label: "Waiting for model quota", detail: `About ${left}s left. The free model tier allows a few requests per minute.`, done: false };
        return { label: "Thinking", detail: "The model is choosing the next step.", done: false };
      }
      case "tool_called":
        if (e.tool === "prepareProposalDraft") return { label: "Preparing recommendation", done: false };
        if (e.tool === "getProductDetails") return { label: "Checking evidence", detail: "Reading product pages for unconfirmed must-haves.", done: false };
        if (e.tool === "searchProducts") return { label: "Searching suppliers", done: false };
        continue;
      case "search_started":
      case "search_completed":
      case "candidates_normalized":
        return { label: "Searching suppliers", done: false };
      case "details_fetched":
      case "evaluation_completed":
        return { label: "Checking evidence", done: false };
      case "budget_checked":
        return { label: "Checking budget", done: false };
      case "research_started":
        return { label: "Starting", done: false };
      default:
        continue;
    }
  }
  return { label: "Starting", done: false };
}

/** "1m 04s" style elapsed time since the run's first event. */
export function elapsedLabel(startIso: string | null, now: number): string | null {
  if (!startIso) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(startIso)) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
