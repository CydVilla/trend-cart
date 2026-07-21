import assert from "node:assert/strict";
import test from "node:test";
import { validateDealSearchEvidence } from "./factcheck.js";

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
