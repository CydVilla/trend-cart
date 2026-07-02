/**
 * Cheap, zero-cost filters that run on every firehose event.
 * They exist to keep obvious junk away from the LLM — the LLM is the real
 * judgment layer, so these lists stay LEAN. Over-broad stems here have
 * already been proven to veto the bot's own trigger vocabulary ("keyboard
 * died", "sick setup", budget questions), so: when in doubt, let the LLM see it.
 */

/**
 * Hard-kill topics where even storing the post is pointless: unmistakable
 * tragedy/crisis, politics, adult content. Nuanced safety (illness mentions,
 * grief-adjacent language, sarcasm) is the LLM's job, not a regex's.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(passed away|funeral|memorial|grie(f|ving)|condolence|rest in peace)\b/i,
  /\b(suicid\w*|self.?harm)\b/i,
  /\b(cancer|chemo\w*|hospice|terminal illness)\b/i,
  /\b(politic\w*|election|senat\w*|congress|president|democrat|republican)\b/i,
  /\b(bombing|shooting|massacre|genocide|war crime)\b/i,
  /\b(nsfw|onlyfans|porn\w*)\b/i,
  /\bpray for\b/i,
];

/** Returns the matched sensitive pattern source, or null if the text is clean. */
export function findSensitiveMatch(text: string): string | null {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

/**
 * Promotional-post filter: unmistakable ad markers only. Posts that merely
 * mention prices or budgets ("looking for a grinder under $50") are the
 * HIGHEST-intent posts on the network and must pass through.
 */
const PROMO_PATTERNS: RegExp[] = [
  /\b\d+%\s*off\b/i,
  /\bhalf off\b/i,
  /\b(promo|discount|coupon)\s*code\b/i,
  /\bfree shipping\b/i,
  /\b(flash|clearance)\s*sale\b/i,
  /\blink in bio\b/i,
  /\baffiliate\b/i,
  /\b(buy|shop|order) now\b/i,
  /\bgiveaway\b/i,
  /\bwas \$\d+/i,
  /\$\d+(\.\d{2})?\s*[•|]/, // price-bullet formatting typical of deal bots
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

export type KeywordMatch = { slug: string; keyword: string };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive match; multi-word keywords match as phrases. */
function keywordToRegex(keyword: string): RegExp {
  return new RegExp(`\\b${escapeRegex(keyword.trim())}\\b`, "i");
}

type CompiledCategory = {
  slug: string;
  keywords: Array<{ phrase: string; regex: RegExp }>;
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
      keywords: c.keywords.map((k) => ({ phrase: k.trim(), regex: keywordToRegex(k) })),
      negativeKeywords: c.negativeKeywords.map(keywordToRegex),
    }));
  }

  get categoryCount(): number {
    return this.compiled.length;
  }

  /**
   * Returns one entry per matching category, including WHICH keyword fired —
   * the tuning signal that lets keyword lists improve from evidence.
   */
  match(text: string): KeywordMatch[] {
    const matches: KeywordMatch[] = [];
    for (const category of this.compiled) {
      const hit = category.keywords.find((k) => k.regex.test(text));
      if (!hit) continue;
      if (category.negativeKeywords.some((k) => k.test(text))) continue;
      matches.push({ slug: category.slug, keyword: hit.phrase });
    }
    return matches;
  }
}
