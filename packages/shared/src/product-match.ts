/**
 * How confident are we that a resolved Amazon listing is actually the product
 * the reply meant?
 *
 * A search link is forgiving: land a reader on roughly the right results page
 * and they finish the job themselves. A direct product link is not — it is a
 * confident assertion, and asserting the WRONG product (a phone case instead
 * of the phone, a sticker instead of the game) is worse than never linking.
 * So every resolved ASIN is scored here before it can be posted unreviewed.
 *
 * Deterministic on purpose: no model call, no cost, same answer every run, and
 * testable against the failure modes that actually happen.
 */

/** Words that carry no identifying signal, so their absence proves nothing. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "on", "in", "to", "by",
  "amazon", "new", "official", "ver", "version", "edition", "figure", "game",
]);

/**
 * Companion junk. When the TITLE advertises one of these and the QUERY never
 * asked for it, the match is an accessory riding the product's keywords —
 * the single most common way a search's top hit is confidently wrong.
 */
const ACCESSORY_MARKERS = [
  "case", "cover", "skin", "sticker", "decal", "poster", "keychain", "keyring",
  "lanyard", "screen protector", "grip", "carrying", "pouch", "sleeve",
  "replacement part", "mount", "stand for", "charger for", "cable for",
  "strap", "wallpaper", "magnet", "pin badge", "patch", "guide book",
  "walkthrough", "art print",
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * 0–100 confidence that `title` is the product `query` was looking for.
 *
 * 0 means "cannot verify" (no title) as well as "definitely wrong" — both are
 * disqualifying for an unreviewed post, which is the only decision this feeds.
 */
export function productMatchConfidence(query: string, title: string | null): number {
  if (!title) return 0; // nothing to check against — never assert a match
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t));
  if (queryTokens.length === 0) return 0;

  const titleTokens = new Set(tokenize(title));
  const titleLower = title.toLowerCase();
  const queryLower = query.toLowerCase();

  // Coverage: how much of what we asked for actually shows up in the listing.
  const covered = queryTokens.filter(
    (t) => titleTokens.has(t) || titleLower.includes(t),
  ).length;
  let score = Math.round((covered / queryTokens.length) * 100);

  // Accessory veto: the listing sells a companion item we never asked about.
  // Capped rather than zeroed — an operator reviewing it may still disagree.
  const accessoryInTitle = ACCESSORY_MARKERS.find((m) => titleLower.includes(m));
  if (accessoryInTitle && !queryLower.includes(accessoryInTitle)) {
    score = Math.min(score, 35);
  }

  return Math.max(0, Math.min(100, score));
}
