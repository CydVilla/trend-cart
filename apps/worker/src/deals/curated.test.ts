import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCuratorUrl, curatorProfileHandle, validateDealText } from "@trendcart/shared";
import {
  composeCuratedDeal,
  curatedDealKind,
  curatedLeadBudget,
  curatorLabel,
  extractCuratedProduct,
  hasPriceClaim,
  parseAuthorFeed,
  resolveAmazonLink,
  templateLead,
  validateCuratedLead,
} from "./curated.js";

const ACTOR = "wario64.bsky.social";
const LINK = "https://www.amazon.com/dp/B0HJ6GH7B8?tag=ours-20";

/** A getAuthorFeed entry with one amzn.to facet over its visible text. */
function entry(
  text: string,
  overrides: { uri?: string; handle?: string; reason?: unknown; reply?: unknown; link?: string } = {},
) {
  const display = "amzn.to/4yR60yW";
  const enc = new TextEncoder();
  const at = text.indexOf(display);
  const facets =
    at >= 0
      ? [
          {
            index: {
              byteStart: enc.encode(text.slice(0, at)).length,
              byteEnd: enc.encode(text.slice(0, at)).length + enc.encode(display).length,
            },
            features: [
              { $type: "app.bsky.richtext.facet#link", uri: overrides.link ?? "https://amzn.to/4yR60yW" },
            ],
          },
        ]
      : [];
  return {
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    post: {
      uri: overrides.uri ?? "at://did:plc:knj5sw5al3sukl6vhkpi7637/app.bsky.feed.post/3mw4esdkenc2n",
      author: { did: "did:plc:knj5sw5al3sukl6vhkpi7637", handle: overrides.handle ?? ACTOR },
      record: {
        text,
        facets,
        createdAt: "2026-09-22T13:53:20.000Z",
        ...(overrides.reply ? { reply: overrides.reply } : {}),
      },
      indexedAt: "2026-09-22T13:53:24.157Z",
    },
  };
}

test("parseAuthorFeed keeps the curator's own Amazon-linked posts only", () => {
  const posts = parseAuthorFeed(
    {
      feed: [
        entry("Halo Season Two (4K UHD) is $12.49 on Amazon amzn.to/4yR60yW #ad"),
        entry("Reposted deal amzn.to/4yR60yW", { reason: { $type: "reasonRepost" } }),
        entry("reply amzn.to/4yR60yW", { reply: { root: {} } }),
        entry("someone else amzn.to/4yR60yW", { handle: "other.bsky.social" }),
        entry("Best Buy only buff.ly/abc", { link: "https://buff.ly/abc" }),
      ],
    },
    ACTOR,
  );
  assert.equal(posts.length, 1);
  const [post] = posts;
  assert.equal(post!.url, `https://bsky.app/profile/${ACTOR}/post/3mw4esdkenc2n`);
  assert.deepEqual(post!.amazonLinks, [{ uri: "https://amzn.to/4yR60yW", display: "amzn.to/4yR60yW" }]);
  // The OLDER of createdAt / indexedAt — never the fresher-looking one.
  assert.equal(post!.publishedAt?.toISOString(), "2026-09-22T13:53:20.000Z");
});

test("parseAuthorFeed tolerates junk", () => {
  assert.deepEqual(parseAuthorFeed(null, ACTOR), []);
  assert.deepEqual(parseAuthorFeed({ feed: [null, 3, { post: {} }] }, ACTOR), []);
});

