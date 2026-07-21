import { extractAsin, isAmazonHost, parseCents } from "@trendcart/shared";

/**
 * Dependency-free RSS 2.0 parsing + Amazon-product extraction for the deal
 * suggestion loop. Deal feeds (Slickdeals et al.) are RSS 2.0; we only need
 * four fields per item, so a scoped regex parser beats an XML dependency —
 * same reasoning as the hand-signed SigV4 client.
 *
 * Everything here treats feed content as UNTRUSTED text: titles go to the
 * LLM gate inside untrusted tags, URLs are validated against the Amazon host
 * allowlist, and product links are rebuilt canonically from the ASIN so the
 * source's affiliate/redirect parameters never survive.
 */

export type RssItem = {
  title: string;
  link: string | null;
  /** guid, falling back to link — the per-source dedup key. */
  guid: string;
  description: string;
  /** Raw content:encoded HTML (entity-decoded) — Slickdeals puts the store
   *  link attributes (incl. the ASIN) here, not in the description. */
  content: string;
  /** Feed publication time when supplied and parseable. Ranking and strict
   * sale verification treat a missing timestamp conservatively. */
  publishedAt: Date | null;
};

/** Minimal HTML/XML entity decode for the fields we read. &amp; goes LAST so
 *  "&amp;#39;" decodes as the literal "&#39;" only once, not twice. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** Unwrap <![CDATA[...]]>, decode entities, collapse whitespace. */
function cleanField(raw: string | undefined): string {
  if (!raw) return "";
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities((cdata ? cdata[1]! : raw).trim()).replace(/\s+/g, " ").trim();
}

function field(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return cleanField(match?.[1]);
}

/** Extract the items of an RSS 2.0 document. Unparseable input → []. */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]!;
    const title = field(block, "title");
    const link = field(block, "link") || null;
    const guid = field(block, "guid") || link || "";
    // description and content:encoded are HTML; keep them RAW here (URLs and
    // ASINs hide in attributes) but entity-decoded so &amp; inside hrefs
    // doesn't break URL parsing.
    const rawHtml = (tagRe: string): string => {
      const m = block.match(new RegExp(`<${tagRe}[^>]*>([\\s\\S]*?)</${tagRe}>`, "i"));
      const raw = m?.[1] ?? "";
      const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
      return decodeEntities((cdata ? cdata[1]! : raw).trim());
    };
    const description = rawHtml("description");
    const content = rawHtml("content:encoded");
    const publishedRaw = field(block, "pubDate") || field(block, "dc:date");
    const parsedPublished = publishedRaw ? new Date(publishedRaw) : null;
    const publishedAt =
      parsedPublished && !Number.isNaN(parsedPublished.getTime()) ? parsedPublished : null;
    if (!title || !guid) continue; // no stable identity → unusable
    items.push({ title, link, guid, description, content, publishedAt });
  }
  return items;
}

export type AmazonRef = { asin: string; marketplace: string };

export type AmazonMatch = AmazonRef & {
  /** Confidence that this exact ASIN is the product named by the RSS item,
   * not an unrelated Amazon link embedded elsewhere in the feed markup. */
  matchConfidence: number;
  evidence: "direct-item-link" | "embedded-target" | "amazon-product-attribute" | "direct-body-link";
};

const URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;

function marketplaceOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith("www.") ? host : `www.${host}`;
}

function directAmazonRef(candidate: string): AmazonRef | null {
  const asin = extractAsin(candidate);
  if (!asin) return null;
  try {
    const url = new URL(candidate);
    if (!isAmazonHost(url.hostname)) return null;
    return { asin, marketplace: marketplaceOf(url) };
  } catch {
    return null;
  }
}

const TITLE_STOP_WORDS = new Set([
  "amazon",
  "deal",
  "sale",
  "with",
  "from",
  "only",
  "free",
  "shipping",
  "save",
  "price",
  "the",
  "and",
  "for",
]);

function meaningfulTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\$\s*[\d,.]+|\b\d{1,3}%\s*off\b/g, " ")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token)),
  );
}

