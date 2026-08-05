import assert from "node:assert/strict";
import { test } from "node:test";
import { productMatchConfidence } from "@trendcart/shared";

test("a real listing for the queried product scores high", () => {
  assert.ok(
    productMatchConfidence(
      "Sono Bisque Doll Kitagawa Marin Coreful Figure Veronica Taito",
      "Taito Sono Bisque Doll: That Time I Got Reincarnated - Kitagawa Marin - Coreful Figure - Veronica Ver.",
    ) >= 80,
  );
  assert.ok(
    productMatchConfidence(
      "hollow knight silksong nintendo switch",
      "Hollow Knight: Silksong - Nintendo Switch",
    ) >= 80,
  );
});

test("accessories riding the product's keywords are vetoed", () => {
  // The classic failure: searched a game, top hit is a sticker.
  const sticker = productMatchConfidence(
    "hollow knight silksong nintendo switch",
    "Hollow Knight Silksong Nintendo Switch Vinyl Skin Sticker Decal",
  );
  assert.ok(sticker <= 35, `expected accessory veto, got ${sticker}`);

  const phoneCase = productMatchConfidence(
    "steam deck oled 1tb",
    "Steam Deck OLED Carrying Case Protective Cover",
  );
  assert.ok(phoneCase <= 35, `expected accessory veto, got ${phoneCase}`);
});

test("an accessory the query ASKED for is not vetoed", () => {
  assert.ok(
    productMatchConfidence(
      "steam deck carrying case",
      "Steam Deck Carrying Case Hard Shell Travel Bag",
    ) >= 80,
  );
});

test("a wrong-product listing scores low on coverage", () => {
  assert.ok(
    productMatchConfidence(
      "hollow knight silksong nintendo switch",
      "Super Mario Odyssey - Nintendo Switch",
    ) < 60,
  );
});

test("no title cannot be verified, so it never counts as a match", () => {
  assert.equal(productMatchConfidence("anything at all", null), 0);
});

test("stopwords alone can't manufacture a match", () => {
  assert.equal(productMatchConfidence("the a of for", "Completely Unrelated Item"), 0);
});
