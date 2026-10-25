// Read-only Nessie contract probe. Prints status codes and response shapes (keys and value
// types, never full bodies) for the routes Runway relies on. Makes no writes.
import { loadEnvFile, parseConfig, secretValues } from "../src/config.js";
import { registerSecrets } from "../src/lib/redact.js";
import { NessieClient, unwrapArray, unwrapObject } from "../src/integrations/nessie.js";
import { openDatabase } from "../src/db/db.js";

loadEnvFile();
const config = parseConfig(process.env);
registerSecrets(secretValues(config));
const client = new NessieClient({ apiKey: config.nessie.apiKey, baseUrl: config.nessie.baseUrl });

const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.length ? [shape(v[0]), `(${v.length} items)`] : "[] (empty)";
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "object" && x !== null ? shape(x) : typeof x]));
  return typeof v;
};
async function probe(label: string, path: string) {
  const res = await client.request("GET", path);
  console.log(`\nGET ${path.replace(/\/[a-f0-9]{24}/g, "/{id}")} -> HTTP ${res.status}`);
  console.log(JSON.stringify(shape(res.body), null, 1).slice(0, 1500));
  return res.body;
}

console.log(`Base URL: ${config.nessie.baseUrl}`);
const customers = unwrapArray(await probe("customers", "/customers")) ?? [];
const db = openDatabase(config.databasePath);
const seeded = db.prepare("SELECT kind, name, external_id FROM nessie_resources").all() as Array<{ kind: string; name: string; external_id: string }>;
const accountId = config.nessie.accountId ?? seeded.find((s) => s.kind === "account")?.external_id ?? null;
const customerId = config.nessie.customerId ?? seeded.find((s) => s.kind === "customer")?.external_id ?? (customers[0] as { _id?: string } | undefined)?._id ?? null;
if (customerId) await probe("customer accounts", `/customers/${customerId}/accounts`);
if (accountId) {
  const acct = unwrapObject(await probe("account", `/accounts/${accountId}`));
  console.log(`\nbalance raw value: ${JSON.stringify(acct?.balance)} (type ${typeof acct?.balance})`);
  await probe("bills", `/accounts/${accountId}/bills`);
  const purchases = await probe("purchases", `/accounts/${accountId}/purchases`);
  const first = (unwrapArray(purchases) ?? [])[0] as { _id?: string } | undefined;
  if (first?._id) await probe("purchase detail", `/purchase/${first._id}`);
} else {
  console.log("\nNo account id yet (set NESSIE_ACCOUNT_ID or run npm run seed:nessie).");
}
await probe("merchants", "/merchants");
