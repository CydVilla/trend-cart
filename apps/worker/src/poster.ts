import { AtpAgent, RichText } from "@atproto/api";
import { prisma, ReplyStatus } from "@trendcart/db";
import { blueskyBackingOff, noteBlueskyDown, noteBlueskyUp } from "./bluesky-health.js";
import { config } from "./config.js";
import { isPaused, setPostingState } from "./heartbeat.js";

const MAX_LOGIN_FAILURES = 3;
const MAX_POST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10 * 60_000;
const GETPOSTS_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";

export type PosterStats = {
  posted: number;
  postFailed: number;
  disabled: boolean;
};

export type Poster = {
  tick: () => Promise<void>;
  enabled: boolean;
};

/** Errors that mean "this reply can never be posted" (vs. transient network). */
function isPermanentPostError(message: string): boolean {
  return /blocked|not found|invalid|deleted|suspended/i.test(message);
}

async function targetStillExists(uri: string): Promise<boolean> {
  try {
    const url = new URL(GETPOSTS_URL);
    url.searchParams.append("uris", uri);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return true; // AppView hiccup — don't skip on a 5xx
    const body = (await response.json()) as { posts?: Array<{ uri: string }> };
    return (body.posts ?? []).some((p) => p.uri === uri);
  } catch {
    return true; // network failure is not evidence of deletion
  }
}

/**
 * Publishes APPROVED replies to Bluesky, one at a time, oldest first.
 * Hard rules:
 *  - exactly-once: rows are CLAIMED (APPROVED→POSTING) before any network
 *    call, so a crash can never double-post
 *  - the global cooldown derives from postedAt in the DB (restart-proof)
 *  - pre-flight: the target must still exist and the author must not have
 *    opted out between approval and posting
 *  - transient post errors retry up to 3 times; permanent ones FAIL
 *  - never runs when DRY_RUN=true; repeated login failures disable posting
 */
