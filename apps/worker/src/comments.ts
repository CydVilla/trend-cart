import { config } from "./config.js";

/**
 * Fetch the top replies under a post as untrusted conversation context.
 *
 * Uses the PUBLIC AppView (no auth, no cost, no rate impact on the bot's own
 * session) — the same channel evaluate.ts already uses for author profiles.
 * Returns the highest-liked, non-trivial reply texts so the classifier and the
 * reply generator can see what people are actually saying about the post
 * ("is this on Switch?" / "the physical edition is great"). Best-effort: any
 * failure or a disabled flag yields [], and enrichment never blocks a decision.
 */
const GETTHREAD_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread";

type ThreadReply = {
  post?: { record?: { text?: string }; likeCount?: number };
};

export async function fetchTopComments(uri: string): Promise<string[]> {
  if (!config.comments.enabled) return [];
  try {
    const url = new URL(GETTHREAD_URL);
    url.searchParams.set("uri", uri);
    url.searchParams.set("depth", "1"); // direct replies only
    url.searchParams.set("parentHeight", "0");
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { thread?: { replies?: ThreadReply[] } };
    const replies = data.thread?.replies ?? [];
    return replies
      .map((r) => ({
        text: (r.post?.record?.text ?? "").replace(/\s+/g, " ").trim(),
        likes: r.post?.likeCount ?? 0,
      }))
      .filter((r) => r.text.length >= config.comments.minLength)
      .sort((a, b) => b.likes - a.likes)
      .slice(0, config.comments.max)
      .map((r) => r.text.slice(0, 200)); // cap each so the prompt stays bounded
  } catch {
    return []; // enrichment is best-effort, never blocks evaluation or reply
  }
}
