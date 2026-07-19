"use server";

import Anthropic from "@anthropic-ai/sdk";
import { prisma, DealPostStatus, ReplyStatus, SafetyStatus } from "@trendcart/db";
import { PAAPI_SEARCH_INDEXES, isAmazonHost, parseCents, withAffiliateTag } from "@trendcart/shared";
import { revalidatePath } from "next/cache";

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Comma- or newline-separated input → clean string array. */
function list(formData: FormData, name: string): string[] {
  return str(formData, name)
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Replies ─────────────────────────────────────────────────

export async function approveReply(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  // updateMany guards the status so a double-click or race can't re-approve
  await prisma.botReply.updateMany({
    where: { id, status: ReplyStatus.PENDING_APPROVAL },
    data: { status: ReplyStatus.APPROVED, approvedAt: new Date() },
  });
  revalidatePath("/replies");
}

/** Operator edits the pending reply text directly (anchor must survive). */
export async function editReply(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const text = str(formData, "text");
  if (!id || !text) return;
  const reply = await prisma.botReply.findUnique({ where: { id } });
  if (!reply || reply.status !== ReplyStatus.PENDING_APPROVAL) return;
  if (text.length > 290) return; // Bluesky cap is 300 graphemes
  if (reply.linkAnchor) {
    // The anchor is the clickable link — it must remain exactly once, and no
    // raw URLs may be introduced (the facet is the only link).
    if (text.split(reply.linkAnchor).length - 1 !== 1) return;
    if (/https?:\/\//.test(text)) return;
  }
  await prisma.botReply.update({
    where: { id },
    data: {
      replyText: text,
      // Learning signal: keep the original once, so the reflection job can
      // study before→after pairs of what the operator changed.
      editedByOperator: true,
      ...(reply.preEditText === null ? { preEditText: reply.replyText } : {}),
    },
  });
  revalidatePath("/replies");
}

/** Operator gives a direction ("mention the 75th anniversary") — the LLM
 *  rewrites the pending reply's text; link/anchor stay untouched. */
export async function refineReply(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const instruction = str(formData, "instruction");
  if (!id || !instruction) return;
  const reply = await prisma.botReply.findUnique({ where: { id }, include: { post: true } });
  if (!reply || reply.status !== ReplyStatus.PENDING_APPROVAL) return;

  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  const anchor = reply.linkAnchor ?? "";
  const maxLength = Number(process.env.REPLY_MAX_LENGTH ?? 240);
  const textBudget = maxLength - (anchor ? anchor.length + 1 : 0);
  const wordBudget = Math.max(12, Math.floor(textBudget / 6.5));
  const currentText = anchor
    ? reply.replyText.slice(0, reply.replyText.lastIndexOf(anchor)).trim()
    : reply.replyText;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000 });
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    ...(model.includes("haiku") ? {} : { output_config: { effort: "low" as const } }),
    system:
      "You revise a short Bluesky reply written by the TrendCart recommendation bot. " +
      "The operator's direction is AUTHORITATIVE — follow it exactly; it may be the precise " +
      "message or framing they want used. Do not include any URL (a clickable link is appended " +
      "after your text automatically). No hashtags, no @-mentions, no hype, no invented facts. " +
      `Return ONLY the revised text, at most ${wordBudget} words.`,
    messages: [
      {
        role: "user",
        content: `Operator direction: ${instruction}\n\nOriginal post being replied to:\n<untrusted_post>\n${reply.post.text}\n</untrusted_post>\n\nCurrent reply text (before the link):\n${currentText}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") return;
  let newText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!newText) return;
  if (newText.length > textBudget) {
    newText = `${newText.slice(0, Math.max(0, textBudget - 1)).trimEnd()}…`;
  }
  await prisma.botReply.update({
    where: { id },
    data: { replyText: anchor ? `${newText} ${anchor}` : newText },
  });
  revalidatePath("/replies");
}

/**
 * Post-hoc verdict on a POSTED reply — the operator's feedback channel for
 * autonomously posted replies. Rating ("up"/"down") plus an optional note;
 * both feed the nightly reflection (lessons) and the insights report.
 * Clicking the already-selected rating clears it.
 */
export async function rateReply(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const rating = str(formData, "rating");
  const feedback = str(formData, "feedback").slice(0, 500);
  if (!id || (rating !== "up" && rating !== "down")) return;
  const reply = await prisma.botReply.findUnique({
    where: { id },
    select: { status: true, operatorRating: true },
  });
  if (!reply || reply.status !== ReplyStatus.POSTED) return;
  const clearing = reply.operatorRating === rating && !feedback;
  await prisma.botReply.update({
    where: { id },
    data: clearing
      ? { operatorRating: null, operatorFeedback: null, ratedAt: null }
      : { operatorRating: rating, ...(feedback ? { operatorFeedback: feedback } : {}), ratedAt: new Date() },
  });
  revalidatePath("/replies");
}

export async function rejectReply(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  await prisma.botReply.updateMany({
    where: { id, status: { in: [ReplyStatus.PENDING_APPROVAL, ReplyStatus.APPROVED] } },
    data: { status: ReplyStatus.SKIPPED, skipReason: "rejected via dashboard" },
  });
  revalidatePath("/replies");
}

// ── Worker control ──────────────────────────────────────────

/** Operator kill switch: the worker reads `paused` every tick. */
export async function toggleWorkerPaused(): Promise<void> {
  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });
  if (!heartbeat) return; // worker has never run — nothing to pause
  await prisma.workerHeartbeat.update({
    where: { id: "worker" },
    data: { paused: !heartbeat.paused },
  });
  revalidatePath("/");
}

/**
 * Autonomous mode: the bot self-approves replies that clear the higher
 * intent + link-confidence bars; marginal ones still queue for manual
 * approval. DRY_RUN (env) always overrides. Worker picks the flag up
 * within ~30s.
 */
export async function toggleAutonomous(): Promise<void> {
  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });
  if (!heartbeat) return;
  await prisma.workerHeartbeat.update({
    where: { id: "worker" },
    data: { autonomous: !heartbeat.autonomous },
  });
  revalidatePath("/");
}

/**
 * Operator standing guidance: free-text instructions the bot treats as
 * AUTHORITATIVE in every evaluation and reply — it overrides the bot's
 * default judgment and anything it learned, short of the hard safety/spam
 * rules. This is the operator's direct override channel. The worker applies
 * it within ~2 minutes; empty clears it.
 */
export async function updateOperatorGuidance(formData: FormData): Promise<void> {
  const content = str(formData, "guidance").slice(0, 2000);
  await prisma.botMemory.upsert({
    where: { id: "operator-guidance" },
    create: { id: "operator-guidance", content },
    update: { content },
  });
  revalidatePath("/");
}

/**
 * Operator edits the bot's learned lessons directly. Auto-learning keeps
 * running: the next daily reflection PRESERVES this edited version (and won't
 * re-add anything removed) while still appending genuinely new lessons.
 * Clearing the box removes them; the bot re-derives from scratch next cycle.
 */
export async function updateLessons(formData: FormData): Promise<void> {
  const content = str(formData, "lessons").slice(0, 4000);
  if (!content) {
    await prisma.botMemory.deleteMany({ where: { id: "lessons" } });
  } else {
    await prisma.botMemory.upsert({
      where: { id: "lessons" },
      create: { id: "lessons", content, basis: { operatorEditedAt: new Date().toISOString() } },
      update: { content, basis: { operatorEditedAt: new Date().toISOString() } },
    });
  }
  revalidatePath("/");
}

/**
 * "Test a post": fetch a real Bluesky post by URL and inject it into the
 * pipeline as a MANUAL candidate — it skips the maturation wait, gets a
 * longer expiry, and flows through evaluation/reply/approval like any other.
 */
export async function injectPost(formData: FormData): Promise<void> {
  const input = str(formData, "url");
  if (!input) return;
  const note = str(formData, "note") || null;

  // Operator link: strict Amazon allowlist, and NEVER accepted untagged —
  // if the tag env is missing, the link is dropped rather than posted bare.
  const rawLink = str(formData, "link");
  const tag = process.env.AMAZON_ASSOCIATE_TAG ?? "";
  let operatorLinkUrl: string | null = null;
  if (rawLink && tag) {
    try {
      const parsed = new URL(rawLink);
      if (isAmazonHost(parsed.hostname)) {
        operatorLinkUrl = withAffiliateTag(rawLink, tag);
      }
    } catch {
      /* invalid URL — ignore the link, the note may still be useful */
    }
  }

  let did: string | null = null;
  let rkey: string | null = null;
  const atMatch = input.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)/);
  const webMatch = input.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (atMatch) {
    did = atMatch[1] ?? null;
    rkey = atMatch[2] ?? null;
  } else if (webMatch) {
    rkey = webMatch[2] ?? null;
    const actor = webMatch[1] ?? "";
    if (actor.startsWith("did:")) {
      did = actor;
    } else {
      const resolve = await fetch(
        `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (resolve.ok) did = ((await resolve.json()) as { did?: string }).did ?? null;
    }
  }
  if (!did || !rkey) return;

  const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
  const response = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) return;
  const body = (await response.json()) as {
    posts?: Array<{
      uri: string;
      cid: string;
      author: { did: string; handle?: string };
      record?: { text?: string; reply?: unknown };
      embed?: { images?: Array<{ alt?: string }> };
      indexedAt?: string;
      likeCount?: number;
      repostCount?: number;
      replyCount?: number;
      quoteCount?: number;
    }>;
  };
  const post = body.posts?.[0];
  // Top-level posts only — the poster builds reply refs with root === parent.
  if (!post?.record?.text || post.record.reply) return;

  // The classifier can't see images, but it can see their alt text.
  const embed = post.embed;
  const altTexts = (embed?.images ?? []).map((i) => i.alt).filter(Boolean);
  const contextText =
    embed?.images?.length
      ? `Post includes ${embed.images.length} image(s).${altTexts.length ? ` Alt text: ${altTexts.join(" | ")}` : ""}`
      : null;

  const counts = {
    likeCount: post.likeCount ?? 0,
    repostCount: post.repostCount ?? 0,
    replyCount: post.replyCount ?? 0,
    quoteCount: post.quoteCount ?? 0,
  };
  const data = {
    authorHandle: post.author.handle ?? null,
    text: post.record.text,
    indexedAt: post.indexedAt ? new Date(post.indexedAt) : new Date(),
    ...counts,
    engagementScore:
      counts.likeCount + counts.repostCount * 3 + counts.replyCount * 2 + counts.quoteCount * 3,
    source: "MANUAL" as const,
    lastHydratedAt: new Date(),
    contextText,
    operatorNote: note,
    operatorLinkUrl,
    deadAt: null,
  };

  const existing = await prisma.post.findUnique({ where: { uri: post.uri }, select: { id: true } });
  if (existing) {
    // Never reset while the poster holds an in-flight claim — deleting a
    // POSTING row mid-publish would orphan the live reply and re-arm the
    // post for a double reply. The operator can retry in ~30s.
    const inFlight = await prisma.botReply.findFirst({
      where: { postId: existing.id, status: ReplyStatus.POSTING },
      select: { id: true },
    });
    if (inFlight) return;
    // OVERRIDE RESET: wipe prior verdicts and unposted replies so the post
    // re-runs with the operator's guidance. POSTED/POSTING rows are never touched.
    await prisma.$transaction([
      prisma.candidateEvaluation.deleteMany({ where: { postId: existing.id } }),
      prisma.botReply.deleteMany({
        where: {
          postId: existing.id,
          status: { notIn: [ReplyStatus.POSTED, ReplyStatus.POSTING] },
        },
      }),
      prisma.post.update({
        where: { id: existing.id },
        data: { ...data, safetyStatus: SafetyStatus.PENDING, productIntentScore: null },
      }),
    ]);
  } else {
    await prisma.post.create({
      data: {
        uri: post.uri,
        cid: post.cid,
        authorDid: post.author.did,
        matchedKeywords: ["manual-injection"],
        ...data,
      },
    });
  }
  revalidatePath("/candidates");
}

