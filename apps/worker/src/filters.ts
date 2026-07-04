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

// (The firehose-era CategoryMatcher was retired with discovery v2 — category
// keywords are now Bluesky search queries; see discover.ts.)
