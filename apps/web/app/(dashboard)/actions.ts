"use server";

import { prisma, ReplyStatus, SafetyStatus } from "@trendcart/db";
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

  const counts = {
    likeCount: post.likeCount ?? 0,
    repostCount: post.repostCount ?? 0,
    replyCount: post.replyCount ?? 0,
    quoteCount: post.quoteCount ?? 0,
  };
  await prisma.post.createMany({
    data: [
      {
        uri: post.uri,
        cid: post.cid,
        authorDid: post.author.did,
        authorHandle: post.author.handle ?? null,
        text: post.record.text,
        indexedAt: post.indexedAt ? new Date(post.indexedAt) : new Date(),
        ...counts,
        engagementScore:
          counts.likeCount + counts.repostCount * 3 + counts.replyCount * 2 + counts.quoteCount * 3,
        matchedKeywords: ["manual-injection"],
        source: "MANUAL",
        lastHydratedAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
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
