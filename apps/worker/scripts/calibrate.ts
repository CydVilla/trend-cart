/**
 * Weekly calibration: replay operator-labeled posts through the CURRENT
 * classifier brain (prompt + learned lessons + operator guidance + gates) and
 * measure agreement. The bot's prompts mutate daily (reflection) — this is
 * the regression check that the drift still matches the operator's judgment.
 *
 * Labels come from the operator's own actions:
 *   expected REPLY:    replies rated 👍, plus manual-era approvals (a human
 *                      clicked Approve) that were never rated 👎
 *   expected NO REPLY: replies rated 👎, dashboard rejections, manual skips
 *
 * Output: a markdown report on stdout (the workflow files it as an issue).
 * Also stores the agreement number in BotMemory("calibration") so next run
 * (and the insights job) can show the trend.
 *
 * Run: pnpm --filter @trendcart/worker calibrate
 * Env: DATABASE_URL, ANTHROPIC_API_KEY (required); ANTHROPIC_MODEL,
 *      CALIBRATE_MAX_PER_CLASS (default 20).
 */
import { prisma, type Post, type Prisma } from "@trendcart/db";
import type { CategoryContext } from "@trendcart/shared";
import { config } from "../src/config.js";
import { applyGates } from "../src/evaluate.js";
import { AnthropicLlmClient } from "../src/llm/anthropic.js";
import { getLearnedGuidelines, getOperatorGuidance } from "../src/reflect.js";

const MAX_PER_CLASS = Number(process.env.CALIBRATE_MAX_PER_CLASS ?? 20);
/** Autonomous mode went live 2026-07-06 — approvals before then were human clicks. */
const MANUAL_ERA_END = new Date("2026-07-06T00:00:00Z");

type Labeled = { post: Post; expected: boolean; source: string };

function dedupeByPost(rows: Labeled[]): Labeled[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.post.id)) return false;
    seen.add(r.post.id);
    return true;
  });
}

async function gatherLabels(): Promise<Labeled[]> {
  const [ratedUp, manualApproved] = await Promise.all([
    prisma.botReply.findMany({
      where: { operatorRating: "up" },
      include: { post: true },
      orderBy: { ratedAt: "desc" },
      take: MAX_PER_CLASS,
    }),
    prisma.botReply.findMany({
      where: {
        status: "POSTED",
        approvedAt: { lt: MANUAL_ERA_END },
        OR: [{ operatorRating: null }, { operatorRating: "up" }],
      },
      include: { post: true },
      orderBy: { postedAt: "desc" },
      take: MAX_PER_CLASS,
    }),
  ]);
  const [ratedDown, rejected, skipped] = await Promise.all([
    prisma.botReply.findMany({
      where: { operatorRating: "down" },
      include: { post: true },
      orderBy: { ratedAt: "desc" },
      take: MAX_PER_CLASS,
    }),
    prisma.botReply.findMany({
      where: { status: "SKIPPED", skipReason: "rejected via dashboard" },
      include: { post: true },
      orderBy: { createdAt: "desc" },
      take: MAX_PER_CLASS,
    }),
    prisma.botReply.findMany({
      where: { status: "SKIPPED", skipReason: "manually skipped via dashboard" },
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

async function main(): Promise<void> {
  if (!config.llm.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const labels = await gatherLabels();
  const positives = labels.filter((l) => l.expected).length;
  const negatives = labels.length - positives;
  if (labels.length < 6) {
    console.log(
      `## Calibration skipped\n\nOnly ${labels.length} labeled examples exist — rate/reject more replies first.`,
    );
    return;
  }

  const categories: CategoryContext[] = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: { slug: true, name: true, description: true, exampleProblems: true },
  });
  const activeSlugs = new Set(categories.map((c) => c.slug));
  const [guidance, lessons] = await Promise.all([getOperatorGuidance(), getLearnedGuidelines()]);
  const llm = new AnthropicLlmClient(config.llm.anthropicApiKey, config.llm.model);

  type Flip = { text: string; source: string; got: boolean; reason: string };
  const flips: Flip[] = [];
  let agree = 0;
  let errors = 0;

  for (const { post, expected, source } of labels) {
    try {
      const raw = await llm.classifyPost({
        postText: post.text,
        authorHandle: post.authorHandle,
        categories,
        keywordMatches: post.detectedCategories,
        engagement: {
          likeCount: post.likeCount,
          repostCount: post.repostCount,
          replyCount: post.replyCount,
          quoteCount: post.quoteCount,
        },
        postAgeMinutes: 90, // normalized: judge content, not staleness
        authorProfile: null,
        isDirectRequest: post.source === "MENTION",
        threadContext: post.contextText,
        operatorNote: post.operatorNote,
        operatorGuidance: guidance,
        learnedGuidelines: lessons,
      });
      const verdict = applyGates(raw, activeSlugs);
      if (verdict.shouldReply === expected) agree += 1;
      else {
        flips.push({
          text: post.text.slice(0, 110),
          source,
          got: verdict.shouldReply,
          reason: verdict.reason.slice(0, 140),
        });
      }
    } catch (error) {
      errors += 1;
      console.error(`eval failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const scored = labels.length - errors;
  const pct = scored > 0 ? Math.round((agree / scored) * 100) : 0;

  const prev = await prisma.botMemory.findUnique({ where: { id: "calibration" } });
  const prevBasis = (prev?.basis ?? null) as { agreementPct?: number } | null;
  const delta =
    prevBasis?.agreementPct != null ? ` (previous run: ${prevBasis.agreementPct}%)` : "";

  const falsePositives = flips.filter((f) => f.got);
  const falseNegatives = flips.filter((f) => !f.got);
  const lines = [
    `## Weekly calibration — brain vs. your judgment`,
    ``,
    `Replayed **${scored}** operator-labeled posts (${positives} expected-reply, ${negatives} expected-skip) through the current classifier + gates + lessons + guidance.`,
    ``,
    `**Agreement: ${pct}%**${delta}${errors ? ` · ${errors} eval errors` : ""}`,
    ``,
  ];
  if (falsePositives.length > 0) {
    lines.push(`### Would now reply, but you said no (${falsePositives.length})`, ``);
    for (const f of falsePositives) lines.push(`- (${f.source}) "${f.text}" — bot: ${f.reason}`);
    lines.push(``);
  }
  if (falseNegatives.length > 0) {
    lines.push(`### Would now skip, but you approved (${falseNegatives.length})`, ``);
    for (const f of falseNegatives) lines.push(`- (${f.source}) "${f.text}" — bot: ${f.reason}`);
    lines.push(``);
  }
  lines.push(
    flips.length === 0
      ? `No disagreements — the learning loop is still aligned with your decisions.`
      : `Operator approvals and ratings are ground truth — a flip is always the bot's miss, never a "label error". Fix via Operator guidance (authoritative) or the lessons editor on the Overview page.`,
  );

  const report = lines.join("\n");
  console.log(report);

  await prisma.botMemory.upsert({
    where: { id: "calibration" },
    create: {
      id: "calibration",
      content: report,
      basis: { agreementPct: pct, scored, generatedAt: new Date().toISOString() },
    },
    update: {
      content: report,
      basis: {
        agreementPct: pct,
        scored,
        generatedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
}

main()
  .catch((e) => {
    console.error("CALIBRATION FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
