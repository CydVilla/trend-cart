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
    data: { status: ReplyStatus.APPROVED },
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
