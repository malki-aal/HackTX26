// Capital One Nessie sandbox adapter. Customer (non-enterprise) endpoints only; writes are limited
// to resources owned by the configured key. Response shapes are validated loosely because the
// published spec leaves many bodies untyped; see docs/NESSIE.md for verified behavior.
import { z } from "zod";
import { IntegrationError } from "../lib/errors.js";
import { httpJson, type HttpResponse } from "../lib/http.js";
import { floatToCents } from "../domain/money.js";
import type { BillSnapshot } from "../domain/budget.js";

export interface NessieAccount {
  id: string;
  type: string;
  nickname: string;
  balanceCents: number;
  rawBalance: number;
  customerId: string | null;
  /** 16-digit sandbox account number; only ever exposed masked. */
  accountNumber: string | null;
}

/** Normalized Nessie merchant (GET /merchants/{id}). */
export interface NessieMerchant {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  state: string | null;
}

export function maskAccountNumber(n: string | null): string | null {
  return n && n.length >= 4 ? `•••• ${n.slice(-4)}` : null;
}

export interface NessiePurchase {
  id: string;
  merchantId: string | null;
  amountCents: number | null;
  rawAmount: unknown;
  status: string | null;
  medium: string | null;
  description: string | null;
  date: string | null;
}

export interface CreatePurchaseInput {
  merchantId: string;
  amountCents: number;
  description: string;
  date: string; // YYYY-MM-DD
}

export interface CreatePurchaseResult {
  externalId: string | null;
  providerStatus: string | null;
  providerAmount: unknown;
  httpStatus: number;
  message: string | null;
}

/** A transfer between two Nessie accounts (company → employee). */
export interface NessieTransfer {
  id: string;
  payerId: string | null;
  payeeId: string | null;
  amountCents: number | null;
  rawAmount: unknown;
  status: string | null;
  description: string | null;
  date: string | null;
}

export interface CreateTransferInput {
  payeeAccountId: string;
  amountCents: number;
  description: string;
  date: string; // YYYY-MM-DD
}

export interface BankAdapter {
  readonly source: "nessie_live" | "fixture";
  /** Single POST, never retried. Ambiguous failures surface as IntegrationError(outcome="ambiguous"). */
  createTransfer(payerAccountId: string, input: CreateTransferInput): Promise<CreatePurchaseResult>;
  getTransfer(transferId: string): Promise<NessieTransfer | null>;
  /** Transfers the account sent (payer side). */
  listTransfers(payerAccountId: string): Promise<NessieTransfer[]>;
  /** Sandbox customer + checking account for an employee (starts at $0). */
  createCustomer(firstName: string, lastName: string): Promise<{ id: string }>;
  createAccount(customerId: string, nickname: string): Promise<NessieAccount>;
  getAccount(accountId: string): Promise<NessieAccount>;
  listBills(accountId: string): Promise<BillSnapshot[]>;
  listPurchases(accountId: string): Promise<NessiePurchase[]>;
  getPurchase(purchaseId: string): Promise<NessiePurchase | null>;
  createPurchase(accountId: string, input: CreatePurchaseInput): Promise<CreatePurchaseResult>;
  getMerchant(merchantId: string): Promise<NessieMerchant | null>;
  /** Creates a clearly labeled sandbox merchant; only called on an explicit mapping request. */
  createMerchant(name: string, category: string): Promise<NessieMerchant>;
}

const Id24 = z.string().min(1);
const AccountSchema = z.object({ _id: Id24, type: z.string(), nickname: z.string().default(""), balance: z.number(), customer_id: z.string().optional(), account_number: z.string().optional() }).passthrough();
const MerchantSchema = z
  .object({
    _id: Id24,
    name: z.string(),
    category: z.union([z.string(), z.array(z.string())]).optional().nullable(),
    address: z.object({ city: z.string().optional(), state: z.string().optional() }).passthrough().optional().nullable(),
  })
  .passthrough();
