import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectAssociatesReport,
  parseAssociatesReport,
  parseTrackingSummaryReport,
  parseDelimited,
  parseMoneyCents,
  parseReportDate,
  type ParsedAssociatesReport,
} from "@trendcart/shared";

/**
 * The Associates CSVs are the only sales data we get, and their format is
 * undocumented and drifts. These fixtures follow the real downloads' shape
 * (title preamble, "($)" money headers, Tag vs Tracking ID) — the parser must
 * find columns by name and never misread a row silently.
 */

function ok(text: string): ParsedAssociatesReport {
  const parsed = parseAssociatesReport(text);
  if ("error" in parsed) assert.fail(parsed.error);
  return parsed;
}

const ORDERS_CSV = [
  "Fee-Orders reports from 10-01-2026 to 10-07-2026",
  "Category,Name,ASIN,Date,Qty,Price($),Link Type,Tag,Indirect Sales,Device Type Group",
  'Video Games,"Xenoblade Chronicles X: Definitive Edition, Switch",B0DTESTX01,2026-10-03 14:22:10,1,59.99,Text+Image,villa-curated-20,N,DESKTOP',
  'Video Games,"Xenoblade Chronicles X: Definitive Edition, Switch",B0DTESTX01,2026-10-03 21:05:44,2,"1,059.99",Text+Image,villa-curated-20,N,PHONE',
  "Toys,LEGO Botanicals Orchid,B0LEGO0001,2026-10-04 09:00:00,1,39.99,Text,villa-reply-20,Y,PHONE",
  "Total,,,,4,,,,,",
  "",
].join("\r\n");

test("orders report: preamble skipped, rows aggregated per day × tag × ASIN", () => {
  const r = ok(ORDERS_CSV);
  assert.equal(r.kind, "ORDERS");
  assert.deepEqual(r.range, { from: "2026-10-01", to: "2026-10-07" });
  assert.equal(r.skipped, 0);
  assert.equal(r.lines.length, 2);
  const [xeno, lego] = r.lines;
  assert.deepEqual(
    { day: xeno!.day, tag: xeno!.trackingId, asin: xeno!.asin, items: xeno!.items, sales: xeno!.salesCents },
    // 1 × 59.99 + 2 × 1,059.99 — unit price × qty, quoted thousands separator
    { day: "2026-10-03", tag: "villa-curated-20", asin: "B0DTESTX01", items: 3, sales: 5999 + 211998 },
  );
  assert.equal(xeno!.title, "Xenoblade Chronicles X: Definitive Edition, Switch");
  assert.equal(xeno!.indirectItems, 0);
  assert.equal(lego!.indirectItems, 1);
  assert.equal(lego!.feeCents, 0);
});

const EARNINGS_TSV = [
  "Fee-Earnings reports from 2026-10-01 to 2026-10-07",
  ["Category", "Name", "ASIN", "Seller", "Tracking ID", "Date Shipped", "Price($)", "Items Shipped", "Returns", "Revenue($)", "Ad Fees($)", "Device Type Group", "Direct"].join("\t"),
  ["Video Games", "Xenoblade X", "B0DTESTX01", "Amazon.com", "villa-curated-20", "October 5, 2026", "59.99", "2", "1", "119.98", "2.40", "PHONE", "Y"].join("\t"),
  ["Kitchen", "Some Halo Item", "B0HALO0001", "Third Party", "villa-curated-20", "10/06/2026", "12.00", "1", "0", "12.00", "0.36", "PHONE", "N"].join("\t"),
].join("\n");

test("earnings report (TSV): ship date, revenue total, ad fees, returns, direct flag", () => {
  const r = ok(EARNINGS_TSV);
  assert.equal(r.kind, "EARNINGS");
  assert.equal(r.lines.length, 2);
  const [xeno, halo] = r.lines;
  assert.equal(xeno!.day, "2026-10-05");
  assert.equal(xeno!.items, 2);
  assert.equal(xeno!.returns, 1);
  assert.equal(xeno!.salesCents, 11998);
  assert.equal(xeno!.feeCents, 240);
  assert.equal(xeno!.indirectItems, 0);
  assert.equal(halo!.day, "2026-10-06");
  assert.equal(halo!.indirectItems, 1);
});

