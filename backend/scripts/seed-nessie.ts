// Explicit, rerunnable Nessie seed. Creates or reuses only namespaced, clearly fictional Runway
// resources owned by this key; never deletes or modifies anything else. Server startup never seeds.
import { loadEnvFile, parseConfig, secretValues } from "../src/config.js";
import { registerSecrets } from "../src/lib/redact.js";
import { NessieClient } from "../src/integrations/nessie.js";
import { openDatabase, nowIso } from "../src/db/db.js";
import { DEMO_ACCOUNT_RESOURCE } from "../src/services/budget.js";

loadEnvFile();
const config = parseConfig(process.env);
registerSecrets(secretValues(config));
if (config.mode !== "live") {
  console.error("seed:nessie writes to the live sandbox; set INTEGRATION_MODE=live.");
  process.exit(1);
}
const client = new NessieClient({ apiKey: config.nessie.apiKey, baseUrl: config.nessie.baseUrl });
const db = openDatabase(config.databasePath);

const CUSTOMER = { first_name: "Runway", last_name: "Demo Co (fictional)", address: { street_number: "100", street_name: "Sandbox Ave", city: "Austin", state: "TX", zip: "78701" } };
const ACCOUNT_NICKNAME = "Runway Demo Operating (sandbox)";
const OPENING_BALANCE_DOLLARS = Number(process.env.SEED_OPENING_BALANCE ?? 25000);
// payment_date is required in practice: Nessie accepts a bill without it but then fails every
// bill listing on the account with a validation error (observed 2026-10-24).
const nextMonthFirst = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
})();
const BILL = { status: "pending", payee: "Fictional Office Lease LLC", nickname: "Runway demo rent (fictional)", payment_amount: 1500, recurring_date: 1, payment_date: nextMonthFirst };

const remember = (kind: string, name: string, id: string, payload: unknown) =>
  db.prepare("INSERT INTO nessie_resources (kind, name, external_id, payload, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, name) DO UPDATE SET external_id = excluded.external_id").run(kind, name, id, JSON.stringify(payload), nowIso());
const known = (kind: string, name: string) => (db.prepare("SELECT external_id FROM nessie_resources WHERE kind = ? AND name = ?").get(kind, name) as { external_id: string } | undefined)?.external_id;

// Customer: reuse by exact fictional name among customers this key can see.
let customerId = config.nessie.customerId ?? known("customer", "runway_demo_customer");
if (!customerId) {
  const existing = (await client.listCustomers()).find((c) => c.first_name === CUSTOMER.first_name && c.last_name === CUSTOMER.last_name);
  if (existing && typeof existing._id === "string") customerId = existing._id;
  else {
    const created = await client.create("/customers", CUSTOMER);
    console.log(`POST /customers -> HTTP ${created.status}; response keys: ${Object.keys((created.raw as object) ?? {}).join(", ")}`);
    customerId = typeof created.object?._id === "string" ? created.object._id : undefined;
    if (!customerId) {
      const again = (await client.listCustomers()).find((c) => c.first_name === CUSTOMER.first_name && c.last_name === CUSTOMER.last_name);
      customerId = typeof again?._id === "string" ? again._id : undefined;
    }
  }
}
if (!customerId) throw new Error("Could not create or find the Runway demo customer");
remember("customer", "runway_demo_customer", customerId, CUSTOMER);
console.log(`customer: ${customerId}`);

// Account: reuse by nickname under that customer.
let accountId = config.nessie.accountId ?? known("account", DEMO_ACCOUNT_RESOURCE);
if (!accountId) {
  const accounts = await client.listCustomerAccounts(customerId);
  const existing = accounts.find((a) => a.nickname === ACCOUNT_NICKNAME);
  if (existing && typeof existing._id === "string") accountId = existing._id;
  else {
    const created = await client.create(`/customers/${customerId}/accounts`, { type: "Checking", nickname: ACCOUNT_NICKNAME, rewards: 0, balance: OPENING_BALANCE_DOLLARS });
    console.log(`POST /customers/{id}/accounts -> HTTP ${created.status}; response keys: ${Object.keys((created.raw as object) ?? {}).join(", ")}`);
    accountId = typeof created.object?._id === "string" ? created.object._id : undefined;
    if (!accountId) accountId = ((await client.listCustomerAccounts(customerId)).find((a) => a.nickname === ACCOUNT_NICKNAME)?._id as string | undefined) ?? undefined;
  }
}
if (!accountId) throw new Error("Could not create or find the Runway demo account");
remember("account", DEMO_ACCOUNT_RESOURCE, accountId, { nickname: ACCOUNT_NICKNAME });
console.log(`account: ${accountId}`);

// One pending bill so the budget shows an obligation. Reused by nickname.
const billsRes = await client.request("GET", `/accounts/${accountId}/bills`);
const bills = Array.isArray(billsRes.body) ? (billsRes.body as Array<Record<string, unknown>>) : [];
if (!bills.some((b) => b.nickname === BILL.nickname) && !known("bill", "runway_demo_rent")) {
  const created = await client.create(`/accounts/${accountId}/bills`, BILL);
  console.log(`POST /accounts/{id}/bills -> HTTP ${created.status}`);
  const id = typeof created.object?._id === "string" ? created.object._id : "created";
  remember("bill", "runway_demo_rent", id, BILL);
} else console.log("bill: already present");

const acct = await client.getAccount(accountId);
console.log(`\nVerified account read: ${acct.nickname}, balance raw=${acct.rawBalance} -> ${acct.balanceCents} cents`);
console.log(`\nAdd to backend/.env (optional; ids are also stored in the local database):\nNESSIE_CUSTOMER_ID=${customerId}\nNESSIE_ACCOUNT_ID=${accountId}`);
