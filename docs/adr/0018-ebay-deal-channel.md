# ADR-0018: eBay deal channel — Slickdeals listings, classic Partner Network links

**Status:** Accepted

## Context
TrendCart was approved for the eBay Partner Network through impact.com. The
operator wants eBay deals posted automatically, with earnings visible per post.
Two facts shaped the design, both measured on 2026-11-10:

- **Impact can't build the links.** Its API refuses deep links for program 9356,
  and the tracking domain it uses (`app.partner.ebay.com`) returns NXDOMAIN.
  The eBay portal instead generates classic links directly on `www.ebay.com`
  (`campid`, `customid`, `mkevt` …), which load normally.
- **Supply is narrow.** None of about 400 recent curator posts linked to eBay.
  Slickdeals' eBay search is the one automated source, and its feed shortens
  most long links in the middle, hiding the item number.

## Decision
**A new `EBAY` `DealSource`, fed by the Slickdeals eBay search feed and by saved
Browse API searches.** It uses the shared staging, ranking and posting pipeline. An eBay listing
is a `TrackedListing` with `marketplace = www.ebay.com` and the item ID in `asin`.

- **Complete item numbers only.** An item qualifies only if every eBay link in it
  is printed in full and they all name one listing. Slickdeals' click tracker is
  never called to recover a shortened one.
- **Links are built, not fetched.** `withEbayTracking` applies the campaign ID on
  the canonical listing URL and, at publish, the post ID as `customid`.
- **Source-attested, price-free.** With no eBay API key and no scraping, a feed
  item under `DEAL_EBAY_MAX_AGE_HOURS` (6) old is the evidence. The copy credits
  Slickdeals and never states a price.
- **Browse API searches.** A source whose URL starts with
  `https://www.ebay.com/sch/i.html?` is a saved search, run with its `_nkw`
  keywords once `EBAY_APP_ID` and `EBAY_CERT_ID` are set. Results must be new,
  fixed-price, single-variation, marked down at least 20%, and from a seller
  with 98% feedback and a score of 500. Listing titles suggesting a fake or a
  partial product are dropped.
- **Re-read before posting.** Each Browse listing is fetched again at promotion
  and dismissed if it ended, sold out, or lost its discount. The check fails
  closed. The link posted is the `itemAffiliateWebUrl` eBay returns, which the
  API requires for commissions, with the post ID as the affiliate reference.
- **Browse posts state the price.** The copy gives the price and discount from
  the re-read, stamped "price as of <time>". eBay's API license says displayed
  listing information may not be more than six hours older than eBay's and that
  any lag must be disclosed. A Bluesky post stays up past that window. The
  operator accepted this on 2026-11-10 and handles aging posts. The stamp is the
  disclosure. MAP-restricted items are skipped, and photos are not posted.
- **Own budget.** `DEAL_EBAY_MAX_POSTS_PER_DAY` (4) and
  `DEAL_EBAY_COOLDOWN_MINUTES` (60), counted apart from every other channel.
  The channel is off until `EBAY_CAMPAIGN_ID` is set.
- **Bots get the bare listing.** `/r/<id>` sends crawlers to the parameter-free
  URL, so firehose fetches don't register as affiliate clicks with eBay.
- **Conversions by sub-ID.** An hourly read of Impact's Actions API upserts
  `EbayConversion` rows, tied to a post when a sub-ID matches. Unmatched rows
  still count in the totals. eBay clicks stay out of Amazon's conversion math.

## Consequences
- A Slickdeals listing can't be confirmed live before posting, so an ended one
  can be posted inside the freshness window. Browse listings don't have this gap.
- Slickdeals volume depends on what it prints in full and what passes the lanes.
  The first sample yielded very few on-lane listings, so saved searches are the
  main supply once keys exist.
- eBay says production Buy API access is for partners, must be applied for
  through the Partner Network, and isn't guaranteed. Keys may not be enough.
- Whether classic-link sales arrive through Impact's Actions API, and with
  `customid` as a sub-ID, is unconfirmed until the first real sale.

## Addendum (2026-11-11): curator eBay links

A third supply: a curator account's post (ADR-0017) that links exactly one US
eBay listing and yields no Amazon candidate. Curators link eBay through general
shorteners (`buff.ly`), so a short link counts as eBay only when its line of
the post names eBay, and only if its first redirect lands on a `/itm/` page.
That redirect header is the only thing requested; eBay itself is never fetched
through the curator's tracking link.

The listing is then read through the Browse API. Its title and price are
eBay's, never the curator's wording. The curator's judgment replaces the
20%-markdown rule; new, fixed price, single variation, in stock and the seller
thresholds still apply. The post goes out on the eBay channel's budget, priced
like a saved-search post, with "(via <curator>)".

eBay's own curated deals (the Deal API behind ebay.com/deals: daily, spotlight
and event deals) were also considered. The production keyset cannot use it:
the `buy.deal` scope is refused and the endpoint returns 403. It is a
limited-release API that eBay grants per application. Scraping the deals page
is not an option under the API license.

