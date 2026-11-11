import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractEbayItemId,
  validateDealText,
  withAffiliateTag,
  withEbayTracking,
} from "@trendcart/shared";
import { composeEbayDeal, ebayDealTitle, ebayFeedItem, matchEbayItemId } from "./ebay.js";
import type { RssItem } from "./rss.js";

const anchor = (printed: string): string =>
  `<a href="https://slickdeals.net/click?lno=4" data-product-exitWebsite="ebay.com" data-store-slug="ebay" rel="nofollow">${printed}</a>`;

const item = (content: string, title = "Nintendo Switch OLED Console"): RssItem => ({
  title,
  link: "https://slickdeals.net/f/1",
  guid: "1",
  description: "",
  content,
  publishedAt: new Date(),
});

const CAMPAIGN = "5339244955";

test("reads an item ID printed in full", () => {
  assert.equal(matchEbayItemId(item(anchor("https://www.ebay.com/itm/277938630069"))), "277938630069");
});

test("reads an item ID split by a <wbr> tag", () => {
  assert.equal(matchEbayItemId(item(anchor("https://www.ebay.com/itm/27793<wbr/>8630069"))), "277938630069");
});

test("skips a link Slickdeals shortened in the middle", () => {
  assert.equal(matchEbayItemId(item(anchor("https://www.ebay.com/itm/96017548...9497<wbr/>309937"))), null);
});

test("the same listing linked twice is still one listing", () => {
  const link = anchor("https://www.ebay.com/itm/277938630069");
  assert.equal(matchEbayItemId(item(`${link} and again ${link}`)), "277938630069");
});

test("skips an item naming two listings", () => {
  const html = `${anchor("https://www.ebay.com/itm/277938630069")} ${anchor("https://www.ebay.com/itm/960176458017")}`;
  assert.equal(matchEbayItemId(item(html)), null);
});

test("skips an item when any eBay link is unreadable", () => {
  const html = `${anchor("https://www.ebay.com/itm/277938630069")} ${anchor("this sale")}`;
  assert.equal(matchEbayItemId(item(html)), null);
});

test("ignores links to other stores", () => {
  const other = `<a href="https://slickdeals.net/click" data-store-slug="amazon">https://www.amazon.com/dp/B0FT995SPF</a>`;
  assert.equal(matchEbayItemId(item(other)), null);
});

test("feed item carries the listing as a marketplace ref", () => {
  const ref = ebayFeedItem(item(anchor("https://www.ebay.com/itm/277938630069")))?.ebay;
  assert.equal(ref?.asin, "277938630069");
  assert.equal(ref?.marketplace, "www.ebay.com");
});

test("only US listing URLs yield an item ID", () => {
  assert.equal(extractEbayItemId("https://www.ebay.com/itm/some-slug/277938630069?x=1"), "277938630069");
  assert.equal(extractEbayItemId("https://www.ebay.co.uk/itm/277938630069"), null);
  assert.equal(extractEbayItemId("https://www.ebay.com.evil.test/itm/277938630069"), null);
  assert.equal(extractEbayItemId("https://www.ebay.com/str/somestore"), null);
});

test("tracking replaces whatever the input carried", () => {
  const url = new URL(
    withEbayTracking(
      "https://www.ebay.com/itm/277938630069?campid=999&customid=theirs&_trkparms=x",
      CAMPAIGN,
      "post123",
    ),
  );
  assert.equal(url.origin + url.pathname, "https://www.ebay.com/itm/277938630069");
  assert.equal(url.searchParams.get("campid"), CAMPAIGN);
  assert.equal(url.searchParams.get("customid"), "post123");
  assert.equal(url.searchParams.get("mkrid"), "711-53200-19255-0");
  assert.equal(url.searchParams.get("_trkparms"), null);
});

test("tracking is idempotent", () => {
  const once = withEbayTracking("https://www.ebay.com/itm/277938630069", CAMPAIGN, "post123");
  assert.equal(withEbayTracking(once, CAMPAIGN, "post123"), once);
});

test("the Amazon tagger leaves an eBay link alone", () => {
  const link = withEbayTracking("https://www.ebay.com/itm/277938630069", CAMPAIGN);
  assert.equal(withAffiliateTag(link, "tag-20"), link);
});

test("titles lose prices and the store name", () => {
  assert.equal(ebayDealTitle("$22.40 adidas Mens Stadium Track Top + Free S&H"), "adidas Mens Stadium Track Top");
  assert.equal(ebayDealTitle("$626 - Refurb - Acer Aspire Go 15"), "Refurb - Acer Aspire Go 15");
  assert.equal(ebayDealTitle("Nintendo Switch OLED Console on eBay"), "Nintendo Switch OLED Console");
  assert.equal(ebayDealTitle("Nintendo Switch OLED Console $199 via eBay"), "Nintendo Switch OLED Console");
});

const link = withEbayTracking("https://www.ebay.com/itm/277938630069", CAMPAIGN);

test("composed copy is price-free, disclosed and names eBay", () => {
  const composed = composeEbayDeal({
    rawTitle: "$199 Nintendo Switch OLED Console + Free Shipping",
    sourceLabel: "Slickdeals",
    linkUrl: link,
    maxLength: 300,
  });
  assert.equal(
    composed?.text,
    "Deal spotted via Slickdeals: Nintendo Switch OLED Console is currently discounted on eBay — check eBay's current offer #ad",
  );
});

test("a title with nothing left after cleaning is not composed", () => {
  assert.equal(
    composeEbayDeal({ rawTitle: "$199", sourceLabel: "Slickdeals", linkUrl: link, maxLength: 300 }),
    null,
  );
});

test("the validator requires our campaign on an eBay link", () => {
  const text = "Great item — check eBay's current offer #ad";
  const anchorText = "check eBay's current offer";
  assert.equal(validateDealText(text, link, 300, anchorText).ok, true);
  assert.equal(validateDealText(text, "https://www.ebay.com/itm/277938630069", 300, anchorText).ok, false);
  assert.equal(validateDealText(text, `https://www.ebay.com/str/x?campid=${CAMPAIGN}`, 300, anchorText).ok, false);
});

test("the validator still rejects other hosts and untagged Amazon links", () => {
  const text = "Great item — see it #ad";
  assert.equal(validateDealText(text, "https://example.com/itm/277938630069?campid=1", 300, "see it").ok, false);
  assert.equal(validateDealText(text, "https://www.amazon.com/dp/B0FT995SPF", 300, "see it").ok, false);
});
