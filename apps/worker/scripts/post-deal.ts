/**
 * Queue ONE operator-supplied deal for the bot's own profile. No LLM, no
 * Amazon catalog API — the two things that can be unavailable.
 *
 * This is the channel that still works when Anthropic credits are out (the
 * spending loops stand down, see llm-health.ts) AND while the Creators API is
 * still behind its eligibility gate. The operator reads the price off Amazon
 * and passes it here, which is exactly the human attestation ADR-0013 requires
 * before any price is advertised — the same standard the automated RSS channel
 * has to reach with a web-search fact check.
 *
 * MANUAL deals deliberately bypass the global deal throttles (see
 * deals/poster.ts): the cooldown and daily cap exist to stop AUTOMATED bursts
 * flooding the profile, and an operator posting by hand is the deliberate act
 * they were never meant to restrain.
 *
 *   pnpm --filter @trendcart/worker post-deal -- \
 *     --url "https://www.amazon.com/dp/B0HJ6F8L6V" \
 *     --title "Nintendo Switch 2 — The Legend of Zelda bundle" \
 *     --price 499.99 [--was 549.99] [--dry]
 *
 * --dry prints the exact post and writes nothing. ALWAYS dry-run first: the
 * poster claims a READY row within ~30s, so there is no take-backs window.
 */
import { DealPostStatus, DealSource, ListingOrigin, prisma } from "@trendcart/db";
import {
  canonicalAmazonUrl,
  composeDealPost,
  extractAsin,
  isAmazonHost,
  parseCents,
  withAffiliateTag,
} from "@trendcart/shared";
import { config } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry");
  const url = arg("url");
  const title = arg("title");
  const priceRaw = arg("price");
  const wasRaw = arg("was");
  const imageUrl = arg("image") ?? null;

  if (!url || !title || !priceRaw) {
    fail('need --url, --title and --price (add --was for the "reg." strikethrough, --dry to preview)');
  }

  // Validate everything BEFORE touching the DB: each of these is a hard stop
  // at post time anyway, and a half-written listing is worse than a refusal.
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return fail(`not a URL: ${url}`);
  }
  if (!isAmazonHost(host)) fail(`not an Amazon URL: ${host}`);

  const asin = extractAsin(url);
  if (!asin) fail(`no ASIN in ${url} — use a /dp/<ASIN> link`);

  const salePriceCents = parseCents(priceRaw);
  if (salePriceCents === null || salePriceCents <= 0) fail(`bad --price: ${priceRaw}`);
  const wasPriceCents = wasRaw ? parseCents(wasRaw) : null;
  if (wasRaw && wasPriceCents === null) fail(`bad --was: ${wasRaw}`);
  if (wasPriceCents !== null && wasPriceCents <= salePriceCents) {
    fail(`--was (${wasRaw}) must be higher than --price (${priceRaw}) to claim a discount`);
  }
  if (!config.site.amazonAssociateTag) {
    fail("AMAZON_ASSOCIATE_TAG is not set — refusing to post an untagged link");
  }

  // The operator's link may already carry a tag and tracking params. Rebuild
  // it from the ASIN so exactly one tag (ours) survives, and store the
  // canonical tag-free URL on the listing.
  const productUrl = canonicalAmazonUrl(asin, host);
  const linkUrl = withAffiliateTag(productUrl, config.site.amazonAssociateTag);
  const priceAsOf = new Date();

  const composed = composeDealPost({
    title,
    salePriceCents,
    wasPriceCents,
    currency: "USD",
    priceAsOf,
    linkUrl,
    maxLength: config.deals.postMaxLength,
    style: config.deals.postStyle,
  });
  if ("error" in composed) fail(`cannot compose a valid post: ${composed.error}`);

  console.log("\n┌─ would post ─────────────────────────────────");
  for (const line of composed.text.split("\n")) console.log(`│ ${line}`);
  console.log("└──────────────────────────────────────────────");
  console.log(`  link:   ${linkUrl}`);
  console.log(`  anchor: "${composed.anchor}"`);
  console.log(`  asin:   ${asin}\n`);

  if (dryRun) {
    console.log("--dry: nothing written. Re-run without --dry to queue it.");
    return;
  }
  if (config.bot.dryRun) fail("DRY_RUN=true — the deal poster is off, so this would sit READY forever");
  if (!config.deals.enabled) {
    fail("DEALS_ENABLED=false — the deal poster isn't running, so this would sit READY forever");
  }

  // Reuse a known ASIN, but never resurrect one the operator deactivated —
  // that flag is a standing ban the automated channel also honors.
  const existing = await prisma.trackedListing.findUnique({
    where: { asin_marketplace: { asin, marketplace: host } },
  });
  if (existing && !existing.isActive) {
    fail(`ASIN ${asin} is deactivated (banned) — re-activate it on the Deals page first`);
  }

  const listing = existing
    ? await prisma.trackedListing.update({
        where: { id: existing.id },
        data: {
          title,
          imageUrl: imageUrl ?? existing.imageUrl,
          lastPriceCents: salePriceCents,
          lastPriceAsOf: priceAsOf,
        },
      })
    : await prisma.trackedListing.create({
        data: {
          asin,
          marketplace: host,
          productUrl,
          title,
          imageUrl,
          fullPriceCents: wasPriceCents,
          currency: "USD",
          origin: ListingOrigin.WATCHLIST,
          lastPriceCents: salePriceCents,
          lastPriceAsOf: priceAsOf,
        },
      });

  const post = await prisma.dealPost.create({
    data: {
      listingId: listing.id,
      status: DealPostStatus.READY,
      source: DealSource.MANUAL,
      salePriceCents,
      // Nothing triggered this: the operator's price IS the target.
      targetPriceCents: salePriceCents,
      wasPriceCents,
      currency: "USD",
      priceAsOf,
      linkUrl,
      postText: composed.text,
      linkAnchor: composed.anchor,
    },
    select: { id: true },
  });

  console.log(`✓ queued deal ${post.id} (listing ${listing.id}) — the poster publishes it within ~30s.`);
  console.log(
    `  The poster refuses a price snapshot older than ${config.deals.maxPriceAgeHours}h, ` +
      "so if it hasn't gone out by then, re-run this.",
  );
}

main()
  .catch((error) => {
    console.error("post-deal failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
