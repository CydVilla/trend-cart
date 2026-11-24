import assert from "node:assert/strict";
import { test } from "node:test";
import { clickBotReason, EARLY_CLICK_WINDOW_MS } from "@trendcart/shared";

const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

function req(headers: Record<string, string>, method = "GET") {
  const h = new Headers(headers);
  return { method, headers: h };
}

const created = new Date("2026-11-24T12:00:00Z");
const later = new Date(created.getTime() + 10 * 60_000);

test("a real browser click after the early window counts as human", () => {
  assert.equal(clickBotReason(req({ "user-agent": SAFARI, "accept-language": "en-US,en;q=0.9" }), created, later), null);
});

test("HEAD, empty UA and bot UAs are bots", () => {
  assert.equal(clickBotReason(req({ "user-agent": SAFARI }, "HEAD"), created, later), "head");
  assert.equal(clickBotReason(req({ "accept-language": "en" }), created, later), "empty-ua");
  assert.equal(clickBotReason(req({ "user-agent": "Bluesky Cardyb/1.1", "accept-language": "en" }), created, later), "bot-ua");
  assert.equal(clickBotReason(req({ "user-agent": "node", "accept-language": "en" }), created, later), "bot-ua");
});

test("a browser UA without Accept-Language is a bot", () => {
  assert.equal(clickBotReason(req({ "user-agent": SAFARI }), created, later), "no-accept-language");
  assert.equal(clickBotReason(req({ "user-agent": SAFARI, "accept-language": " " }), created, later), "no-accept-language");
});

test("a click inside the early window is a bot, right after it is human", () => {
  const h = { "user-agent": SAFARI, "accept-language": "en-US" };
  const inside = new Date(created.getTime() + 2_000);
  const edge = new Date(created.getTime() + EARLY_CLICK_WINDOW_MS);
  assert.equal(clickBotReason(req(h), created, inside), "early");
  assert.equal(clickBotReason(req(h), created, edge), null);
});

test("no creation time skips the early check", () => {
  assert.equal(clickBotReason(req({ "user-agent": SAFARI, "accept-language": "en" }), null, created), null);
});
