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
 * Each post is classified ONCE; the report then re-gates those same LLM
 * outputs at a grid of intent / link-confidence thresholds (a THRESHOLD SWEEP,
 * no extra API calls) so the operator can pick the gate that best matches
 * their own labels instead of eyeballing the funnel. Disagreements are also
 * bucketed by category — higher-signal than the funnel's posted counts for
 * deciding which categories to cut or re-key.
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
import type { CandidateEvaluationResult, CategoryContext } from "@trendcart/shared";
import { config } from "../src/config.js";
import { applyGates, type GateThresholds } from "../src/evaluate.js";
import { AnthropicLlmClient } from "../src/llm/anthropic.js";
import { getLearnedGuidelines, getOperatorGuidance } from "../src/reflect.js";

const MAX_PER_CLASS = Number(process.env.CALIBRATE_MAX_PER_CLASS ?? 20);
/** Autonomous mode went live 2026-07-06 — approvals before then were human clicks. */
const MANUAL_ERA_END = new Date("2026-07-06T00:00:00Z");
/** Values the sweep re-gates at. Bracket the useful range around the defaults. */
const INTENT_SWEEP = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85];
const LINK_SWEEP = [40, 45, 50, 55, 60, 65, 70, 75, 80];

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

/** One classified label: the LLM output kept so the sweep can re-gate it. */
type Scored = {
  expected: boolean;
  source: string;
  text: string;
  raw: CandidateEvaluationResult;
};

type SweepRow = { value: number; agreementPct: number; replyRate: number; current: boolean };

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

  // Classify each labeled post ONCE. The sweep below re-gates these raw
  // outputs at many thresholds, so it adds no API calls beyond this loop.
  const scoredPosts: Scored[] = [];
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
        // Replay the stored images through today's (vision-capable) brain.
        // Comments aren't persisted and old threads have drifted, so skip them.
        images: post.imageUrls.map((url, i) => ({ url, alt: post.imageAlts[i]?.trim() || null })),
        comments: [],
        operatorNote: post.operatorNote,
        operatorGuidance: guidance,
        learnedGuidelines: lessons,
      });
      scoredPosts.push({ expected, source, text: post.text.slice(0, 110), raw });
    } catch (error) {
      errors += 1;
      console.error(`eval failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const scored = scoredPosts.length;
  if (scored === 0) {
    console.log(`## Calibration failed\n\nAll ${errors} evaluations errored.`);
    return;
  }

  // Agreement + flips at the CURRENTLY DEPLOYED thresholds (the regression
  // signal, unchanged from before the sweep was added).
  type Flip = { text: string; source: string; got: boolean; reason: string; category: string };
  const flips: Flip[] = [];
  let agree = 0;
  for (const s of scoredPosts) {
    const verdict = applyGates(s.raw, activeSlugs);
    if (verdict.shouldReply === s.expected) agree += 1;
    else {
      flips.push({
        text: s.text,
        source: s.source,
        got: verdict.shouldReply,
        reason: verdict.reason.slice(0, 140),
        category: verdict.recommendedCategorySlug ?? "(specific-product search)",
      });
    }
  }
  const pct = Math.round((agree / scored) * 100);

  // Re-gate the same outputs at each threshold value. agreementPct is vs the
  // operator's labels; replyRate is the share of THIS labeled set the bot
  // would reply to — shown so a stricter gate's agreement gain is read against
  // its volume cost (a "never reply" gate scores high if most labels are no).
  function sweep(values: number[], make: (v: number) => GateThresholds, current: number): SweepRow[] {
    return values.map((value) => {
      let a = 0;
      let replies = 0;
      for (const s of scoredPosts) {
        const verdict = applyGates(s.raw, activeSlugs, make(value));
        if (verdict.shouldReply) replies += 1;
        if (verdict.shouldReply === s.expected) a += 1;
      }
      return {
        value,
        agreementPct: Math.round((a / scored) * 100),
        replyRate: Math.round((replies / scored) * 100),
        current: value === current,
      };
    });
  }
  const intentSweep = sweep(
    INTENT_SWEEP,
    (v) => ({ minProductIntentScore: v }),
    config.bot.minProductIntentScore,
  );
  const linkSweep = sweep(LINK_SWEEP, (v) => ({ minLinkConfidence: v }), config.bot.minLinkConfidence);

  function peak(rows: SweepRow[]): SweepRow {
    return rows.reduce((best, r) => (r.agreementPct > best.agreementPct ? r : best));
  }
  function sweepTable(name: string, envVar: string, rows: SweepRow[], current: number): string[] {
    const best = peak(rows);
    const currentRow = rows.find((r) => r.current);
    const out = [
      `### ${name} — \`${envVar}\` (currently ${current})`,
      ``,
      `| ${name} | agreement | reply-rate | |`,
      `| ---: | ---: | ---: | :--- |`,
    ];
    for (const r of rows) {
      const tags = [r.current ? "← current" : "", r.value === best.value ? "peak" : ""]
        .filter(Boolean)
        .join(", ");
      out.push(`| ${r.value} | ${r.agreementPct}% | ${r.replyRate}% | ${tags} |`);
    }
    out.push(``);
    out.push(
      best.value === current
        ? `Current \`${envVar}=${current}\` already maximizes agreement (${best.agreementPct}%).`
        : `Agreement peaks at \`${envVar}=${best.value}\` (${best.agreementPct}%) vs ${currentRow?.agreementPct ?? "?"}% at the current ${current}. Check the reply-rate column before moving — a stricter gate trades volume for agreement.`,
    );
    out.push(``);
    return out;
  }

  // Disagreements bucketed by category — where the brain and the operator
  // diverge most, a better cut/re-key signal than raw posted counts.
  const catFlips = new Map<string, number>();
  for (const f of flips) catFlips.set(f.category, (catFlips.get(f.category) ?? 0) + 1);
  const catFlipRows = [...catFlips.entries()].sort((a, b) => b[1] - a[1]);

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
    `**Agreement: ${pct}%**${delta}${errors ? ` · ${errors} eval errors` : ""} at the deployed thresholds (\`MIN_PRODUCT_INTENT_SCORE=${config.bot.minProductIntentScore}\`, \`MIN_LINK_CONFIDENCE=${config.bot.minLinkConfidence}\`).`,
    ``,
    `## Threshold sweep — which gate best matches your labels`,
    ``,
    `The same replayed evaluations, re-gated at each value (no extra API calls). Use this to tune thresholds from your own labels instead of guessing; reply-rate is the share of this labeled set the bot would reply to.`,
    ``,
    ...sweepTable("Intent", "MIN_PRODUCT_INTENT_SCORE", intentSweep, config.bot.minProductIntentScore),
    ...sweepTable("Link confidence", "MIN_LINK_CONFIDENCE", linkSweep, config.bot.minLinkConfidence),
  ];
  if (catFlipRows.length > 0) {
    lines.push(
      `### Disagreements by category`,
      ``,
      `Categories the brain and your labels diverge on most (at current thresholds):`,
      ``,
    );
    for (const [cat, n] of catFlipRows) lines.push(`- ${cat}: ${n}`);
    lines.push(``);
  }
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
        intentSweep,
        linkSweep,
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
