// Normalize a SerpApi Google Shopping item into an Offer with cited evidence.
import { createHash } from "node:crypto";
import type { Offer, ProductDetails, RawShoppingItem, SpecEvidence } from "./types.js";
import { parsePriceText, floatToCents } from "./money.js";
import {
  extractBrand,
  extractCondition,
  extractDeliveryDate,
  extractDimensions,
  extractInstallmentHint,
  extractModel,
  extractPackageQuantity,
  extractPanelType,
  extractPorts,
  extractRefreshRate,
  extractResolution,
  extractScreenSize,
  extractScrewSize,
  extractThickness,
  extractVolume,
  extractCapacityWh,
  extractAcOutlets,
} from "./extract.js";
import { checkListingCategory, type CategoryProfile } from "./categories.js";

export interface NormalizeContext {
  runId: string;
  queryId: string;
  observedAt: Date;
  offerMaxAgeMinutes: number;
  fromCache: boolean;
  /** The confirmed requested category; listings are checked against it. */
  category: CategoryProfile;
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

  // Category consistency: the title decides; the snippet is consulted only when the title is silent.
  const profile = ctx.category;
  let cat = checkListingCategory(item.title, profile);
  let catField = "title";
  if (cat.state === "unknown" && item.snippet) {
    cat = checkListingCategory(item.snippet, profile);
    catField = "snippet";
  }
  if (cat.state !== "unknown") {
    addEvidence({ attribute: "product_type", value: cat.detected, source: "serpapi_google_shopping", sourceField: catField, excerpt: cat.excerpt ?? item.title.slice(0, 120), method: "listing_text_pattern", confidence: "listing_evidence" });
  }
  const spec = <T>(attribute: string, fn: (t: string) => { value: T; excerpt: string } | null) => {
    const m = firstFrom(fn);
    if (m) addEvidence({ attribute, value: m.value, source: "serpapi_google_shopping", sourceField: m.field, excerpt: m.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  };
  for (const kind of profile.specs) {
    if (kind === "screen_size") spec("screen_size", extractScreenSize);
    else if (kind === "resolution") spec("resolution", extractResolution);
    else if (kind === "refresh_rate") spec("refresh_rate", extractRefreshRate);
    else if (kind === "panel_type") spec("panel_type", extractPanelType);
    else if (kind === "volume") spec("volume", (t) => extractVolume(t, { bareOzIsFluid: profile.bareOzIsFluid }));
    else if (kind === "capacity_wh") spec("capacity_wh", extractCapacityWh);
    else if (kind === "ac_outlets") spec("ac_outlets", extractAcOutlets);
    else if (kind === "dimensions") spec("dimensions", extractDimensions);
    else if (kind === "thickness") spec("thickness", extractThickness);
    else if (kind === "screw_size") spec("screw_size", extractScrewSize);
    else if (kind === "port") {
      const seenPorts = new Set<string>();
      for (const [field, text] of textFields) {
        for (const p of extractPorts(text)) {
          if (seenPorts.has(p.value)) continue;
          seenPorts.add(p.value);
          addEvidence({ attribute: "port", value: p.value, source: "serpapi_google_shopping", sourceField: field, excerpt: p.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
        }
      }
    }
  }
  for (const [fid, f] of Object.entries(profile.features)) {
    for (const [field, text] of textFields) {
      // An explicit absence ("armless") is stronger listing evidence than silence.
      const neg = f.absent?.exec(text);
      if (neg) {
        addEvidence({ attribute: "feature", value: `!${fid}`, source: "serpapi_google_shopping", sourceField: field, excerpt: text.slice(Math.max(0, neg.index - 30), neg.index + neg[0].length + 30).trim(), method: "listing_text_pattern", confidence: "listing_evidence" });
        break;
      }
      const m = f.pattern.exec(text);
      if (!m) continue;
      addEvidence({ attribute: "feature", value: fid, source: "serpapi_google_shopping", sourceField: field, excerpt: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim(), method: "listing_text_pattern", confidence: "listing_evidence" });
      break;
    }
  }
  const brand = extractBrand(item.title);
  if (brand) addEvidence({ attribute: "brand", value: brand, source: "serpapi_google_shopping", sourceField: "title", excerpt: brand, method: "listing_text_pattern", confidence: "listing_evidence" });

  // Delivery date, only when the listing states one; otherwise it stays unknown.
  const deliveryStmt = [item.delivery, ...(item.extensions ?? [])].filter(Boolean).join(" · ");
  const deliveryDate = deliveryStmt ? extractDeliveryDate(deliveryStmt, ctx.observedAt) : null;
  if (deliveryDate) {
    addEvidence({ attribute: "delivery_by", value: deliveryDate.value, source: "serpapi_google_shopping", sourceField: "delivery", excerpt: deliveryDate.excerpt, method: "listing_text_pattern", confidence: "listing_evidence" });
  }

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
    delivery: {
      status: item.delivery ? "stated" : "unknown",
      excerpt: item.delivery ? item.delivery.slice(0, 120) : null,
      earliest: deliveryDate?.value.earliest ?? null,
      latest: deliveryDate?.value.latest ?? null,
      source: deliveryDate ? "listing" : null,
    },
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
export function applyProductDetails(offer: Offer, details: ProductDetails, fetchedAt: Date, fromCache: boolean, profile: CategoryProfile): Offer {
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
    } else if (profile.specs.includes("capacity_wh") && /capacity|battery|energy/.test(t)) {
      const m = extractCapacityWh(v);
      if (m) add("capacity_wh", m.value, f.title, v);
    } else if (profile.specs.includes("ac_outlets") && /outlet|ac output|output port/.test(t)) {
      const m = extractAcOutlets(/\bac\b|outlet/i.test(v) ? v : `${v} AC outlets`);
      if (m) add("ac_outlets", m.value, f.title, v);
    } else if (profile.specs.includes("volume") && /volume|capacity|net content|size|jar|pitcher|container/.test(t)) {
      const m = extractVolume(v, { bareOzIsFluid: profile.bareOzIsFluid });
      if (m) add("volume", m.value, f.title, v);
    } else if (profile.specs.includes("dimensions") && /dimension|size|length|width/.test(t)) {
      const m = extractDimensions(v);
      if (m) add("dimensions", m.value, f.title, v);
    } else if (profile.specs.includes("thickness") && /thickness/.test(t)) {
      const m = extractThickness(`${v} thick`);
      if (m) add("thickness", m.value, f.title, v);
    } else if (profile.specs.includes("screw_size") && /size|length|gauge|diameter/.test(t)) {
      const m = extractScrewSize(v);
      if (m) add("screw_size", m.value, f.title, v);
    }
    for (const [fid, def] of Object.entries(profile.features)) {
      if (def.pattern.test(`${f.title} ${v}`) && !evidence.some((e) => e.attribute === "feature" && e.value === fid && e.source === "serpapi_immersive_product")) add("feature", fid, f.title, v);
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
  let delivery = offer.delivery;
  if (store) {
    for (const d of store.details) {
      const dd = extractDeliveryDate(d, fetchedAt);
      if (!dd) continue;
      delivery = { status: "stated", excerpt: `${store.name}: ${d}`.slice(0, 120), earliest: dd.value.earliest, latest: dd.value.latest, source: "product_page_store" };
      evidence.push({ id: `${offer.id}_ev${++seq}`, attribute: "delivery_by", value: dd.value, source: "serpapi_immersive_product", sourceField: `stores[${store.name}].details_and_offers`, excerpt: `${store.name}: ${d}`.slice(0, 300), method: "provider_field", confidence: "listing_evidence" });
      break;
    }
  }
  return { ...offer, evidence, shipping, availability, delivery, details: { status: "fetched", fetchedAt: fetchedAt.toISOString(), fromCache, matchedStore: store?.name ?? null } };
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
