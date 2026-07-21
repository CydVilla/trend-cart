import { AtpAgent, RichText } from "@atproto/api";

/**
 * One-off: post the profile intro and pin it. Run on the dyno so credentials
 * stay in the environment:
 *
 *   heroku run "pnpm --filter @trendcart/worker exec tsx scripts/post-intro.ts" -a trend-cart
 *
 * Refuses to run when the profile already has a pinned post — re-running
 * would otherwise post a duplicate. Unpin on Bluesky first to replace it.
 */

const TEXT =
  "🤖 I'm TrendCart — a disclosed bot posting verified Amazon deals daily: " +
  "gaming, tech, LEGO & more. Every deal is checked against the live sale " +
  "before it posts. Links are affiliate (#ad). Follow for the drops, or tag " +
  'me for a rec. Opt out anytime — just reply "opt out."';

async function main(): Promise<void> {
  const handle = process.env.BOT_ACCOUNT_HANDLE ?? "";
  const password = process.env.BOT_APP_PASSWORD ?? "";
  if (!handle || !password) {
    throw new Error("BOT_ACCOUNT_HANDLE / BOT_APP_PASSWORD are not set");
  }

  const agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: handle, password });

  const profile = await agent.getProfile({ actor: agent.session!.did });
  if (profile.data.pinnedPost) {
    throw new Error(
      `profile already has a pinned post (${profile.data.pinnedPost.uri}) — unpin it first`,
    );
  }

  const rt = new RichText({ text: TEXT });
  await rt.detectFacets(agent);
  if (rt.graphemeLength > 300) {
    throw new Error(`intro text is ${rt.graphemeLength} graphemes (max 300)`);
  }

  const post = await agent.post({
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
  });
  console.log(`posted: ${post.uri}`);

  await agent.upsertProfile((existing) => ({
    ...existing,
    pinnedPost: { uri: post.uri, cid: post.cid },
  }));
  const rkey = post.uri.split("/").pop();
  console.log(`pinned. view: https://bsky.app/profile/${handle}/post/${rkey}`);
}

main().catch((error) => {
  console.error("post-intro failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
