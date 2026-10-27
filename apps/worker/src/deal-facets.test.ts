import assert from "node:assert/strict";
import { test } from "node:test";
import { hashtagSpans } from "@trendcart/shared";
import { buildFacets } from "./deals/poster.js";

test("every hashtag gets a tag facet, not just #ad", () => {
  const text = "Samsung's 512GB microSD Express card is on sale on Amazon #NintendoSwitch2 #Switch2 #ad";
  const facets = buildFacets(text, "https://www.amazon.com/dp/B0FT995SPF?tag=x-20", "on Amazon");
  const tags = facets.flatMap((f) => f.features).filter((f) => f.$type === "app.bsky.richtext.facet#tag");
  assert.deepEqual(tags.map((f) => (f as { tag: string }).tag), ["NintendoSwitch2", "Switch2", "ad"]);
  const link = facets.find((f) => f.features[0]?.$type === "app.bsky.richtext.facet#link")!;
  // ASCII-only text: byte offsets equal char offsets.
  assert.equal(text.slice(link.index.byteStart, link.index.byteEnd), "on Amazon");
});

test("byte offsets survive multibyte text before a tag", () => {
  const text = "Pokémon Legends Z-A — on sale on Amazon #Switch2 #ad";
  const facets = buildFacets(text, "https://www.amazon.com/dp/B000000000?tag=x-20", "on Amazon");
  const bytes = new TextEncoder().encode(text);
  const switch2 = facets.find((f) => (f.features[0] as { tag?: string }).tag === "Switch2")!;
  assert.equal(new TextDecoder().decode(bytes.slice(switch2.index.byteStart, switch2.index.byteEnd)), "#Switch2");
});

test("prices, numbers and mid-word # are not hashtags", () => {
  assert.deepEqual(hashtagSpans("$99 is #1 and C#sharp #ad").map((s) => s.tag), ["ad"]);
});
