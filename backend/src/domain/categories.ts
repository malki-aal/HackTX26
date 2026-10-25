// Category registry. Every category-specific assumption (what the item is called, how listings
// for it are recognized, what is an accessory or part rather than the item, which specs apply
// and how to search for it) lives here. Adding a category or sector means adding a profile.

export type SpecKind = "screen_size" | "resolution" | "port" | "refresh_rate" | "panel_type" | "brand" | "volume" | "dimensions" | "thickness" | "screw_size";

export interface FeatureDef {
  label: string;
  /** Matches the feature in request text and listing text. */
  pattern: RegExp;
  /** Listing text that states the feature is absent (e.g. "armless"); contradicts the feature. */
  absent?: RegExp;
}

export interface CategoryProfile {
  id: string;
  label: string;
  plural: string;
  sector: "office_equipment" | "furniture_manufacturing";
  /** Default unit for request quantities and listing pack counts. */
  unit: string;
  /** Words that identify a listing (and a request) as this item. */
  identify: RegExp;
  /** Accessories, parts or adjacent products that are not this item. */
  exclude: RegExp;
  /** Phrases describing a feature of the item that must not trigger `exclude`. */
  featurePhrases: RegExp[];
  /** Base Google Shopping query term. */
  searchTerm: string;
  /** Spec kinds parsed from the request text and checked against listings. */
  specs: SpecKind[];
  features: Record<string, FeatureDef>;
  /** Treat bare "oz" as fluid ounces (liquids only). */
  liquid?: boolean;
}

const MONITOR_FEATURE_PHRASES = [
  /\b(?:with|w\/|includes?|including|adjustable|height[\s-]?adjustable|built[\s-]?in)\s+(?:[\w-]+\s+){0,3}(?:stand|cable|cables|hub|speakers?|mount)\b/gi,
  /\b(?:vesa|wall)[\s-]?(?:mount(?:able|ing)?|compatible)(?:[\s-]?(?:ready|compatible))?\b/gi,
  /\bmount(?:ing)?[\s-]?(?:ready|compatible)\b/gi,
];

