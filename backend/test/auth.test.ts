// Signed-in mode, exercised with a controlled test identity provider (never a real Google/Clerk
// session). These tests prove the server-side rules, not the provider integration.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, testConfig, type Harness } from "./helpers.js";
import { TestIdentityProvider } from "../src/auth/identity.js";
import { FixtureBank } from "../src/integrations/fixtures.js";
import { awaitRun } from "../src/services/research.js";
import { parseConfig } from "../src/config.js";

interface World {
  h: Harness;
  idp: TestIdentityProvider;
  emp: string;
  emp2: string;
  exec: string;
  otherExec: string;
  stranger: string;
  bootstrapFile: string;
}

function world(opts: { bank?: FixtureBank } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "runway-auth-"));
  const bootstrapFile = join(dir, "access.json");
  writeFileSync(
    bootstrapFile,
    JSON.stringify({
      companies: [{ id: "org_other", name: "Other Co (fictional)" }],
      members: [
        { email: "emp@runway.test", role: "employee", company: "org_demo" },
        { email: "emp2@runway.test", role: "employee", company: "org_demo" },
        { email: "exec@runway.test", role: "executive", company: "org_demo" },
        { email: "other-exec@runway.test", role: "executive", company: "org_other" },
      ],
    }),
  );
  const config = testConfig({ AUTH_MODE: "clerk", ACCESS_BOOTSTRAP_FILE: bootstrapFile });
  const idp = new TestIdentityProvider();
  const w: World = {
    h: harness({ config, identity: idp, bank: opts.bank }),
    idp,
    emp: idp.addUser("u_emp", "Emma Employee", "emp@runway.test"),
    emp2: idp.addUser("u_emp2", "Eli Employee", "emp2@runway.test"),
    exec: idp.addUser("u_exec", "Erin Executive", "exec@runway.test"),
    otherExec: idp.addUser("u_other", "Omar Other", "other-exec@runway.test"),
    stranger: idp.addUser("u_stranger", "Sam Stranger", "stranger@gmail.test"),
    bootstrapFile,
  };
  return w;
}

const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

