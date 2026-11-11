import assert from "node:assert/strict";
import { test } from "node:test";
import { ebaySearchQuery, hasEbayCustomId, validateDealText } from "@trendcart/shared";
import {
  browseFeedItem,
  composeBrowseDeal,
  createEbayBrowseClient,
  disqualification,
  parseItemCheck,
  parseSearchResults,
} from "./ebay-browse.js";

const criteria = { minDiscountPercent: 20, minSellerFeedbackPercent: 98, minSellerFeedbackScore: 500 };
const creds = { appId: "APP", certId: "CERT", campaignId: "5339244955" };
const NOW = new Date("2026-11-10T12:00:00Z");

const summary = (over: Record<string, unknown> = {}) => ({
  itemId: "v1|306591775745|0",
  legacyItemId: "306591775745",
  title: "Super Mario Odyssey Nintendo Switch New Sealed",
  price: { value: "39.99", currency: "USD" },
  marketingPrice: {
    originalPrice: { value: "59.99", currency: "USD" },
    discountPercentage: "33",
    priceTreatment: "MARKDOWN",
  },
  buyingOptions: ["FIXED_PRICE"],
  seller: { username: "shop", feedbackPercentage: "99.8", feedbackScore: 12000 },
  ...over,
});

test("a marked-down listing from an established seller qualifies", () => {
  assert.equal(disqualification(summary(), criteria), null);
});

for (const [name, over, reason] of [
  ["variations", { itemGroupType: "SELLER_DEFINED_VARIATIONS" }, "multi_variation"],
  ["a variation ID", { itemId: "v1|306591775745|5" }, "multi_variation"],
  ["auctions", { buyingOptions: ["AUCTION"] }, "not_fixed_price"],
  ["adult items", { adultOnly: true }, "adult_only"],
  ["bootlegs", { title: "Nendoroid Bootleg Figure" }, "bad_listing_title"],
  ["partial products", { title: "Mario Odyssey Case Only" }, "bad_listing_title"],
  ["other currencies", { price: { value: "39.99", currency: "CAD" } }, "no_usd_price"],
  ["no markdown", { marketingPrice: undefined }, "discount_too_small"],
  ["small markdowns", { marketingPrice: { discountPercentage: "10" } }, "discount_too_small"],
  ["MAP pricing", { marketingPrice: { discountPercentage: "33", priceTreatment: "MINIMUM_ADVERTISED_PRICE" } }, "map_restricted"],
  ["low feedback", { seller: { feedbackPercentage: "95", feedbackScore: 9000 } }, "seller_feedback_low"],
  ["new sellers", { seller: { feedbackPercentage: "100", feedbackScore: 12 } }, "seller_too_new"],
] as const) {
  test(`rejects ${name}`, () => {
    assert.equal(disqualification(summary(over), criteria), reason);
  });
}

test("search results keep qualifiers, deepest discount first", () => {
  const rows = parseSearchResults(
    {
      itemSummaries: [
        summary({ legacyItemId: "111111111" }),
        summary({ legacyItemId: "222222222", marketingPrice: { discountPercentage: "50" } }),
        summary({ legacyItemId: "333333333", buyingOptions: ["AUCTION"] }),
      ],
    },
    criteria,
  );
  assert.deepEqual(rows.map((r) => r.itemId), ["222222222", "111111111"]);
  assert.equal(rows[0]?.priceCents, 3999);
});

test("an empty search is empty", () => {
  assert.deepEqual(parseSearchResults({ total: 0 }, criteria), []);
});

const AFFILIATE = "https://www.ebay.com/itm/306591775745?mkevt=1&campid=5339244955&customid=ebpost1&toolid=10049";
const item = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
  itemAffiliateWebUrl: AFFILIATE,
  ...over,
});

test("a live listing passes with eBay's affiliate URL", () => {
  const check = parseItemCheck(item(), criteria, NOW);
  assert.equal(check.status, "ok");
  assert.equal(check.status === "ok" && check.affiliateUrl, AFFILIATE);
});

