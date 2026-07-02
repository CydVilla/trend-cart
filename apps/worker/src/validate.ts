/**
 * Final gate before a reply can be stored or posted. The LLM prompt already
 * asks for all of this — the validator assumes the prompt failed and checks
 * everything mechanically. A reply that fails here is recorded as FAILED,
 * never posted.
 */

const LINK_REGEX = /https?:\/\/\S+/g;

/** Lowercase phrases that must never appear in a reply. */
export const BANNED_PHRASES = [
  "as an ai",
  "i'm an ai",
  "i am an ai",
  "language model",
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
  text: string,
  requiredUrl: string,
  maxLength: number,
): ReplyValidation {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty reply" };
  if (trimmed.length > maxLength) {
    return { ok: false, reason: `too long (${trimmed.length} > ${maxLength})` };
  }

  const links = trimmed.match(LINK_REGEX) ?? [];
  if (links.length !== 1) {
    return { ok: false, reason: `must contain exactly one link (found ${links.length})` };
  }
  if (!trimmed.includes(requiredUrl)) {
    return { ok: false, reason: "link is not the recommendation page URL" };
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