/** Employee creates, confirms, researches and submits a monitor proposal; returns ids. */
async function submitted(w: World, amount?: number, quantity = 4) {
  const { h } = w;
  const created = await h.call("POST", "/api/v1/requests", { title: "Engineering monitors", description: "Find new 27-inch monitors, at least 1440p, HDMI required.", quantity, currency: "USD", budgetCents: 100000, budgetBasis: "total", allowedCondition: "new" }, as(w.emp));
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const id = created.body.data.id;
  await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: created.body.data.version }, as(w.emp));
  const run = await h.call("POST", `/api/v1/requests/${id}/research`, { version: created.body.data.version }, as(w.emp));
  await awaitRun(run.body.data.runId);
  const cands = await h.call("GET", `/api/v1/requests/${id}/candidates`, undefined, as(w.emp));
  const top = cands.body.data.candidates.find((c: any) => c.eligibility === "eligible");
  const prop = await h.call("POST", `/api/v1/requests/${id}/proposals`, { runId: run.body.data.runId, offerId: top.offerId, justification: "Cheapest eligible" }, as(w.emp));
  const exact = amount ?? top.knownComparableCostCents + 1234;
  const sub = await h.call("POST", `/api/v1/proposals/${prop.body.data.id}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: exact }, as(w.emp));
  if (sub.status !== 200) throw new Error(JSON.stringify(sub.body));
  return { requestId: id as string, proposalId: prop.body.data.id as string, exact, seller: top.seller as string };
}

const decide = (w: World, token: string, proposalId: string, body: Record<string, unknown>, key = `k-${Math.random().toString(36).slice(2, 10)}`) =>
  w.h.call("POST", `/api/v1/proposals/${proposalId}/decision`, body, as(token, { "idempotency-key": key }));

const confirm = (version: number, exactAmountCents: number) => ({ confirmed: true, proposalVersion: version, exactAmountCents });

async function mapSellerAsExec(w: World, seller: string) {
  const r = await w.h.call("POST", "/api/v1/merchant-mappings", { action: "create_sandbox_merchant", seller }, as(w.exec));
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
}

describe("authentication", () => {
  it("signed-out, invalid and expired sessions are rejected; public routes stay public", async () => {
    const w = world();
    expect((await w.h.call("GET", "/api/v1/requests")).body.error.code).toBe("UNAUTHENTICATED");
    expect((await w.h.call("GET", "/api/v1/requests", undefined, as("garbage"))).status).toBe(401);
    const expired = await w.h.call("GET", "/api/v1/requests", undefined, as("test:u_emp:expired"));
    expect(expired.status).toBe(401);
    expect(expired.body.error.details.reason).toBe("expired");
    expect((await w.h.call("GET", "/api/v1/health")).status).toBe(200);
    expect((await w.h.call("GET", "/api/v1/categories")).status).toBe(200);
  });

  it("fails closed when sign-in is not configured", async () => {
    const h = harness({ config: testConfig({ AUTH_MODE: "clerk" }), identity: null });
    const r = await h.call("GET", "/api/v1/requests", undefined, as("anything"));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("AUTH_NOT_CONFIGURED");
    expect((await h.call("GET", "/api/v1/health")).body.data.auth).toEqual({ mode: "clerk", configured: false });
  });

  it("demo identities cannot be used with live integrations", () => {
    expect(() => parseConfig({ NODE_ENV: "test", INTEGRATION_MODE: "live", AUTH_MODE: "demo" })).toThrow(/only allowed with INTEGRATION_MODE=fixtures/);
    expect(parseConfig({ NODE_ENV: "test", INTEGRATION_MODE: "live" }).auth.mode).toBe("clerk");
  });

  it("rejects spoofed identity fields and headers in signed-in mode", async () => {
    const w = world();
    const s = await submitted(w);
    const spoofBody = await w.h.call("POST", `/api/v1/proposals/${s.proposalId}/decision`, { version: 1, decision: "reject", actor: "executive-demo" }, as(w.emp, { "idempotency-key": "spoof-1234" }));
    expect(spoofBody.status).toBe(400);
    expect(spoofBody.body.error.code).toBe("IDENTITY_FIELD_NOT_ALLOWED");
    const spoofHeader = await w.h.call("GET", "/api/v1/budget", undefined, as(w.emp, { "x-demo-actor": "executive-demo" }));
    expect(spoofHeader.body.error.code).toBe("IDENTITY_FIELD_NOT_ALLOWED");
    const noAuthButDemo = await w.h.call("GET", "/api/v1/requests", undefined, { "x-demo-actor": "executive-demo" });
    expect(noAuthButDemo.status).toBe(400);
  });
});

describe("profiles, memberships and the bootstrap allowlist", () => {
  it("returns a safe current-user view; allowlisted users get their server-owned role", async () => {
    const w = world();
    const me = await w.h.call("GET", "/api/v1/me", undefined, as(w.exec));
    expect(me.body.data).toMatchObject({
      user: { displayName: "Erin Executive", email: "exec@runway.test", emailVerified: true, defaultAvatar: "executive_silhouette" },
      membership: { status: "active", role: "executive", company: { id: "org_demo" } },
      auth: { mode: "clerk", demoIdentity: false },
    });
    expect(me.body.meta.demoIdentity).toBe(false);
    const emp = await w.h.call("GET", "/api/v1/me", undefined, as(w.emp));
    expect(emp.body.data.user.defaultAvatar).toBe("employee_silhouette");
  });

  it("an unlisted Google account is signed in but has no access", async () => {
    const w = world();
    const me = await w.h.call("GET", "/api/v1/me", undefined, as(w.stranger));
    expect(me.body.data.membership).toEqual({ status: "pending", role: null, company: null });
    const r = await w.h.call("GET", "/api/v1/requests", undefined, as(w.stranger));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("ACCESS_PENDING");
    expect((await w.h.call("POST", "/api/v1/requests", { title: "x", quantity: 1, currency: "USD", budgetCents: 100 }, as(w.stranger))).status).toBe(403);
  });

  it("an unverified email never matches the allowlist", async () => {
    const w = world();
    const t = w.idp.addUser("u_unverified", "Una", "exec2@runway.test", false);
    writeFileSync(w.bootstrapFile, JSON.stringify({ members: [{ email: "exec2@runway.test", role: "executive", company: "org_demo" }] }));
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(t))).body.data.membership.status).toBe("pending");
  });

  it("profile edits cannot change role or company; display name and avatar style can change", async () => {
    const w = world();
    const role = await w.h.call("PATCH", "/api/v1/me", { role: "executive" }, as(w.emp));
    expect(role.status).toBe(422);
    const company = await w.h.call("PATCH", "/api/v1/me", { company: "org_other" }, as(w.emp));
    expect(company.status).toBe(422);
    const ok = await w.h.call("PATCH", "/api/v1/me", { displayName: "Emma E.", avatarStyle: "employee_silhouette" }, as(w.emp));
    expect(ok.body.data).toMatchObject({ user: { displayName: "Emma E.", avatarStyle: "employee_silhouette" }, membership: { role: "employee" } });
    // A later sign-in refresh does not overwrite the role (still employee) or the edited name.
    w.h.clock.now = new Date(Date.now() + 11 * 60_000);
    const again = await w.h.call("GET", "/api/v1/me", undefined, as(w.emp));
    expect(again.body.data).toMatchObject({ user: { displayName: "Emma E." }, membership: { role: "employee" } });
  });

  it("removing an email from the allowlist revokes access on the next request", async () => {
    const w = world();
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(w.exec))).body.data.membership.role).toBe("executive");
    writeFileSync(w.bootstrapFile, JSON.stringify({ members: [{ email: "emp@runway.test", role: "employee", company: "org_demo" }] }));
    const after = await w.h.call("GET", "/api/v1/me", undefined, as(w.exec));
    expect(after.body.data.membership.status).toBe("pending");
    expect((await w.h.call("GET", "/api/v1/proposals", undefined, as(w.exec))).status).toBe(403);
  });
});

describe("authorization and scoping", () => {
  it("employees cannot approve, use executive endpoints, or read colleagues' records", async () => {
    const w = world();
    const s = await submitted(w);
    const approve = await decide(w, w.emp, s.proposalId, { version: 1, decision: "approve", confirmation: confirm(1, s.exact) });
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe("FORBIDDEN_ROLE");
    expect((await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview`, undefined, as(w.emp))).status).toBe(403);
    expect((await w.h.call("GET", "/api/v1/purchase-history", undefined, as(w.emp))).status).toBe(403);
    expect((await w.h.call("POST", "/api/v1/agent-configs", { displayName: "x", instructions: "", enabledTools: ["searchProducts"], rankingPriority: "lowest_known_total", searchStrategy: "exact_specs", limits: { maxSearchCalls: 1, maxSteps: 4, maxDurationMs: 60000 } }, as(w.emp))).status).toBe(403);
    // Another employee in the same company sees nothing by id or in lists.
    for (const url of [`/api/v1/requests/${s.requestId}`, `/api/v1/proposals/${s.proposalId}`, `/api/v1/proposals/${s.proposalId}/confirmation`]) {
      expect((await w.h.call("GET", url, undefined, as(w.emp2))).status).toBe(404);
    }
    expect((await w.h.call("GET", "/api/v1/requests", undefined, as(w.emp2))).body.data).toEqual([]);
    expect((await w.h.call("GET", "/api/v1/proposals", undefined, as(w.emp2))).body.data).toEqual([]);
    // Budget: employees get status only, never company figures.
    const b = await w.h.call("GET", "/api/v1/budget", undefined, as(w.emp));
    expect(b.body.data).toMatchObject({ scope: "employee", availableBudgetCents: null, reportedBalanceCents: null });
    const detail = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}`, undefined, as(w.emp));
    expect(detail.body.data.financialAssessment).toBeNull();
    expect(detail.body.data.budgetAssessment.availableBudgetCents).toBeNull();
  });

  it("an executive in another company can neither read nor decide the proposal", async () => {
    const w = world();
    const s = await submitted(w);
    expect((await w.h.call("GET", `/api/v1/proposals/${s.proposalId}`, undefined, as(w.otherExec))).status).toBe(404);
    const d = await decide(w, w.otherExec, s.proposalId, { version: 1, decision: "reject" });
    expect(d.status).toBe(404);
    expect((await w.h.call("GET", "/api/v1/proposals?decisionState=awaiting_review", undefined, as(w.otherExec))).body.data).toEqual([]);
    expect((await w.h.call("GET", "/api/v1/merchant-mappings", undefined, as(w.otherExec))).status).toBe(403);
  });

  it("an executive cannot decide their own proposal", async () => {
    const w = world();
    const own = await w.h.call("POST", "/api/v1/requests", { title: "Wood glue", description: "New wood glue, 8 fl oz", quantity: 1, currency: "USD", budgetCents: 2000, allowedCondition: "new" }, as(w.exec));
    const id = own.body.data.id;
    await w.h.call("POST", `/api/v1/requests/${id}/confirm`, { version: own.body.data.version }, as(w.exec));
    const run = await w.h.call("POST", `/api/v1/requests/${id}/research`, { version: own.body.data.version }, as(w.exec));
    await awaitRun(run.body.data.runId);
    const c = (await w.h.call("GET", `/api/v1/requests/${id}/candidates`, undefined, as(w.exec))).body.data;
    const top = c.candidates.find((x: any) => x.eligibility === "eligible");
    const p = await w.h.call("POST", `/api/v1/requests/${id}/proposals`, { runId: c.runId, offerId: top.offerId }, as(w.exec));
    await w.h.call("POST", `/api/v1/proposals/${p.body.data.id}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: 700 }, as(w.exec));
    const d = await decide(w, w.exec, p.body.data.id, { version: 1, decision: "approve", confirmation: confirm(1, 700) });
    expect(d.body.error.code).toBe("SELF_APPROVAL_NOT_ALLOWED");
  });
});

