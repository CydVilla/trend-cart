import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affiliateTagFor,
  amazonSearchUrl,
  channelsForTag,
  dealChannel,
  resolveAffiliateTags,
  tagOfUrl,
  withAffiliateTag,
} from "@trendcart/shared";

/**
 * Per-channel tracking IDs are the only way Amazon's reports can say which
 * channel sold something. The failure modes that matter: a channel silently
 * posting under the wrong ID (its sales land in another channel's row), or an
 * unset var producing an UNTAGGED link (sales lost outright).
 */

const BASE = { AMAZON_ASSOCIATE_TAG: "villa03b-20" };

test("every channel falls back to the base tag when its own var is unset", () => {
  const tags = resolveAffiliateTags(BASE);
  for (const tag of Object.values(tags)) assert.equal(tag, "villa03b-20");
});

test("a channel's own var wins, and only for that channel", () => {
  const env = { ...BASE, AMAZON_TAG_DEAL_CURATED: "villa-curated-20" };
  assert.equal(affiliateTagFor("deal_curated", env), "villa-curated-20");
  assert.equal(affiliateTagFor("deal_rss", env), "villa03b-20");
  assert.equal(affiliateTagFor("reply", env), "villa03b-20");
});

test("blank or whitespace vars fall back instead of producing an untagged link", () => {
  const env = { ...BASE, AMAZON_TAG_REPLY: "  ", AMAZON_TAG_DEAL_RSS: "" };
  assert.equal(affiliateTagFor("reply", env), "villa03b-20");
  assert.equal(affiliateTagFor("deal_rss", env), "villa03b-20");
  assert.equal(affiliateTagFor("reply", { AMAZON_TAG_REPLY: " villa-reply-20 " }), "villa-reply-20");
});

test("no tags at all resolves to empty, which link builders leave untagged", () => {
  assert.equal(affiliateTagFor("reply", {}), "");
  assert.equal(withAffiliateTag("https://www.amazon.com/dp/B0TEST0001", ""), "https://www.amazon.com/dp/B0TEST0001");
});

test("the chosen tag reaches the link builders", () => {
  const env = { ...BASE, AMAZON_TAG_REPLY: "villa-reply-20" };
  const search = amazonSearchUrl("xenoblade chronicles 2", affiliateTagFor("reply", env));
  assert.equal(tagOfUrl(search), "villa-reply-20");
  // Re-tagging (the poster does this at publish) replaces, never appends.
  const retagged = withAffiliateTag(
    "https://www.amazon.com/dp/B0TEST0001?tag=villa03b-20",
    affiliateTagFor("reply", env),
  );
  assert.equal(new URL(retagged).searchParams.getAll("tag").join(","), "villa-reply-20");
});

test("deal posts map to their channel the same way the poster splits them", () => {
  assert.equal(dealChannel("CURATED", null), "deal_curated");
  assert.equal(dealChannel("MANUAL", null), "deal_manual");
  assert.equal(dealChannel("DISCOVERED", null), "deal_rss");
  assert.equal(dealChannel("DISCOVERED", "feed_1"), "deal_feed");
  assert.equal(dealChannel("AUTOMATED", null), "deal_feed");
});

test("reverse lookup lists every channel sharing an ID, case-insensitively", () => {
  const env = { ...BASE, AMAZON_TAG_REPLY: "villa-reply-20" };
  assert.deepEqual(channelsForTag("VILLA-REPLY-20", env), ["reply"]);
  assert.deepEqual(channelsForTag("villa03b-20", env), [
    "deal_rss",
    "deal_curated",
    "deal_feed",
    "deal_manual",
  ]);
  assert.deepEqual(channelsForTag("someone-else-20", env), []);
});

test("tagOfUrl tolerates junk", () => {
  assert.equal(tagOfUrl("not a url"), null);
  assert.equal(tagOfUrl("https://www.amazon.com/dp/B0TEST0001"), null);
});
