"use server";

import Anthropic from "@anthropic-ai/sdk";
import { prisma, ReplyStatus, SafetyStatus } from "@trendcart/db";
import { isAmazonHost, withAffiliateTag } from "@trendcart/shared";
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
  await prisma.botReply.update({ where: { id }, data: { replyText: text } });
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
  await prisma.productCategory.update({
    where: { id },
    data: {
      name,
      description,
      keywords: list(formData, "keywords"),
      negativeKeywords: list(formData, "negativeKeywords"),
    },
  });
  revalidatePath("/categories");
}

// ── Products ────────────────────────────────────────────────

export async function createProduct(formData: FormData): Promise<void> {
  const categoryId = str(formData, "categoryId");
  const name = str(formData, "name");
  const url = str(formData, "url");
  if (!categoryId || !name || !url) return;
  await prisma.product.create({
    data: {
      categoryId,
      name,
      url,
      description: str(formData, "description"),
      priceRange: str(formData, "priceRange"),
      imageUrl: str(formData, "imageUrl") || null,
    },
  });
  revalidatePath("/products");
}

export async function toggleProductActive(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return;
  await prisma.product.update({ where: { id }, data: { isActive: !product.isActive } });
  revalidatePath("/products");
}

// ── Recommendation pages ────────────────────────────────────

export async function upsertRecommendationPage(formData: FormData): Promise<void> {
  const categoryId = str(formData, "categoryId");
  const title = str(formData, "title");
  const intro = str(formData, "intro");
  if (!categoryId || !title) return;
  const category = await prisma.productCategory.findUnique({ where: { id: categoryId } });
  if (!category) return;
  await prisma.recommendationPage.upsert({
    where: { categoryId },
    create: { categoryId, slug: category.slug, title, intro },
    update: { title, intro },
  });
  revalidatePath("/pages");
}

export async function togglePagePublished(formData: FormData): Promise<void> {
  const id = str(formData, "id");
  const page = await prisma.recommendationPage.findUnique({ where: { id } });
  if (!page) return;
  await prisma.recommendationPage.update({
    where: { id },
    data: { isPublished: !page.isPublished },
  });
  revalidatePath("/pages");
}
