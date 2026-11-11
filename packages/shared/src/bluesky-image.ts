/**
 * Attach an operator-chosen image to a post the bot has ALREADY published.
 *
 * Bluesky has no edit button, but a post is a record in the account's repo
 * and `putRecord` can rewrite it in place: same URL, same likes and reposts.
 * We only ever ADD an image embed — text, facets (the affiliate link) and
 * createdAt are carried over untouched. A post that already has a link card
 * or quote is refused rather than overwritten.
 *
 * Plain XRPC over fetch, so the dashboard needs no Bluesky SDK.
 */

/** Bluesky's uploadBlob cap for images. */
export const BLUESKY_MAX_IMAGE_BYTES = 976_560;
export const BLUESKY_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const IMAGES_EMBED = "app.bsky.embed.images";

export type AttachImageInput = {
  handle: string;
  appPassword: string;
  /** at://did/app.bsky.feed.post/rkey of the post to update. */
  postUri: string;
  image: { bytes: Uint8Array; mimeType: string; width?: number | null; height?: number | null };
  alt: string;
  service?: string;
  fetchImpl?: typeof fetch;
};

export type AttachImageResult = { ok: true } | { ok: false; error: string };

type Json = Record<string, unknown>;
const rec = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});

export function parsePostUri(uri: string): { repo: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/);
  return match ? { repo: match[1]!, rkey: match[2]! } : null;
}

export async function attachImageToPost(input: AttachImageInput): Promise<AttachImageResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const service = (input.service ?? "https://bsky.social").replace(/\/$/, "");
  const fail = (error: string): AttachImageResult => ({ ok: false, error });

  const target = parsePostUri(input.postUri);
  if (!target) return fail("not a Bluesky post URI");
  const { bytes, mimeType } = input.image;
  if (!BLUESKY_IMAGE_TYPES.includes(mimeType)) return fail("image must be a JPEG, PNG or WebP");
  if (bytes.byteLength === 0) return fail("image is empty");
  if (bytes.byteLength > BLUESKY_MAX_IMAGE_BYTES) return fail("image is over Bluesky's 976 KB limit");

  const call = async (
    method: string,
    init: { token?: string; json?: unknown; body?: Uint8Array; contentType?: string; query?: Record<string, string> },
  ): Promise<{ status: number; data: Json }> => {
    const url = new URL(`${service}/xrpc/${method}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const isPost = init.json !== undefined || init.body !== undefined;
    const response = await fetchImpl(url, {
      method: isPost ? "POST" : "GET",
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : (init.body as NonNullable<Parameters<typeof fetch>[1]>["body"]),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, data: rec(await response.json().catch(() => ({}))) };
  };
  const why = (step: string, r: { status: number; data: Json }): AttachImageResult =>
    fail(`${step} failed (HTTP ${r.status}${r.data.message ? `: ${String(r.data.message).slice(0, 160)}` : ""})`);

  try {
    const session = await call("com.atproto.server.createSession", {
      json: { identifier: input.handle, password: input.appPassword },
    });
    const token = String(session.data.accessJwt ?? "");
    const did = String(session.data.did ?? "");
    if (session.status !== 200 || !token || !did) return why("Bluesky login", session);
    // Only ever rewrite the bot's own posts.
    if (target.repo !== did) return fail("post does not belong to the bot account");

    const record = { repo: did, collection: "app.bsky.feed.post", rkey: target.rkey };
    const current = await call("com.atproto.repo.getRecord", { token, query: record });
    const value = rec(current.data.value);
    const cid = String(current.data.cid ?? "");
    if (current.status !== 200 || !cid || typeof value.text !== "string") return why("reading the post", current);
    const existing = rec(value.embed).$type;
    if (existing && existing !== IMAGES_EMBED) {
      return fail("post already has a link card or quote; an image can't be added to it");
    }

    const upload = await call("com.atproto.repo.uploadBlob", {
      token,
      body: bytes,
      contentType: mimeType,
    });
    if (upload.status !== 200 || !upload.data.blob) return why("image upload", upload);

    const { width, height } = input.image;
    const aspectRatio =
      width && height && width > 0 && height > 0
        ? { width: Math.round(width), height: Math.round(height) }
        : null;
    const put = await call("com.atproto.repo.putRecord", {
      token,
      json: {
        ...record,
        // Fails instead of clobbering if the post changed since we read it.
        swapRecord: cid,
        record: {
          ...value,
          embed: {
            $type: IMAGES_EMBED,
            images: [
              {
                image: upload.data.blob,
                alt: input.alt.slice(0, 1000),
                ...(aspectRatio ? { aspectRatio } : {}),
              },
            ],
          },
        },
      },
    });
    if (put.status !== 200) return why("updating the post", put);
    return { ok: true };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
