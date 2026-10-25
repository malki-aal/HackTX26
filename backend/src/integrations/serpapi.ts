// SerpApi Google Shopping adapter: server-side only, validated, cached by exact parameters.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProductDetails, RawShoppingItem } from "../domain/types.js";
import { IntegrationError } from "../lib/errors.js";
import { httpJson } from "../lib/http.js";

export interface ShoppingQuery {
  q: string;
  gl: string;
  hl: string;
  location?: string;
}

export interface ShoppingResult {
  items: RawShoppingItem[];
  fetchedAt: Date;
  fromCache: boolean;
  /** "empty" when the provider returned a successful search with no shopping results. */
  outcome: "results" | "empty";
  providerSearchId: string | null;
}

export interface ShoppingSearch {
  readonly source: "serpapi_live" | "fixture";
  search(query: ShoppingQuery, opts: { signal?: AbortSignal }): Promise<ShoppingResult>;
  /** Product-detail lookup by an opaque token from a prior search result (never a URL). */
  details(pageToken: string, opts: { signal?: AbortSignal }): Promise<ProductDetails>;
}

const DetailsResponse = z
  .object({
    error: z.string().optional(),
    product_results: z
      .object({
        title: z.string().optional(),
        about_the_product: z.object({ features: z.array(z.object({ title: z.string(), value: z.string() }).passthrough()).optional() }).passthrough().optional(),
        stores: z
          .array(
            z
              .object({
                name: z.string(),
                extracted_price: z.number().optional(),
                shipping: z.string().optional(),
                shipping_extracted: z.number().optional(),
                details_and_offers: z.array(z.string()).optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseDetailsResponse(body: unknown): ProductDetails {
  const p = DetailsResponse.safeParse(body);
  if (!p.success) throw new IntegrationError("serpapi", "UPSTREAM_ERROR", "SerpApi product details had an unexpected shape", "definitive", false);
  if (p.data.error && !p.data.product_results) throw new IntegrationError("serpapi", "UPSTREAM_ERROR", `SerpApi error: ${p.data.error.slice(0, 200)}`, "definitive", false);
  const pr = p.data.product_results ?? {};
  return {
    title: pr.title ?? null,
    features: (pr.about_the_product?.features ?? []).slice(0, 120).map((f) => ({ title: f.title.slice(0, 80), value: f.value.slice(0, 200) })),
    stores: (pr.stores ?? []).slice(0, 20).map((s) => ({
      name: s.name.slice(0, 120),
      extractedPrice: s.extracted_price ?? null,
      shipping: s.shipping?.slice(0, 60) ?? null,
      shippingExtracted: s.shipping_extracted ?? null,
      details: (s.details_and_offers ?? []).slice(0, 6).map((d) => d.slice(0, 120)),
    })),
  };
}

const Item = z
  .object({
    position: z.number().optional(),
    title: z.string().min(1),
    product_id: z.string().optional(),
    product_link: z.string().optional(),
    link: z.string().optional(),
    source: z.string().optional(),
    price: z.string().optional(),
    extracted_price: z.number().optional(),
    old_price: z.string().optional(),
    installment: z.unknown().optional(),
    alternative_price: z.unknown().optional(),
    second_hand_condition: z.string().optional(),
    delivery: z.string().optional(),
    snippet: z.string().optional(),
    extensions: z.array(z.string()).optional(),
    tag: z.string().optional(),
    thumbnail: z.string().optional(),
    rating: z.number().optional(),
    reviews: z.number().optional(),
  })
  .passthrough();

const Response = z
  .object({
    search_metadata: z.object({ id: z.string().optional(), status: z.string().optional() }).passthrough().optional(),
    shopping_results: z.array(z.unknown()).optional(),
    inline_shopping_results: z.array(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** Keep only fields we use so stored payloads stay bounded and free of unrelated data. */
function compactItem(item: z.infer<typeof Item>): RawShoppingItem {
  const pick = <K extends keyof RawShoppingItem>(k: K) => (item as Record<string, unknown>)[k] as RawShoppingItem[K];
  const out: RawShoppingItem = { title: item.title.slice(0, 300) };
  for (const k of ["position", "product_id", "product_link", "link", "source", "price", "extracted_price", "old_price", "installment", "second_hand_condition", "delivery", "snippet", "tag", "thumbnail", "rating", "reviews", "immersive_product_page_token"] as const) {
    const v = pick(k);
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = typeof v === "string" ? v.slice(0, k === "immersive_product_page_token" ? 4000 : 500) : v;
  }
  if (item.extensions) out.extensions = item.extensions.slice(0, 8).map((e) => e.slice(0, 120));
  return out;
}

export function parseShoppingResponse(body: unknown): { items: RawShoppingItem[]; outcome: "results" | "empty"; providerSearchId: string | null; dropped: number } {
  const parsed = Response.safeParse(body);
  if (!parsed.success) throw new IntegrationError("serpapi", "UPSTREAM_ERROR", "SerpApi returned an unexpected response shape", "definitive", false);
  const r = parsed.data;
  const raw = [...(r.shopping_results ?? []), ...(r.inline_shopping_results ?? [])];
  const items: RawShoppingItem[] = [];
  let dropped = 0;
  for (const it of raw) {
    const p = Item.safeParse(it);
    if (p.success) items.push(compactItem(p.data));
    else dropped++;
  }
  if (r.error && items.length === 0) {
    // SerpApi reports "no results" as a successful search with an error string.
    if (/hasn't returned any results|no results/i.test(r.error)) return { items: [], outcome: "empty", providerSearchId: r.search_metadata?.id ?? null, dropped };
    throw new IntegrationError("serpapi", "UPSTREAM_ERROR", `SerpApi error: ${r.error.slice(0, 200)}`, "definitive", false);
  }
  return { items, outcome: items.length ? "results" : "empty", providerSearchId: r.search_metadata?.id ?? null, dropped };
}

export function cacheKey(q: ShoppingQuery): string {
  return createHash("sha256").update(JSON.stringify({ engine: "google_shopping", q: q.q, gl: q.gl, hl: q.hl, location: q.location ?? null })).digest("hex");
}

/** Small FIFO semaphore bounding concurrent provider calls. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(readonly max: number) {}
  get inFlight() {
    return this.active;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * SerpApi adapter limited to two engines: google_shopping (discover candidates) and
 * google_immersive_product (enrich a shortlisted candidate by the token Shopping returned; this is
 * SerpApi's product-page lookup for the current Google Shopping layout). No other engines.
 */
export class SerpApiShopping implements ShoppingSearch {
  readonly source = "serpapi_live" as const;
  private readonly limiter: Semaphore;
  constructor(private readonly apiKey: string | null, private readonly timeoutMs = 20_000, maxConcurrency = 2) {
    this.limiter = new Semaphore(maxConcurrency);
  }

  async search(query: ShoppingQuery, opts: { signal?: AbortSignal }): Promise<ShoppingResult> {
    return this.limiter.run(() => this.searchNow(query, opts));
  }

  async details(pageToken: string, opts: { signal?: AbortSignal }): Promise<ProductDetails> {
    return this.limiter.run(() => this.detailsNow(pageToken, opts));
  }

  private async searchNow(query: ShoppingQuery, opts: { signal?: AbortSignal }): Promise<ShoppingResult> {
    if (!this.apiKey) throw new IntegrationError("serpapi", "INTEGRATION_NOT_CONFIGURED", "SERPAPI_API_KEY is not set", "definitive", false);
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", query.q);
    url.searchParams.set("gl", query.gl);
    url.searchParams.set("hl", query.hl);
    if (query.location) url.searchParams.set("location", query.location);
    url.searchParams.set("api_key", this.apiKey);
    const res = await httpJson({ service: "serpapi", method: "GET", url: url.toString(), timeoutMs: this.timeoutMs, retries: 1, signal: opts.signal });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("serpapi", "INTEGRATION_NOT_CONFIGURED", "SerpApi rejected the API key", "definitive", false, res.status);
    if (res.status >= 400 && res.status !== 200) {
      const msg = (res.body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new IntegrationError("serpapi", "UPSTREAM_ERROR", `SerpApi error: ${String(msg).slice(0, 200)}`, "definitive", false, res.status);
    }
    const parsed = parseShoppingResponse(res.body);
    return { items: parsed.items, outcome: parsed.outcome, providerSearchId: parsed.providerSearchId, fetchedAt: new Date(), fromCache: false };
  }

  private async detailsNow(pageToken: string, opts: { signal?: AbortSignal }): Promise<ProductDetails> {
    if (!this.apiKey) throw new IntegrationError("serpapi", "INTEGRATION_NOT_CONFIGURED", "SERPAPI_API_KEY is not set", "definitive", false);
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_immersive_product");
    url.searchParams.set("page_token", pageToken);
    url.searchParams.set("api_key", this.apiKey);
    const res = await httpJson({ service: "serpapi", method: "GET", url: url.toString(), timeoutMs: this.timeoutMs, retries: 1, signal: opts.signal });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("serpapi", "INTEGRATION_NOT_CONFIGURED", "SerpApi rejected the API key", "definitive", false, res.status);
    if (res.status !== 200) throw new IntegrationError("serpapi", "UPSTREAM_ERROR", `SerpApi product details HTTP ${res.status}`, "definitive", false, res.status);
    return parseDetailsResponse(res.body);
  }
}
