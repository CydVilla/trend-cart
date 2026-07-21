import assert from "node:assert/strict";
import test from "node:test";
import {
  matchAmazonProduct,
  parseRssItems,
  stripUnverifiedPriceClaims,
  type RssItem,
} from "./rss.js";

function item(overrides: Partial<RssItem>): RssItem {
  return {
    title: "Nintendo Switch Pro Controller deal",
    link: "https://slickdeals.net/deal/123",
    guid: "123",
    description: "",
    content: "",
    publishedAt: null,
    ...overrides,
  };
}

test("parses RSS publication time", () => {
  const [parsed] = parseRssItems(`
    <rss><channel><item>
      <title><![CDATA[Nintendo Switch game]]></title>
      <guid>abc</guid>
      <pubDate>Tue, 21 Jul 2026 15:00:00 GMT</pubDate>
    </item></channel></rss>`);
  assert.equal(parsed?.publishedAt?.toISOString(), "2026-07-21T15:00:00.000Z");
});

test("prefers the exact direct product URL over unrelated body links", () => {
  const matched = matchAmazonProduct(
    item({
      link: "https://www.amazon.com/Nintendo-Switch-Controller/dp/B01NAWKYZ0",
      content: '<a href="https://www.amazon.com/Unrelated/dp/B012345678">ad</a>',
    }),
  );
  assert.equal(matched?.asin, "B01NAWKYZ0");
  assert.equal(matched?.evidence, "direct-item-link");
});

test("handles Amazon Product Services attributes in any order and quote style", () => {
  const matched = matchAmazonProduct(
    item({
      content:
        "<a data-store-slug='amazon' class='deal' data-aps-asin='B01NAWKYZ0' href='/click'>deal</a>",
    }),
  );
  assert.equal(matched?.asin, "B01NAWKYZ0");
  assert.equal(matched?.matchConfidence, 90);
});

test("fails closed when equally strong Amazon products make the item ambiguous", () => {
  const matched = matchAmazonProduct(
    item({
      content:
        '<a data-store-slug="amazon" data-aps-asin="B01NAWKYZ0">one</a>' +
        '<a data-store-slug="amazon" data-aps-asin="B012345678">two</a>',
    }),
  );
  assert.equal(matched, null);
});

test("removes external prices and discount percentages without erasing product specs", () => {
  assert.equal(
    stripUnverifiedPriceClaims("2TB NVMe SSD $79.99 — save 35% with 20% coupon"),
    "2TB NVMe SSD",
  );
  assert.equal(stripUnverifiedPriceClaims("Controller half off, 2-pack"), "Controller, 2-pack");
});
