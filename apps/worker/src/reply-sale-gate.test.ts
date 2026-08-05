import assert from "node:assert/strict";
import { test } from "node:test";
import { composeReplyPriceSuffix } from "@trendcart/shared";
import { validateReply } from "./validate.js";

/**
 * The sale gate itself lives inside chooseLink (DB + network bound), so these
 * cover the two things that can silently break a priced reply: the decision
 * table, and whether the composed text survives the reply validator.
 */

const MIN_SAVING = 10;

/** Mirror of the chooseLink decision — kept in sync deliberately. */
function shouldReply(input: {
  savingPercent: number | null; // null = Amazon didn't tell us
  posterNamedProduct: boolean | null;
  requireSale: boolean;
}): boolean {
  if (input.savingPercent === null) return true; // fail-open: no price data
  if (!input.requireSale) return true;
  const onSale = input.savingPercent >= MIN_SAVING;
  const botIdentifiedIt = input.posterNamedProduct === false;
  return onSale || botIdentifiedIt;
}

test("author named the product: replies only when genuinely discounted", () => {
  const named = { posterNamedProduct: true, requireSale: true };
  assert.equal(shouldReply({ ...named, savingPercent: 30 }), true, "30% off → reply");
  assert.equal(shouldReply({ ...named, savingPercent: 10 }), true, "at the floor → reply");
  assert.equal(shouldReply({ ...named, savingPercent: 4 }), false, "trivial markdown → silent");
  assert.equal(shouldReply({ ...named, savingPercent: 0 }), false, "full price → silent");
});

test("bot identified the product: replies at any price", () => {
  const identified = { posterNamedProduct: false, requireSale: true };
  assert.equal(shouldReply({ ...identified, savingPercent: 0 }), true, "the figure case");
  assert.equal(shouldReply({ ...identified, savingPercent: 45 }), true);
});

test("unknown provenance is treated as author-named (the strict side)", () => {
  assert.equal(
    shouldReply({ savingPercent: 0, posterNamedProduct: null, requireSale: true }),
    false,
  );
});

test("no price data fails OPEN — a dark Amazon API must not silence the bot", () => {
  for (const posterNamedProduct of [true, false, null]) {
    assert.equal(
      shouldReply({ savingPercent: null, posterNamedProduct, requireSale: true }),
      true,
      `posterNamedProduct=${posterNamedProduct}`,
    );
  }
});

test("priced reply text still passes the reply validator", () => {
  const anchor = "Sono Bisque Doll Kitagawa on Amazon";
  const suffix = composeReplyPriceSuffix({
    priceCents: 4299,
    wasPriceCents: 5999,
    priceAsOf: new Date("2026-08-05T02:12:00Z"),
  });
  const body = "That lighting really brings out the sculpt — the Taito Coreful figure has great detail.";
  const text = `${body} ${anchor}${suffix}`;

  const result = validateReply(text, anchor, 240);
  assert.ok(result.ok, `expected valid, got: ${result.ok ? "" : result.reason}`);
  // The two ways a price suffix could break the reply contract:
  assert.equal(text.split(anchor).length - 1, 1, "anchor must appear exactly once");
  assert.ok(!text.includes("#"), "no hashtag — the validator bans them outright");
});

test("price suffix is budgeted so a full-length reply still fits", () => {
  const anchor = "Sono Bisque Doll Kitagawa on Amazon";
  const suffix = composeReplyPriceSuffix({
    priceCents: 4299,
    wasPriceCents: 5999,
    priceAsOf: new Date("2026-08-05T02:12:00Z"),
  });
  const reserved = anchor.length + 1 + suffix.length;
  const body = "x".repeat(240 - reserved);
  const text = `${body} ${anchor}${suffix}`;
  assert.equal(text.length, 240);
  assert.ok(validateReply(text, anchor, 240).ok, "exactly at budget must validate");
});
