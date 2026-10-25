// Normalize a SerpApi Google Shopping item into an Offer with cited evidence.
import { createHash } from "node:crypto";
import type { Offer, ProductDetails, RawShoppingItem, SpecEvidence } from "./types.js";
import { parsePriceText, floatToCents } from "./money.js";
import {
  extractBrand,
  extractCondition,
  extractInstallmentHint,
  extractModel,
  extractPackageQuantity,
  extractPanelType,
  extractPorts,
  extractProductType,
  extractRefreshRate,
  extractResolution,
  extractScreenSize,
} from "./extract.js";

export interface NormalizeContext {
  runId: string;
  queryId: string;
  observedAt: Date;
  offerMaxAgeMinutes: number;
  fromCache: boolean;
}

const INSTRUCTION_LIKE = /\b(?:ignore (?:all |any )?(?:previous|prior|above) instructions|system prompt|api[\s_-]?key|approve this (?:purchase|request)|you are (?:now )?an? (?:ai|assistant))\b/i;

export type NormalizeResult = { ok: true; offer: Offer; detailToken: string | null } | { ok: false; reason: string };

const SECOND_HAND_SELLER = /\b(?:renew(?:ed)?|refurb(?:ished)?|pre-?owned|used|open[\s-]?box|second[\s-]?hand)\b/i;

