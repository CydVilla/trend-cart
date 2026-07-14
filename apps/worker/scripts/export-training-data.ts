/**
 * Export the labeled reply dataset as JSONL — the raw material for an
 * eventual fine-tuning loop (and for offline analysis today).
 *
 * One record per reply the operator has passed judgment on, labeled from
 * their own actions (the same ground truth the calibration set uses):
 *   good: rated 👍, or manual-era approved+posted and never rated 👎
 *   bad:  rated 👎, rejected via dashboard, or manually skipped
 *
 * Each record carries the full context the bot saw (post text, categories,
 * evaluation scores), what it wrote (including before/after operator edits —
 * the strongest style signal), and how the post performed (engagement counts
 * from the outcomes sweep, clicks from tracked links).
 *
 * Usage:
 *   pnpm --filter @trendcart/worker export:dataset            # stdout
 *   pnpm --filter @trendcart/worker export:dataset out.jsonl  # file
 */
import { writeFileSync } from "node:fs";
import { prisma, type BotReply, type Post } from "@trendcart/db";

/** Autonomous mode went live 2026-07-06 — approvals before then were human clicks. */
const MANUAL_ERA_END = new Date("2026-07-06T00:00:00Z");

type ReplyWithPost = BotReply & { post: Post };
type Labeled = { reply: ReplyWithPost; label: "good" | "bad"; labelSource: string };

function dedupeByReply(rows: Labeled[]): Labeled[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.reply.id)) return false;
    seen.add(r.reply.id);
    return true;
  });
}

async function gather(): Promise<Labeled[]> {
  const [ratedUp, manualApproved, ratedDown, rejected, skipped] = await Promise.all([
    prisma.botReply.findMany({ where: { operatorRating: "up" }, include: { post: true } }),
    prisma.botReply.findMany({
      where: {
        status: "POSTED",
        approvedAt: { lt: MANUAL_ERA_END },
        OR: [{ operatorRating: null }, { operatorRating: "up" }],
      },
      include: { post: true },
    }),
    prisma.botReply.findMany({ where: { operatorRating: "down" }, include: { post: true } }),
    prisma.botReply.findMany({
      where: { status: "SKIPPED", skipReason: "rejected via dashboard" },
      include: { post: true },
    }),
    prisma.botReply.findMany({
      where: { status: "SKIPPED", skipReason: "manually skipped via dashboard" },
      include: { post: true },
    }),
  ]);

  // Negatives outrank positives on conflict (a 👎 on a posted reply means the
  // operator regrets it, whatever the earlier approval said).
  const negatives = dedupeByReply([
    ...ratedDown.map((r) => ({ reply: r, label: "bad" as const, labelSource: "rated-down" })),
    ...rejected.map((r) => ({ reply: r, label: "bad" as const, labelSource: "rejected" })),
    ...skipped.map((r) => ({ reply: r, label: "bad" as const, labelSource: "manual-skip" })),
  ]);
  const negativeIds = new Set(negatives.map((n) => n.reply.id));
  const positives = dedupeByReply([
    ...ratedUp.map((r) => ({ reply: r, label: "good" as const, labelSource: "rated-up" })),
    ...manualApproved.map((r) => ({
      reply: r,
      label: "good" as const,
      labelSource: "manually-approved",
    })),
  ]).filter((p) => !negativeIds.has(p.reply.id));
  return [...positives, ...negatives];
}

async function main(): Promise<void> {
  const rows = await gather();
  const postIds = [...new Set(rows.map((r) => r.reply.postId))];
  const replyIds = rows.map((r) => r.reply.id);

  // The verdict that drove each reply (shouldReply=true, newest), with the
  // newest evaluation of any kind as fallback for skip-path rows.
  const evaluations = await prisma.candidateEvaluation.findMany({
    where: { postId: { in: postIds } },
    orderBy: { createdAt: "desc" },
  });
  const evalByPost = new Map<string, (typeof evaluations)[number]>();
  for (const e of evaluations) {
    const current = evalByPost.get(e.postId);
    if (!current || (e.shouldReply && !current.shouldReply)) evalByPost.set(e.postId, e);
  }

  const links = await prisma.trackedLink.findMany({
    where: { kind: "reply", sourceId: { in: replyIds } },
    select: { sourceId: true, clickCount: true },
  });
  const clicksByReply = new Map<string, number>();
  for (const l of links) {
    clicksByReply.set(l.sourceId as string, (clicksByReply.get(l.sourceId as string) ?? 0) + l.clickCount);
  }

  const records = rows.map(({ reply, label, labelSource }) => {
    const evaluation = evalByPost.get(reply.postId);
    return {
      replyId: reply.id,
      label,
      labelSource,
      context: {
        postText: reply.post.text,
        postSource: reply.post.source,
        detectedCategories: reply.post.detectedCategories,
        imageAlts: reply.post.imageAlts.filter((a) => a.length > 0),
        threadContext: reply.post.contextText,
        operatorNote: reply.post.operatorNote,
        postEngagementScore: reply.post.engagementScore,
      },
      evaluation: evaluation
        ? {
            productIntentScore: evaluation.productIntentScore,
            linkConfidence: evaluation.linkConfidence,
            recommendedCategory: evaluation.recommendedCategory,
            recommendedSearchQuery: evaluation.recommendedSearchQuery,
            suggestedReplyAngle: evaluation.suggestedReplyAngle,
            reason: evaluation.reason,
            model: evaluation.model,
          }
        : null,
      reply: {
        text: reply.replyText,
        // Before/after pairs from operator edits — the strongest style signal.
        preEditText: reply.preEditText,
        editedByOperator: reply.editedByOperator,
        linkAnchor: reply.linkAnchor,
        status: reply.status,
      },
      outcome: {
        likes: reply.replyLikeCount,
        replies: reply.replyReplyCount,
        reposts: reply.replyRepostCount,
        quotes: reply.replyQuoteCount,
        clicks: clicksByReply.get(reply.id) ?? 0,
        postedAt: reply.postedAt?.toISOString() ?? null,
        operatorFeedback: reply.operatorFeedback,
      },
    };
  });

  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  const outPath = process.argv[2];
  if (outPath) {
    writeFileSync(outPath, jsonl, "utf8");
  } else {
    process.stdout.write(jsonl);
  }
  const good = records.filter((r) => r.label === "good").length;
  console.error(
    `Exported ${records.length} labeled replies (${good} good / ${records.length - good} bad)` +
      (outPath ? ` → ${outPath}` : ""),
  );
}

main()
  .catch((error) => {
    console.error("Export failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
