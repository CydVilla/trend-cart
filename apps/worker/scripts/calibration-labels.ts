/**
 * The calibration golden set, shared by calibrate.ts (weekly agreement check)
 * and threshold-sweep.ts (gate-threshold tuning). Labels come from the
 * operator's own actions and are ground truth:
 *   expected REPLY:    replies rated 👍, plus manual-era approvals (a human
 *                      clicked Approve) that were never rated 👎
 *   expected NO REPLY: replies rated 👎, dashboard rejections, manual skips
 */
import { prisma, type Post } from "@trendcart/db";

export const MAX_PER_CLASS = Number(process.env.CALIBRATE_MAX_PER_CLASS ?? 20);
/** Autonomous mode went live 2026-07-06 — approvals before then were human clicks. */
const MANUAL_ERA_END = new Date("2026-07-06T00:00:00Z");

export type Labeled = { post: Post; expected: boolean; source: string };

function dedupeByPost(rows: Labeled[]): Labeled[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.post.id)) return false;
    seen.add(r.post.id);
    return true;
  });
}

// Operator-DIRECTIVE posts (operatorLinkUrl set) bypass the classifier in
// production — the human decided by fiat, model="operator", no LLM judgment.
// Replaying them through the classifier measures nothing about the brain, so
// they are not labels. (Posts with only an operatorNote stay: the classifier
// still judged those, with the note as context.)
const CLASSIFIER_PATH = { post: { operatorLinkUrl: null } } as const;

export async function gatherLabels(): Promise<Labeled[]> {
  const [ratedUp, manualApproved] = await Promise.all([
    prisma.botReply.findMany({
      where: { operatorRating: "up", ...CLASSIFIER_PATH },
      include: { post: true },
      orderBy: { ratedAt: "desc" },
      take: MAX_PER_CLASS,
    }),
    prisma.botReply.findMany({
      where: {
        status: "POSTED",
        approvedAt: { lt: MANUAL_ERA_END },
        OR: [{ operatorRating: null }, { operatorRating: "up" }],
        ...CLASSIFIER_PATH,
      },
      include: { post: true },
      orderBy: { postedAt: "desc" },
      take: MAX_PER_CLASS,
    }),
  ]);
  const [ratedDown, rejected, skipped] = await Promise.all([
    prisma.botReply.findMany({
      where: { operatorRating: "down", ...CLASSIFIER_PATH },
      include: { post: true },
      orderBy: { ratedAt: "desc" },
      take: MAX_PER_CLASS,
    }),
    prisma.botReply.findMany({
      where: { status: "SKIPPED", skipReason: "rejected via dashboard", ...CLASSIFIER_PATH },
      include: { post: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PER_CLASS,
    }),
    prisma.botReply.findMany({
      where: {
        status: "SKIPPED",
        skipReason: "manually skipped via dashboard",
        ...CLASSIFIER_PATH,
      },
      include: { post: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PER_CLASS,
    }),
  ]);

  const positives = dedupeByPost([
    ...ratedUp.map((r) => ({ post: r.post, expected: true, source: "rated 👍" })),
    ...manualApproved.map((r) => ({ post: r.post, expected: true, source: "manually approved" })),
  ]).slice(0, MAX_PER_CLASS);
  // Negatives outrank positives on conflict (a 👎 on a posted reply means the
  // operator regrets it, whatever the earlier approval said).
  const negatives = dedupeByPost([
    ...ratedDown.map((r) => ({ post: r.post, expected: false, source: "rated 👎" })),
    ...rejected.map((r) => ({ post: r.post, expected: false, source: "rejected" })),
    ...skipped.map((r) => ({ post: r.post, expected: false, source: "skipped" })),
  ]).slice(0, MAX_PER_CLASS);
  const negativeIds = new Set(negatives.map((n) => n.post.id));
  return [...positives.filter((p) => !negativeIds.has(p.post.id)), ...negatives];
}
