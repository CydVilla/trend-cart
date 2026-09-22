import {
  canonicalAmazonUrl,
  DEAL_BANNED_PHRASES,
  extractAsin,
  isAmazonHost,
  validateDealText,
  type CuratedDealKind,
} from "@trendcart/shared";
import { stripUnverifiedPriceClaims, type AmazonRef, type RssItem } from "./rss.js";

/**
 * Curator-account deal source (ADR-0017): a DealSuggestionSource whose URL is
 * a bsky.app profile — Wario64 being the reason this exists. The account is
 * read through the public, unauthenticated Bluesky AppView; each post's
 * Amazon link (almost always an amzn.to short link carrying the CURATOR'S
 * affiliate tag) is resolved to an ASIN by reading one redirect header, and
 * the product URL is rebuilt canonically so only our tag ever survives.
 *
 * Everything the curator wrote is UNTRUSTED text: it feeds keyword filters,
 * a product-name extraction, and (with credit) an LLM inside untrusted tags.
 * Their prices are never repeated — copy is price-free per ADR-0013.
 */

const PUBLIC_APPVIEW = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
const USER_AGENT = "TrendCartBot/1.0 (deal curator reader)";
const FETCH_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const MAX_REDIRECT_HOPS = 4;
/** Amazon's own shorteners — resolved by redirect, never by loading a page. */
const SHORTENER_HOSTS = new Set(["amzn.to", "a.co"]);

export type CuratorPost = {
  /** at:// URI — the per-source dedup guid. */
  uri: string;
  /** Human-facing bsky.app URL of the post (audit + fact-check context). */
  url: string;
  text: string;
  /** Older of createdAt/indexedAt, so a backdated or re-indexed post can't
   *  look fresher than it is. */
  publishedAt: Date | null;
  /** Amazon-host links (facets + link-card embed). `display` is the link's
   *  visible text in the post, used to find which line names the product. */
  amazonLinks: Array<{ uri: string; display: string | null }>;
};

export type CuratedMeta = {
  productTitle: string;
  kind: CuratedDealKind;
  postUrl: string;
};

export type CuratedItem = RssItem & { curated: CuratedMeta };

type JsonRecord = Record<string, unknown>;

function rec(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function validDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function marketplaceOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith("www.") ? host : `www.${host}`;
}

/** Parse one getAuthorFeed response. Reposts, replies, other authors' posts,
 *  and posts without an Amazon link are dropped. */
export function parseAuthorFeed(json: unknown, actor: string): CuratorPost[] {
  const feed = rec(json).feed;
  if (!Array.isArray(feed)) return [];
  const want = actor.toLowerCase();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const posts: CuratorPost[] = [];

  for (const entry of feed) {
    if (rec(entry).reason) continue; // a repost of someone else
    const post = rec(rec(entry).post);
    const author = rec(post.author);
    const handle = str(author.handle)?.toLowerCase() ?? "";
    if (handle !== want && str(author.did) !== actor) continue;
    const record = rec(post.record);
    if (record.reply) continue;
    const uri = str(post.uri);
    const text = str(record.text) ?? "";
    if (!uri || !text) continue;

    const bytes = enc.encode(text);
    const amazonLinks: CuratorPost["amazonLinks"] = [];
    const addLink = (candidate: unknown, display: string | null): void => {
      const link = str(candidate);
      if (!link) return;
      try {
        if (!isAmazonHost(new URL(link).hostname)) return;
      } catch {
        return;
      }
      if (!amazonLinks.some((l) => l.uri === link)) amazonLinks.push({ uri: link, display });
    };
    for (const facet of Array.isArray(record.facets) ? record.facets : []) {
      const index = rec(rec(facet).index);
      const start = typeof index.byteStart === "number" ? index.byteStart : -1;
      const end = typeof index.byteEnd === "number" ? index.byteEnd : -1;
      const display =
        start >= 0 && end > start && end <= bytes.length
          ? dec.decode(bytes.slice(start, end)).trim() || null
          : null;
      const features = rec(facet).features;
      for (const feature of Array.isArray(features) ? features : []) {
        addLink(rec(feature).uri, display);
      }
    }
    const embed = rec(record.embed);
    addLink(rec(embed.external).uri, null);
    addLink(rec(rec(embed.media).external).uri, null);
    if (amazonLinks.length === 0) continue;

    const rkey = uri.split("/").pop() ?? "";
    const dates = [validDate(record.createdAt), validDate(post.indexedAt)].filter(
      (d): d is Date => d !== null,
    );
    posts.push({
      uri,
      url: `https://bsky.app/profile/${handle || actor}/post/${rkey}`,
      text,
      publishedAt:
        dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null,
      amazonLinks,
    });
  }
  return posts;
}

/** Newest top-level posts of a curator account, Amazon-linked only. */
export async function fetchCuratorPosts(
  actor: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CuratorPost[]> {
  const url = new URL(PUBLIC_APPVIEW);
  url.searchParams.set("actor", actor);
  url.searchParams.set("limit", String(Math.max(1, Math.min(100, limit))));
  url.searchParams.set("filter", "posts_no_replies");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`author feed fetch failed: HTTP ${response.status}`);
  return parseAuthorFeed(await response.json(), actor);
}

