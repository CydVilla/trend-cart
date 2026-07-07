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
    // The description is HTML; keep it RAW here (URLs may hide in attributes)
    // but entity-decoded so &amp; inside hrefs doesn't break URL parsing.
    const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
    const rawDesc = descMatch?.[1] ?? "";
    const cdata = rawDesc.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    const description = decodeEntities((cdata ? cdata[1]! : rawDesc).trim());
    if (!title || !guid) continue; // no stable identity → unusable
    items.push({ title, link, guid, description });
  }
  return items;
}

export type AmazonRef = { asin: string; marketplace: string };

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

/**
 * Find the first Amazon product reference in the given texts (item link
 * first, then description HTML). Handles both direct product URLs and deal-
 * site redirects that carry the target URL-encoded in a query parameter
 * (e.g. slickdeals.net/?...&u2=https%3A%2F%2Fwww.amazon.com%2Fdp%2FASIN).
 * Shortener links (amzn.to / a.co) stay unresolvable offline → null.
 */
export function extractAmazonRef(...texts: Array<string | null>): AmazonRef | null {
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(URL_RE)) {
      const candidate = match[0]!;
      const direct = directAmazonRef(candidate);
      if (direct) return direct;
      // Redirect form: scan every query-param value for an embedded URL.
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        continue;
      }
      for (const value of url.searchParams.values()) {
        if (!/^https?:\/\//i.test(value)) continue;
        const embedded = directAmazonRef(value);
        if (embedded) return embedded;
      }
    }
  }
  return null;
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
