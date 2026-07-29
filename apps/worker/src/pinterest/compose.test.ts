import assert from "node:assert/strict";
import { test } from "node:test";
import { composePinCopy } from "./compose.js";

test("priced pin carries price, was-price, #ad, and the Associates line", () => {
  const copy = composePinCopy({
    title: "8BitDo Ultimate Controller",
    salePriceCents: 4_999,
    wasPriceCents: 6_999,
    currency: "USD",
    priceFree: false,
  });
  assert.equal(copy.title, "8BitDo Ultimate Controller");
  assert.match(copy.description, /^#ad /);
  assert.match(copy.description, /\$49\.99 \(was \$69\.99\) when pinned/);
  assert.match(copy.description, /Amazon Associate/);
  assert.match(copy.description, /may have changed/);
});

test("price-free pin never mentions a number", () => {
  const copy = composePinCopy({
    title: "Anker USB-C Hub",
    salePriceCents: 0,
    wasPriceCents: null,
    currency: "USD",
    priceFree: true,
  });
  assert.doesNotMatch(copy.description, /\$/);
  assert.match(copy.description, /^#ad /);
});

test("limits hold for absurd titles and disclosure survives truncation", () => {
  const copy = composePinCopy({
    title: "X".repeat(500),
    salePriceCents: 1_299,
    wasPriceCents: null,
    currency: "USD",
    priceFree: false,
  });
  assert.ok(copy.title.length <= 100, `title ${copy.title.length} > 100`);
  assert.ok(copy.description.length <= 800, `description ${copy.description.length} > 800`);
  assert.ok(copy.altText.length <= 500, `altText ${copy.altText.length} > 500`);
  assert.match(copy.description, /^#ad /);
  assert.match(copy.description, /Amazon Associate/);
});