// ── Candidates ──────────────────────────────────────────────

/**
 * Permanently exclude a post from the pipeline: a SKIPPED reply row blocks
 * reply generation, and dropping PENDING safety blocks LLM evaluation.
 */
export async function skipPost(formData: FormData): Promise<void> {
  const postId = str(formData, "postId");
  if (!postId) return;
  await prisma.$transaction([
    prisma.botReply.create({
      data: {
        postId,
        replyText: "",
        status: ReplyStatus.SKIPPED,
        skipReason: "manually skipped via dashboard",
      },
    }),
    prisma.post.updateMany({
      where: { id: postId, safetyStatus: SafetyStatus.PENDING },
      data: { safetyStatus: SafetyStatus.UNCERTAIN },
    }),
  ]);
  revalidatePath("/candidates");
}

// ── Categories ──────────────────────────────────────────────

export async function toggleCategoryActive(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const category = await prisma.productCategory.findUnique({ where: { id } });
  if (!category) return;
  await prisma.productCategory.update({
    where: { id },
    data: { isActive: !category.isActive },
  });
  revalidatePath("/categories");
}

export async function updateCategory(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const name = str(formData, "name");
  const description = str(formData, "description");
  if (!id || !name) return;
  // Optional per-category engagement floor: blank = follow the global
  // MIN_ENGAGEMENT_SCORE; a number overrides it for this category only.
  const floorRaw = str(formData, "minEngagementScore");
  const floorNum = Number(floorRaw);
  const minEngagementScore =
    floorRaw !== "" && Number.isFinite(floorNum) && floorNum >= 0 ? Math.round(floorNum) : null;
  await prisma.productCategory.update({
    where: { id },
    data: {
      name,
      description,
      keywords: list(formData, "keywords"),
      negativeKeywords: list(formData, "negativeKeywords"),
      minEngagementScore,
    },
  });
  revalidatePath("/categories");
}