test("no preamble: range comes from the rows themselves", () => {
  const r = ok(
    "ASIN,Name,Tag,Date,Qty,Price\nB0LEGO0001,Orchid,villa-reply-20,2026-10-09,1,39.99\nB0LEGO0001,Orchid,villa-reply-20,2026-10-02,1,39.99\n",
  );
  assert.deepEqual(r.range, { from: "2026-10-02", to: "2026-10-09" });
  assert.deepEqual(r.lines.map((l) => l.day), ["2026-10-02", "2026-10-09"]);
});

test("bad rows are skipped and reported, never half-read", () => {
  const r = ok(
    [
      "ASIN,Name,Tag,Date,Qty,Price",
      "B0LEGO0001,Orchid,villa-reply-20,2026-10-02,1,39.99",
      "not-an-asin,Bad,villa-reply-20,2026-10-02,1,1.00",
      "B0LEGO0002,No tag,,2026-10-02,1,1.00",
      "B0LEGO0003,Bad date,villa-reply-20,someday,1,1.00",
      "B0LEGO0004,Bad qty,villa-reply-20,2026-10-02,one,1.00",
    ].join("\n"),
  );
  assert.equal(r.lines.length, 1);
  assert.equal(r.skipped, 4);
  assert.equal(r.warnings.length, 4);
  assert.match(r.warnings[0]!, /line 3: bad ASIN/);
});

test("the wrong file is an error, not an empty import", () => {
  const summary = parseAssociatesReport("Date,Clicks,Ordered Items,Conversion\n2026-10-01,120,3,2.5%\n");
  assert.ok("error" in summary);
  const allBad = parseAssociatesReport("ASIN,Tag,Date,Qty,Price\nxx,t,2026-10-01,1,1\n");
  assert.ok("error" in allBad && /no readable rows/.test(allBad.error));
});

test("a UTF-8 BOM before the header is ignored", () => {
  const r = ok("\uFEFFASIN,Tag,Date,Qty,Price\nB0LEGO0001,villa-reply-20,2026-10-02,1,39.99\n");
  assert.equal(r.lines.length, 1);
});

test("date formats Amazon has used", () => {
  assert.equal(parseReportDate("2026-10-03"), "2026-10-03");
  assert.equal(parseReportDate("2026-10-03 23:59:59"), "2026-10-03");
  assert.equal(parseReportDate("10/03/2026"), "2026-10-03");
  assert.equal(parseReportDate("10-03-2026"), "2026-10-03");
  assert.equal(parseReportDate("October 3, 2026"), "2026-10-03");
  assert.equal(parseReportDate("Oct 3 2026"), "2026-10-03");
  assert.equal(parseReportDate("3 Oct 2026"), "2026-10-03");
  assert.equal(parseReportDate("02/30/2026"), null);
  assert.equal(parseReportDate("yesterday"), null);
});

test("money: currency marks, thousands, negatives, blanks", () => {
  assert.equal(parseMoneyCents("$1,299.99"), 129999);
  assert.equal(parseMoneyCents("-4.50"), -450);
  assert.equal(parseMoneyCents("(4.50)"), -450);
  assert.equal(parseMoneyCents(""), 0);
  assert.equal(parseMoneyCents("0.1"), 10);
  assert.equal(parseMoneyCents("n/a"), null);
});

test("quoted fields keep delimiters, escaped quotes and newlines", () => {
  assert.deepEqual(parseDelimited('a,"b,c","say ""hi""","two\nlines"\r\nx,y', ","), [
    ["a", "b,c", 'say "hi"', "two\nlines"],
    ["x", "y"],
  ]);
});

// ── Summary reports (shape of the real 2026-11-04 downloads) ──