describe("executive queue, notes and decisions", () => {
  it("a submission appears in the executive queue with counts; the decision and note reach the employee", async () => {
    const w = world();
    const s = await submitted(w);
    const queue = await w.h.call("GET", "/api/v1/proposals?decisionState=awaiting_review", undefined, as(w.exec));
    expect(queue.body.meta.counts.awaiting_review).toBe(1);
    expect(queue.body.meta.serverTime).toBeTruthy();
    const item = queue.body.data[0];
    expect(item).toMatchObject({ id: s.proposalId, decisionState: "awaiting_review", exactAmountCents: s.exact, quantity: 4, employee: { displayName: "Emma Employee", demoIdentity: false } });
    // Polling with updatedAfter returns nothing new until something changes.
    await new Promise((r) => setTimeout(r, 5));
    const since = (await w.h.call("GET", "/api/v1/proposals", undefined, as(w.exec))).body.meta.serverTime;
    await new Promise((r) => setTimeout(r, 5));
    expect((await w.h.call("GET", `/api/v1/proposals?updatedAfter=${encodeURIComponent(since)}`, undefined, as(w.exec))).body.data).toEqual([]);
    const d = await decide(w, w.exec, s.proposalId, { version: 1, decision: "request_changes", note: "  Please   find a seller\r\nwith stated   delivery.  " });
    expect(d.status).toBe(200);
    const mine = await w.h.call("GET", "/api/v1/proposals", undefined, as(w.emp));
    expect(mine.body.data[0]).toMatchObject({ decisionState: "changes_requested", latestDecision: { decision: "request_changes", resultingState: "changes_requested", note: "Please find a seller\nwith stated delivery.", actor: { displayName: "Erin Executive" } } });
    expect((await w.h.call("GET", `/api/v1/proposals?updatedAfter=${encodeURIComponent(since)}`, undefined, as(w.exec))).body.data.length).toBe(1);
    expect((await w.h.call("GET", "/api/v1/proposals?decisionState=awaiting_review", undefined, as(w.exec))).body.meta.counts).toMatchObject({ awaiting_review: 0, changes_requested: 1 });
  });

  it("notes are optional for every decision; malformed or oversized notes are rejected", async () => {
    const w = world();
    const a = await submitted(w);
    const r1 = await decide(w, w.exec, a.proposalId, { version: 1, decision: "reject" });
    expect(r1.status).toBe(200);
    const b = await submitted(w);
    expect((await decide(w, w.exec, b.proposalId, { version: 1, decision: "request_changes", note: "x".repeat(1001) })).status).toBe(422);
    expect((await decide(w, w.exec, b.proposalId, { version: 1, decision: "request_changes", note: "bad\u0007bell" })).status).toBe(422);
    expect((await decide(w, w.exec, b.proposalId, { version: 1, decision: "request_changes" })).status).toBe(200);
    const c = await submitted(w);
    await mapSellerAsExec(w, c.seller);
    const ok = await decide(w, w.exec, c.proposalId, { version: 1, decision: "approve", confirmation: confirm(1, c.exact) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.decisions.at(-1)).toMatchObject({ note: "", confirmation: { proposalVersion: 1, exactAmountCents: c.exact } });
  });

  it("approval needs explicit confirmation of the current version and exact cents; other decisions do not", async () => {
    const w = world();
    const s = await submitted(w);
    await mapSellerAsExec(w, s.seller);
    const missing = await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve" });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(missing.body.error.details.statement).toMatch(/I approve this simulated purchase for \$/);
    const unchecked = await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve", confirmation: { confirmed: false, proposalVersion: 1, exactAmountCents: s.exact } });
    expect(unchecked.body.error.code).toBe("CONFIRMATION_REQUIRED");
    const wrongAmount = await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve", confirmation: confirm(1, s.exact + 1) });
    expect(wrongAmount.status).toBe(409);
    expect(wrongAmount.body.error.code).toBe("TERMS_CHANGED");
    expect(wrongAmount.body.error.details.exactAmountCents).toBe(s.exact);
    expect(w.h.bank.createCalls).toBe(0);
    const ok = await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve", note: "OK for the team", confirmation: confirm(1, s.exact) });
    expect(ok.body.data.execution.status).toBe("recorded");
    const dec = ok.body.data.decisions.at(-1);
    expect(dec).toMatchObject({ decision: "approve", note: "OK for the team", actorInfo: { displayName: "Erin Executive", role: "executive" }, confirmation: { proposalVersion: 1, exactAmountCents: s.exact } });
    expect(dec.confirmation.statement).toContain("I approve this simulated purchase for $");
  });

  it("changed terms invalidate an old review: a revision needs a fresh confirmation", async () => {
    const w = world();
    const s = await submitted(w);
    await decide(w, w.exec, s.proposalId, { version: 1, decision: "request_changes", note: "Lower the amount" });
    const req = (await w.h.call("GET", `/api/v1/requests/${s.requestId}`, undefined, as(w.emp))).body.data;
    const c = (await w.h.call("GET", `/api/v1/requests/${s.requestId}/candidates`, undefined, as(w.emp))).body.data;
    const top = c.candidates.find((x: any) => x.eligibility === "eligible");
    await w.h.call("POST", `/api/v1/requests/${s.requestId}/proposals`, { proposalId: s.proposalId, runId: req.latestRunId, offerId: top.offerId }, as(w.emp));
    await w.h.call("POST", `/api/v1/proposals/${s.proposalId}/submit`, { version: 2, technicalReviewConfirmed: true, exactAmountCents: s.exact - 1000 }, as(w.emp));
    await mapSellerAsExec(w, s.seller);
    const stale = await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve", confirmation: confirm(1, s.exact) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    const oldAmount = await decide(w, w.exec, s.proposalId, { version: 2, decision: "approve", confirmation: confirm(2, s.exact) });
    expect(oldAmount.body.error.code).toBe("TERMS_CHANGED");
    const ok = await decide(w, w.exec, s.proposalId, { version: 2, decision: "approve", confirmation: confirm(2, s.exact - 1000) });
    expect(ok.body.data.execution.approvedAmountCents).toBe(s.exact - 1000);
    // History keeps both decisions with their versions.
    expect(ok.body.data.decisions.map((d: any) => [d.version, d.decision])).toEqual([[1, "request_changes"], [2, "approve"]]);
  });

  it("replays and double clicks give one decision and one purchase, even after a lost response", async () => {
    const w = world();
    const s = await submitted(w);
    await mapSellerAsExec(w, s.seller);
    const body = { version: 1, decision: "approve", note: "Go", confirmation: confirm(1, s.exact) };
    const [a, b] = await Promise.all([decide(w, w.exec, s.proposalId, body, "click-1234"), decide(w, w.exec, s.proposalId, body, "click-1234")]);
    const okOne = [a, b].find((r) => r.status === 200)!;
    // The client never saw a response ("lost"); it retries with the same key and terms.
    const retry = await decide(w, w.exec, s.proposalId, body, "click-1234");
    expect(retry.status).toBe(200);
    expect(retry.body.data.execution.id).toBe(okOne.body.data.execution.id);
    expect(w.h.bank.createCalls).toBe(1);
    expect(w.h.ctx.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE proposal_id = ?").get(s.proposalId)).toEqual({ n: 1 });
    const changed = await decide(w, w.exec, s.proposalId, { ...body, note: "Different" }, "click-1234");
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("financial preview", () => {
  it("projects available budget in cents and never subtracts an existing reservation twice", async () => {
    // Balance $3,200.00 minus a $1,200.00 pending bill = $2,000.00 available.
    const bank = new FixtureBank();
    bank.state.account.balanceCents = 320_000;
    const w = world({ bank });
    const s = await submitted(w, 58756, 2);
    await mapSellerAsExec(w, s.seller);
    const pre = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview?refresh=true`, undefined, as(w.exec));
    expect(pre.body.data).toMatchObject({
      currency: "USD",
      currentAvailableCents: 200000,
      exactExpenseCents: 58756,
      projectedAvailableCents: 141244,
      reservationIncluded: false,
      canApprove: true,
      freshness: { refreshedNow: true },
    });
    expect(pre.body.data.label).toMatch(/Not a bank balance/);
    expect(pre.body.data.unknowns).toContain("Sales tax");
    await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve", confirmation: confirm(1, 58756) });
    const post = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview?refresh=true`, undefined, as(w.exec));
    expect(post.body.data).toMatchObject({ currentAvailableCents: 141244, projectedAvailableCents: 141244, reservationIncluded: true, canApprove: false });
    expect(post.body.data.blockingReasons.map((b: any) => b.code)).toContain("not_awaiting_review");
    // Repeated reads never change the figure.
    const again = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview`, undefined, as(w.exec));
    expect(again.body.data.projectedAvailableCents).toBe(141244);
  });

  it("shows provider-stored amount and discrepancy separately after Nessie rounds to whole dollars", async () => {
    const w = world({ bank: new FixtureBank({ wholeDollars: true }) });
    const s = await submitted(w, 79656);
    await mapSellerAsExec(w, s.seller);
    await decide(w, w.exec, s.proposalId, { version: 1, decision: "approve", confirmation: confirm(1, 79656) });
    const p = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview`, undefined, as(w.exec));
    expect(p.body.data.amounts).toMatchObject({ exactExpenseCents: 79656, approvedAmountCents: 79656, providerStoredAmountCents: 79600, discrepancyCents: 56 });
  });

  it("blocks with clear reasons instead of showing a fake balance when bank data is missing or over budget", async () => {
    const bank = new FixtureBank();
    bank.state.account.balanceCents = 150_000; // $300 available after the $1,200 bill
    const w = world({ bank });
    const s = await submitted(w, 79656);
    const cached = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview`, undefined, as(w.exec));
    const codes = cached.body.data.blockingReasons.map((b: any) => b.code);
    expect(codes).toContain("merchant_mapping_required");
    const fresh = await w.h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview?refresh=true`, undefined, as(w.exec));
    expect(fresh.body.data.currentAvailableCents).toBe(30000);
    expect(fresh.body.data.projectedAvailableCents).toBe(30000 - 79656);
    expect(fresh.body.data.canApprove).toBe(false);
    expect(fresh.body.data.blockingReasons.map((b: any) => b.code)).toContain("exceeds_available_budget");
  });
});

describe("auth configuration", () => {
  it("a blank authorized-parties setting falls back to the frontend origins, never to 'any origin'", () => {
    const c = parseConfig({ NODE_ENV: "test", INTEGRATION_MODE: "fixtures", AUTH_MODE: "clerk", CLERK_AUTHORIZED_PARTIES: "", FRONTEND_ORIGINS: "http://localhost:3000" });
    expect(c.auth.authorizedParties).toEqual(["http://localhost:3000"]);
    expect(parseConfig({ NODE_ENV: "test", INTEGRATION_MODE: "fixtures", AUTH_MODE: "" }).auth.mode).toBe("demo");
  });
});

describe("allowlist from ACCESS_BOOTSTRAP_JSON (hosts without secret files)", () => {
  const ALLOW = JSON.stringify({
    companies: [{ id: "runway_team", name: "Runway team (fictional)" }],
    members: [
      { email: "Boss@Runway.test", role: "executive", company: "runway_team" },
      { email: "worker@runway.test", role: "employee", company: "runway_team" },
    ],
  });

  function jsonWorld(extra: Record<string, string> = {}) {
    // The file lists someone else entirely, proving the inline JSON takes precedence.
    const dir = mkdtempSync(join(tmpdir(), "runway-auth-json-"));
    const file = join(dir, "access.json");
    writeFileSync(file, JSON.stringify({ members: [{ email: "file-only@runway.test", role: "executive", company: "org_demo" }] }));
    const config = testConfig({ AUTH_MODE: "clerk", ACCESS_BOOTSTRAP_FILE: file, ACCESS_BOOTSTRAP_JSON: ALLOW, ACCOUNT_COMPANY_ID: "runway_team", ...extra });
    const idp = new TestIdentityProvider();
    return {
      h: harness({ config, identity: idp }),
      boss: idp.addUser("u_boss", "Bea Boss", "boss@runway.test"),
      worker: idp.addUser("u_worker", "Wes Worker", "worker@runway.test"),
      fileOnly: idp.addUser("u_file", "Fay File", "file-only@runway.test"),
      stranger: idp.addUser("u_str", "Stu Stranger", "stranger@gmail.test"),
      unverified: idp.addUser("u_unv", "Una", "boss2@runway.test", false),
    };
  }

  it("grants server-owned roles from verified emails; JSON wins over the file", async () => {
    const w = jsonWorld();
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(w.boss))).body.data.membership).toMatchObject({ status: "active", role: "executive", company: { id: "runway_team" } });
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(w.worker))).body.data.membership).toMatchObject({ status: "active", role: "employee", company: { id: "runway_team" } });
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(w.fileOnly))).body.data.membership.status).toBe("pending");
  });

  it("unlisted and unverified accounts stay pending; employees get null budget figures", async () => {
    const w = jsonWorld();
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(w.stranger))).body.data.membership).toEqual({ status: "pending", role: null, company: null });
    const pending = await w.h.call("GET", "/api/v1/requests", undefined, as(w.stranger));
    expect([pending.status, pending.body.error.code]).toEqual([403, "ACCESS_PENDING"]);
    expect((await w.h.call("GET", "/api/v1/me", undefined, as(w.unverified))).body.data.membership.status).toBe("pending");
    const budget = await w.h.call("GET", "/api/v1/budget", undefined, as(w.worker));
    expect(budget.status).toBe(200);
    expect(budget.body.data.scope).toBe("employee");
    // Real figures are null; the remaining totals are fixed placeholders that carry no company data.
    expect(budget.body.data).toMatchObject({ reportedBalanceCents: null, availableBudgetCents: null, obligations: [], obligationsCents: 0, activeReservationsCents: 0, unreflectedExpensesCents: 0 });
  });

  it("rejects malformed JSON or schema errors without echoing emails or the text", async () => {
    const cases = [
      '{"members":[{"email":"secret.person@runway.test","role":"executive"',
      JSON.stringify({ members: [{ email: "secret.person@runway.test", role: "owner", company: "runway_team" }] }),
      JSON.stringify({ members: [{ email: "secret.person@runway.test", role: "employee", company: "runway_team" }, { email: "SECRET.person@runway.test", role: "executive", company: "runway_team" }] }),
    ];
    for (const bad of cases) {
      const idp = new TestIdentityProvider();
      const t = idp.addUser("u_x", "X", "secret.person@runway.test");
      const h = harness({ config: testConfig({ AUTH_MODE: "clerk", ACCESS_BOOTSTRAP_JSON: bad }), identity: idp });
      const { loadBootstrap } = await import("../src/auth/access.js");
      let msg = "";
      try {
        loadBootstrap(h.ctx.config.auth);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/^ACCESS_BOOTSTRAP_JSON /);
      expect(msg).not.toMatch(/secret\.person|@/i);
      const r = await h.call("GET", "/api/v1/me", undefined, as(t));
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/secret\.person/i);
    }
  });
});

