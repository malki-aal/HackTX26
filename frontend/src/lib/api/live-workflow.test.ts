import { afterEach, describe, expect, it, vi } from "vitest";
import { liveApi } from "./live";
import type { NewRequestInput, ProjectView } from "./types";

vi.mock("../auth/token", () => ({ getAuthToken: async () => null, UNAUTHORIZED_EVENT: "unauthorized" }));
vi.mock("../auth/config", () => ({ authMode: "demo" }));

const input: NewRequestInput = {
  title: "Desk organizers", purpose: "Build prototypes", budgetTotalCents: 10000,
  mandatory: [], preferences: [], condition: "any", deadlineKind: "hard", deadline: "2026-11-04", agentConfigId: "cfg_default",
  items: [
    { name: "Wood glue", quantity: 2, unit: "bottles", budgetCents: 3000, specifications: ["Wood rated"] },
    { name: "Cork sheets", quantity: 5, unit: "sheets", budgetCents: 7000, specifications: ["Adhesive backing"] },
  ],
};
const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("live grouped request wiring", () => {
  it("uses projects, preserves each quantity and budget, and keeps item specs separate", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ id: "prj_test", lines: [] }));
    vi.stubGlobal("fetch", fetcher);
    await liveApi.createProject(input);
    expect(fetcher.mock.calls[0][0]).toMatch(/\/projects$/);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]).toMatchObject({ title: "Wood glue", quantity: 2, budgetCents: 3000 });
    expect(body.lines[0].description).toContain("Wood rated");
    expect(body.lines[0].description).not.toContain("Adhesive backing");
    expect(body.lines[1].description).toContain("Adhesive backing");
    expect(body.budgetCents).toBe(10000);
    expect(body.deadlineType).toBe("hard");
  });
  it("does not restart already researched or in-progress items when starting the group", async () => {
    const project: ProjectView = { id: "prj_test", title: "Desk", purpose: "", budgetCents: 10000, lines: [
      { key: "ready", requestId: "req_1", title: "Glue", quantity: 2, lineBudgetCents: 3000, status: "confirmed", isCurrentVersionConfirmed: true, unansweredQuestionIds: [], research: null },
      { key: "done", requestId: "req_2", title: "Cork", quantity: 5, lineBudgetCents: 7000, status: "researched", isCurrentVersionConfirmed: true, unansweredQuestionIds: [], research: { runStatus: "completed" } },
    ] };
    const fetcher = vi.fn().mockResolvedValueOnce(response(project)).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ results: [{ key: "ready", result: "started" }] }));
    vi.stubGlobal("fetch", fetcher);
    await liveApi.startProjectResearch(project.id);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ lineKeys: ["ready"] });
  });
});