const TRACKING_SUMMARY_CSV = [
  "Tracking Id,Clicks,Items Ordered,Ordered Revenue,Items Shipped,Items Returned,Items Shipped Revenue,Items Returned Revenue,Total Earnings,Bonus,Items Shipped Earnings,Items Returned Earnings",
  "villa03b-20,1261.0,-,-,-,-,-,-,-,0.0,-,-",
  "Other,0.0,4.0,93.28,3.0,0.0,63.449999999999996,0.0,2.13,0.0,2.13,0.0",
  "",
].join("\n");

const PRODUCT_SUMMARY_CSV = [
  "Date,Category,Product Title,ASIN,Clicks,Indirect Items Ordered,Direct Items Ordered,Items Ordered,Direct Conversion Rate,Order Quantity,Product Conversion Rate,Order Conversion Rate,Commission Rate,Ordered Revenue,Items Shipped,Items Returned,Items Shipped Revenue,Items Shipped Earnings,Items Returned Revenue,Items Returned Earnings,Total Earnings",
  "11-04-2026,-,-,None,438.0,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-",
].join("\n");

const CATEGORY_SUMMARY_CSV = [
  "Date,Category,Clicks,Indirect Items Ordered,Direct Items Ordered,Items Ordered,Direct Conversion Rate,Order Quantity,Product Conversion Rate,Order Conversion Rate,Commission Rate,Ordered Revenue,Items Shipped,Items Returned,Items Shipped Revenue,Items Shipped Earnings,Items Returned Revenue,Items Returned Earnings,Bonus,Total Earnings",
  "11-04-2026,Video Games,354.0,-,-,-,-,-,-,-,-,-,-,-,-,-,-,-,0.0,-",
].join("\n");

test("detect: summaries vs detail reports", () => {
  assert.equal(detectAssociatesReport(TRACKING_SUMMARY_CSV), "tracking_summary");
  assert.equal(detectAssociatesReport(PRODUCT_SUMMARY_CSV), "product_summary");
  assert.equal(detectAssociatesReport(CATEGORY_SUMMARY_CSV), "category_summary");
  assert.equal(detectAssociatesReport(ORDERS_CSV), "detail");
  assert.equal(detectAssociatesReport(EARNINGS_TSV), "detail");
  assert.equal(detectAssociatesReport("hello,world\n1,2"), null);
});

test("tracking summary: float counts, '-' as zero, float-noise money rounded", () => {
  const r = parseTrackingSummaryReport(TRACKING_SUMMARY_CSV, { from: "2026-10-06", to: "2026-11-04" });
  if ("error" in r) assert.fail(r.error);
  assert.deepEqual(r.range, { from: "2026-10-06", to: "2026-11-04" });
  assert.deepEqual(r.lines, [
    {
      trackingId: "villa03b-20",
      clicks: 1261,
      orderedItems: 0,
      orderedSalesCents: 0,
      shippedItems: 0,
      returnedItems: 0,
      shippedSalesCents: 0,
      earningsCents: 0,
      bonusCents: 0,
    },
    {
      trackingId: "Other",
      clicks: 0,
      orderedItems: 4,
      orderedSalesCents: 9328,
      shippedItems: 3,
      returnedItems: 0,
      shippedSalesCents: 6345,
      earningsCents: 213,
      bonusCents: 0,
    },
  ]);
});

test("tracking summary: unreadable cell fails the whole file, never a silent drop", () => {
  const bad = TRACKING_SUMMARY_CSV.replace("1261.0", "12.5");
  const r = parseTrackingSummaryReport(bad, { from: "2026-10-06", to: "2026-11-04" });
  assert.ok("error" in r && /clicks/.test(r.error));
  const backwards = parseTrackingSummaryReport(TRACKING_SUMMARY_CSV, { from: "2026-11-04", to: "2026-10-06" });
  assert.ok("error" in backwards);
});

test("orders/earnings parser still refuses summaries", () => {
  assert.ok("error" in parseAssociatesReport(TRACKING_SUMMARY_CSV));
  assert.ok("error" in parseAssociatesReport(PRODUCT_SUMMARY_CSV));
});
