import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";
import { awaitRun } from "../src/services/research.js";

describe("multi-item request flow", () => {
  it("creates separate item searches within a shared budget without requiring the unsupported single-request path", async () => {
    const h = harness();
    const result = await h.call("POST", "/api/v1/projects", {
      title: "Workshop restock", purpose: "Restock the line and power the open day", budgetCents: 60000, agentConfigId: "cfg_default",
      lines: [
        { key: "glue", title: "Wood glue", description: "Wood glue required", quantity: 2, unit: "bottles", budgetCents: 10000, allowedCondition: "any" },
        { key: "power", title: "Portable power station", description: "Portable power station, at least 500 Wh", quantity: 5, unit: "power stations", budgetCents: 50000, allowedCondition: "any" },
      ],
    });
    expect(result.status).toBe(201);
    const project = result.body.data;
    expect(project.lines).toHaveLength(2);
    expect(project.lines.map((line: { quantity: number }) => line.quantity)).toEqual([2, 5]);
    const confirm = await h.call("POST", `/api/v1/projects/${project.id}/confirm`, {});
    expect(confirm.body.data.results.every((line: { result: string }) => line.result === "confirmed")).toBe(true);
    const research = await h.call("POST", `/api/v1/projects/${project.id}/research`, { lineKeys: ["glue", "power"] });
    expect(research.status).toBe(202);
    expect(research.body.data.results.every((line: { result: string }) => line.result === "started")).toBe(true);
    for (const line of research.body.data.results) await awaitRun(line.runId);
    expect(h.shopping.calls.some((q) => /wood glue/i.test(q.q))).toBe(true);
    expect(h.shopping.calls.some((q) => /power station/i.test(q.q))).toBe(true);
    expect(h.bank.state.purchases).toHaveLength(0);
  });
});
