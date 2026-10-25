// Approval → money arrives in the employee's Nessie sandbox account (+), then the employee pays the
// seller (−). Fixtures only. The company budget changes once, at the transfer.
import { describe, expect, it } from "vitest";
import { EXEC, harness, mapSeller, submittedProposal } from "./helpers.js";
import { FixtureBank } from "../src/integrations/fixtures.js";

const approve = async (h: ReturnType<typeof harness>, proposalId: string, key = "wallet-approve-0001") => {
  await mapSeller(h, proposalId);
  const view = (await h.call("GET", `/api/v1/proposals/${proposalId}`, undefined, EXEC)).body.data;
  return h.call("POST", `/api/v1/proposals/${proposalId}/decision`, { version: view.version, decision: "approve", note: "", confirmation: { confirmed: true, proposalVersion: view.version, exactAmountCents: view.amounts.exactAmountCents } }, { ...EXEC, "idempotency-key": key });
};
const pay = (h: ReturnType<typeof harness>, executionId: string, key?: string, headers: Record<string, string> = {}) =>
  h.call("POST", `/api/v1/executions/${executionId}/pay`, {}, { ...(key ? { "idempotency-key": key } : {}), ...headers });

describe("employee wallet", () => {
  it("approval credits the employee (+), paying the seller debits them (−), and the company budget moves once", async () => {
    const h = harness();
    const s = await submittedProposal(h);
    const before = (await h.call("GET", "/api/v1/budget", undefined, EXEC)).body.data.availableBudgetCents;
    const d = await approve(h, s.proposalId);
    expect(d.status).toBe(200);
    const exe = d.body.data.execution;
    expect(exe).toMatchObject({ kind: "transfer", status: "recorded", payee: { displayName: "Demo Employee" } });
    const afterApproval = (await h.call("GET", "/api/v1/budget", undefined, EXEC)).body.data.availableBudgetCents;
    expect(before - afterApproval).toBe(s.amount);

    let w = (await h.call("GET", "/api/v1/me/wallet")).body.data;
    expect(w.account.masked).toMatch(/^•••• \d{4}$/);
    expect(w).toMatchObject({ runwayBalanceCents: s.amount, receivedCents: s.amount, paidCents: 0, reportedBalance: { balanceCents: s.amount } });
    expect(w.entries).toEqual([expect.objectContaining({ type: "received", amountCents: s.amount, status: "recorded", canPay: true, seller: s.top.seller })]);

    // Only the employee who received it can pay, and an Idempotency-Key is required.
    expect((await pay(h, exe.id, "wallet-pay-exec-01", EXEC)).status).toBe(403);
    expect((await pay(h, exe.id)).status).toBe(400);
    const paid = await pay(h, exe.id, "wallet-pay-key-0001");
    expect(paid.status).toBe(200);
    expect(paid.body.data.payment).toMatchObject({ status: "recorded", amountCents: s.amount });
    expect(paid.body.data.externalReference.purchaseId).toMatch(/^fixture_purchase_/);
    expect(h.bank.state.purchases).toHaveLength(1);
    expect(h.bank.state.purchases[0]!.merchantId).toBe(exe.merchantMapping.nessieMerchantId);

    w = (await h.call("GET", "/api/v1/me/wallet")).body.data;
    expect(w).toMatchObject({ runwayBalanceCents: 0, receivedCents: s.amount, paidCents: s.amount, reportedBalance: { balanceCents: 0 } });
    expect(w.entries.map((x: any) => x.type).sort()).toEqual(["paid", "received"]);
    expect(w.entries.find((x: any) => x.type === "received").canPay).toBe(false);
    // Paying from the employee's account never touches the company budget again.
    expect((await h.call("GET", "/api/v1/budget", undefined, EXEC)).body.data.availableBudgetCents).toBe(afterApproval);
  });

  it("pays at most once: retries return the same payment, and a different key cannot pay again", async () => {
    const h = harness();
    const s = await submittedProposal(h);
    const exe = (await approve(h, s.proposalId)).body.data.execution;
    const calls = h.bank.createCalls;
    await pay(h, exe.id, "wallet-once-key-01");
    await pay(h, exe.id, "wallet-once-key-01");
    const other = await pay(h, exe.id, "wallet-once-key-02");
    expect(other.status).toBe(200);
    expect(other.body.data.payment.status).toBe("recorded");
    expect(h.bank.createCalls - calls).toBe(1);
    expect(h.bank.state.purchases).toHaveLength(1);
  });

  it("cannot pay before the money arrives, and an uncertain payment is checked, never resent", async () => {
    const bank = new FixtureBank({ nextCreate: "timeout" });
    const h = harness({ bank });
    const s = await submittedProposal(h);
    const stuck = (await approve(h, s.proposalId)).body.data.execution;
    expect(stuck.status).toBe("uncertain");
    const early = await pay(h, stuck.id, "wallet-early-key-1");
    expect(early.status).toBe(409);

    bank.state.nextCreate = "ok";
    const s2 = await submittedProposal(h);
    const exe = (await approve(h, s2.proposalId, "wallet-approve-0002")).body.data.execution;
    expect(exe.status).toBe("recorded");
    bank.state.nextCreate = "ok_then_timeout"; // the purchase is stored but the response is lost
    const lost = await pay(h, exe.id, "wallet-lost-key-01");
    expect(lost.body.data.payment.status).toBe("uncertain");
    const again = await pay(h, exe.id, "wallet-lost-key-02");
    expect([again.status, again.body.error.code]).toEqual([409, "PAYMENT_UNCERTAIN"]);
    bank.state.nextCreate = "ok";
    const checked = await h.call("POST", `/api/v1/executions/${exe.id}/payment/check`, {});
    expect(checked.body.data.payment.status).toBe("recorded");
    expect(bank.state.purchases).toHaveLength(1); // found by reference, not paid twice
  });

  it("older approvals (company paid the merchant directly) are not payable again", async () => {
    const h = harness();
    const s = await submittedProposal(h);
    const exe = (await approve(h, s.proposalId)).body.data.execution;
    h.ctx.db.prepare("UPDATE executions SET kind = 'purchase' WHERE id = ?").run(exe.id);
    expect((await pay(h, exe.id, "wallet-legacy-key1")).status).toBe(409);
  });
});