for (const [name, over, reason] of [
  ["sold out", { estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK" }] }, "out_of_stock"],
  ["no availability data", { estimatedAvailabilities: [] }, "out_of_stock"],
  ["ended", { itemEndDate: "2026-11-10T11:00:00Z" }, "ended"],
  ["discount gone", { marketingPrice: undefined }, "discount_too_small"],
  ["no affiliate URL", { itemAffiliateWebUrl: undefined }, "no_affiliate_url"],
] as const) {
  test(`re-read fails when ${name}`, () => {
    assert.deepEqual(parseItemCheck(item(over), criteria, NOW), { status: "unavailable", reason });
  });
}

test("a future end date is fine", () => {
  assert.equal(parseItemCheck(item({ itemEndDate: "2026-12-01T00:00:00Z" }), criteria, NOW).status, "ok");
});

test("feed item carries the listing and a current timestamp", () => {
  const feed = browseFeedItem({ itemId: "306591775745", title: "T", priceCents: 3999, discountPercent: 33 }, NOW);
  assert.equal(feed.guid, "306591775745");
  assert.equal(feed.ebay.marketplace, "www.ebay.com");
  assert.equal(feed.ebay.priceCents, 3999);
  assert.equal(feed.publishedAt, NOW);
});

test("only eBay search URLs with keywords are saved searches", () => {
  assert.equal(ebaySearchQuery("https://www.ebay.com/sch/i.html?_nkw=nintendo+switch+game"), "nintendo switch game");
  assert.equal(ebaySearchQuery("https://www.ebay.com/sch/i.html?_sacat=0"), null);
  assert.equal(ebaySearchQuery("https://slickdeals.net/newsearch.php?q=ebay"), null);
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

type Call = { url: string; headers: Record<string, string>; body?: string };

function fakeEbay(handler: (call: Call) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    const call = {
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(call);
    if (call.url.includes("/oauth2/token")) return json({ access_token: "TOK", expires_in: 7200 });
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("search sends the filters, marketplace and campaign, and reuses the token", async () => {
  const { fetchImpl, calls } = fakeEbay(() => json({ itemSummaries: [summary()] }));
  const client = createEbayBrowseClient(creds, criteria, fetchImpl, () => NOW);
  await client.search("amiibo", { minCents: null, maxCents: 7500 });
  await client.search("amiibo", { minCents: null, maxCents: null });
  assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1);
  assert.match(calls[0]?.body ?? "", /grant_type=client_credentials/);
  const search = new URL(calls[1]!.url);
  assert.equal(search.searchParams.get("q"), "amiibo");
  assert.match(search.searchParams.get("filter") ?? "", /buyingOptions:\{FIXED_PRICE\},conditions:\{NEW\}/);
  assert.match(search.searchParams.get("filter") ?? "", /price:\[\.\.75\.00\],priceCurrency:USD/);
  assert.equal(calls[1]?.headers["x-ebay-c-marketplace-id"], "EBAY_US");
  assert.equal(calls[1]?.headers.authorization, "Bearer TOK");
  assert.equal(calls[1]?.headers["x-ebay-c-enduserctx"], "affiliateCampaignId=5339244955");
});

test("the token is refreshed after it expires", async () => {
  let now = NOW;
  const { fetchImpl, calls } = fakeEbay(() => json({}));
  const client = createEbayBrowseClient(creds, criteria, fetchImpl, () => now);
  await client.search("a", { minCents: null, maxCents: null });
  now = new Date(NOW.getTime() + 8000 * 1000);
  await client.search("a", { minCents: null, maxCents: null });
  assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 2);
});

test("the re-read sends the post ID as the affiliate reference", async () => {
  const { fetchImpl, calls } = fakeEbay(() => json(item()));
  const client = createEbayBrowseClient(creds, criteria, fetchImpl, () => NOW);
  const check = await client.check("306591775745", "ebpost1");
  assert.equal(check?.status, "ok");
  assert.match(calls[1]!.url, /\/item\/v1%7C306591775745%7C0$/);
  assert.equal(calls[1]?.headers["x-ebay-c-enduserctx"], "affiliateCampaignId=5339244955,affiliateReferenceId=ebpost1");
});

test("a missing listing is unavailable, but an outage is retried", async () => {
  const gone = createEbayBrowseClient(creds, criteria, fakeEbay(() => json({}, 404)).fetchImpl, () => NOW);
  assert.deepEqual(await gone.check("1", "p"), { status: "unavailable", reason: "http_404" });
  const down = createEbayBrowseClient(creds, criteria, fakeEbay(() => json({}, 500)).fetchImpl, () => NOW);
  assert.equal(await down.check("1", "p"), null);
});

test("a failed search reports only its status", async () => {
  const client = createEbayBrowseClient(creds, criteria, fakeEbay(() => json({}, 403)).fetchImpl, () => NOW);
  await assert.rejects(client.search("a", { minCents: null, maxCents: null }), /eBay search failed: HTTP 403/);
});

const priced = {
  listingTitle: "Super Mario Odyssey Nintendo Switch",
  priceCents: 3999,
  discountPercent: 33,
  priceAsOf: NOW,
  linkUrl: AFFILIATE,
  maxLength: 300,
};

test("composed copy states the checked price, its age and #ad", () => {
  const composed = composeBrowseDeal(priced);
  assert.equal(composed?.anchor, "$39.99 on eBay");
  assert.match(composed?.text ?? "", /^Super Mario Odyssey Nintendo Switch is \$39\.99 on eBay \(33% off\) #ad\n\n\(price as of .+ — subject to change\)$/);
});

test("a listing title stating its own price is not composed", () => {
  assert.equal(composeBrowseDeal({ ...priced, listingTitle: "Mario Odyssey 50% off today only" }), null);
});

test("a missing price is not composed", () => {
  assert.equal(composeBrowseDeal({ ...priced, priceCents: 0 }), null);
});

test("an affiliate URL without our campaign fails validation", () => {
  const text = "Great item — see it on eBay #ad";
  assert.equal(validateDealText(text, "https://www.ebay.com/itm/306591775745?customid=x", 300, "see it on eBay").ok, false);
});

test("the poster can recognize a link that already names its post", () => {
  assert.equal(hasEbayCustomId(AFFILIATE, "ebpost1"), true);
  assert.equal(hasEbayCustomId(AFFILIATE, "other"), false);
  assert.equal(hasEbayCustomId("not a url", "x"), false);
});

test("a curator's pick may skip the markdown rule but not the seller rules", async () => {
  const noMarkdown = item({ marketingPrice: undefined });
  const strict = createEbayBrowseClient(creds, criteria, fakeEbay(() => json(noMarkdown)).fetchImpl, () => NOW);
  assert.deepEqual(await strict.check("306591775745", "p"), { status: "unavailable", reason: "discount_too_small" });

  const { fetchImpl, calls } = fakeEbay(() => json(noMarkdown));
  const relaxed = await createEbayBrowseClient(creds, criteria, fetchImpl, () => NOW).check("306591775745", "", {
    minDiscountPercent: 0,
  });
  assert.equal(relaxed?.status, "ok");
  assert.ok(relaxed?.status === "ok" && relaxed.title.length > 0 && relaxed.discountPercent === 0);
  // No post exists yet at staging time: no affiliate reference is sent.
  assert.equal(calls[1]?.headers["x-ebay-c-enduserctx"], "affiliateCampaignId=5339244955");

  const badSeller = item({ marketingPrice: undefined, seller: { feedbackPercentage: "91.0", feedbackScore: 9000 } });
  const client = createEbayBrowseClient(creds, criteria, fakeEbay(() => json(badSeller)).fetchImpl, () => NOW);
  assert.deepEqual(await client.check("306591775745", "", { minDiscountPercent: 0 }), {
    status: "unavailable",
    reason: "seller_feedback_low",
  });
});

test("curator-sourced copy credits the curator and omits a zero discount", () => {
  const composed = composeBrowseDeal({ ...priced, discountPercent: 0, via: "Wario64" });
  assert.match(composed?.text ?? "", /^Super Mario Odyssey Nintendo Switch is \$39\.99 on eBay \(via Wario64\) #ad\n\n\(price as of /);
});
