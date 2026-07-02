/**
 * Cheap, zero-cost filters that run on every firehose event.
 * Their job is to keep the LLM (Phase 4) and the database from ever seeing
 * the vast majority of posts. False negatives are fine — we're sampling a
 * firehose, not building an index.
 */

/**
 * Sensitive-topic pre-filter. This is NOT the real safety system (the LLM
 * evaluates safety in Phase 4) — it's a conservative first gate so we never
 * even store posts about tragedy, politics, illness, crisis, etc.
 * False positives just mean a skipped post, which costs nothing.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(died?|death|dying|passed away|funeral|memorial|grief|griev)/i,
  /\b(suicid|self.?harm|depress|anxiety|panic attack|trauma|crisis)/i,
  /\b(cancer|diagnos|chemo|hospital|surgery|illness|disease|chronic pain|sick)/i,
  /\b(politic|election|vote|voting|senat|congress|president|democrat|republican)/i,
  /\b(war|bombing|shooting|violence|assault|abuse|attack)/i,
  /\b(church|jesus|allah|quran|bible|religio|pray for|prayers)/i,
  /\b(nsfw|onlyfans|porn|sexual)/i,
  /\b(divorce|breakup|broke up|laid off|fired|lost my job|evict|homeless)/i,
];

/** Returns the matched sensitive pattern source, or null if the text is clean. */
export function findSensitiveMatch(text: string): string | null {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

/**
 * Promotional-post filter: posts that are themselves ads (deal bots, affiliate
 * spam) contain product keywords but zero genuine product need. Engaging with
 * them would make us look like — and amplify — exactly what we're avoiding.
 */
const PROMO_PATTERNS: RegExp[] = [
  /\b\d+%\s*off\b/i,
  /\bhalf off\b/i,
  /\b(promo|discount|coupon)\s*code\b/i,
  /\bfree shipping\b/i,
  /\b(flash|clearance)\s*sale\b/i,
  /\blink in bio\b/i,
  /\baffiliate\b/i,
  /\$\d+(\.\d{2})?\s*(•|\||-)?\s*(was|now|only|deal)\b/i,
  /\b(just|only|for)\s*\$\d+/i,
  /\bspecial\b.*\$\d+/i,
  /\b(buy now|shop now|order now|限定)\b/i,
];

/** Returns the matched promo pattern source, or null if the post looks organic. */
export function findPromotionalMatch(text: string): string | null {
  for (const pattern of PROMO_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

export type MatcherCategory = {
  slug: string;
  keywords: string[];
  negativeKeywords: string[];
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive match; multi-word keywords match as phrases. */
function keywordToRegex(keyword: string): RegExp {
  return new RegExp(`\\b${escapeRegex(keyword.trim())}\\b`, "i");
}

type CompiledCategory = {
  slug: string;
  keywords: RegExp[];
  negativeKeywords: RegExp[];
};

/**
 * Matches post text against category keyword lists loaded from the database.
 * Categories are recompiled via update() when the DB copy is refreshed.
 */
export class CategoryMatcher {
  private compiled: CompiledCategory[] = [];

  constructor(categories: MatcherCategory[]) {
    this.update(categories);
  }

  update(categories: MatcherCategory[]): void {
    this.compiled = categories.map((c) => ({
      slug: c.slug,
      keywords: c.keywords.map(keywordToRegex),
      negativeKeywords: c.negativeKeywords.map(keywordToRegex),
    }));
  }

  get categoryCount(): number {
    return this.compiled.length;
  }

  /** Returns slugs of all categories whose keywords hit (and negatives don't). */
  match(text: string): string[] {
    const matches: string[] = [];
    for (const category of this.compiled) {
      if (!category.keywords.some((k) => k.test(text))) continue;
      if (category.negativeKeywords.some((k) => k.test(text))) continue;
      matches.push(category.slug);
    }
    return matches;
  }
}