// Products and recommendation pages were retired 2026-07-04: replies link
// straight to tagged Amazon searches (operator link > specific query >
// category query), so the curated catalog and public pages served nothing.

// ── Deal tracker ────────────────────────────────────────────

const DEAL_MAX_PRICE_AGE_HOURS = Number(process.env.DEAL_MAX_PRICE_AGE_HOURS ?? 1);

/**
 * Whether a queued deal would actually publish — read from the worker's
 * heartbeat (its real mode), not this web process's env. When true, deals are
 * queued as terminal DRY_RUN records the poster never sends.
 */
async function workerInDryRun(): Promise<boolean> {
  const hb = await prisma.workerHeartbeat.findUnique({
    where: { id: "worker" },
    select: { dryRun: true },
  });
  return hb?.dryRun ?? true; // unknown worker → assume dry run (safe)
}

/** Bounded positive int from a form field; null when absent/invalid. */
function intField(formData: FormData, name: string, min: number, max: number): number | null {
  const raw = str(formData, name);
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/** Shared parse/validate for the create + update feed forms. */
function feedFields(formData: FormData): {
  keywords: string;
  searchIndex: string;
  minSavingPercent: number;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  minReviewCount: number;
  minReviewRating: number;
  amazonOnly: boolean;
} | null {
  const keywords = str(formData, "keywords");
  const searchIndex = str(formData, "searchIndex");
  const minSavingPercent = intField(formData, "minSavingPercent", 1, 90);
  if (!keywords || minSavingPercent === null) return null;
  // An unknown SearchIndex would 400 every SearchItems call for the feed.
  if (!(PAAPI_SEARCH_INDEXES as readonly string[]).includes(searchIndex)) return null;
  const minPriceCents = parseCents(str(formData, "minPrice"));
  const maxPriceCents = parseCents(str(formData, "maxPrice"));
  if (minPriceCents != null && maxPriceCents != null && maxPriceCents < minPriceCents) return null;
  return {
    keywords,
    searchIndex,
    minSavingPercent,
    minPriceCents,
    maxPriceCents,
    minReviewCount: intField(formData, "minReviewCount", 0, 1_000_000) ?? 0,
    minReviewRating: intField(formData, "minReviewRating", 0, 4) ?? 0,
    amazonOnly: formData.get("amazonOnly") === "on",
  };
}

export async function createDealFeed(formData: FormData): Promise<void> {
  const name = str(formData, "name");
  const fields = feedFields(formData);
  if (!name || !fields) return;
  // Upsert by name so re-submitting the form edits instead of erroring.
  await prisma.dealFeed.upsert({
    where: { name },
    create: { name, ...fields },
    update: fields,
  });
  revalidatePath("/deals");
}

export async function updateDealFeed(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const fields = feedFields(formData);
  if (!id || !fields) return;
  await prisma.dealFeed.update({ where: { id }, data: fields }).catch(() => {});
  revalidatePath("/deals");
}

export async function toggleDealFeedActive(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const feed = await prisma.dealFeed.findUnique({ where: { id } });
  if (!feed) return;
  await prisma.dealFeed.update({ where: { id }, data: { isActive: !feed.isActive } });
  revalidatePath("/deals");
}

export async function deleteDealFeed(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  // DealPost.feedId is SetNull on delete — history survives, unattributed.
  await prisma.dealFeed.delete({ where: { id } }).catch(() => {});
  revalidatePath("/deals");
}

/** Make the feed due immediately (the worker picks it up within a minute). */
export async function runDealFeedNow(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  await prisma.dealFeed.updateMany({
    where: { id, isActive: true },
    data: { lastRunAt: null, lastRunError: null },
  });
  revalidatePath("/deals");
}

/**
 * Approve a feed-discovered deal. Deals are perishable: a price snapshot
 * older than the freshness ceiling can never be advertised, so approving a
 * stale one closes it out instead of queuing a post the poster would refuse.
 */
/** Ban/allow an ASIN for the automated deal channel: a deactivated
 *  DISCOVERED listing is skipped by both the RSS pipeline and PA-API feeds. */
export async function toggleListingActive(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  const listing = await prisma.trackedListing.findUnique({
    where: { id },
    select: { isActive: true },
  });
  if (!listing) return;
  await prisma.trackedListing.update({
    where: { id },
    data: { isActive: !listing.isActive },
  });
  revalidatePath("/deals");
}

export async function approveDealPost(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  const deal = await prisma.dealPost.findUnique({ where: { id } });
  if (!deal || deal.status !== DealPostStatus.PENDING_APPROVAL) return;
  if (Date.now() - deal.priceAsOf.getTime() > DEAL_MAX_PRICE_AGE_HOURS * 3_600_000) {
    await prisma.dealPost.updateMany({
      where: { id, status: DealPostStatus.PENDING_APPROVAL },
      data: {
        status: DealPostStatus.SKIPPED,
        skipReason: "price snapshot went stale awaiting approval",
      },
    });
    revalidatePath("/deals");
    return;
  }
  const dryRun = await workerInDryRun();
  // updateMany guards the status so a double-click or race can't re-approve.
  await prisma.dealPost.updateMany({
    where: { id, status: DealPostStatus.PENDING_APPROVAL },
    data: { status: dryRun ? DealPostStatus.DRY_RUN : DealPostStatus.READY },
  });
  revalidatePath("/deals");
}

export async function rejectDealPost(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  await prisma.dealPost.updateMany({
    where: { id, status: DealPostStatus.PENDING_APPROVAL },
    data: { status: DealPostStatus.SKIPPED, skipReason: "rejected by operator" },
  });
  revalidatePath("/deals");
}

// ── Deal suggestion sources (RSS; the no-PA-API bridge) ─────

/** Shared parse/validate for the create + update source forms. */
function sourceFields(formData: FormData): {
  url: string;
  topic: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  minPriceCents: number | null;
  maxPriceCents: number | null;
} | null {
  const url = str(formData, "url");
  const topic = str(formData, "topic");
  if (!topic) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }
  const minPriceCents = parseCents(str(formData, "minPrice"));
  const maxPriceCents = parseCents(str(formData, "maxPrice"));
  if (minPriceCents != null && maxPriceCents != null && maxPriceCents < minPriceCents) return null;
  return {
    url,
    topic,
    includeKeywords: list(formData, "includeKeywords"),
    excludeKeywords: list(formData, "excludeKeywords"),
    minPriceCents,
    maxPriceCents,
  };
}

