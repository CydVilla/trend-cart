/**
 * Deal-alert post composition + validation. Lives in shared because BOTH the
 * worker (automated price trigger) and the web dashboard (manual "post deal
 * now") build the exact same post copy — this is the single source of truth.
 *
 * The post text carries the affiliate link on a fixed anchor phrase (never a
 * raw URL — the byte-offset facet is attached at post time in the worker) plus
 * an in-post "#ad" disclosure and Amazon's "as of <time>; price subject to
 * change" price-freshness qualifier.
 */
import { isAmazonHost } from "./amazon";

/** Fixed clickable phrase the affiliate link rides on (a facet, not a URL). */
export const DEAL_ANCHOR = "grab it on Amazon";

/** Non-hype openers; none may collide with DEAL_BANNED_PHRASES. */
const LEAD_INS = ["Price drop:", "Deal spotted:", "On sale:", "Price alert:"];

/** Phrases a deal post must never contain (mirrors the reply validator). */
export const DEAL_BANNED_PHRASES = [
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

const RAW_URL_RE = /https?:\/\/\S+/i;

export type DealCopyInput = {
  title: string;
  salePriceCents: number;
  wasPriceCents?: number | null;
  currency: string;
  priceAsOf: Date;
  /** The tag-enforced affiliate URL — validated, never shown raw. */
  linkUrl: string;
  maxLength?: number;
};

export type DealValidation = { ok: true } | { ok: false; reason: string };

/** Integer cents → localized currency string ("$399.99"). */
export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatAsOf(date: Date): string {
  return (
    date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      hour12: true,
    }) + " UTC"
  );
}

/** Stable per-title opener so the same listing always reads consistently. */
function pickLeadIn(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return LEAD_INS[Math.abs(hash) % LEAD_INS.length]!;
}

/** Grapheme-ish length: code points over-estimate graphemes, so capping on
 *  this is safe (never under Bluesky's 300-grapheme limit). */
const glen = (s: string): number => [...s].length;

/**
 * Mechanical gate before a deal post can be stored/published: exactly one link
 * anchor, an "#ad" disclosure, a real tagged Amazon URL, no raw URLs, no banned
 * phrases, within the length cap.
 */
export function validateDealText(
  text: string,
  linkUrl: string,
  maxLength: number,
): DealValidation {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty deal post" };
  if (glen(trimmed) > maxLength) {
    return { ok: false, reason: `too long (${glen(trimmed)} > ${maxLength})` };
  }
  if (RAW_URL_RE.test(trimmed)) return { ok: false, reason: "raw URL in display text" };
  const anchorCount = trimmed.split(DEAL_ANCHOR).length - 1;
  if (anchorCount !== 1) {
    return { ok: false, reason: `link anchor must appear exactly once (found ${anchorCount})` };
  }
  if (!/#ad\b/i.test(trimmed)) return { ok: false, reason: "missing #ad disclosure" };
  try {
    const url = new URL(linkUrl);
    if (!isAmazonHost(url.hostname)) return { ok: false, reason: "link is not an Amazon URL" };
    if (!url.searchParams.get("tag")) return { ok: false, reason: "link is missing the affiliate tag" };
  } catch {
    return { ok: false, reason: "invalid link URL" };
  }
  const lower = trimmed.toLowerCase();
  for (const phrase of DEAL_BANNED_PHRASES) {
    if (lower.includes(phrase)) return { ok: false, reason: `contains banned phrase: "${phrase}"` };
  }
  return { ok: true };
}

/**
 * Build the deal-alert text. Fits under the length cap by dropping the "% off"
 * clause, then the "(was …)" clause, then ellipsizing the title. Returns the
 * final validated text or a reason it can't be built.
 */
export function composeDealPost(input: DealCopyInput): { text: string } | { error: string } {
  const max = input.maxLength ?? 300;
  const currency = input.currency || "USD";
  const saleStr = formatMoney(input.salePriceCents, currency);
  const hasWas = input.wasPriceCents != null && input.wasPriceCents > input.salePriceCents;
  const wasStr = hasWas ? formatMoney(input.wasPriceCents as number, currency) : "";
  const pct = hasWas
    ? Math.round(((((input.wasPriceCents as number) - input.salePriceCents) /
        (input.wasPriceCents as number)) * 100))
    : 0;
  const leadIn = pickLeadIn(input.title);
  const asOf = formatAsOf(input.priceAsOf);

  const build = (title: string, withWas: boolean, withPct: boolean): string => {
    const wasClause = withWas && hasWas ? ` (was ${wasStr})` : "";
    const pctClause = withPct && pct >= 1 ? `, ${pct}% off` : "";
    return `${leadIn} ${title} — ${saleStr}${wasClause}${pctClause}. as of ${asOf}; price subject to change. ${DEAL_ANCHOR} #ad`;
  };

  let title = input.title.trim().replace(/\s+/g, " ");
  let text = build(title, true, true);
  if (glen(text) > max) text = build(title, true, false);
  if (glen(text) > max) text = build(title, false, false);
  while (glen(text) > max && title.length > 8) {
    title = title.slice(0, Math.max(1, title.length - 4)).trimEnd();
    text = build(`${title}…`, false, false);
  }

  const validation = validateDealText(text, input.linkUrl, max);
  if (!validation.ok) return { error: validation.reason };
  return { text };
}
