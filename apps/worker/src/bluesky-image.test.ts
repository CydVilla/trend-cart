import assert from "node:assert/strict";
import { test } from "node:test";
import { attachImageToPost, BLUESKY_MAX_IMAGE_BYTES, parsePostUri } from "@trendcart/shared";

const DID = "did:plc:bot";
const URI = `at://${DID}/app.bsky.feed.post/3kabc`;
const POST = {
  $type: "app.bsky.feed.post",
  text: "Saros is on sale on Amazon #ad",
  facets: [{ index: { byteStart: 17, byteEnd: 26 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://x/r/1" }] }],
  createdAt: "2026-11-11T14:22:00.000Z",
};

type Call = { method: string; httpMethod: string; body: unknown; headers: Record<string, string> };

function fakeBluesky(over: { record?: Record<string, unknown>; did?: string; putStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    const method = url.pathname.replace("/xrpc/", "");
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, httpMethod: init.method ?? "GET", body, headers });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    switch (method) {
      case "com.atproto.server.createSession":
        return json(200, { accessJwt: "jwt", did: over.did ?? DID });
      case "com.atproto.repo.getRecord":
        return json(200, { uri: URI, cid: "cid-1", value: over.record ?? POST });
      case "com.atproto.repo.uploadBlob":
        return json(200, { blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/jpeg", size: 3 } });
      case "com.atproto.repo.putRecord":
        return json(over.putStatus ?? 200, over.putStatus ? { message: "Record was at cid-2" } : { uri: URI, cid: "cid-2" });
      default:
        return json(404, {});
    }
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const input = (fetchImpl: typeof fetch) => ({
  handle: "bot.bsky.social",
  appPassword: "pw",
  postUri: URI,
  image: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", width: 1200, height: 800 },
  alt: "Saros (PS5)",
  fetchImpl,
});

test("parsePostUri accepts only feed-post URIs", () => {
  assert.deepEqual(parsePostUri(URI), { repo: DID, rkey: "3kabc" });
  assert.equal(parsePostUri("at://did:plc:bot/app.bsky.feed.like/3k"), null);
  assert.equal(parsePostUri("https://bsky.app/profile/x/post/3k"), null);
});

test("adds the image and leaves text, link and date untouched", async () => {
  const { calls, fetchImpl } = fakeBluesky();
  assert.deepEqual(await attachImageToPost(input(fetchImpl)), { ok: true });
  assert.deepEqual(
    calls.map((c) => c.method),
    [
      "com.atproto.server.createSession",
      "com.atproto.repo.getRecord",
      "com.atproto.repo.uploadBlob",
      "com.atproto.repo.putRecord",
    ],
  );
  assert.equal(calls[2]!.headers["content-type"], "image/jpeg");
  const put = calls[3]!.body as { swapRecord: string; rkey: string; record: Record<string, unknown> };
  assert.equal(put.swapRecord, "cid-1");
  assert.equal(put.rkey, "3kabc");
  assert.equal(put.record.text, POST.text);
  assert.deepEqual(put.record.facets, POST.facets);
  assert.equal(put.record.createdAt, POST.createdAt);
  const embed = put.record.embed as { $type: string; images: Array<Record<string, unknown>> };
  assert.equal(embed.$type, "app.bsky.embed.images");
  assert.equal(embed.images.length, 1);
  assert.equal(embed.images[0]!.alt, "Saros (PS5)");
  assert.deepEqual(embed.images[0]!.aspectRatio, { width: 1200, height: 800 });
});

test("an existing image is replaced; a link card or quote is refused", async () => {
  const withImage = fakeBluesky({ record: { ...POST, embed: { $type: "app.bsky.embed.images", images: [] } } });
  assert.deepEqual(await attachImageToPost(input(withImage.fetchImpl)), { ok: true });

  const withCard = fakeBluesky({ record: { ...POST, embed: { $type: "app.bsky.embed.external" } } });
  const result = await attachImageToPost(input(withCard.fetchImpl));
  assert.equal(result.ok, false);
  assert.ok(!withCard.calls.some((c) => c.method === "com.atproto.repo.putRecord"));
  assert.ok(!withCard.calls.some((c) => c.method === "com.atproto.repo.uploadBlob"));
});

test("refuses another account's post, bad files, and reports a lost race", async () => {
  const other = fakeBluesky({ did: "did:plc:someone-else" });
  assert.equal((await attachImageToPost(input(other.fetchImpl))).ok, false);
  assert.equal(other.calls.length, 1); // login only — nothing read or written

  const none = fakeBluesky();
  const big = { ...input(none.fetchImpl), image: { bytes: new Uint8Array(BLUESKY_MAX_IMAGE_BYTES + 1), mimeType: "image/png" } };
  assert.equal((await attachImageToPost(big)).ok, false);
  const pdf = { ...input(none.fetchImpl), image: { bytes: new Uint8Array([1]), mimeType: "application/pdf" } };
  assert.equal((await attachImageToPost(pdf)).ok, false);
  assert.equal(none.calls.length, 0);

  const raced = fakeBluesky({ putStatus: 400 });
  const lost = await attachImageToPost(input(raced.fetchImpl));
  assert.ok(!lost.ok && /updating the post failed/.test(lost.error));
});
