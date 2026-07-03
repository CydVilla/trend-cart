/**
 * Final gate before a reply can be stored or posted. The LLM prompt already
 * asks for all of this — the validator assumes the prompt failed and checks
 * everything mechanically. A reply that fails here is retried once, then
 * recorded as FAILED, never posted.
 *
 * Replies carry their link as a rich-text FACET: the display text contains a
 * human-readable anchor ("Deltarune on Amazon"), never a raw URL. The URL
 * itself is validated at composition time in reply.ts.
 */

const LINK_REGEX = /https?:\/\/\S+/g;

/** Lowercase phrases that must never appear in a reply. */
export const BANNED_PHRASES = [
  "buy now",
  "act now",
  "limited time",
  "don't miss",
  "click here",
  "game changer",
  "you need this",
  "guaranteed",
  "miracle",
  "cure",
  "promo code",
  "discount code",
  "medical advice",
  "financial advice",
];

export type ReplyValidation = { ok: true } | { ok: false; reason: string };

export function validateReply(
  displayText: string,
  linkAnchor: string,
  maxLength: number,
): ReplyValidation {
  const trimmed = displayText.trim();
  if (!trimmed) return { ok: false, reason: "empty reply" };
  if (trimmed.length > maxLength) {
    return { ok: false, reason: `too long (${trimmed.length} > ${maxLength})` };
  }

  // Raw URLs never appear in display text — the link is a facet on the anchor.
  const rawLinks = trimmed.match(LINK_REGEX) ?? [];
  if (rawLinks.length > 0) {
    return { ok: false, reason: `raw URL in display text (${rawLinks.length})` };
  }
  const anchorCount = trimmed.split(linkAnchor).length - 1;
  if (anchorCount !== 1) {
    return { ok: false, reason: `link anchor must appear exactly once (found ${anchorCount})` };
  }

  if (trimmed.includes("#")) return { ok: false, reason: "contains a hashtag" };
  if (/(^|\s)@\S/.test(trimmed)) return { ok: false, reason: "contains an @-mention" };

  const lower = trimmed.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `contains banned phrase: "${phrase}"` };
    }
  }

  return { ok: true };
}