function toMerchant(m: z.infer<typeof MerchantSchema>): NessieMerchant {
  return { id: m._id, name: m.name, category: Array.isArray(m.category) ? (m.category[0] ?? null) : (m.category ?? null), city: m.address?.city ?? null, state: m.address?.state ?? null };
}
const PurchaseSchema = z
  .object({
    _id: Id24,
    merchant_id: z.string().optional().nullable(),
    amount: z.unknown(),
    status: z.string().optional().nullable(),
    medium: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    purchase_date: z.string().optional().nullable(),
    transaction_date: z.string().optional().nullable(),
  })
  .passthrough();
const TransferSchema = z
  .object({
    _id: Id24,
    payer_id: z.string().optional().nullable(),
    payee_id: z.string().optional().nullable(),
    amount: z.unknown(),
    status: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    transaction_date: z.string().optional().nullable(),
  })
  .passthrough();
function toTransfer(t: z.infer<typeof TransferSchema>): NessieTransfer {
  return { id: t._id, payerId: t.payer_id ?? null, payeeId: t.payee_id ?? null, amountCents: fromNessieAmount(t.amount), rawAmount: t.amount, status: t.status ?? null, description: t.description ?? null, date: t.transaction_date ?? null };
}
const BillSchema = z.object({ _id: Id24, status: z.string(), payee: z.string().default(""), payment_amount: z.number().optional() }).passthrough();

/** Unit conversion: Nessie amounts are dollars (number). Cents are converted at the boundary only. */
export const toNessieAmount = (cents: number) => cents / 100;
export const fromNessieAmount = (v: unknown) => (typeof v === "number" ? floatToCents(v) : typeof v === "string" ? floatToCents(Number(v)) : null);

function toPurchase(p: z.infer<typeof PurchaseSchema>): NessiePurchase {
  return {
    id: p._id,
    merchantId: p.merchant_id ?? null,
    amountCents: fromNessieAmount(p.amount),
    rawAmount: p.amount,
    status: p.status ?? null,
    medium: p.medium ?? null,
    description: p.description ?? null,
    date: p.transaction_date ?? p.purchase_date ?? null,
  };
}

/** Accept a bare object, a {objectCreated} wrapper, or a {data} wrapper. */
export function unwrapObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  for (const k of ["objectCreated", "object_created", "data", "result"]) {
    if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k])) return b[k] as Record<string, unknown>;
  }
  return b;
}

export function unwrapArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const k of ["data", "results", "items"]) if (Array.isArray(b[k])) return b[k] as unknown[];
  }
  return null;
}

export class NessieClient implements BankAdapter {
  readonly source = "nessie_live" as const;
  constructor(private readonly opts: { apiKey: string | null; baseUrl: string; timeoutMs?: number }) {}

  private url(path: string): string {
    if (!this.opts.apiKey) throw new IntegrationError("nessie", "INTEGRATION_NOT_CONFIGURED", "NESSIE_API_KEY is not set", "definitive", false);
    const u = new URL(this.opts.baseUrl + path);
    u.searchParams.set("key", this.opts.apiKey);
    return u.toString();
  }

  async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<HttpResponse> {
    const res = await httpJson({ service: "nessie", method, url: this.url(path), body, timeoutMs: this.opts.timeoutMs ?? 15_000, retries: 2 });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("nessie", "INTEGRATION_NOT_CONFIGURED", `Nessie rejected the API key (HTTP ${res.status})`, "definitive", false, res.status);
    return res;
  }

