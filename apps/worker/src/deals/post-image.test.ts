import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogItem } from "../creators-api.js";
import { chooseListingImage, imageSize } from "./post-image.js";

const item = (over: Partial<CatalogItem>): CatalogItem => ({
  asin: "B0TEST0001",
  priceCents: null,
  savingsCents: null,
  wasPriceCents: null,
  title: "Saros - PlayStation 5",
  imageUrl: "https://m.media-amazon.com/images/I/abc._SL500_.jpg",
  available: true,
  currency: "USD",
  reviewCount: null,
  reviewRating: null,
  ...over,
});
const listing = { asin: "B0TEST0001", title: "SAROS (PS5)" };

test("the catalog image for the same ASIN and product is used", () => {
  assert.deepEqual(chooseListingImage(listing, item({})), {
    imageUrl: "https://m.media-amazon.com/images/I/abc._SL500_.jpg",
  });
});

test("no catalog row, another ASIN, or no image → no photo", () => {
  assert.ok("skip" in chooseListingImage(listing, undefined));
  assert.ok("skip" in chooseListingImage(listing, item({ asin: "B0OTHER0002" })));
  assert.ok("skip" in chooseListingImage(listing, item({ imageUrl: null })));
});

test("an ASIN whose Amazon title is a different product → no photo", () => {
  assert.ok("skip" in chooseListingImage(listing, item({ title: "Anker USB-C Charger 65W" })));
  assert.ok("skip" in chooseListingImage(listing, item({ title: null })));
});

test("an accessory riding the product's name → no photo", () => {
  const choice = chooseListingImage(
    { asin: "B0TEST0001", title: "Steam Deck OLED 1TB" },
    item({ title: "Steam Deck OLED Carrying Case Protective Cover" }),
  );
  assert.ok("skip" in choice);
});

test("imageSize reads PNG and JPEG headers", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  png.set([0, 0, 0x01, 0xf4, 0, 0, 0x01, 0x77], 16); // 500 x 375
  assert.deepEqual(imageSize(png), { width: 500, height: 375 });

  const jpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x77, 0x01, 0xf4, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, // SOF0 375 x 500
  ]);
  assert.deepEqual(imageSize(jpeg), { width: 500, height: 375 });

  assert.equal(imageSize(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(imageSize(new Uint8Array(0)), null);
});
