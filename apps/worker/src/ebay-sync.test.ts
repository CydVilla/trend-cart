import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://unused";
const { fetchImpactConversions, parseImpactActions } = await import("./ebay-sync.js");

const action = (over: Record<string, unknown> = {}) => ({
  Id: "A1",
  CampaignId: "9356",
  State: "PENDING",
  Amount: "49.99",
  Payout: "1.5",
  Currency: "USD",
  EventDate: "2026-11-10T10:00:00-05:00",
  SubId1: "post123",
  SharedId: "",
  ...over,
});

test("maps an action to cents and collects sub-IDs", () => {
  const [row] = parseImpactActions({ Actions: [action()] }, "9356");
  assert.equal(row?.saleCents, 4999);
  assert.equal(row?.payoutCents, 150);
  assert.deepEqual(row?.subIds, ["post123"]);
  assert.equal(row?.eventAt.toISOString(), "2026-11-10T15:00:00.000Z");
});

test("drops other programs and unusable rows", () => {
  const rows = parseImpactActions(
    { Actions: [action({ CampaignId: "1" }), action({ Id: "" }), action({ EventDate: "nope" })] },
    "9356",
  );
  assert.equal(rows.length, 0);
});

test("a response without Actions is empty", () => {
  assert.deepEqual(parseImpactActions({}, "9356"), []);
  assert.deepEqual(parseImpactActions(null, "9356"), []);
});

const creds = { accountSid: "SID", authToken: "TOKEN", programId: "9356" };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

test("reads every page with basic auth", async () => {
  const calls: URL[] = [];
  let auth = "";
  const rows = await fetchImpactConversions(creds, new Date("2026-11-10T00:00:00Z"), (async (
    url: URL,
    init: RequestInit,
  ) => {
    calls.push(url);
    auth = (init.headers as Record<string, string>).authorization ?? "";
    return json({ "@numpages": "2", Actions: [action({ Id: `A${calls.length}` })] });
  }) as typeof fetch);
  assert.equal(calls.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ["A1", "A2"]);
  assert.equal(auth, `Basic ${Buffer.from("SID:TOKEN").toString("base64")}`);
  assert.equal(calls[0]?.searchParams.get("ActionDateEnd"), "2026-11-10T00:00:00Z");
});

test("a failure reports the status and no credentials", async () => {
  await assert.rejects(
    fetchImpactConversions(creds, new Date(), (async () => json({}, 401)) as typeof fetch),
    (error: Error) => error.message === "Impact Actions failed: HTTP 401",
  );
});
