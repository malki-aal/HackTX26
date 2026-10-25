// The live Nessie client's company → employee transfer, against a mocked HTTP layer (no network).
import { afterEach, describe, expect, it, vi } from "vitest";
import { NessieClient } from "../src/integrations/nessie.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

const client = () => new NessieClient({ apiKey: "test-key", baseUrl: "https://nessie.test" });
const input = { payeeAccountId: "acct_employee", amountCents: 12499, description: "Runway exe_123 | blender", date: "2026-10-25" };
const calls = (f: ReturnType<typeof vi.fn>) =>
  (f.mock.calls as Array<[string, RequestInit | undefined]>).map(([url, init]) => ({ method: init?.method ?? "GET", path: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : null }));

describe("Nessie transfer (current API has no payee on TransferCreate)", () => {
  it("records a deposit to the employee, then a matching company withdrawal, without payee_id", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(201, { code: 201, message: "Created deposit", objectCreated: { _id: "dep_1", amount: 124.99, status: "pending", description: input.description, payee_id: "acct_employee" } }))
      .mockResolvedValueOnce(json(201, { code: 201, message: "Created withdrawal", objectCreated: { _id: "wd_1" } }));
    vi.stubGlobal("fetch", f);
    const res = await client().createTransfer("acct_company", input);
    expect(res).toMatchObject({ externalId: "dep_1", providerStatus: "pending", httpStatus: 201 });
    const [dep, wd] = calls(f);
    expect(dep).toEqual({ method: "POST", path: "/accounts/acct_employee/deposits", body: { medium: "balance", transaction_date: "2026-10-25", status: "pending", amount: 124.99, description: input.description } });
    expect(wd).toEqual({ method: "POST", path: "/accounts/acct_company/withdrawals", body: { medium: "balance", transaction_date: "2026-10-25", status: "pending", amount: 124.99, description: input.description } });
    for (const c of [dep!, wd!]) expect(c.body).not.toHaveProperty("payee_id");
  });

  it("a rejected deposit fails definitively and no withdrawal is attempted", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(400, "1 validation error for DepositCreate"));
    vi.stubGlobal("fetch", f);
    await expect(client().createTransfer("acct_company", input)).rejects.toMatchObject({ outcome: "definitive" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a failed company withdrawal keeps the employee deposit and says so", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(201, { objectCreated: { _id: "dep_2", amount: 124.99, status: "pending" } }))
      .mockResolvedValueOnce(json(400, "validation error"));
    vi.stubGlobal("fetch", f);
    const res = await client().createTransfer("acct_company", input);
    expect(res.externalId).toBe("dep_2");
    expect(res.message).toMatch(/matching company withdrawal was not \(HTTP 400\)/);
  });

  it("reads a transfer back by its deposit, and finds it on the employee side by reference", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(200, { _id: "dep_1", amount: 124.99, status: "executed", description: input.description, transaction_date: "2026-10-25" }))
      .mockResolvedValueOnce(json(200, [{ _id: "dep_1", amount: 124.99, status: "pending", description: input.description }]));
    vi.stubGlobal("fetch", f);
    const c = client();
    expect(await c.getTransfer("dep_1")).toMatchObject({ id: "dep_1", amountCents: 12499, status: "executed" });
    expect(await c.listTransfersTo("acct_employee")).toEqual([expect.objectContaining({ id: "dep_1", payeeId: "acct_employee" })]);
    expect(calls(f).map((x) => x.path)).toEqual(["/deposits/dep_1", "/accounts/acct_employee/deposits"]);
  });
});
