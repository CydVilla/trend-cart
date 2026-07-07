/**
 * Deal-alert post composition + validation. Lives in shared because BOTH the
 * worker (automated price trigger + feed discovery) and the web dashboard
 * (manual "post deal now") build the exact same post copy — this is the
 * single source of truth.
 *
 * The post text carries the affiliate link on an anchor phrase (never a raw
 * URL — the byte-offset facet is attached at post time in the worker) plus an
 * in-post "#ad" disclosure and Amazon's "as of <time>; price subject to
 * change" price-freshness qualifier.
 *
 * Two styles:
 *  - "wario"   — terse deal-account format ("Title is $39.99 on Amazon
 *                (43% off, reg. $69.99) #ad"), the price phrase itself is the
 *                clickable link. Default.
 *  - "classic" — the original lead-in format on the fixed DEAL_ANCHOR phrase.
 */
import { isAmazonHost } from "./amazon";

/** Fixed clickable phrase classic-style posts ride the link on. */
export const DEAL_ANCHOR = "grab it on Amazon";

export type DealPostStyle = "wario" | "classic";

/** DEAL_POST_STYLE env → style, defaulting unknown values to "wario". */
export function parseDealPostStyle(raw: string | undefined): DealPostStyle {
  return raw === "classic" ? "classic" : "wario";
}

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
  /** Copy format; defaults to "wario". */
  style?: DealPostStyle;
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
 * phrases, within the length cap. `anchor` is the clickable phrase the facet
 * rides on — wario-style posts carry a per-post anchor ("$39.99 on Amazon"),
 * classic posts the fixed DEAL_ANCHOR.
 */