test("extractCuratedProduct names the product on real Wario64 phrasing", () => {
  const cases: Array<[string, string | null, string, string]> = [
    ["Halo Season Two (4K UHD) is $12.49 on Amazon amzn.to/4yR60yW #ad", "amzn.to/4yR60yW", "Halo Season Two (4K UHD)", "sale"],
    [
      "Terranigma (XSX) up for preorder on Amazon ($39.99) amzn.to/4xzAPqL\n\nBest Buy (+ Switch 2E/PS5) buff.ly/BYDvbZW #ad",
      "amzn.to/4xzAPqL",
      "Terranigma (XSX)",
      "preorder",
    ],
    [
      "Stellar Blade Complete SteelBook Edition (Switch 2) preorder availability:\n\nAmazon amzn.to/4dJHAiB\nGameStop buff.ly/gGeFZtZ #ad",
      "amzn.to/4dJHAiB",
      "Stellar Blade Complete SteelBook Edition (Switch 2)",
      "preorder",
    ],
    [
      "SKINNYPOP Original, Gluten Free Popcorn Bags, .65 oz (30 Count) w/ subscribe & save discount + 20% off listed coupon is $10.44 on Amazon amzn.to/3H4jAty #ad",
      "amzn.to/3H4jAty",
      "SKINNYPOP Original, Gluten Free Popcorn Bags, .65 oz (30 Count)",
      "sale",
    ],
    [
      "Nintendo Switch™ 2 Pro Controller The Legend of Zelda™ – 40th Anniversary Edition up for preorder on Amazon ($99.99) amzn.to/4dShD0n #ad",
      "amzn.to/4dShD0n",
      "Nintendo Switch 2 Pro Controller The Legend of Zelda – 40th Anniversary Edition",
      "preorder",
    ],
    [
      // The Amazon line only names the retailer — fall back to the headline.
      "Paper Mario: The Thousand-Year Door (Switch physical/digital) is $41.99 at Best Buy buff.ly/TfcF13N #ad\nGameStop buff.ly/UdQmeIm\n\nAmazon digital amzn.to/4rZOC8c",
      "amzn.to/4rZOC8c",
      "Paper Mario: The Thousand-Year Door (Switch physical/digital)",
      "sale",
    ],
    [
      // Multi-product post: the product is on the Amazon link's own line.
      "Weekend game deals\nXeno Crisis (PS4) is $38.47 on Amazon amzn.to/4hGxxxa\nBitmap Bureau Collection (Switch) $42.75 at VGP buff.ly/x",
      "amzn.to/4hGxxxa",
      "Xeno Crisis (PS4)",
      "sale",
    ],
    ["RESTOCK: PS5 DualSense Edge in stock on Amazon amzn.to/x", "amzn.to/x", "PS5 DualSense Edge", "restock"],
  ];
  for (const [text, display, title, kind] of cases) {
    assert.deepEqual(extractCuratedProduct(text, display), { productTitle: title, kind }, text);
  }
});

test("extractCuratedProduct refuses when nothing nameable is left", () => {
  assert.equal(extractCuratedProduct("Amazon amzn.to/4dJHAiB #ad", "amzn.to/4dJHAiB"), null);
  assert.equal(extractCuratedProduct("$12.49 on Amazon amzn.to/x", "amzn.to/x"), null);
  assert.equal(extractCuratedProduct("", null), null);
});

test("extracted titles never carry a price", () => {
  const result = extractCuratedProduct(
    "Zelda Pro Controller / Case / Game ($10 off physical MSRP) available for preorder on Amazon amzn.to/4y9JS2Y #ad",
    "amzn.to/4y9JS2Y",
  );
  assert.ok(result);
  assert.equal(hasPriceClaim(result.productTitle), false);
  assert.equal(result.kind, "preorder");
});

test("curatedDealKind", () => {
  assert.equal(curatedDealKind("X up for pre-order on Amazon"), "preorder");
  assert.equal(curatedDealKind("X back in stock at Amazon"), "restock");
  assert.equal(curatedDealKind("X is $10 on Amazon"), "sale");
});