function slugOverlap(candidate: string, title: string): number {
  try {
    const url = new URL(candidate);
    const slug = url.pathname.split(/\/(?:dp|gp\/product)\//i)[0] ?? "";
    const titleTokens = meaningfulTokens(title);
    let overlap = 0;
    for (const token of meaningfulTokens(slug)) {
      if (titleTokens.has(token)) overlap += 1;
    }
    return overlap;
  } catch {
    return 0;
  }
}

type MatchCandidate = AmazonMatch & { score: number };

function urlCandidate(
  candidate: string,
  title: string,
  baseScore: number,
  evidence: AmazonMatch["evidence"],
): MatchCandidate | null {
  const ref = directAmazonRef(candidate);
  if (!ref) return null;
  const score = Math.min(100, baseScore + Math.min(12, slugOverlap(candidate, title) * 4));
  return { ...ref, matchConfidence: score, evidence, score };
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

/**
 * Resolve the exact Amazon product an RSS item names. Unlike the legacy
 * first-link-wins extractor, this collects every candidate, ranks evidence,
 * deduplicates by ASIN, and rejects an ambiguous near-tie. That prevents an
 * unrelated recommendation/ad link in feed HTML from becoming our post.
 */
export function matchAmazonProduct(item: RssItem): AmazonMatch | null {
  const candidates: MatchCandidate[] = [];
  const fields: Array<{ text: string | null; directBase: number; embeddedBase: number; body: boolean }> = [
    { text: item.link, directBase: 96, embeddedBase: 92, body: false },
    { text: item.description, directBase: 80, embeddedBase: 86, body: true },
    { text: item.content, directBase: 82, embeddedBase: 88, body: true },
  ];

  for (const field of fields) {
    if (!field.text) continue;
    for (const match of field.text.matchAll(URL_RE)) {
      const candidate = match[0]!;
      const direct = urlCandidate(
        candidate,
        item.title,
        field.directBase,
        field.body ? "direct-body-link" : "direct-item-link",
      );
      if (direct) candidates.push(direct);

      let redirect: URL;
      try {
        redirect = new URL(candidate);
      } catch {
        continue;
      }
      for (const value of redirect.searchParams.values()) {
        if (!/^https?:\/\//i.test(value)) continue;
        const embedded = urlCandidate(value, item.title, field.embeddedBase, "embedded-target");
        if (embedded) candidates.push(embedded);
      }
    }

    // Attribute order and quote style vary by feed renderer. Parse the full
    // anchor first, then read named attributes independently.
    for (const anchor of field.text.matchAll(/<a\b[^>]*>/gi)) {
      const tag = anchor[0]!;
      const asin = attr(tag, "data-aps-asin")?.toUpperCase() ?? null;
      const store = (attr(tag, "data-store-slug") ?? "").toLowerCase();
      const exit = (attr(tag, "data-product-exitwebsite") ?? "").toLowerCase();
      if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) continue;
      if (store !== "amazon" && !/(^|\.)amazon\.com$/.test(exit)) continue;
      candidates.push({
        asin,
        marketplace: "www.amazon.com",
        matchConfidence: 90,
        evidence: "amazon-product-attribute",
        score: 90,
      });
    }
  }

  const byAsin = new Map<string, MatchCandidate>();
  for (const candidate of candidates) {
    const prior = byAsin.get(candidate.asin);
    if (!prior || candidate.score > prior.score) byAsin.set(candidate.asin, candidate);
  }
  const ranked = [...byAsin.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0]!.score - ranked[1]!.score <= 4) return null;
  const best = ranked[0]!;
  return {
    asin: best.asin,
    marketplace: best.marketplace,
    matchConfidence: best.matchConfidence,
    evidence: best.evidence,
  };
}

/**
 * Find the first Amazon product reference in the given texts (item link
 * first, then description HTML). Handles both direct product URLs and deal-
 * site redirects that carry the target URL-encoded in a query parameter
 * (e.g. slickdeals.net/?...&u2=https%3A%2F%2Fwww.amazon.com%2Fdp%2FASIN).
 * Shortener links (amzn.to / a.co) stay unresolvable offline → null.
 */
export function extractAmazonRef(...texts: Array<string | null>): AmazonRef | null {
  const match = matchAmazonProduct({
    title: "",
    link: texts[0] ?? null,
    guid: "legacy-extractor",
    description: texts[1] ?? "",
    content: texts.slice(2).filter(Boolean).join(" "),
    publishedAt: null,
  });
  return match ? { asin: match.asin, marketplace: match.marketplace } : null;
}

const PRICE_RE = /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

/**
 * First dollar amount in the texts, as integer cents — deal headlines lead
 * with the sale price by convention ("Widget $29.99 + Free Shipping"). This
 * is only ever a HINT for the operator's confirm form, never advertised.
 */
export function extractPriceHintCents(...texts: Array<string | null>): number | null {
  for (const text of texts) {
    if (!text) continue;
    // Strip tags so prices inside markup read as plain text.
    const plain = text.replace(/<[^>]+>/g, " ");
    const match = plain.match(PRICE_RE);
    if (match) {
      const cents = parseCents(match[1]!);
      if (cents != null && cents > 0) return cents;
    }
  }
  return null;
}

/** Remove monetary and discount claims copied from an external feed before
 * composing no-PA-API autonomous text. Product numbers/capacities survive;
 * only recognizable price/percentage language is removed. */
export function stripUnverifiedPriceClaims(text: string): string {
  return text
    .replace(/(?:US\$|USD\s*|\$)\s*[0-9][\d,.]*/gi, " ")
    .replace(/\b[0-9][\d,.]*\s*(?:dollars?|usd)\b/gi, " ")
    .replace(
      /\b(?:save\s+)?\d{1,3}\s*(?:%|percent)\s*(?:off|discount|coupon|savings?)?\b/gi,
      " ",
    )
    .replace(/\b(?:half|one[ -]third|two[ -]thirds?)\s+off\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,;:])/g, "$1")
    .replace(/\b(?:with|plus|for|at|now|only|save)\s*$/i, "")
    .replace(/[\s\-–—:,+@&]+$/g, "")
    .trim();
}