function offerId(runId: string, item: RawShoppingItem): string {
  const h = createHash("sha256")
    .update([runId, item.product_id ?? "", item.source ?? "", item.title, item.price ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `off_${h}`;
}

export function normalizeOffer(item: RawShoppingItem, ctx: NormalizeContext): NormalizeResult {
  if (!item.title || typeof item.title !== "string") return { ok: false, reason: "missing title" };
  const id = offerId(ctx.runId, item);
  const evidence: SpecEvidence[] = [];
  const needsReviewReasons: string[] = [];
  let evSeq = 0;
  const addEvidence = (e: Omit<SpecEvidence, "id">) => {
    const ev = { ...e, id: `${id}_ev${++evSeq}` };
    evidence.push(ev);
    return ev;
  };

  // Text sources, each cited by field name. Title is the primary listing statement.
  const textFields: Array<[string, string]> = [["title", item.title]];
  if (item.snippet) textFields.push(["snippet", item.snippet]);
  if (item.extensions?.length) textFields.push(["extensions", item.extensions.join(" · ")]);
  // Listing text is never executed, but instruction-like text is a signal a human should look.
  if (textFields.some(([, t]) => INSTRUCTION_LIKE.test(t))) needsReviewReasons.push("Listing text contains instruction-like content; treat this listing with caution");

  const firstFrom = <T>(fn: (t: string) => { value: T; excerpt: string } | null) => {
    for (const [field, text] of textFields) {
      const m = fn(text);
      if (m) return { ...m, field };
    }
    return null;
  };

  const productType = firstFrom(extractProductType);
  if (productType) {
    addEvidence({ attribute: "product_type", value: productType.value, source: "serpapi_google_shopping", sourceField: productType.field, excerpt: productType.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  }
  const size = firstFrom(extractScreenSize);
  if (size) addEvidence({ attribute: "screen_size", value: size.value, source: "serpapi_google_shopping", sourceField: size.field, excerpt: size.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  const res = firstFrom(extractResolution);
  if (res) addEvidence({ attribute: "resolution", value: res.value, source: "serpapi_google_shopping", sourceField: res.field, excerpt: res.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  const seenPorts = new Set<string>();
  for (const [field, text] of textFields) {
    for (const p of extractPorts(text)) {
      if (seenPorts.has(p.value)) continue;
      seenPorts.add(p.value);
      addEvidence({ attribute: "port", value: p.value, source: "serpapi_google_shopping", sourceField: field, excerpt: p.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
    }
  }
  const hz = firstFrom(extractRefreshRate);
  if (hz) addEvidence({ attribute: "refresh_rate", value: hz.value, source: "serpapi_google_shopping", sourceField: hz.field, excerpt: hz.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  const panel = firstFrom(extractPanelType);
  if (panel) addEvidence({ attribute: "panel_type", value: panel.value, source: "serpapi_google_shopping", sourceField: panel.field, excerpt: panel.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  const brand = extractBrand(item.title);
  if (brand) addEvidence({ attribute: "brand", value: brand, source: "serpapi_google_shopping", sourceField: "title", excerpt: brand, method: "listing_text_pattern", confidence: "listing_evidence" });

  // Condition: provider field first, then listing text; absence of any second-hand marker is a weak inference of new.
  let condition: Offer["condition"] = null;
  if (item.second_hand_condition) {
    const c = /refurb|renewed/i.test(item.second_hand_condition) ? "refurbished" : "used";
    condition = c;
    addEvidence({ attribute: "condition", value: c, source: "serpapi_google_shopping", sourceField: "second_hand_condition", excerpt: item.second_hand_condition.slice(0, 120), method: "provider_field", confidence: "listing_evidence" });
  } else {
    const c = firstFrom(extractCondition);
    if (c) {
      condition = c.value;
      addEvidence({ attribute: "condition", value: c.value, source: "serpapi_google_shopping", sourceField: c.field, excerpt: c.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
    } else if (item.source && SECOND_HAND_SELLER.test(item.source)) {
      // A seller storefront named for renewed/used stock is evidence about the listing's condition.
      condition = "refurbished";
      addEvidence({ attribute: "condition", value: "refurbished", source: "serpapi_google_shopping", sourceField: "source", excerpt: `Seller: ${item.source.slice(0, 100)}`, method: "listing_text_pattern", confidence: "listing_evidence" });
    } else {
      condition = "new";
      addEvidence({ attribute: "condition", value: "new", source: "serpapi_google_shopping", sourceField: "second_hand_condition", excerpt: "No second-hand condition reported by Google Shopping for this listing", method: "inferred_default", confidence: "weak_inference" });
    }
  }

  // Price.
  const priced = parsePriceText(item.price);
  let currency: Offer["currency"] = null;
  let listedPriceCents: number | null = null;
  let priceBasis: Offer["priceBasis"] = "unknown";
  if (priced.currencyToken && priced.currency !== "USD") {
    return { ok: false, reason: `unsupported currency ${priced.currencyToken}` };
  }
  if (priced.cents !== null) {
    currency = "USD";
    listedPriceCents = priced.cents;
    priceBasis = "one_time";
  } else {
    const fallback = floatToCents(item.extracted_price);
    if (fallback !== null) {
      currency = "USD";
      listedPriceCents = fallback;
      priceBasis = "one_time";
    }
  }
  const priceText = item.price ?? null;
  if (priceText && /^\s*from\b/i.test(priceText)) {
    priceBasis = "from_price";
    needsReviewReasons.push("Price is a 'from' price; the exact variant price is unknown");
  }
  if (priceText && extractInstallmentHint(priceText)) {
    priceBasis = "installment";
    needsReviewReasons.push("Listed price looks like a monthly installment, not the full purchase price");
  }
  if (listedPriceCents === null) needsReviewReasons.push("No parseable listed price");

  // Package quantity.
  let packageQuantity: number | null = 1;
  let packageQuantityMethod: Offer["packageQuantityMethod"] = "inferred_default";
  const pack = extractPackageQuantity(item.title);
  if (pack && "value" in pack) {
    packageQuantity = pack.value;
    packageQuantityMethod = "listing_text_pattern";
  } else if (pack && "ambiguous" in pack) {
    packageQuantity = null;
    packageQuantityMethod = null;
    needsReviewReasons.push(`Units per listing are unclear (${pack.ambiguous})`);
  }

  // Shipping: only an explicit statement counts as known.
  const deliveryText = [item.delivery, ...(item.extensions ?? [])].filter(Boolean).join(" · ");
  let shipping: Offer["shipping"] = { status: "unknown", cents: null, source: null };
  if (/\bfree (?:shipping|delivery)\b/i.test(deliveryText)) shipping = { status: "known", cents: 0, source: "delivery: free shipping stated" };
  else {
    const m = /(?:\+\s*)?\$([\d,]+(?:\.\d{1,2})?)\s*(?:shipping|delivery)\b/i.exec(deliveryText);
    if (m) {
      const c = parsePriceText(`$${m[1]}`).cents;
      if (c !== null) shipping = { status: "known", cents: c, source: `delivery: ${m[0]}` };
    }
  }

  const observedAt = ctx.observedAt.toISOString();
  const expiresAt = new Date(ctx.observedAt.getTime() + ctx.offerMaxAgeMinutes * 60_000).toISOString();
  const offer: Offer = {
    id,
    runId: ctx.runId,
    provider: "serpapi_google_shopping",
    queryId: ctx.queryId,
    title: item.title.slice(0, 300),
    normalizedModel: extractModel(item.title),
    brand,
    seller: item.source ?? null,
    sourceUrl: item.product_link ?? item.link ?? null,
    imageUrl: item.thumbnail ?? null,
    observedAt,
    expiresAt,
    fromCache: ctx.fromCache,
    currency,
    priceText,
    listedPriceCents,
    priceBasis,
    packageQuantity,
    packageQuantityMethod,
    shipping,
    tax: { status: "unknown", cents: null, source: null },
    condition,
    availability: /\bin stock\b/i.test(deliveryText) ? { status: "in_stock", excerpt: "in stock" } : { status: "unknown", excerpt: null },
    delivery: item.delivery ? { status: "stated", excerpt: item.delivery.slice(0, 120) } : { status: "unknown", excerpt: null },
    rating: typeof item.rating === "number" && Number.isFinite(item.rating) ? item.rating : null,
    reviews: typeof item.reviews === "number" && Number.isInteger(item.reviews) ? item.reviews : null,
    evidence,
    needsReviewReasons,
    details: { status: item.immersive_product_page_token ? "not_fetched" : "not_available", fetchedAt: null, fromCache: false, matchedStore: null },
  };
  return { ok: true, offer, detailToken: item.immersive_product_page_token ?? null };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Add product-page specification evidence (and the matching seller's shipping/stock statement)
 * to an offer. Pure; returns a new offer. Product specs describe the product, not a particular
 * seller's listing, which the evidence excerpt states.
 */
export function applyProductDetails(offer: Offer, details: ProductDetails, fetchedAt: Date, fromCache: boolean): Offer {
  const evidence = offer.evidence.filter((e) => e.source !== "serpapi_immersive_product");
  let seq = offer.evidence.length;
  const add = (attribute: string, value: unknown, title: string, raw: string) => {
    evidence.push({ id: `${offer.id}_ev${++seq}`, attribute, value, source: "serpapi_immersive_product", sourceField: `about_the_product.features[${title}]`, excerpt: `Product specs: ${title} = ${raw}`.slice(0, 300), method: "provider_field", confidence: "listing_evidence" });
  };
  const seenPorts = new Set<string>();
  for (const f of details.features) {
    const t = f.title.toLowerCase();
    const v = f.value;
    if (/^(screen|display|panel) size|^screen size \(diagonal\)|^diagonal/.test(t)) {
      const m = /(\d{2}(?:\.\d)?)/.exec(v);
      if (m && Number(m[1]) >= 10 && Number(m[1]) <= 100) add("screen_size", Number(m[1]), f.title, v);
    } else if (/^(native |max(imum)? )?resolution$/.test(t)) {
      const r = extractResolution(v);
      if (r) add("resolution", r.value, f.title, v);
    } else if (/connector|^ports?$|interface|video input|inputs?$|connectivity/.test(t)) {
      for (const p of extractPorts(v)) {
        if (seenPorts.has(p.value)) continue;
        seenPorts.add(p.value);
        add("port", p.value, f.title, v);
      }
    } else if (/number of hdmi ports/.test(t) && Number(v) > 0 && !seenPorts.has("hdmi")) {
      seenPorts.add("hdmi");
      add("port", "hdmi", f.title, v);
    } else if (/refresh rate/.test(t)) {
      const r = extractRefreshRate(v);
      if (r) add("refresh_rate", r.value, f.title, v);
    } else if (/panel type/.test(t)) {
      const p = extractPanelType(v);
      if (p) add("panel_type", p.value, f.title, v);
    }
  }
  const store = offer.seller ? details.stores.find((s) => norm(s.name) === norm(offer.seller!)) ?? details.stores.find((s) => norm(offer.seller!).startsWith(norm(s.name)) || norm(s.name).startsWith(norm(offer.seller!))) : undefined;
  let shipping = offer.shipping;
  let availability = offer.availability;
  if (store) {
    if (store.shippingExtracted !== null) {
      const c = floatToCents(store.shippingExtracted);
      if (c !== null) shipping = { status: "known", cents: c, source: `product page store ${store.name}: shipping ${store.shipping ?? ""}`.trim() };
    } else if (store.shipping && /^free/i.test(store.shipping)) shipping = { status: "known", cents: 0, source: `product page store ${store.name}: free shipping` };
    const stock = store.details.find((d) => /in stock/i.test(d));
    if (stock) availability = { status: "in_stock", excerpt: `${store.name}: ${stock}` };
  }
  return { ...offer, evidence, shipping, availability, details: { status: "fetched", fetchedAt: fetchedAt.toISOString(), fromCache, matchedStore: store?.name ?? null } };
}

/**
 * Remove repeated offers. Two offers are duplicates only if seller, normalized title and listed
 * price all match; different sellers or materially different variants are kept.
 */
export function dedupeOffers(offers: Offer[]): Offer[] {
  const seen = new Map<string, Offer>();
  for (const o of offers) {
    const key = [
      (o.seller ?? "").toLowerCase().trim(),
      o.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      o.listedPriceCents ?? "na",
      o.condition ?? "na",
    ].join("|");
    if (!seen.has(key)) seen.set(key, o);
  }
  return [...seen.values()];
}