/**
 * Follow an Amazon link to its product ASIN. Short links are resolved by
 * reading the redirect's Location header (HEAD, redirects not followed), so
 * no Amazon page is ever loaded. Returns null when the link definitively
 * isn't a single product (store page, search, non-Amazon hop); THROWS on a
 * network failure so the caller can retry on a later poll.
 */
export async function resolveAmazonLink(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AmazonRef | null> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!isAmazonHost(url.hostname)) return null;
    const bare = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!SHORTENER_HOSTS.has(bare)) {
      const asin = extractAsin(url.toString());
      return asin ? { asin, marketplace: marketplaceOf(url) } : null;
    }
    if (hop === MAX_REDIRECT_HOPS) return null;
    const response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      if (response.status >= 500) throw new Error(`shortener HTTP ${response.status}`);
      return null;
    }
    current = new URL(location, url).toString();
  }
  return null;
}

// ── Product-name extraction ─────────────────────────────────────────────

/** Visible link text ("amzn.to/4yR60yW", "buff.ly/x", full URLs). */
const LINK_TEXT_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;
const HASHTAG_RE = /(^|\s)#[\p{L}\p{N}_]+/gu;
/** Parentheticals that carry price talk: "($39.99)", "($10 off MSRP)". */
const PRICE_PAREN_RE = /\([^)]*(?:\$|%|\boff\b|\bsave\b|coupon|msrp|\bprice\b)[^)]*\)/gi;
/** Opening labels curators put before the product name. */
const LEAD_LABEL_RE =
  /^(?:amazon|deals?|restock(?:ed)?|pre-?orders?|reminder|psa|update|live|now live|price drop|new low|all[- ]time low|atl|lowest price(?: ever)?)\s*[:\-–—]\s*/i;
/** Where the product name ends and the deal sentence begins. */
const DEAL_PHRASE_RE = new RegExp(
  [
    String.raw`\s(?:is|are)\s+(?:now\s+|down\s+to\s+|only\s+|currently\s+|back\s+)?(?:\$|\d|on sale|discounted|marked down|in stock|available|up for|free)`,
    String.raw`\s(?:for|at|just|only)\s+\$`,
    String.raw`\s[-–—:]?\s*\$\s*\d`,
    String.raw`\s(?:up|available|now|open)\s+for\s+pre-?orders?`,
    String.raw`\spre-?orders?\b`,
    String.raw`\s(?:on|at|via|from)\s+amazon\b`,
    String.raw`\s(?:restock(?:ed)?|back in stock|in stock)\b`,
    String.raw`\sw\/\s`,
    String.raw`\swith\s+(?:subscribe|s&s|coupon|code|promo|clip|prime)`,
  ].join("|"),
  "i",
);
/** A line that only names a retailer (+ format): "Amazon", "Amazon digital". */
const RETAILER_ONLY_RE =
  /^(?:amazon|best buy|target|walmart|gamestop|woot|vgp|pnp)(?:\s+(?:digital|physical|version|copy|code|link|us|ca|uk|only))*$/i;

export function curatedDealKind(text: string): CuratedDealKind {
  if (/\bpre-?orders?\b/i.test(text)) return "preorder";
  if (/\b(?:restock(?:ed|s)?|back in stock|in stock)\b/i.test(text)) return "restock";
  return "sale";
}

