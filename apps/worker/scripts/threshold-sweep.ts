/**
 * Gate-threshold sweep: how would MIN_PRODUCT_INTENT_SCORE / MIN_LINK_CONFIDENCE
 * changes score against the operator's own labels?
 *
 * Each labeled post is classified ONCE through the live brain (same as
 * calibrate.ts), then the stored outputs are RE-GATED at a grid of thresholds —
 * no extra API calls per grid point. Reports, per threshold: agreement with the
 * operator, reply-rate, false-positives (bot would reply / operator said no)
 * and false-negatives (bot would skip / operator approved), plus per-class
 * accuracy — overall agreement alone is misleading when the classes are
 * imbalanced.
 *
 * Run: cd apps/worker && npx tsx scripts/threshold-sweep.ts
 * Env: DATABASE_URL, ANTHROPIC_API_KEY; CALIBRATE_MAX_PER_CLASS (default 20).
 */
import { prisma } from "@trendcart/db";
import type { CandidateEvaluationResult, CategoryContext } from "@trendcart/shared";
import { config } from "../src/config.js";
import { applyGates } from "../src/evaluate.js";
import { AnthropicLlmClient } from "../src/llm/anthropic.js";
import { getLearnedGuidelines, getOperatorGuidance } from "../src/reflect.js";
import { gatherLabels } from "./calibration-labels.js";

/** The override mechanism must provably work before any sweep result counts. */
function selfTest(activeSlugs: Set<string>): void {
  const base: CandidateEvaluationResult = {
    productIntentScore: 65,
    safetyStatus: "safe",
    recommendedCategorySlug: null,
    recommendedSearchQuery: "hollow knight silksong switch",
    linkConfidence: 70,
    suggestedNewCategory: null,
    shouldReply: true,
    reason: "self-test",
    suggestedReplyAngle: "x",
  };
  const atIntent60 = applyGates(base, activeSlugs, { minProductIntentScore: 60, minLinkConfidence: 60 });
  const atIntent70 = applyGates(base, activeSlugs, { minProductIntentScore: 70, minLinkConfidence: 60 });
  const atLink60 = applyGates(base, activeSlugs, { minProductIntentScore: 60, minLinkConfidence: 60 });
  const atLink75 = applyGates(base, activeSlugs, { minProductIntentScore: 60, minLinkConfidence: 75 });
  const ok =
    atIntent60.shouldReply && !atIntent70.shouldReply && atLink60.shouldReply && !atLink75.shouldReply;
  console.log(`override self-test (intent 65 / linkConf 70, no category): ${ok ? "PASS ✅" : "FAIL ❌"}`);
  if (!ok) throw new Error("applyGates threshold overrides are not taking effect — sweep aborted");
}

type Row = { expected: boolean; source: string; raw: CandidateEvaluationResult; text: string };

function gradeAt(
  rows: Row[],
  activeSlugs: Set<string>,
  minIntent: number,
  minLink: number,
): { agree: number; reply: number; fp: number; fn: number } {
  let agree = 0, reply = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const verdict = applyGates(r.raw, activeSlugs, {
      minProductIntentScore: minIntent,
      minLinkConfidence: minLink,
    });
    if (verdict.shouldReply) reply += 1;
    if (verdict.shouldReply === r.expected) agree += 1;
    else if (verdict.shouldReply) fp += 1;
    else fn += 1;
  }
  return { agree, reply, fp, fn };
}

async function main(): Promise<void> {
  if (!config.llm.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const labels = await gatherLabels();
  const positives = labels.filter((l) => l.expected).length;
  const negatives = labels.length - positives;
  console.log(`golden set: ${labels.length} labels (${positives} expect-reply, ${negatives} expect-skip)`);
  if (negatives < 15 || positives < 15) {
    console.log(
      `⚠️  ${negatives < 15 ? `only ${negatives} negative` : `only ${positives} positive`} labels — conclusions are TENTATIVE; rate more posted replies to firm them up.`,
    );
  }

  const categories: CategoryContext[] = await prisma.productCategory.findMany({
    where: { isActive: true },
    select: { slug: true, name: true, description: true, exampleProblems: true },
  });
  const activeSlugs = new Set(categories.map((c) => c.slug));
  selfTest(activeSlugs);

  const [guidance, lessons] = await Promise.all([getOperatorGuidance(), getLearnedGuidelines()]);
  const llm = new AnthropicLlmClient(config.llm.anthropicApiKey, config.llm.model);

  // Classify each label exactly once under the CURRENT brain.
  const rows: Row[] = [];
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
        postAgeMinutes: 90,
        authorProfile: null,
        isDirectRequest: post.source === "MENTION",
        threadContext: post.contextText,
        images: post.imageUrls.map((url, i) => ({ url, alt: post.imageAlts[i]?.trim() || null })),
        comments: [],
        operatorNote: post.operatorNote,
        operatorGuidance: guidance,
        learnedGuidelines: lessons,
      });
      rows.push({ expected, source, raw, text: post.text.slice(0, 80) });
    } catch (error) {
      errors += 1;
      console.error(`classify failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`classified ${rows.length} labels (${errors} errors)\n`);

  const liveIntent = config.bot.minProductIntentScore;
  const liveLink = config.bot.minLinkConfidence;
  const fmt = (r: { agree: number; reply: number; fp: number; fn: number }, mark: string) =>
    `agree ${String(Math.round((r.agree / rows.length) * 100)).padStart(3)}%  reply-rate ${String(Math.round((r.reply / rows.length) * 100)).padStart(3)}%  FP ${r.fp}  FN ${r.fn}${mark}`;

  console.log(`── MIN_PRODUCT_INTENT_SCORE sweep (link fixed at live ${liveLink}) ──`);
  for (let t = 40; t <= 85; t += 5) {
    const r = gradeAt(rows, activeSlugs, t, liveLink);
    console.log(`  intent ≥ ${String(t).padStart(2)}: ${fmt(r, t === liveIntent ? "   ← live" : "")}`);
  }
  console.log(`\n── MIN_LINK_CONFIDENCE sweep (intent fixed at live ${liveIntent}) ──`);
  for (let t = 40; t <= 80; t += 5) {
    const r = gradeAt(rows, activeSlugs, liveIntent, t);
    console.log(`  link ≥ ${String(t).padStart(2)}: ${fmt(r, t === liveLink ? "   ← live" : "")}`);
  }

  // Where do residual disagreements live at the LIVE thresholds?
  console.log(`\n── disagreements at live thresholds (${liveIntent}/${liveLink}) ──`);
  for (const r of rows) {
    const v = applyGates(r.raw, activeSlugs, {
      minProductIntentScore: liveIntent,
      minLinkConfidence: liveLink,
    });
    if (v.shouldReply !== r.expected) {
      console.log(
        `  ${v.shouldReply ? "FP" : "FN"} (${r.source}) intent=${r.raw.productIntentScore} link=${r.raw.linkConfidence} llmSaid=${r.raw.shouldReply}: "${r.text}"`,
      );
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("SWEEP FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
