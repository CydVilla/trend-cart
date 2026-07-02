import { AtpAgent, RichText } from "@atproto/api";
import { prisma, ReplyStatus } from "@trendcart/db";
import { config } from "./config.js";

const TICK_MS = 30_000;
const MAX_LOGIN_FAILURES = 3;

export type PosterStats = {
  posted: number;
  postFailed: number;
  disabled: boolean;
};

/**
 * Publishes APPROVED replies to Bluesky, one at a time, oldest first.
 * Hard rules:
 *  - never runs when DRY_RUN=true (the loop isn't even started)
 *  - needs BOT_ACCOUNT_HANDLE + BOT_APP_PASSWORD (app password, never the
 *    real account password)
 *  - keeps the global cooldown between actual posts even if many rows were
 *    approved at once in the dashboard
 *  - repeated login failures disable posting until restart (no hammering)
 */
export function startPostingLoop(stats: PosterStats): (() => void) | null {
  if (config.bot.dryRun) {
    console.log("  posting:          disabled (DRY_RUN=true)");
    return null;
  }
  if (!config.bluesky.handle || !config.bluesky.appPassword) {
    console.warn(
      "  posting:          disabled — set BOT_ACCOUNT_HANDLE and BOT_APP_PASSWORD to enable",
    );
    return null;
  }
  console.log(`  posting:          enabled as @${config.bluesky.handle}`);

  let agent: AtpAgent | null = null;
  let loginFailures = 0;
  let lastPostedAt = 0;
  let stopped = false;

  async function ensureAgent(): Promise<AtpAgent | null> {
    if (agent) return agent;
    const candidate = new AtpAgent({ service: "https://bsky.social" });
    try {
      await candidate.login({
        identifier: config.bluesky.handle,
        password: config.bluesky.appPassword,
      });
      loginFailures = 0;
      agent = candidate;
      return agent;
    } catch (error) {
      loginFailures += 1;
      console.error(
        `[poster] login failed (${loginFailures}/${MAX_LOGIN_FAILURES}):`,
        error instanceof Error ? error.message : error,
      );
      if (loginFailures >= MAX_LOGIN_FAILURES) {
        console.error("[poster] disabling posting until restart — check BOT_APP_PASSWORD");
        stats.disabled = true;
        stopped = true;
      }
      return null;
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;

    // Respect the global gap between real posts, even for a backlog of
    // dashboard-approved rows.
    if (Date.now() - lastPostedAt < config.bot.globalReplyCooldownMinutes * 60_000) return;

    const approved = await prisma.botReply.findFirst({
      where: { status: ReplyStatus.APPROVED },
      orderBy: { createdAt: "asc" },
      include: { post: true },
    });
    if (!approved) return;

    const activeAgent = await ensureAgent();
    if (!activeAgent) return;

    try {
      // RichText facets make the link clickable in Bluesky clients.
      const richText = new RichText({ text: approved.replyText });
      await richText.detectFacets(activeAgent);
      const postRef = { uri: approved.post.uri, cid: approved.post.cid };
      const result = await activeAgent.post({
        text: richText.text,
        facets: richText.facets,
        // We only ingest top-level posts, so root === parent.
        reply: { root: postRef, parent: postRef },
        createdAt: new Date().toISOString(),
      });
      await prisma.botReply.update({
        where: { id: approved.id },
        data: { status: ReplyStatus.POSTED, replyUri: result.uri },
      });
      lastPostedAt = Date.now();
      stats.posted += 1;
      console.log(`[poster] posted reply to ${approved.post.uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.botReply.update({
        where: { id: approved.id },
        data: { status: ReplyStatus.FAILED, skipReason: `post failed: ${message}` },
      });
      stats.postFailed += 1;
      console.error(`[poster] post failed for ${approved.post.uri}: ${message}`);
    }
  }

  const run = (): void => {
    tick().catch((error) => {
      console.error("[poster] tick failed:", error instanceof Error ? error.message : error);
    });
  };
  run();
  const timer = setInterval(run, TICK_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
