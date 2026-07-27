import assert from "node:assert/strict";
import test from "node:test";
import {
  dealVerdictPasses,
  routeIsAtLeastAsGood,
  routeVerdict,
  validateDealSearchEvidence,
  verdictDisproves,
  verdictPasses,
  type DealFactCheckVerdict,
  type FactCheckVerdict,
} from "./factcheck.js";

function dealVerdict(over: Partial<DealFactCheckVerdict>): DealFactCheckVerdict {
  return {
    accurate: true,
    exactProductMatch: true,
    orderableOnAmazon: true,
    amazonSaleConfirmed: true,
    confidence: 90,
    amazonProductEvidenceUrl: "https://www.amazon.com/dp/B01NAWKYZ0",
    saleEvidenceUrl: "https://slickdeals.net/f/1",
    saleEvidenceSummary: "",
    issues: [],
    summary: "",
    model: "test",
    checkedAt: "2026-07-24T00:00:00Z",
    evidenceUrls: [],
    saleEvidencePublishedAt: "2026-07-24T00:00:00Z",
    ...over,
  };
}

// Loose (corroboration) mode gates on existence + orderability only; strict
// additionally requires exact match + a confirmed Amazon sale.
test("dealVerdictPasses: loose passes an orderable item with no confirmed sale", () => {
  const noSale = dealVerdict({ amazonSaleConfirmed: false, exactProductMatch: false });
  assert.equal(dealVerdictPasses(noSale, false), true); // corroboration: orderable is enough
  assert.equal(dealVerdictPasses(noSale, true), false); // strict: needs the confirmed sale
});

test("dealVerdictPasses: loose still fails a dead/unorderable or inaccurate link", () => {
  assert.equal(dealVerdictPasses(dealVerdict({ orderableOnAmazon: false }), false), false);
  assert.equal(dealVerdictPasses(dealVerdict({ accurate: false }), false), false);
  assert.equal(dealVerdictPasses(dealVerdict({ confidence: 40 }), false), false);
  assert.equal(dealVerdictPasses(null, false), false);
});

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

// routeVerdict: the repair pass only ever exists between "flagged" and
// "queue" — it must never intercept a disproof or a pass.
test("routeVerdict: a self-approving reply that passes posts; a queue-bound one still queues", () => {
  const clean = verdict({ accurate: true, confidence: 90 });
  assert.equal(routeVerdict({ verdict: clean, selfApproved: true, repairsLeft: 1 }), "post");
  assert.equal(routeVerdict({ verdict: clean, selfApproved: false, repairsLeft: 1 }), "queue");
});

test("routeVerdict: disproof auto-rejects even with repair attempts left", () => {
  const disproved = verdict({ accurate: false, confidence: 90 });
  assert.equal(routeVerdict({ verdict: disproved, selfApproved: true, repairsLeft: 1 }), "reject");
  assert.equal(routeVerdict({ verdict: disproved, selfApproved: false, repairsLeft: 1 }), "reject");
});

test("routeVerdict: a flagged self-approving reply repairs, then queues once attempts run out", () => {
  const flagged = verdict({ accurate: false, confidence: 55 });
  assert.equal(routeVerdict({ verdict: flagged, selfApproved: true, repairsLeft: 1 }), "repair");
  assert.equal(routeVerdict({ verdict: flagged, selfApproved: true, repairsLeft: 0 }), "queue");
  // An errored/unverifiable check is repairable too — the findings say so.
  assert.equal(routeVerdict({ verdict: null, selfApproved: true, repairsLeft: 1 }), "repair");
  assert.equal(routeVerdict({ verdict: null, selfApproved: true, repairsLeft: 0 }), "queue");
});

test("routeVerdict: a queue-bound reply is never repaired (no rewrite can auto-approve it)", () => {
  const flagged = verdict({ accurate: false, confidence: 55 });
  assert.equal(routeVerdict({ verdict: flagged, selfApproved: false, repairsLeft: 1 }), "queue");
  assert.equal(routeVerdict({ verdict: null, selfApproved: false, repairsLeft: 9 }), "queue");
});

// The adoption rule: a rewrite may rescue a reply into posting, but must never
// turn one the operator would have reviewed into a silent auto-rejection.
test("routeIsAtLeastAsGood: a rewrite is adopted when it improves or holds, discarded when worse", () => {
  assert.equal(routeIsAtLeastAsGood("post", "queue"), true); // rescued → posts
  assert.equal(routeIsAtLeastAsGood("queue", "queue"), true); // still flagged → better text, same queue
  assert.equal(routeIsAtLeastAsGood("reject", "queue"), false); // worse → keep the original
  assert.equal(routeIsAtLeastAsGood("post", "reject"), true);
  assert.equal(routeIsAtLeastAsGood("queue", "post"), false);
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