function clipWords(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const clipped = text.slice(0, max);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 20 ? lastSpace : max).trimEnd()}…`;
}

function productFromLine(line: string): string | null {
  let s = line
    .replace(LINK_TEXT_RE, " ")
    .replace(HASHTAG_RE, " ")
    .replace(PRICE_PAREN_RE, " ")
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEAD_LABEL_RE, "");
  const cut = s.search(DEAL_PHRASE_RE);
  if (cut >= 0) s = s.slice(0, cut);
  s = stripUnverifiedPriceClaims(s)
    .replace(/\(\s*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—:,;|+@&/]+|[\s\-–—:,;|+@&/]+$/g, "")
    .trim();
  if ([...s].length < 8 || !/[a-z]/i.test(s) || RETAILER_ONLY_RE.test(s)) return null;
  return clipWords(s, 120);
}

/**
 * The product a curator's post names, plus what kind of deal it announces.
 * Prefers the line that carries the Amazon link (multi-retailer posts list
 * one product per line); falls back to the first line when that line is just
 * "Amazon <link>" under a headline. Null = nothing safely nameable.
 */
export function extractCuratedProduct(
  text: string,
  linkDisplay: string | null,
): { productTitle: string; kind: CuratedDealKind } | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const linkLine = linkDisplay ? lines.find((line) => line.includes(linkDisplay)) : undefined;
  for (const line of [linkLine, lines[0]]) {
    if (!line) continue;
    const productTitle = productFromLine(line);
    if (productTitle) {
      return { productTitle, kind: curatedDealKind(`${linkLine ?? ""}\n${line}`) };
    }
  }
  return null;
}

/** The curator post → the RSS-shaped item the shared staging gates expect.
 *  The canonical /dp/ link is the item link, so ASIN matching is exact. */
export function curatedFeedItem(
  post: CuratorPost,
  ref: AmazonRef,
  product: { productTitle: string; kind: CuratedDealKind },
): CuratedItem {
  return {
    title: post.text.replace(/\s+/g, " ").trim(),
    link: canonicalAmazonUrl(ref.asin, ref.marketplace),
    guid: post.uri,
    description: "",
    content: "",
    publishedAt: post.publishedAt,
    curated: { ...product, postUrl: post.url },
  };
}

// ── Copy ────────────────────────────────────────────────────────────────

/** The clickable phrase per kind — a pre-order is not "a deal". */
export const CURATED_ANCHORS: Record<CuratedDealKind, string> = {
  sale: "see the deal",
  preorder: "pre-order here",
  restock: "check stock",
};

const TEMPLATE_LEADS: Record<CuratedDealKind, Array<(title: string) => string>> = {
  sale: [
    (t) => `${t} is on sale on Amazon right now`,
    (t) => `Price drop on Amazon: ${t}`,
    (t) => `${t} is marked down on Amazon`,
    (t) => `${t} is discounted on Amazon at the moment`,
  ],
  preorder: [
    (t) => `${t} is up for pre-order on Amazon`,
    (t) => `Pre-orders are open on Amazon for ${t}`,
  ],
  restock: [
    (t) => `${t} is back in stock on Amazon`,
    (t) => `Restock on Amazon: ${t}`,
  ],
};

function stableIndex(seed: string, n: number): number {
  let hash = 7;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % n;
}

/** Tokenless copy: one of a few concrete, price-free phrasings, chosen
 *  deterministically per ASIN so re-composes are stable. */
export function templateLead(kind: CuratedDealKind, productTitle: string, seed: string): string {
  const options = TEMPLATE_LEADS[kind];
  return options[stableIndex(seed, options.length)]!(productTitle);
}

/** "Wario64 (Bluesky)" → "Wario64": credit the curator, not the platform. */
export function curatorLabel(sourceName: string): string {
  return sourceName.replace(/\s*\([^)]*\)\s*$/, "").trim() || sourceName.trim();
}

/** Any money or discount figure. Lead copy must have none. */
export function hasPriceClaim(text: string): boolean {
  return (
    /(?:US\$|\$|USD\s?)\s*\d/i.test(text) ||
    /\d\s*(?:%|percent)/i.test(text) ||
    /\b\d[\d,.]*\s*(?:dollars?|bucks|usd)\b/i.test(text) ||
    /\b(?:half|\d+)\s+off\b/i.test(text) ||
    /\bsave\s+\$?\d/i.test(text)
  );
}

const SALE_WORDS_RE = /\b(?:on sale|sale|discount(?:ed)?|marked down|price drop|cheaper|deal price|\boff\b)/i;
const HYPE_RE = /\b(?:hurry|act fast|while (?:it|they) lasts?|grab it before)\b/i;

/**
 * Mechanical gate on an LLM-written lead. Returns a rejection reason, or
 * null when the lead is safe to publish. Any rejection → the template.
 */
export function validateCuratedLead(
  lead: string,
  kind: CuratedDealKind,
  productTitle: string,
  maxLength: number,
): string | null {
  const text = lead.trim();
  if (!text) return "empty";
  if ([...text].length > maxLength) return "too long";
  if (hasPriceClaim(text)) return "price claim";
  if (/https?:\/\/|www\.|#|@/i.test(text)) return "link, hashtag, or mention";
  if (!/amazon/i.test(text)) return "does not name Amazon";
  if (kind !== "sale" && SALE_WORDS_RE.test(text)) return `calls a ${kind} a sale`;
  if (HYPE_RE.test(text)) return "hype";
  const lower = text.toLowerCase();
  if (DEAL_BANNED_PHRASES.some((phrase) => lower.includes(phrase))) return "banned phrase";
  const tokens = productTitle
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
  if (tokens.length > 0 && !tokens.some((token) => lower.includes(token))) {
    return "does not name the product";
  }
  return null;
}

/** Room left for the lead once attribution, anchor, and #ad are appended. */
export function curatedLeadBudget(sourceLabel: string, kind: CuratedDealKind, maxLength: number): number {
  return maxLength - [...` (via ${sourceLabel}) — ${CURATED_ANCHORS[kind]} #ad`].length;
}

/** Final post text. Null when it can't pass the shared deal-text validator. */
export function composeCuratedDeal(input: {
  lead: string;
  kind: CuratedDealKind;
  sourceLabel: string;
  linkUrl: string;
  maxLength: number;
}): { text: string; anchor: string } | null {
  const anchor = CURATED_ANCHORS[input.kind];
  const lead = input.lead.trim().replace(/[\s.!,;:—–-]+$/g, "");
  if (!lead || hasPriceClaim(lead)) return null;
  const text = `${lead} (via ${input.sourceLabel}) — ${anchor} #ad`;
  return validateDealText(text, input.linkUrl, input.maxLength, anchor).ok ? { text, anchor } : null;
}
