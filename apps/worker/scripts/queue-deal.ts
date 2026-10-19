import { readFileSync } from "node:fs";
import { RichText } from "@atproto/api";
import {
  DealArmState,
  DealPostStatus,
  DealSource,
  ListingOrigin,
  prisma,
} from "@trendcart/db";
import {
  canonicalAmazonUrl,
  extractAsin,
  validateDealText,
  withAffiliateTag,
} from "@trendcart/shared";
import { config } from "../src/config.js";

/**
 * Operator CLI: queue hand-written deal posts for the bot's own profile —
 * pre-orders (list price, so they never clear the automated discount gates),
 * restocks, or a batch spotted by hand. Replaces the one-off post-preorder /
 * post-deal-batch scripts, which posted straight to Bluesky and so skipped
 * every guard the channel has.
 *
 * This does NOT post. It writes MANUAL DealPost rows (READY) and the worker's
 * deal poster publishes them — so a manual post gets the same exactly-once
 * claim, /r/ click tracking, per-listing lastPostedAt (the RSS and curator
 * channels' 7-day ASIN cooldown sees it), outcome sweep, and Deals-page
 * history as everything else. MANUAL posts bypass the channel's daily caps
 * and global gap (operator intent), so a batch is spaced with --gap instead.
 *
 * Links are rebuilt from the ASIN alone: whatever tracking cruft or foreign
 * affiliate tag the pasted URL carried is discarded and AMAZON_ASSOCIATE_TAG
 * applied. Copy must contain the link anchor exactly once and "#ad".
 *
 * Prices: Amazon prices move and Associates terms forbid showing a stale one,
 * so copy containing "$<digits>" is refused unless --allow-price. Prefer
 * price-free wording ("is on sale", "pre-orders are open").
 *
 *   # one post
 *   pnpm --filter @trendcart/worker queue:deal --url https://amzn.to/... \
 *     --text "Pre-orders are open for the Zelda Pro Controller on Amazon #ad"
 *   # a batch, 15 minutes apart
 *   pnpm --filter @trendcart/worker queue:deal --file deals.json --gap 15
 *   # validate and preview only
 *   pnpm --filter @trendcart/worker queue:deal --file deals.json --dry
 *
 * deals.json: [{ "asin" | "url", "text", "anchor"?, "title"? }, ...]
 * anchor defaults to "on Amazon"; title (the Deals-page label) defaults to
 * the copy before the anchor. Against prod, run with prod's DATABASE_URL
 * (e.g. `heroku run -a trend-cart -- pnpm --filter @trendcart/worker queue:deal ...`).
 */

type DealInput = { asin?: string; url?: string; text: string; anchor?: string; title?: string };

const DEFAULT_ANCHOR = "on Amazon";
const PRICE_RE = /\$\s?\d/;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const has = (name: string) => process.argv.includes(`--${name}`);

function readInputs(): DealInput[] {
  const file = flag("file");
  if (file) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
    return parsed as DealInput[];
  }
  const text = flag("text");
  if (!text) throw new Error("pass --file deals.json, or --asin/--url with --text");
  return [{ asin: flag("asin"), url: flag("url"), text, anchor: flag("anchor"), title: flag("title") }];
}

/** amzn.to short links carry no ASIN — follow the redirect header once. */
async function resolveAsin(input: DealInput): Promise<string> {
  if (input.asin) return input.asin.trim().toUpperCase();
  if (!input.url) throw new Error(`entry needs "asin" or "url": ${input.text}`);
  const direct = extractAsin(input.url);
  if (direct) return direct;
  const res = await fetch(input.url, { method: "HEAD", redirect: "manual" });
  const location = res.headers.get("location");
  const asin = location ? extractAsin(location) : null;
  if (!asin) throw new Error(`no ASIN in ${input.url}${location ? ` -> ${location}` : ""}`);
  return asin;
}