export function createPoster(stats: PosterStats): Poster {
  if (config.bot.dryRun) {
    console.log("  posting:          disabled (DRY_RUN=true)");
    setPostingState("disabled: DRY_RUN=true");
    return { tick: async () => {}, enabled: false };
  }
  if (!config.bluesky.handle || !config.bluesky.appPassword) {
    console.warn(
      "  posting:          disabled — set BOT_ACCOUNT_HANDLE and BOT_APP_PASSWORD to enable",
    );
    setPostingState("disabled: missing credentials");
    return { tick: async () => {}, enabled: false };
  }
  console.log(`  posting:          enabled as @${config.bluesky.handle}`);
  setPostingState("enabled");

  let agent: AtpAgent | null = null;
  let loginFailures = 0;
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
      // A transient outage (504/network) is NOT a credential problem — back off
      // and retry later; never let it trip the permanent login-disable.
      if (noteBlueskyDown(error)) {
        setPostingState("waiting: Bluesky unreachable");
        return null;
      }
      loginFailures += 1;
      console.error(
        `[poster] login failed (${loginFailures}/${MAX_LOGIN_FAILURES}):`,
        error instanceof Error ? error.message : error,
      );
      if (loginFailures >= MAX_LOGIN_FAILURES) {
        console.error("[poster] disabling posting until restart — check BOT_APP_PASSWORD");
        setPostingState("disabled: repeated login failures");
        stats.disabled = true;
        stopped = true;
      }
      return null;
    }
  }

  async function releaseClaim(id: string, skipReason: string): Promise<void> {
    await prisma.botReply.update({
      where: { id },
      data: { status: ReplyStatus.SKIPPED, skipReason },
    });
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (await isPaused()) return;
    if (blueskyBackingOff()) return; // Bluesky is down — skip until the probe window

    // Restart-proof global gap between real posts, derived from the DB.
    const lastPosted = await prisma.botReply.findFirst({
      where: { status: ReplyStatus.POSTED, postedAt: { not: null } },
      orderBy: { postedAt: "desc" },
      select: { postedAt: true },
    });
    if (
      lastPosted?.postedAt &&
      Date.now() - lastPosted.postedAt.getTime() <
        config.bot.globalReplyCooldownMinutes * 60_000
    ) {
      return;
    }

    // Operator-provided/solicited replies post first; trending fills in after.
    const attemptDue = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] };
    const candidate =
      (await prisma.botReply.findFirst({
        where: {
          status: ReplyStatus.APPROVED,
          ...attemptDue,
          post: { source: { in: ["MANUAL", "MENTION"] } },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      })) ??
      (await prisma.botReply.findFirst({
        where: { status: ReplyStatus.APPROVED, ...attemptDue },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }));
    if (!candidate) return;

    // CLAIM before any network call — the count===1 guard makes posting
    // exactly-once even across overlapping ticks or competing processes.
    const claim = await prisma.botReply.updateMany({
      where: { id: candidate.id, status: ReplyStatus.APPROVED },
      data: { status: ReplyStatus.POSTING },
    });
    if (claim.count !== 1) return;

    const approved = await prisma.botReply.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { post: true },
    });

    // Stale-approval guard: a reply approved too late reads as necro-spam.
    // Mirrors the reply pipeline's windows (operator-injected posts get 7d).
    const maxPostAgeHours = approved.post.source === "MANUAL" ? 7 * 24 : 48;
    if (approved.post.indexedAt.getTime() < Date.now() - maxPostAgeHours * 3_600_000) {
      await releaseClaim(
        approved.id,
        `approved too late — post older than ${maxPostAgeHours}h at posting time`,
      );
      return;
    }
    // Consent + existence pre-flight, both may have changed since approval.
    const optOut = await prisma.authorOptOut.findUnique({
      where: { did: approved.post.authorDid },
    });
    if (optOut) {
      await releaseClaim(approved.id, "author opted out before posting");
      return;
    }
    if (approved.post.deadAt || !(await targetStillExists(approved.post.uri))) {
      await releaseClaim(approved.id, "post deleted before posting");
      return;
    }

    const activeAgent = await ensureAgent();
    if (!activeAgent) {
      // Login failed — put the claim back for a later tick.
      await prisma.botReply.update({
        where: { id: approved.id },
        data: { status: ReplyStatus.APPROVED, nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS) },
      });
      return;
    }

    try {
      // The reply's link rides on the anchor text as a rich-text facet —
      // readers see "Deltarune on Amazon", not a raw URL. Legacy rows (no
      // linkUrl) fall back to auto-detecting URLs in the text.
      let text = approved.replyText;
      let facets: import("@atproto/api").AppBskyRichtextFacet.Main[] | undefined;
      if (approved.linkUrl && approved.linkAnchor) {
        const anchorIndex = text.lastIndexOf(approved.linkAnchor);
        if (anchorIndex >= 0) {
          const encoder = new TextEncoder();
          const byteStart = encoder.encode(text.slice(0, anchorIndex)).length;
          const byteEnd = byteStart + encoder.encode(approved.linkAnchor).length;
          facets = [
            {
              index: { byteStart, byteEnd },
              features: [{ $type: "app.bsky.richtext.facet#link", uri: approved.linkUrl }],
            },
          ];
        }
      }
      if (!facets) {
        const richText = new RichText({ text });
        await richText.detectFacets(activeAgent);
        text = richText.text;
        facets = richText.facets;
      }
      const postRef = { uri: approved.post.uri, cid: approved.post.cid };
      // Mention requests made mid-thread carry the real thread root so our
      // reply joins the conversation; top-level posts are their own root.
      const rootRef =
        approved.post.threadRootUri && approved.post.threadRootCid
          ? { uri: approved.post.threadRootUri, cid: approved.post.threadRootCid }
          : postRef;
      const result = await activeAgent.post({
        text,
        facets,
        reply: { root: rootRef, parent: postRef },
        createdAt: new Date().toISOString(),
      });
      await prisma.botReply.update({
        where: { id: approved.id },
        data: { status: ReplyStatus.POSTED, replyUri: result.uri, postedAt: new Date() },
      });
      noteBlueskyUp();
      stats.posted += 1;
      console.log(`[poster] posted reply to ${approved.post.uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A Bluesky outage must not burn this reply's attempts — back off and
      // release the claim without counting the failure against it.
      if (noteBlueskyDown(error)) {
        await prisma.botReply.update({
          where: { id: approved.id },
          data: { status: ReplyStatus.APPROVED },
        });
        return;
      }
      const attempts = approved.attemptCount + 1;
      if (isPermanentPostError(message) || attempts >= MAX_POST_ATTEMPTS) {
        await prisma.botReply.update({
          where: { id: approved.id },
          data: {
            status: ReplyStatus.FAILED,
            skipReason: `post failed (attempt ${attempts}): ${message}`,
            attemptCount: attempts,
          },
        });
        stats.postFailed += 1;
        console.error(`[poster] post failed permanently for ${approved.post.uri}: ${message}`);
      } else {
        await prisma.botReply.update({
          where: { id: approved.id },
          data: {
            status: ReplyStatus.APPROVED,
            attemptCount: attempts,
            nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
          },
        });
        console.warn(`[poster] transient post error (attempt ${attempts}), will retry: ${message}`);
      }
    }
  }

  return { tick, enabled: true };
}