  private fail(res: HttpResponse, what: string): never {
    const msg = typeof res.body === "object" && res.body ? (res.body as { message?: string }).message : res.text;
    throw new IntegrationError("nessie", res.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR", `Nessie ${what} failed (HTTP ${res.status}): ${String(msg ?? "").slice(0, 160)}`, "definitive", false, res.status);
  }

  async getAccount(accountId: string): Promise<NessieAccount> {
    const res = await this.request("GET", `/accounts/${encodeURIComponent(accountId)}`);
    if (res.status !== 200) this.fail(res, "account read");
    const parsed = AccountSchema.safeParse(unwrapObject(res.body));
    if (!parsed.success) throw new IntegrationError("nessie", "UPSTREAM_ERROR", "Nessie account response did not match expected shape", "definitive", false, res.status);
    const cents = floatToCents(parsed.data.balance);
    if (cents === null) throw new IntegrationError("nessie", "UPSTREAM_ERROR", "Nessie account balance is not a non-negative number", "definitive", false);
    return { id: parsed.data._id, type: parsed.data.type, nickname: parsed.data.nickname, balanceCents: cents, rawBalance: parsed.data.balance, customerId: parsed.data.customer_id ?? null, accountNumber: parsed.data.account_number ?? null };
  }

  async listBills(accountId: string): Promise<BillSnapshot[]> {
    const res = await this.request("GET", `/accounts/${encodeURIComponent(accountId)}/bills`);
    if (res.status === 404) return [];
    if (res.status !== 200) this.fail(res, "bills read");
    const arr = unwrapArray(res.body) ?? [];
    return arr.flatMap((b) => {
      const p = BillSchema.safeParse(b);
      if (!p.success) return [];
      return [{ id: p.data._id, payee: p.data.payee, status: p.data.status, amountCents: p.data.payment_amount === undefined ? null : floatToCents(p.data.payment_amount) }];
    });
  }

  async listPurchases(accountId: string): Promise<NessiePurchase[]> {
    const res = await this.request("GET", `/accounts/${encodeURIComponent(accountId)}/purchases`);
    if (res.status === 404) return [];
    if (res.status !== 200) this.fail(res, "purchases read");
    const arr = unwrapArray(res.body) ?? [];
    return arr.flatMap((p) => {
      const parsed = PurchaseSchema.safeParse(p);
      return parsed.success ? [toPurchase(parsed.data)] : [];
    });
  }

  async getPurchase(purchaseId: string): Promise<NessiePurchase | null> {
    const res = await this.request("GET", `/purchase/${encodeURIComponent(purchaseId)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res, "purchase read");
    const parsed = PurchaseSchema.safeParse(unwrapObject(res.body));
    return parsed.success ? toPurchase(parsed.data) : null;
  }

  /** Single POST, never retried here. Ambiguous failures surface as IntegrationError(outcome="ambiguous"). */
  async createPurchase(accountId: string, input: CreatePurchaseInput): Promise<CreatePurchaseResult> {
    const body = {
      merchant_id: input.merchantId,
      medium: "balance",
      purchase_date: input.date,
      amount: toNessieAmount(input.amountCents),
      status: "pending",
      description: input.description,
    };
    const res = await this.request("POST", `/accounts/${encodeURIComponent(accountId)}/purchases`, body);
    if (res.status !== 200 && res.status !== 201 && res.status !== 202) this.fail(res, "purchase create");
    const obj = unwrapObject(res.body);
    const created = obj ? PurchaseSchema.safeParse(obj) : null;
    const message = res.body && typeof res.body === "object" ? ((res.body as { message?: string }).message ?? null) : typeof res.body === "string" ? res.body.slice(0, 200) : null;
    return {
      externalId: created?.success ? created.data._id : null,
      providerStatus: created?.success ? (created.data.status ?? null) : null,
      providerAmount: created?.success ? created.data.amount : null,
      httpStatus: res.status,
      message,
    };
  }

  /** Single POST, never retried here (same contract as createPurchase). */
  async createTransfer(payerAccountId: string, input: CreateTransferInput): Promise<CreatePurchaseResult> {
    const body = {
      medium: "balance",
      payee_id: input.payeeAccountId,
      amount: toNessieAmount(input.amountCents),
      transaction_date: input.date,
      status: "pending",
      description: input.description,
    };
    const res = await this.request("POST", `/accounts/${encodeURIComponent(payerAccountId)}/transfers`, body);
    if (res.status !== 200 && res.status !== 201 && res.status !== 202) this.fail(res, "transfer create");
    const obj = unwrapObject(res.body);
    const created = obj ? TransferSchema.safeParse(obj) : null;
    const message = res.body && typeof res.body === "object" ? ((res.body as { message?: string }).message ?? null) : typeof res.body === "string" ? res.body.slice(0, 200) : null;
    return {
      externalId: created?.success ? created.data._id : null,
      providerStatus: created?.success ? (created.data.status ?? null) : null,
      providerAmount: created?.success ? created.data.amount : null,
      httpStatus: res.status,
      message,
    };
  }

  async getTransfer(transferId: string): Promise<NessieTransfer | null> {
    const res = await this.request("GET", `/transfers/${encodeURIComponent(transferId)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res, "transfer read");
    const parsed = TransferSchema.safeParse(unwrapObject(res.body));
    return parsed.success ? toTransfer(parsed.data) : null;
  }

  async listTransfers(payerAccountId: string): Promise<NessieTransfer[]> {
    const res = await this.request("GET", `/accounts/${encodeURIComponent(payerAccountId)}/transfers?type=payer`);
    if (res.status === 404) return [];
    if (res.status !== 200) this.fail(res, "transfers read");
    return (unwrapArray(res.body) ?? []).flatMap((t) => {
      const parsed = TransferSchema.safeParse(t);
      return parsed.success ? [toTransfer(parsed.data)] : [];
    });
  }

  async createCustomer(firstName: string, lastName: string): Promise<{ id: string }> {
    const created = await this.create("/customers", {
      first_name: firstName.slice(0, 40) || "Runway",
      last_name: lastName.slice(0, 40) || "Employee",
      address: { street_number: "1", street_name: "Sandbox Way", city: "Austin", state: "TX", zip: "78701" },
    });
    const id = typeof created.object?._id === "string" ? created.object._id : null;
    if (!id) throw new IntegrationError("nessie", "UPSTREAM_ERROR", "Nessie customer creation returned no id", "definitive", false);
    return { id };
  }

  async createAccount(customerId: string, nickname: string): Promise<NessieAccount> {
    const created = await this.create(`/customers/${encodeURIComponent(customerId)}/accounts`, { type: "Checking", nickname: nickname.slice(0, 60), rewards: 0, balance: 0 });
    const parsed = AccountSchema.safeParse(created.object);
    if (!parsed.success) throw new IntegrationError("nessie", "UPSTREAM_ERROR", "Nessie account creation returned no account", "definitive", false);
    const a = parsed.data;
    return { id: a._id, type: a.type, nickname: a.nickname, balanceCents: floatToCents(a.balance) ?? 0, rawBalance: a.balance, customerId: a.customer_id ?? customerId, accountNumber: a.account_number ?? null };
  }

  async getMerchant(merchantId: string): Promise<NessieMerchant | null> {
    const res = await this.request("GET", `/merchants/${encodeURIComponent(merchantId)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res, "merchant read");
    const parsed = MerchantSchema.safeParse(unwrapObject(res.body));
    return parsed.success ? toMerchant(parsed.data) : null;
  }

  async createMerchant(name: string, category: string): Promise<NessieMerchant> {
    // Nessie validates category as a string (an array is rejected with HTTP 400; observed live).
    const created = await this.create("/merchants", {
      name,
      category,
      address: { street_number: "1", street_name: "Sandbox Way", city: "Austin", state: "TX", zip: "78701" },
      geocode: { lat: 30.2672, lng: -97.7431 },
    });
    const parsed = MerchantSchema.safeParse(created.object);
    if (!parsed.success) throw new IntegrationError("nessie", "UPSTREAM_ERROR", "Nessie merchant creation returned no merchant", "definitive", false);
    return toMerchant(parsed.data);
  }

  // ---- Seed helpers (owned resources only) ----

  async listCustomers(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("GET", "/customers");
    if (res.status !== 200) this.fail(res, "customers read");
    return (unwrapArray(res.body) ?? []) as Array<Record<string, unknown>>;
  }

  async listCustomerAccounts(customerId: string): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("GET", `/customers/${encodeURIComponent(customerId)}/accounts`);
    if (res.status === 404) return [];
    if (res.status !== 200) this.fail(res, "customer accounts read");
    return (unwrapArray(res.body) ?? []) as Array<Record<string, unknown>>;
  }

  async listMerchants(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request("GET", "/merchants");
    if (res.status !== 200) this.fail(res, "merchants read");
    return (unwrapArray(res.body) ?? []) as Array<Record<string, unknown>>;
  }

  async create(path: string, body: unknown): Promise<{ status: number; object: Record<string, unknown> | null; raw: unknown }> {
    const res = await this.request("POST", path, body);
    if (res.status >= 400) this.fail(res, `create ${path}`);
    return { status: res.status, object: unwrapObject(res.body), raw: res.body };
  }
}