export async function createSuggestionSource(formData: FormData): Promise<void> {
  const name = str(formData, "name");
  const fields = sourceFields(formData);
  if (!name || !fields) return;
  await prisma.dealSuggestionSource.upsert({
    where: { name },
    create: { name, ...fields },
    update: fields,
  });
  revalidatePath("/deals");
}

export async function updateSuggestionSource(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const fields = sourceFields(formData);
  if (!id || !fields) return;
  await prisma.dealSuggestionSource.update({ where: { id }, data: fields }).catch(() => {});
  revalidatePath("/deals");
}

export async function toggleSuggestionSourceActive(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const source = await prisma.dealSuggestionSource.findUnique({ where: { id } });
  if (!source) return;
  await prisma.dealSuggestionSource.update({
    where: { id },
    data: { isActive: !source.isActive },
  });
  revalidatePath("/deals");
}

export async function deleteSuggestionSource(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  // Suggestions cascade with their source.
  await prisma.dealSuggestionSource.delete({ where: { id } }).catch(() => {});
  revalidatePath("/deals");
}

/** Make the source due immediately (the worker picks it up within a minute). */
export async function fetchSuggestionSourceNow(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  if (!id) return;
  await prisma.dealSuggestionSource.updateMany({
    where: { id, isActive: true },
    data: { lastFetchedAt: null, lastFetchError: null },
  });
  revalidatePath("/deals");
}
