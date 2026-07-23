import assert from "node:assert/strict";
import test from "node:test";
import {
  validateDealSearchEvidence,
  verdictDisproves,
  verdictPasses,
  type FactCheckVerdict,
} from "./factcheck.js";

function verdict(over: Partial<FactCheckVerdict>): FactCheckVerdict {
  return {
    accurate: true,
    confidence: 90,
    issues: [],
    summary: "",
    model: "test",
    checkedAt: "2026-07-23T00:00:00Z",
    ...over,
  };
}

// Defaults: minConfidence 60, disproofConfidence 80. The three tiers must be
// cleanly separable — disproof is stricter than "does not pass".
test("verdictDisproves: confidently-inaccurate is disproof (auto-reject)", () => {
  assert.equal(verdictDisproves(verdict({ accurate: false, confidence: 90 })), true);
  assert.equal(verdictPasses(verdict({ accurate: false, confidence: 90 })), false);
});

test("verdictDisproves: inaccurate but low-confidence is NOT disproof (demote, don't reject)", () => {
  // Below the disproof floor → unverified, route to a human rather than kill.
  assert.equal(verdictDisproves(verdict({ accurate: false, confidence: 55 })), false);
  assert.equal(verdictDisproves(verdict({ accurate: false, confidence: 70 })), false);
  assert.equal(verdictPasses(verdict({ accurate: false, confidence: 70 })), false);
});

test("verdictDisproves: an accurate verdict never disproves, even at high confidence", () => {
  assert.equal(verdictDisproves(verdict({ accurate: true, confidence: 99 })), false);
  assert.equal(verdictPasses(verdict({ accurate: true, confidence: 99 })), true);
});

test("verdictDisproves: a null (errored/refused) check is unverified, not disproof", () => {
  assert.equal(verdictDisproves(null), false);
  assert.equal(verdictPasses(null), false);
});

const amazonUrl = "https://www.amazon.com/Nintendo-Switch-Controller/dp/B01NAWKYZ0";
const saleUrl = "https://slickdeals.net/f/123-switch-controller";
const checkedAt = new Date("2026-07-21T16:00:00Z");

function validate(overrides: Partial<Parameters<typeof validateDealSearchEvidence>[0]> = {}) {
  return validateDealSearchEvidence({
    amazonProductEvidenceUrl: amazonUrl,
    saleEvidenceUrl: saleUrl,
    evidenceResults: [
      { url: amazonUrl, pageAge: null },
      { url: saleUrl, pageAge: "2026-07-21T15:00:00Z" },
    ],
    asin: "B01NAWKYZ0",
    sourceUrl: saleUrl,
    publishedAt: new Date("2026-07-21T15:00:00Z"),
    maxEvidenceAgeHours: 6,
    checkedAt,
    ...overrides,
  });
}

test("accepts returned exact-ASIN evidence with a fresh trusted sale time", () => {
  const evidence = validate();
  assert.deepEqual(evidence, {
    evidenceUrls: [amazonUrl, saleUrl],
    saleEvidencePublishedAt: "2026-07-21T15:00:00.000Z",
  });
});

test("rejects model evidence URLs that were not returned by web search", () => {
  assert.equal(validate({ saleEvidenceUrl: "https://example.com/invented" }), null);
});

test("rejects the wrong Amazon ASIN and stale sale evidence", () => {
  assert.equal(validate({ asin: "B012345678" }), null);
  assert.equal(validate({ publishedAt: new Date("2026-07-21T09:00:00Z") }), null);
});
