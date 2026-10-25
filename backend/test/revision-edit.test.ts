// Revising the request itself after an executive asks for changes (e.g. 4 monitors → 2): a new request
// version, old research invalidated, fresh pricing, and the earlier decision kept in history. Fixtures only.
import { describe, expect, it } from "vitest";
import { EXEC, harness, submittedProposal } from "./helpers.js";
import { awaitRun } from "../src/services/research.js";

describe("edit request after changes requested", () => {
  it("creates a new version, refuses old research, re-prices for the new quantity and keeps decision history", async () => {
    const h = harness();
    const s = await submittedProposal(h); // 4 monitors, revision 1, awaiting review
    const rc = await h.call("POST", `/api/v1/proposals/${s.proposalId}/decision`, { version: 1, decision: "request_changes", note: "Lower the quantity to 2" }, { ...EXEC, "idempotency-key": "edit-flow-rc-0001" });
    expect(rc.status).toBe(200);

    const before = (await h.call("GET", `/api/v1/requests/${s.id}`)).body.data;
    expect(before.status).toBe("changes_requested");
    const edited = await h.call("PATCH", `/api/v1/requests/${s.id}`, { expectedVersion: before.version, quantity: 2, budgetCents: 50000 });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ version: before.version + 1, quantity: 2, isCurrentVersionConfirmed: false });
    expect(edited.body.data.status).not.toBe("changes_requested");

    // The four-unit research belongs to the old version: it cannot back a revision.
    const stale = await h.call("POST", `/api/v1/requests/${s.id}/proposals`, { runId: s.runId, offerId: s.top.offerId, justification: "Two monitors", proposalId: s.proposalId });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    const oldCands = (await h.call("GET", `/api/v1/requests/${s.id}/candidates?runId=${s.runId}`)).body.data;
    expect(oldCands.resultsCurrent).toBe(false);

    // Confirm the new version and research again (an explicit action), then revise the same proposal.
    const v = edited.body.data.version;
    expect((await h.call("POST", `/api/v1/requests/${s.id}/confirm`, { version: v })).status).toBe(200);
    const start = await h.call("POST", `/api/v1/requests/${s.id}/research`, { version: v });
    await awaitRun(start.body.data.runId);
    const cands = (await h.call("GET", `/api/v1/requests/${s.id}/candidates?runId=${start.body.data.runId}`)).body.data.candidates;
    const same = cands.find((c: any) => c.title === s.top.title);
    expect(same.packagesRequired * (same.packageQuantity ?? 1)).toBeGreaterThanOrEqual(2);
    expect(same.listedSubtotalCents).toBeLessThan(s.top.listedSubtotalCents); // priced for 2, not 4

    const rev = await h.call("POST", `/api/v1/requests/${s.id}/proposals`, { runId: start.body.data.runId, offerId: same.offerId, justification: "Two monitors as requested", proposalId: s.proposalId });
    expect(rev.status).toBe(201);
    expect(rev.body.data.version).toBe(2);
    const sub = await h.call("POST", `/api/v1/proposals/${s.proposalId}/submit`, { version: 2, technicalReviewConfirmed: true, exactAmountCents: same.knownComparableCostCents + 1000 });
    expect(sub.status).toBe(200);

    const view = (await h.call("GET", `/api/v1/proposals/${s.proposalId}`, undefined, EXEC)).body.data;
    expect(view).toMatchObject({ version: 2, decisionState: "awaiting_review", quantity: 2 });
    expect(view.requestVersion).toBe(v);
    // History is preserved and attributed to revision 1 only.
    expect(view.decisions).toHaveLength(1);
    expect(view.decisions[0]).toMatchObject({ version: 1, decision: "request_changes", note: "Lower the quantity to 2" });
    expect(view.versions.map((x: any) => x.version)).toEqual([1, 2]);
    // The executive's preview is for revision 2, against the new request version.
    const preview = (await h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview`, undefined, EXEC)).body.data;
    expect(preview.proposalVersion).toBe(2);
    expect(preview.blockingReasons.some((b: any) => b.code === "requirements_changed")).toBe(false);
  });

  it("cannot edit the request while a proposal is awaiting review or after approval", async () => {
    const h = harness();
    const s = await submittedProposal(h);
    const r = (await h.call("GET", `/api/v1/requests/${s.id}`)).body.data;
    const res = await h.call("PATCH", `/api/v1/requests/${s.id}`, { expectedVersion: r.version, quantity: 2 });
    expect(res.status).toBe(409);
  });
});