describe("production deployment config", () => {
  const VERCEL = "https://malakai-saleh-h26.vercel.app";
  const prodEnv = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "8000",
    INTEGRATION_MODE: "live",
    AUTH_MODE: "clerk",
    DEMO_MODE: "false",
    FRONTEND_ORIGINS: `${VERCEL}/`,
    CLERK_AUTHORIZED_PARTIES: VERCEL,
  };

  it("parses the hosted settings; a trailing slash on an origin still matches", () => {
    const c = parseConfig({ ...prodEnv, DATABASE_PATH: "/data/runway.sqlite" });
    expect(c).toMatchObject({ nodeEnv: "production", host: "0.0.0.0", port: 8000, mode: "live", demoMode: false, databasePath: "/data/runway.sqlite", frontendOrigins: [VERCEL] });
    expect(c.auth).toMatchObject({ mode: "clerk", authorizedParties: [VERCEL], bootstrapJson: null });
  });

  it("CORS allows the Vercel origin with Authorization and Idempotency-Key, and no other origin", async () => {
    // Fixtures integrations so nothing paid can run; the CORS and auth layers are the same code.
    const h = harness({ config: testConfig({ AUTH_MODE: "clerk", FRONTEND_ORIGINS: `${VERCEL}/` }), identity: new TestIdentityProvider() });
    const pre = await h.app.inject({
      method: "OPTIONS",
      url: "/api/v1/proposals/prp_x/decision",
      headers: { origin: VERCEL, "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key,content-type" },
    });
    expect(pre.statusCode).toBeLessThan(300);
    expect(pre.headers["access-control-allow-origin"]).toBe(VERCEL);
    const allowed = String(pre.headers["access-control-allow-headers"]).toLowerCase();
    for (const hd of ["authorization", "idempotency-key", "content-type"]) expect(allowed).toContain(hd);
    expect(String(pre.headers["access-control-allow-methods"])).toContain("POST");
    const evil = await h.app.inject({ method: "OPTIONS", url: "/api/v1/me", headers: { origin: "https://evil.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const noToken = await h.app.inject({ method: "GET", url: "/api/v1/me", headers: { origin: VERCEL } });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().error.code).toBe("UNAUTHENTICATED");
    expect(noToken.headers["access-control-allow-origin"]).toBe(VERCEL);
    const bad = await h.app.inject({ method: "GET", url: "/api/v1/me", headers: { origin: VERCEL, authorization: "Bearer not-a-real-token" } });
    expect([bad.statusCode, bad.json().error.code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});