function fakeFetch(
  routes: Record<string, { status: number; location?: string } | Error>,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    if (route instanceof Error) throw route;
    return new Response(null, {
      status: route.status,
      headers: route.location ? { location: route.location } : {},
    });
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

test("resolveAmazonLink follows amzn.to to the ASIN without loading Amazon", async () => {
  const fetchImpl = fakeFetch({
    "https://amzn.to/4yR60yW": {
      status: 301,
      location: "https://www.amazon.com/dp/B0HJ6GH7B8/ref=as_li_ss_tl?ie=UTF8&linkCode=sl1&tag=sec2002-20",
    },
  });
  assert.deepEqual(await resolveAmazonLink("https://amzn.to/4yR60yW", fetchImpl), {
    asin: "B0HJ6GH7B8",
    marketplace: "www.amazon.com",
  });
  assert.deepEqual(fetchImpl.calls, ["https://amzn.to/4yR60yW"]); // only the shortener
});

test("resolveAmazonLink: direct links need no network; non-products resolve to null", async () => {
  const noNetwork = fakeFetch({});
  assert.equal(
    (await resolveAmazonLink("https://www.amazon.com/dp/B0F2PHXBDQ?tag=x-20", noNetwork))?.asin,
    "B0F2PHXBDQ",
  );
  const fetchImpl = fakeFetch({
    "https://amzn.to/store": {
      status: 301,
      location: "https://www.amazon.com/stores/page/preview?isSlp=1&asins=B0HKF2DM2N,B0HKDZ4LBX",
    },
    "https://amzn.to/offsite": { status: 301, location: "https://evil.example/dp/B0HJ6GH7B8" },
    "https://amzn.to/dead": { status: 404 },
  });
  assert.equal(await resolveAmazonLink("https://amzn.to/store", fetchImpl), null);
  assert.equal(await resolveAmazonLink("https://amzn.to/offsite", fetchImpl), null);
  assert.equal(await resolveAmazonLink("https://amzn.to/dead", fetchImpl), null);
  assert.equal(await resolveAmazonLink("https://evil.example/dp/B0HJ6GH7B8", noNetwork), null);
});

test("resolveAmazonLink throws on outages so the post is retried", async () => {
  const fetchImpl = fakeFetch({
    "https://amzn.to/a": { status: 503 },
    "https://amzn.to/b": new Error("ECONNRESET"),
  });
  await assert.rejects(resolveAmazonLink("https://amzn.to/a", fetchImpl));
  await assert.rejects(resolveAmazonLink("https://amzn.to/b", fetchImpl));
});

test("template copy is price-free, attributed, kind-correct, and valid", () => {
  const kinds = ["sale", "preorder", "restock"] as const;
  for (const kind of kinds) {
    for (const seed of ["B0HJ6GH7B8", "B0F2PHXBDQ", "B0HKKYZ3HQ", "B00KE1E7YA"]) {
      const lead = templateLead(kind, "Halo Season Two (4K UHD)", seed);
      const composed = composeCuratedDeal({
        lead,
        kind,
        sourceLabel: "Wario64",
        linkUrl: LINK,
        maxLength: 300,
      });
      assert.ok(composed, lead);
      assert.equal(validateDealText(composed.text, LINK, 300, composed.anchor).ok, true);
      assert.match(composed.text, /\(via Wario64\) — .+ #ad$/);
      assert.equal(hasPriceClaim(composed.text), false);
      if (kind !== "sale") assert.doesNotMatch(composed.text, /sale|discount|price drop|marked down/i);
    }
  }
  // Deterministic per ASIN: re-composing yields the same post.
  assert.equal(templateLead("sale", "X", "B0HJ6GH7B8"), templateLead("sale", "X", "B0HJ6GH7B8"));
});

test("composeCuratedDeal refuses a lead carrying a price", () => {
  assert.equal(
    composeCuratedDeal({
      lead: "Halo Season Two is $12.49 on Amazon",
      kind: "sale",
      sourceLabel: "Wario64",
      linkUrl: LINK,
      maxLength: 300,
    }),
    null,
  );
});

test("validateCuratedLead gates LLM copy", () => {
  const title = "Terranigma (XSX)";
  assert.equal(validateCuratedLead("Terranigma for Xbox is up for pre-order on Amazon", "preorder", title, 200), null);
  assert.equal(validateCuratedLead("Terranigma is 20% off on Amazon", "sale", title, 200), "price claim");
  assert.equal(validateCuratedLead("Terranigma is on sale on Amazon", "preorder", title, 200), "calls a preorder a sale");
  assert.equal(validateCuratedLead("Terranigma is up for pre-order", "preorder", title, 200), "does not name Amazon");
  assert.equal(validateCuratedLead("A great JRPG is on Amazon", "sale", title, 200), "does not name the product");
  assert.equal(validateCuratedLead("Terranigma on Amazon #rpg", "sale", title, 200), "link, hashtag, or mention");
  assert.equal(validateCuratedLead("Hurry, Terranigma on Amazon", "sale", title, 200), "hype");
  assert.equal(validateCuratedLead("Terranigma on Amazon", "sale", title, 5), "too long");
});

test("curatedLeadBudget leaves room for the appended tail", () => {
  const budget = curatedLeadBudget("Wario64", "sale", 300);
  const lead = "x".repeat(budget);
  assert.ok(composeCuratedDeal({ lead, kind: "sale", sourceLabel: "Wario64", linkUrl: LINK, maxLength: 300 }));
  assert.equal(
    composeCuratedDeal({ lead: `${lead}xx`, kind: "sale", sourceLabel: "Wario64", linkUrl: LINK, maxLength: 300 }),
    null,
  );
});

test("hasPriceClaim", () => {
  for (const claim of ["$12.49", "US$5", "20% off", "30 percent", "15 dollars", "half off", "save $10"]) {
    assert.equal(hasPriceClaim(`Widget ${claim}`), true, claim);
  }
  for (const clean of ["Samsung 990 Pro 2TB", "Switch 2", "30 Count", "4K UHD", "Kirby 30th Anniversary"]) {
    assert.equal(hasPriceClaim(clean), false, clean);
  }
});

test("curator URLs and labels", () => {
  assert.equal(curatorProfileHandle("https://bsky.app/profile/Wario64.bsky.social/"), "wario64.bsky.social");
  assert.equal(curatorProfileHandle("https://bsky.app/profile/did:plc:knj5sw5al3sukl6vhkpi7637"), "did:plc:knj5sw5al3sukl6vhkpi7637");
  assert.equal(curatorProfileHandle("https://bsky.app/profile/wario64.bsky.social/post/abc"), null);
  assert.equal(curatorProfileHandle("https://slickdeals.net/rss"), null);
  assert.equal(canonicalCuratorUrl("http://www.bsky.app/profile/wario64.bsky.social"), "https://bsky.app/profile/wario64.bsky.social");
  assert.equal(curatorLabel("Wario64 (Bluesky)"), "Wario64");
  assert.equal(curatorLabel("Wario64"), "Wario64");
});