export const CATEGORIES: CategoryProfile[] = [
  {
    id: "monitors",
    label: "monitor",
    plural: "monitors",
    sector: "office_equipment",
    unit: "monitor",
    identify: /\b(?:monitors?|displays?)\b/i,
    exclude:
      /\b(?:mount|arm|stand only|desk stand|riser|bracket|cable|cord|adapter|dongle|hub|docking station|screen protector|privacy (?:filter|screen)|anti[\s-]?glare film|cover|dust cover|case|bag|hood|replacement|parts?|(?:button|power|main|control|logic|t-?con|driver|controller)\s?board|mainboard|power supply|remote|light bar|cleaning kit|wall plate)\b/i,
    featurePhrases: MONITOR_FEATURE_PHRASES,
    searchTerm: "monitor",
    specs: ["screen_size", "resolution", "port", "refresh_rate", "panel_type", "brand"],
    features: {},
  },
  {
    id: "office_chairs",
    label: "office chair",
    plural: "office chairs",
    sector: "office_equipment",
    unit: "chair",
    identify: /\b(?:chairs?|seating|task seat)\b/i,
    exclude:
      /\b(?:chair mat|floor mat|cushion|seat cushion|pillow|slipcover|cover|casters?|wheels? only|replacement|parts?|cylinder|gas lift|arm ?pads?|armrest pads?|headrest only|footrest|chair glides?)\b/i,
    featurePhrases: [/\b(?:with|w\/|includes?|including|adjustable|padded|built[\s-]?in)\s+(?:[\w-]+\s+){0,3}(?:cushion|headrest|footrest|wheels|casters|armrests?|arms)\b/gi],
    searchTerm: "office chair",
    specs: ["brand"],
    features: {
      armrests: { label: "Armrests", pattern: /\b(?:arm\s?rests?|with arms|padded arms|flip[\s-]?up arms)\b/i, absent: /\b(?:armless|without arms|no arms|no armrests)\b/i },
      lumbar_support: { label: "Lumbar support", pattern: /\blumbar\b/i },
      adjustable_height: { label: "Adjustable height", pattern: /\b(?:adjustable height|height[\s-]?adjustable|pneumatic|gas lift)\b/i },
      mesh_back: { label: "Mesh back", pattern: /\bmesh\b/i },
      ergonomic: { label: "Ergonomic", pattern: /\bergonomic\b/i },
    },
  },
  {
    id: "wood_glue",
    label: "wood glue",
    plural: "wood glue",
    sector: "furniture_manufacturing",
    unit: "bottle",
    identify: /\b(?:wood\s+glue|carpenter'?s?\s+glue|woodworking\s+glue|pva\s+glue|glue)\b/i,
    exclude: /\b(?:glue gun|glue sticks?|hot glue|glue remover|applicator(?: set| kit)? only|brush(?:es)? only|spreader|clamp|super ?glue|epoxy|ca glue|cyanoacrylate|fabric glue|craft glue|school glue)\b/i,
    featurePhrases: [],
    searchTerm: "wood glue",
    specs: ["volume", "brand"],
    liquid: true,
    features: {
      water_resistant: { label: "Water resistant", pattern: /\b(?:water[\s-]?(?:resistant|proof)|ii\b|iii\b|type ii)\b/i },
      dries_clear: { label: "Dries clear", pattern: /\bdries\s+clear\b/i },
    },
  },
  {
    id: "cork_sheets",
    label: "cork sheet",
    plural: "cork sheets",
    sector: "furniture_manufacturing",
    unit: "sheet",
    identify: /\b(?:cork\s+(?:sheets?|rolls?|backing|board|tiles?|liners?|underlayment)|cork)\b/i,
    exclude: /\b(?:cork\s?screws?|corkscrew|wine|stoppers?|bottle corks?|cork balls?|bulletin board with frame|coasters?|cork board frame|yoga|flooring planks?|push ?pins?|thumb ?tacks?)\b/i,
    featurePhrases: [],
    searchTerm: "cork sheet",
    specs: ["dimensions", "thickness", "brand"],
    features: {
      self_adhesive: { label: "Self-adhesive backing", pattern: /\b(?:self[\s-]?adhesive|adhesive[\s-]?back(?:ed|ing)?|peel\s*(?:and|&|n)\s*stick|sticky back)\b/i, absent: /\b(?:non[\s-]?adhesive|no adhesive|without adhesive)\b/i },
    },
  },
  {
    id: "wood_screws",
    label: "wood screw",
    plural: "wood screws",
    sector: "furniture_manufacturing",
    unit: "screw",
    identify: /\b(?:wood\s+screws?|screws?)\b/i,
    exclude: /\b(?:screwdrivers?|drivers? bit|bits? set|drill bits?|anchors? only|screw extractors?|corkscrews?|machine screws?|sheet metal screws?|drywall screws?|deck(?:ing)? screws?|concrete screws?|masonry)\b/i,
    featurePhrases: [],
    searchTerm: "wood screws",
    specs: ["screw_size", "brand"],
    features: {
      flat_head: { label: "Flat (countersunk) head", pattern: /\b(?:flat[\s-]?head|countersunk|csk)\b/i, absent: /\b(?:pan[\s-]?head|round[\s-]?head|hex[\s-]?head|truss[\s-]?head)\b/i },
      stainless_steel: { label: "Stainless steel", pattern: /\bstainless\b/i },
      zinc_plated: { label: "Zinc plated", pattern: /\bzinc\b/i },
      phillips: { label: "Phillips drive", pattern: /\bphillips\b/i },
    },
  },
];

const ALIASES: Record<string, string> = {
  monitor: "monitors",
  displays: "monitors",
  chairs: "office_chairs",
  chair: "office_chairs",
  office_chair: "office_chairs",
  glue: "wood_glue",
  cork: "cork_sheets",
  cork_backing: "cork_sheets",
  screws: "wood_screws",
};

/** "a monitor", "an office chair". */
export function withArticle(label: string): string {
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

export function getCategory(id: string | null | undefined): CategoryProfile | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  return CATEGORIES.find((c) => c.id === key) ?? CATEGORIES.find((c) => c.id === ALIASES[key]) ?? null;
}

export function categoryIds(): string[] {
  return CATEGORIES.map((c) => c.id);
}

export interface CategoryDetection {
  /** Categories whose terms appear in the request, strongest first. */
  matches: Array<{ id: string; score: number }>;
  /** The single best category, or null when none or several tie. */
  best: string | null;
}

/** Detect the item category from request text. The title counts double. Never defaults. */
export function detectCategory(title: string, description: string): CategoryDetection {
  const scores = CATEGORIES.map((c) => {
    const inTitle = c.identify.test(title) ? 2 : 0;
    const inDesc = c.identify.test(description) ? 1 : 0;
    return { id: c.id, score: inTitle + inDesc };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  // "glue" and "screws" are generic words; a more specific profile wins when both match.
  const best = scores.length === 1 || (scores.length > 1 && scores[0]!.score > scores[1]!.score) ? scores[0]!.id : null;
  return { matches: scores, best };
}

export interface CategoryCheck {
  state: "supported" | "contradicted" | "unknown";
  /** For contradictions: the category the listing appears to be, or "accessory_or_part". */
  detected: string | null;
  excerpt: string | null;
  reason: string;
}

function excerptOf(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/**
 * Category consistency of one listing against the requested category. A listing is supported only
 * when it names the requested item and is not an accessory or part; it is contradicted when it is
 * an accessory/part or names a different registered category instead.
 */
export function checkListingCategory(text: string, profile: CategoryProfile): CategoryCheck {
  let stripped = text;
  for (const re of profile.featurePhrases) stripped = stripped.replace(re, (m) => " ".repeat(m.length));
  const own = profile.identify.exec(text);
  const excl = profile.exclude.exec(stripped);
  if (excl) {
    return { state: "contradicted", detected: "accessory_or_part", excerpt: excerptOf(text, excl.index, excl[0].length), reason: `Listing is a related product, accessory or part ("${excl[0]}"), not ${withArticle(profile.label)}` };
  }
  if (own) {
    // A listing that clearly names another item ("Monitor ... for chair") with no own-category noun near
    // the start is still checked: the own-category word must appear before any other category's word.
    const others = CATEGORIES.filter((c) => c.id !== profile.id).map((c) => ({ c, m: c.identify.exec(text) })).filter((x) => x.m);
    const earlierOther = others.find((x) => x.m!.index < own.index && !profile.identify.test(x.m![0]));
    if (earlierOther) {
      return { state: "contradicted", detected: earlierOther.c.id, excerpt: excerptOf(text, earlierOther.m!.index, earlierOther.m![0].length), reason: `Listing is ${withArticle(earlierOther.c.label)}, not ${withArticle(profile.label)}` };
    }
    return { state: "supported", detected: profile.id, excerpt: excerptOf(text, own.index, own[0].length), reason: `Listing describes ${withArticle(profile.label)}` };
  }
  for (const c of CATEGORIES) {
    if (c.id === profile.id) continue;
    const m = c.identify.exec(text);
    if (m) return { state: "contradicted", detected: c.id, excerpt: excerptOf(text, m.index, m[0].length), reason: `Listing is ${withArticle(c.label)}, not ${withArticle(profile.label)}` };
  }
  return { state: "unknown", detected: null, excerpt: null, reason: `Listing does not say whether it is ${withArticle(profile.label)}` };
}
