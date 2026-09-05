import assert from "node:assert/strict";
import { test } from "node:test";
import { amazonSearchUrl, searchAnchor } from "@trendcart/shared";

/**
 * searchAnchor moved into shared because the worker (drafting) and the
 * dashboard (regenerating against operator direction) both mint links now.
 * If they format anchors differently, a corrected link reads as a different
 * product than the one the reply names.
 */

test("anchor is trimmed to four words and always names Amazon", () => {
  assert.equal(searchAnchor("xenoblade chronicles 2"), "xenoblade chronicles 2 on Amazon");
  assert.equal(
    searchAnchor("the legend of zelda tears of the kingdom switch"),
    "the legend of zelda on Amazon",
  );
});

test("a very long single token is cut so the anchor can't eat the budget", () => {
  const anchor = searchAnchor("a".repeat(80));
  assert.ok(anchor.length <= 34 + " on Amazon".length, `anchor too long: ${anchor.length}`);
  assert.ok(anchor.endsWith(" on Amazon"));
});

test("the anchor appears exactly once in an assembled reply", () => {
  // Facet offsets are computed from lastIndexOf(anchor); a second occurrence
  // would point the clickable span at the wrong characters.
  const anchor = searchAnchor("hollow knight silksong");
  const reply = `Worth a look. ${anchor}`;
  assert.equal(reply.split(anchor).length - 1, 1);
});

test("a corrected query produces a different anchor AND a different URL", () => {
  // The regression this whole change exists for: correcting the text without
  // the link left the reader pointed at the wrong product.
  const wrong = "xenoblade chronicles 2 nintendo switch";
  const right = "xenoblade chronicles 3 nintendo switch";
  assert.notEqual(searchAnchor(wrong), searchAnchor(right));
  assert.notEqual(amazonSearchUrl(wrong, "villa03b-20"), amazonSearchUrl(right, "villa03b-20"));
  assert.ok(amazonSearchUrl(right, "villa03b-20").includes("tag=villa03b-20"));
});
