import { describe, expect, it } from "vitest";
import { elapsedLabel, researchProgress } from "./research";

const t0 = Date.parse("2026-10-25T00:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

describe("research progress", () => {
  it("follows recorded events, including a real model-quota wait with time left", () => {
    const trace = [
      { type: "research_started", at: at(0) },
      { type: "search_completed", at: at(2) },
      { type: "model_quota_wait", at: at(3), waitMs: 50_000 },
    ];
    expect(researchProgress({ state: "running", outcome: null, trace: trace.slice(0, 2) }, t0 + 2500).label).toBe("Searching suppliers");
    const w = researchProgress({ state: "running", outcome: null, trace }, t0 + 13_000);
    expect(w.label).toBe("Waiting for model quota");
    expect(w.detail).toMatch(/About 40s left/);
    expect(researchProgress({ state: "running", outcome: null, trace: [...trace, { type: "tool_called", at: at(55), tool: "prepareProposalDraft" }] }, t0 + 56_000).label).toBe("Preparing recommendation");
  });
  it("says when review is needed instead of claiming a match", () => {
    expect(researchProgress({ state: "completed", outcome: "no_confirmed_match", trace: [] }, t0).label).toBe("Finished, review needed");
    expect(researchProgress({ state: "completed", outcome: "candidates_found", trace: [] }, t0).label).toBe("Finished");
  });
  it("formats elapsed time from the first event", () => {
    expect(elapsedLabel(at(0), t0 + 64_000)).toBe("1m 04s");
    expect(elapsedLabel(null, t0)).toBeNull();
  });
});