export function validateDealText(
  text: string,
  linkUrl: string,
  maxLength: number,
  anchor: string = DEAL_ANCHOR,
): DealValidation {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty deal post" };
  if (glen(trimmed) > maxLength) {
    return { ok: false, reason: `too long (${glen(trimmed)} > ${maxLength})` };
  }
  if (RAW_URL_RE.test(trimmed)) return { ok: false, reason: "raw URL in display text" };
  if (!anchor.trim()) return { ok: false, reason: "empty link anchor" };
  const anchorCount = trimmed.split(anchor).length - 1;
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

/** Separators Amazon uses to bolt keyword spam onto a product name. */
const TITLE_SEPARATORS = [" | ", " – ", " — ", " - ", ": ", ", "];
/** Never cut a title shorter than this — the product name itself. */
const TITLE_MIN_KEEP = 25;

/**
 * Turn a keyword-stuffed Amazon listing title ("Razer BlackShark V2 X Gaming
 * Headset: 7.1 Surround Sound - 50mm Drivers - …") into the short product name
 * a deal account would post. Cuts at the first strong separator past the
 * minimum keep length — but never inside parentheses, so platform markers like
 * "(Switch)" survive — then hard-caps at `max` on a word boundary.
 */
export function shortenAmazonTitle(raw: string, max = 90): string {
  const title = raw.trim().replace(/\s+/g, " ");
  let depth = 0;
  let cutAt = -1;
  for (let i = TITLE_MIN_KEEP; i < title.length && cutAt < 0; i += 1) {
    const ch = title[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    for (const sep of TITLE_SEPARATORS) {
      if (title.startsWith(sep, i)) {
        cutAt = i;
        break;
      }
    }
  }
  let short = cutAt >= 0 ? title.slice(0, cutAt).trimEnd() : title;
  if ([...short].length > max) {
    const clipped = short.slice(0, max);
    const lastSpace = clipped.lastIndexOf(" ");
    short = `${clipped.slice(0, lastSpace > TITLE_MIN_KEEP ? lastSpace : max).trimEnd()}…`;
  }
  return short;
}

/**
 * Strip deal-headline noise from an RSS item title ("Widget 2-Pack $29.99 +
 * Free Shipping" → "Widget 2-Pack") so it can prefill a post-title field.
 * Heuristic only — the operator edits the result before anything posts.
 */
export function cleanDealTitle(raw: string): string {
  let title = raw.replace(/\s+/g, " ").trim();
  // Headlines end with "$29.99 + Free Shipping"-style suffixes: cut at the
  // first price, unless it leads the title ("$5 Widget" stays intact).
  const priceIdx = title.search(/\$\s*[0-9]/);
  if (priceIdx > 10) title = title.slice(0, priceIdx);
  return title
    .replace(/\b(?:w\/\s*|with\s*)?free (?:shipping|delivery|s&h)\b.*$/i, "")
    .replace(/[\s\-–—:,+@&]+$/g, "")
    .trim();
}

export type ComposedDeal = { text: string; anchor: string };

/**
 * Build the deal-alert text in the requested style. Fits under the length cap
 * by dropping the reference-price clause, then the "% off" clause, then
 * ellipsizing the title. Returns the final validated text + the anchor phrase
 * the link facet must ride on, or a reason it can't be built.
 */
export function composeDealPost(input: DealCopyInput): ComposedDeal | { error: string } {
  const max = input.maxLength ?? 300;
  const style = input.style ?? "wario";
  const currency = input.currency || "USD";
  const saleStr = formatMoney(input.salePriceCents, currency);
  const hasWas = input.wasPriceCents != null && input.wasPriceCents > input.salePriceCents;
  const wasStr = hasWas ? formatMoney(input.wasPriceCents as number, currency) : "";
  const pct = hasWas
    ? Math.round(((((input.wasPriceCents as number) - input.salePriceCents) /
        (input.wasPriceCents as number)) * 100))
    : 0;
  const asOf = formatAsOf(input.priceAsOf);

  // Wario style links the price phrase itself; classic the fixed anchor.
  const anchor = style === "wario" ? `${saleStr} on Amazon` : DEAL_ANCHOR;
  const leadIn = pickLeadIn(input.title);

  const build = (title: string, withWas: boolean, withPct: boolean): string => {
    if (style === "wario") {
      const pctClause =
        withPct && pct >= 1
          ? withWas && hasWas
            ? ` (${pct}% off, reg. ${wasStr})`
            : ` (${pct}% off)`
          : "";
      return `${title} is ${anchor}${pctClause} #ad\n\n(price as of ${asOf} — subject to change)`;
    }
    const wasClause = withWas && hasWas ? ` (was ${wasStr})` : "";
    const pctClause = withPct && pct >= 1 ? `, ${pct}% off` : "";
    return `${leadIn} ${title} — ${saleStr}${wasClause}${pctClause}. as of ${asOf}; price subject to change. ${anchor} #ad`;
  };

  let title = input.title.trim().replace(/\s+/g, " ");
  if (style === "wario") title = shortenAmazonTitle(title);
  let text = build(title, true, true);
  if (glen(text) > max) text = build(title, false, true);
  if (glen(text) > max) text = build(title, false, false);
  while (glen(text) > max && title.length > 8) {
    title = title.slice(0, Math.max(1, title.length - 4)).trimEnd();
    text = build(`${title}…`, false, false);
  }

  const validation = validateDealText(text, input.linkUrl, max, anchor);
  if (!validation.ok) return { error: validation.reason };
  return { text, anchor };
}

/**
 * PA-API 5.0 SearchIndex values the dashboard offers for deal feeds (curated
 * physical-product subset of the US marketplace list). Server actions validate
 * against this — an unknown index would 400 every SearchItems call.
 */
export const PAAPI_SEARCH_INDEXES = [
  "All",
  "Automotive",
  "Baby",
  "Beauty",
  "Books",
  "Computers",
  "Electronics",
  "GardenAndOutdoor",
  "GroceryAndGourmetFood",
  "HealthPersonalCare",
  "HomeAndKitchen",
  "Luggage",
  "MoviesAndTV",
  "MusicalInstruments",
  "OfficeProducts",
  "PetSupplies",
  "SportsAndOutdoors",
  "ToolsAndHomeImprovement",
  "ToysAndGames",
  "VideoGames",
] as const;