async function main(): Promise<void> {
  const dry = has("dry");
  const gapMinutes = Number(flag("gap") ?? 0);
  const tag = config.site.amazonAssociateTag;
  if (!tag) throw new Error("AMAZON_ASSOCIATE_TAG is not set");

  // Validate the WHOLE batch before writing anything — a half-queued batch is
  // worse than none.
  const planned: Array<{ asin: string; text: string; anchor: string; title: string; link: string }> = [];
  for (const [i, input] of readInputs().entries()) {
    const label = `#${i + 1}`;
    const text = input.text.trim();
    const anchor = input.anchor ?? DEFAULT_ANCHOR;
    const asin = await resolveAsin(input);
    const link = withAffiliateTag(canonicalAmazonUrl(asin), tag);
    if (PRICE_RE.test(text) && !has("allow-price")) {
      throw new Error(`${label} states a price — reword price-free, or pass --allow-price: ${text}`);
    }
    const graphemes = new RichText({ text }).graphemeLength;
    const verdict = validateDealText(text, link, config.deals.postMaxLength, anchor);
    if (!verdict.ok) throw new Error(`${label} ${verdict.reason}: ${text}`);
    const title = (input.title ?? text.slice(0, text.lastIndexOf(anchor)).trim()).slice(0, 120) || asin;
    planned.push({ asin, text, anchor, title, link });
    console.log(`--- ${label} ${asin} (${graphemes}/${config.deals.postMaxLength}) ---\n${text}\n  "${anchor}" -> ${link}`);
  }
  if (dry) {
    console.log(`\n--dry: ${planned.length} post(s) valid, nothing queued.`);
    return;
  }

  const cooldownMs = config.deals.perListingCooldownHours * 3_600_000;
  const start = Date.now();
  for (const [i, p] of planned.entries()) {
    const existing = await prisma.trackedListing.findUnique({
      where: { asin_marketplace: { asin: p.asin, marketplace: "www.amazon.com" } },
      select: { id: true, isActive: true, lastPostedAt: true },
    });
    if (existing && !existing.isActive) {
      console.warn(`skip ${p.asin}: listing is deactivated (banned on the Deals page)`);
      continue;
    }
    if (existing?.lastPostedAt && Date.now() - existing.lastPostedAt.getTime() < cooldownMs && !has("force")) {
      console.warn(`skip ${p.asin}: posted ${existing.lastPostedAt.toISOString()} — inside the ${config.deals.perListingCooldownHours}h cooldown (--force to override)`);
      continue;
    }
    const listing =
      existing ??
      (await prisma.trackedListing.create({
        data: {
          asin: p.asin,
          productUrl: canonicalAmazonUrl(p.asin),
          title: p.title,
          currency: "USD",
          origin: ListingOrigin.DISCOVERED,
          armState: DealArmState.DISARMED,
          source: "MANUAL",
        },
        select: { id: true },
      }));
    const pending = await prisma.dealPost.count({
      where: {
        listingId: listing.id,
        status: { in: [DealPostStatus.READY, DealPostStatus.POSTING, DealPostStatus.PENDING_APPROVAL] },
      },
    });
    if (pending > 0) {
      console.warn(`skip ${p.asin}: a post for it is already queued`);
      continue;
    }
    const due = new Date(start + i * gapMinutes * 60_000);
    const row = await prisma.dealPost.create({
      data: {
        listingId: listing.id,
        source: DealSource.MANUAL,
        status: DealPostStatus.READY,
        // Zero price = the poster's price-free path: no stale-price check, no
        // priced embed. Any price lives only in the operator's own copy.
        salePriceCents: 0,
        targetPriceCents: 0,
        currency: "USD",
        priceAsOf: new Date(),
        linkUrl: p.link,
        postText: p.text,
        linkAnchor: p.anchor,
        nextAttemptAt: due,
      },
      select: { id: true },
    });
    console.log(`queued ${p.asin} as ${row.id}, due ${due.toISOString()}`);
  }
  if (config.bot.dryRun) console.warn("\nDRY_RUN is on for this environment — the poster won't publish.");
  if (!config.deals.enabled) console.warn("\nDEALS_ENABLED is off — no deal poster runs to publish these.");
}

main()
  .catch((error) => {
    console.error("queue-deal failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
