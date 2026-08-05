import { prisma, ReplyStatus, type CandidateEvaluation, type Post, type Prisma } from "@trendcart/db";
import {
  amazonSearchUrl,
  canonicalAmazonUrl,
  composeReplyPriceSuffix,
  productMatchConfidence,
  withAffiliateTag,
  type GenerateReplyInput,
  type LlmClient,
} from "@trendcart/shared";
import { checkSearchAvailability, findBestOffer, type ReplyOffer } from "./availability.js";
import { fetchTopComments } from "./comments.js";
import { config } from "./config.js";
import { isTransientError } from "./evaluate.js";
import {
  factCheckReply,
  routeIsAtLeastAsGood,
  routeVerdict,
  FACTCHECK_REJECT_SKIP_REASON,
  type FactCheckVerdict,
} from "./factcheck.js";
import { getOperatorFlags } from "./heartbeat.js";
import { getLearnedGuidelines, getOperatorGuidance } from "./reflect.js";
import { createTrackedLink } from "./tracking.js";
import { validateReply } from "./validate.js";

const BATCH_SIZE = 5;
const GENERATION_BACKOFF_MS = 10 * 60_000;
let generationBackoffUntil = 0;
/** Statuses that count as "the bot engaged" for cooldowns/limits/dedupe. */
const ACTIVE_STATUSES = [
  ReplyStatus.DRY_RUN,
  ReplyStatus.PENDING_APPROVAL,
  ReplyStatus.APPROVED,
  ReplyStatus.POSTING,
  ReplyStatus.POSTED,
];

export type ReplyStats = {
  generated: number;
  /** Of `generated`: how many the bot self-approved (autonomous mode). */
  autoApproved: number;
  /** Pre-publication web-search fact checks run (auto-approve path only). */
  factChecked: number;
  /** Rewrites of a flagged draft that got generated AND re-fact-checked. */
  factRepaired: number;
  /** Of `factRepaired`: rewrites that then passed — posted, no human needed. */
  factRescued: number;
  /** Of `factChecked`: failed/unverifiable — demoted to manual approval. */
  factFlagged: number;
  /** Of `factChecked`: DISPROVED — auto-rejected (never surfaced to the human). */
  factRejected: number;
  skipped: number;
  deferred: number;
  failed: number;
};

/**
 * Audit trail for one repair pass, stored under `factCheck.repair`. The
 * top-level verdict is always the one that decided the reply's fate: the
 * rewrite's when `adopted`, the flagged draft's when it was thrown away.
 */
type RepairRecord = {
  /** Rewrites attempted (and fact-checked) after the first flag. */
  attempts: number;
  /** Whether the rewrite replaced the flagged draft. */
  adopted: boolean;
  /** The draft the rewrite was based on, and the verdict that flagged it. */
  flaggedText: string;
  flaggedVerdict: FactCheckVerdict | null;
  /** The rewrite's own verdict. */
  rewriteVerdict: FactCheckVerdict | null;
};

/**
 * skip  = permanent, recorded as a SKIPPED row (auditable, never retried)
 * defer = temporary (rate limit / cooldown window / missing page), retried
 *         next tick without writing a row
 */
type PolicyDecision =
  | { action: "proceed" }
  | { action: "skip"; reason: string }
  | { action: "defer"; reason: string };

async function checkReplyPolicy(post: Post, categorySlug: string | null): Promise<PolicyDecision> {
  const now = Date.now();

  if (post.deadAt) return { action: "skip", reason: "post was deleted" };
  // Solicited = the operator (inject form) or the author (mention) explicitly
  // asked — exempt from author/category cooldowns; a human chose this post.
  const solicited = post.source === "MENTION" || post.source === "MANUAL";

  // Replying to old posts reads as necro-spam. Operator-injected posts get a
  // longer window — a human explicitly chose them.
  const maxAgeHours = post.source === "MANUAL" ? 7 * 24 : 24;
  if (post.indexedAt.getTime() < now - maxAgeHours * 3_600_000) {
    return { action: "skip", reason: `candidate expired (post older than ${maxAgeHours}h)` };
  }

  // Consent revocation is permanent and checked before anything else social.
  const optOut = await prisma.authorOptOut.findUnique({ where: { did: post.authorDid } });
  if (optOut) return { action: "skip", reason: "author opted out" };

  // Per-author cooldown — never reply to the same person twice in the window.
  // Direct requests are exempt: someone asking deserves an answer every time.
  if (!solicited) {
    const authorCutoff = new Date(now - config.bot.authorCooldownHours * 3_600_000);
    const authorReply = await prisma.botReply.findFirst({
      where: {
        status: { in: ACTIVE_STATUSES },
        createdAt: { gte: authorCutoff },
        post: { authorDid: post.authorDid },
      },
      select: { id: true },
    });
    if (authorReply) {
      return { action: "skip", reason: `author cooldown (${config.bot.authorCooldownHours}h)` };
    }
  }

  // Hourly/daily caps — UNSOLICITED (trending) replies only. Replies are the
  // bot's secondary channel now: the deal posts on its own profile do
  // the volume, and a trending reply must be rare and excellent. Solicited
  // replies are exempt: a mention deserves its answer, and manual injection
  // is the operator's deliberate "post more" lever.
  if (!solicited) {
    // Banter replies (the daily humor lane) run on their own budget — they
    // must not starve the already-tiny trending-reply allowance.
    const notBanter = { post: { source: { not: "BANTER" as const } } };
    const hourCount = await prisma.botReply.count({
      where: { status: { in: ACTIVE_STATUSES }, createdAt: { gte: new Date(now - 3_600_000) }, ...notBanter },
    });
    if (hourCount >= config.bot.maxRepliesPerHour) {
      return { action: "defer", reason: "hourly reply limit reached" };
    }
    const dayCount = await prisma.botReply.count({
      where: { status: { in: ACTIVE_STATUSES }, createdAt: { gte: new Date(now - 24 * 3_600_000) }, ...notBanter },
    });
    if (dayCount >= config.bot.maxRepliesPerDay) {
      return { action: "defer", reason: "daily reply limit reached" };
    }
  }

  // Global cooldown — minimum gap between trending replies. Solicited ones
  // skip it too: an asker deserves a prompt answer, and the operator's
  // injections are deliberate.
  if (!solicited && config.bot.globalReplyCooldownMinutes > 0) {
    const lastReply = await prisma.botReply.findFirst({
      where: { status: { in: ACTIVE_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      lastReply &&
      lastReply.createdAt.getTime() > now - config.bot.globalReplyCooldownMinutes * 60_000
    ) {
      return { action: "defer", reason: "global reply cooldown" };
    }
  }

  // Per-category cooldown — don't recommend the same category twice in a row.
  // (Skipped for solicited requests: the asker chose the topic, not the bot.)
  if (!solicited && categorySlug && config.bot.categoryCooldownMinutes > 0) {
    const categoryCutoff = new Date(now - config.bot.categoryCooldownMinutes * 60_000);
    const recentInCategory = await prisma.botReply.findFirst({
      where: {
        status: { in: ACTIVE_STATUSES },
        createdAt: { gte: categoryCutoff },
        post: {
          evaluations: { some: { recommendedCategory: categorySlug, shouldReply: true } },
        },
      },
      select: { id: true },
    });
    if (recentInCategory) return { action: "defer", reason: "category cooldown" };
  }

  return { action: "proceed" };
}

async function writeSkip(
  postId: string,
  reason: string,
  stats: ReplyStats,
  replyText = "",
): Promise<void> {
  await prisma.botReply.create({
    data: { postId, replyText, status: ReplyStatus.SKIPPED, skipReason: reason },
  });
  stats.skipped += 1;
}

/**
 * Status for a freshly generated, validated reply — DRY_RUN is the master
 * switch. The operator's `autonomous` toggle self-approves only replies that
 * clear the HIGHER bars (intent + link confidence, or a human-made decision);
 * marginal ones still land in the manual queue for the operator.
 */
function statusFor(
  evaluation: CandidateEvaluation,
  link: ReplyLink,
  autonomous: boolean,
): { status: ReplyStatus; approvedAt: Date | null } {
  if (config.bot.dryRun || config.bot.replyMode === "dry_run") {
    return { status: ReplyStatus.DRY_RUN, approvedAt: null };
  }
  if (config.bot.replyMode === "auto") {
    return { status: ReplyStatus.APPROVED, approvedAt: new Date() };
  }
  if (autonomous) {
    const humanDecided = evaluation.model === "operator" || link.kind === "operator";
    // PLAYFUL (joke-first) replies always escalate until the operator has
    // curated enough of them to trust the bot's humor — comedy is the genre
    // his 👎 ratings flagged most.
    const playful =
      evaluation.suggestedReplyAngle?.startsWith("PLAYFUL") && !config.bot.playfulAutoApprove;
    // A direct product link is a stronger claim than a search page, so it needs
    // a stronger bar — the ASIN must verifiably be the product we meant. Only
    // OPERATOR links skip the link-quality check (a human already chose them).
    const linkTrusted =
      link.kind === "operator"
        ? true
        : link.kind === "product"
          ? (link.matchConfidence ?? 0) >= config.bot.minProductMatch &&
            evaluation.linkConfidence >= config.bot.autoMinLinkConfidence
          : evaluation.linkConfidence >= config.bot.autoMinLinkConfidence;
    const confident =
      evaluation.productIntentScore >= config.bot.autoMinIntentScore && linkTrusted;
    if (humanDecided || (confident && !playful)) {
      return { status: ReplyStatus.APPROVED, approvedAt: new Date() };
    }
    return { status: ReplyStatus.PENDING_APPROVAL, approvedAt: null }; // escalate to the human
  }
  return { status: ReplyStatus.PENDING_APPROVAL, approvedAt: null };
}

type ReplyLink = {
  kind: "operator" | "search" | "product";
  url: string;
  /** Human-readable clickable text — the URL rides on it as a facet. */
  anchor: string;
  /** Live Amazon offer, when the catalog API answered. Drives the price
   *  suffix and the sale gate; absent means "Amazon didn't tell us". */
  offer?: ReplyOffer;
  /** 0-100 that the resolved ASIN is really the product meant. Product links
   *  below the floor never self-approve. */
  matchConfidence?: number;
};

/** "hollow knight silksong nintendo switch" → "hollow knight silksong on Amazon" */
function searchAnchor(query: string): string {
  const short = query.split(/\s+/).slice(0, 4).join(" ");
  return `${short.length > 34 ? short.slice(0, 34).trimEnd() : short} on Amazon`;
}

/**
 * Deterministically trim an over-long reply body so `${body}… ${anchor}` fits
 * the length cap, cutting at a word boundary. The anchor (and its facet) are
 * always preserved — length is reserved for them first.
 */
export function truncateReplyToFit(body: string, anchor: string, maxLength: number): string {
  const clean = body
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Reserve room for a leading space, the ellipsis, and " " + anchor.
  const budget = maxLength - anchor.length - 2;
  if (budget <= 0) return `${anchor}`; // pathological; validator will reject
  if (clean.length <= budget) return `${clean} ${anchor}`;
  let cut = clean.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > budget * 0.6) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s.,;:!?—-]+$/, "").trimEnd();
  return `${cut}… ${anchor}`;
}

type DraftResult = { ok: true; text: string } | { ok: false; text: string; reason: string };

/**
 * Produce one validated reply draft: generate, retry once against a tighter
 * budget when the validator objects, then fall back to word-boundary
 * truncation for length-only failures. Returns the composed display text
 * (body + anchor) and whether it survived validation.
 *
 * Generation errors PROPAGATE — the caller distinguishes a transient API
 * outage (back off the whole loop) from a dead candidate (FAILED row).
 */
async function draftReply(
  llm: LlmClient,
  input: GenerateReplyInput,
  anchor: string,
  priceSuffix = "",
): Promise<DraftResult> {
  // The price rides AFTER the anchor so the anchor still appears exactly once
  // (the validator requires that, and the facet's byte offsets depend on it).
  const compose = (body: string) => `${body} ${anchor}${priceSuffix}`;
  let body = await llm.generateReply(input);
  let text = compose(body);
  let validation = validateReply(text, anchor, config.bot.replyMaxLength);
  if (!validation.ok) {
    // One retry with a tighter budget — over-length is the common failure.
    try {
      const retryBody = await llm.generateReply({ ...input, textBudget: input.textBudget - 30 });
      const retryText = compose(retryBody);
      const retryValidation = validateReply(retryText, anchor, config.bot.replyMaxLength);
      if (retryValidation.ok) {
        text = retryText;
        validation = retryValidation;
      } else {
        body = retryBody; // shorter body is the better base for truncation
      }
    } catch {
      // fall through to the truncation fallback / the caller's FAILED row
    }
  }
  // Length-only safety net: the model overshot its word budget twice. Rather
  // than discard a good candidate, truncate the body at a word boundary so a
  // valid reply still goes out. Only rescues length failures — a banned
  // phrase or stray URL still (correctly) fails below.
  if (!validation.ok && validation.reason.startsWith("too long")) {
    const truncated = truncateReplyToFit(body, anchor, config.bot.replyMaxLength);
    const truncatedValidation = validateReply(truncated, anchor, config.bot.replyMaxLength);
    if (truncatedValidation.ok) {
      text = truncated;
      validation = truncatedValidation;
    }
  }
  return validation.ok ? { ok: true, text } : { ok: false, text, reason: validation.reason };
}

/** Never send the exact same reply text twice in a week. */
async function isDuplicateText(text: string): Promise<boolean> {
  const duplicate = await prisma.botReply.findFirst({
    where: {
      replyText: text,
      status: { in: ACTIVE_STATUSES },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) },
    },
    select: { id: true },
  });
  return duplicate !== null;
}

/** Display text → the model-written body, without the trailing link anchor. */
function stripAnchor(text: string, anchor: string): string {
  const at = text.lastIndexOf(anchor);
  return at === -1 ? text.trim() : text.slice(0, at).trim();
}

/**
 * Pick the single link a reply will carry:
 *  1. an operator-provided link (the human already decided), or
 *  2. a tagged Amazon search for the SPECIFIC product the LLM identified —
 *     only when its linkConfidence says the results will be relevant
 *     AND (with PA-API keys) Amazon confirms something is orderable.
 * There is NO generic fallback: the operator rejected category-name links
 * ("video games on Amazon") as worthless — a reply either points at a
 * specific, buyable thing or it doesn't happen. null = permanent skip.
 */
async function chooseLink(evaluation: CandidateEvaluation, post: Post): Promise<ReplyLink | null> {
  // No per-reply "(affiliate link)" suffix: the account bio discloses the
  // affiliate relationship, and the anchor text names Amazon explicitly.
  if (post.operatorLinkUrl) {
    return {
      kind: "operator",
      url: post.operatorLinkUrl,
      anchor: "this one on Amazon",
    };
  }
  if (!config.site.amazonAssociateTag) return null;
  if (
    evaluation.recommendedSearchQuery &&
    evaluation.linkConfidence >= config.bot.minLinkConfidence
  ) {
    // linkConfidence is the model's belief the results will be relevant AND
    // orderable; with PA-API keys the orderable half stops being a belief —
    // a query with zero new/in-stock results (unreleased, sold out,
    // collector-only) kills the reply instead of shipping a link to junk.
    // "unknown" (no keys / API down) changes nothing.
    // Ask Amazon for the concrete offer behind this query. A hit gives us the
    // ASIN (a direct product link beats a search page), the live price, and
    // whether it is genuinely discounted. Gated by the master switch so
    // eligibility landing can't silently change every reply's shape — and so
    // no catalog calls are spent while the feature is off.
    const offer = config.bot.productLinksEnabled
      ? await findBestOffer(evaluation.recommendedSearchQuery)
      : null;
    if (offer) {
      const onSale = offer.savingPercent >= config.bot.minSavingPercent;
      // The author naming the product themselves is what makes a full-price
      // reply worthless — the reader already knows what to buy. When the bot
      // did the identifying, the reply is the value. `null` (legacy rows, or
      // a model that skipped the field) reads as author-named, the strict side.
      const botIdentifiedIt = evaluation.posterNamedProduct === false;
      if (config.bot.requireSaleWhenAuthorNamed && !onSale && !botIdentifiedIt) {
        console.log(
          `[reply] "${evaluation.recommendedSearchQuery}" not on sale ` +
            `(${offer.savingPercent}% < ${config.bot.minSavingPercent}%) and the author named it — skipping`,
        );
        return null;
      }
      // Is this listing actually the product we meant? A search page tolerates
      // a near miss; a direct link asserts it. Low scores still reply — they
      // just never post unreviewed (see statusFor).
      const matchConfidence = productMatchConfidence(
        evaluation.recommendedSearchQuery,
        offer.title,
      );
      if (matchConfidence < config.bot.minProductMatch) {
        console.log(
          `[reply] resolved "${evaluation.recommendedSearchQuery}" to ${offer.asin} ` +
            `("${offer.title ?? "no title"}") at match ${matchConfidence} < ` +
            `${config.bot.minProductMatch} — escalating to manual approval`,
        );
      }
      return {
        kind: "product",
        url: withAffiliateTag(
          canonicalAmazonUrl(offer.asin, config.creatorsApi.marketplace),
          config.site.amazonAssociateTag,
        ),
        anchor: searchAnchor(evaluation.recommendedSearchQuery),
        offer,
        matchConfidence,
      };
    }

    // No offer data (no credentials, API down, eligibility pending): fall back
    // to the pre-price behaviour rather than going silent.
    const availability = await checkSearchAvailability(evaluation.recommendedSearchQuery);
    if (availability !== "unavailable") {
      return {
        kind: "search",
        url: amazonSearchUrl(evaluation.recommendedSearchQuery, config.site.amazonAssociateTag),
        anchor: searchAnchor(evaluation.recommendedSearchQuery),
      };
    }
    console.log(
      `[reply] query "${evaluation.recommendedSearchQuery}" has no orderable Amazon results — skipping`,
    );
  }
  return null;
}

/**
 * One pass: take evaluations that cleared Phase 4's gates and have no reply
 * yet, run the anti-spam policy, generate + validate the reply, and store it
 * in the mode-appropriate status. Every permanent decision leaves a row.
 */
export async function generateDueReplies(llm: LlmClient, stats: ReplyStats): Promise<void> {
  const flags = await getOperatorFlags();
  if (flags.paused) return;
  if (Date.now() < generationBackoffUntil) return;

  const dueWhere = {
    shouldReply: true,
    // ALLOWLIST: this run's model tag plus "operator" directives — fake
    // verdicts, policy rows, legacy "unknown" rows, and verdicts from other
    // model configurations can never drive this pipeline.
    model: { in: config.llm.useFake ? ["fake", "operator"] : [config.llm.model, "operator"] },
  } as const;
  // Operator-provided/solicited candidates jump the reply queue — a fresh
  // injection must not wait behind a backlog of trending evaluations.
  const solicitedDue = await prisma.candidateEvaluation.findMany({
    where: {
      ...dueWhere,
      post: { replies: { none: {} }, deadAt: null, source: { in: ["MANUAL", "MENTION"] } },
    },
    include: { post: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });
  // Approval-queue hygiene: a PENDING_APPROVAL reply whose post has passed
  // the poster's necro window can never post (the stale-approval guard would
  // skip it anyway) — expire it so the dashboard queue only ever shows
  // actionable items. Windows mirror poster.ts: 7d for operator-injected
  // posts, 48h otherwise.
  const now = Date.now();
  const lapsed = await prisma.botReply.updateMany({
    where: {
      status: ReplyStatus.PENDING_APPROVAL,
      OR: [
        { post: { source: "MANUAL", indexedAt: { lt: new Date(now - 7 * 24 * 3_600_000) } } },
        {
          post: { source: { not: "MANUAL" }, indexedAt: { lt: new Date(now - 48 * 3_600_000) } },
        },
      ],
    },
    data: {
      status: ReplyStatus.SKIPPED,
      skipReason: "approval window lapsed (post too old to reply to)",
    },
  });
  if (lapsed.count > 0) stats.skipped += lapsed.count;

  // Terminal-skip trending candidates whose post already aged out (24h): with
  // the freshest-first ordering below they would otherwise never surface for
  // their auditable SKIPPED row. Cheap: usually zero rows.
  const agedOut = await prisma.candidateEvaluation.findMany({
    where: {
      ...dueWhere,
      post: {
        replies: { none: {} },
        deadAt: null,
        source: { notIn: ["MANUAL", "MENTION"] },
        indexedAt: { lt: new Date(Date.now() - 24 * 3_600_000) },
      },
    },
    select: { postId: true },
  });
  for (const stale of agedOut) {
    await writeSkip(stale.postId, "candidate expired (post expired)", stats);
  }

  // FRESHEST post first, not oldest evaluation first: replies are worth the
  // most while a post is still hot, and during bursts the old FIFO order spent
  // the whole batch racing candidates that were about to expire anyway while
  // fresh ones aged in line (27 of the first 51 expiries died waiting there).
  // Under backlog the stalest now expire unposted — by design; a reply to a
  // near-dead post is the least valuable thing this loop can produce.
  const trendingDue =
    solicitedDue.length < BATCH_SIZE
      ? await prisma.candidateEvaluation.findMany({
          where: {
            ...dueWhere,
            post: {
              replies: { none: {} },
              deadAt: null,
              source: { notIn: ["MANUAL", "MENTION"] },
            },
          },
          include: { post: true },
          orderBy: { post: { indexedAt: "desc" } },
          take: BATCH_SIZE - solicitedDue.length,
        })
      : [];
  const due = [...solicitedDue, ...trendingDue];
  if (due.length === 0) return;
  // Loop-invariant context — one read per tick, not per candidate.
  const operatorGuidance = config.llm.useFake ? null : await getOperatorGuidance();
  const learnedGuidelines = config.llm.useFake ? null : await getLearnedGuidelines();

  for (const evaluation of due) {
    // Policy runs FIRST so the 24h/7d expiry always writes a terminal SKIPPED
    // row — otherwise permanently-deferring candidates (e.g. a category whose
    // page never gets published) wedge the oldest-first queue forever.
    const policy = await checkReplyPolicy(evaluation.post, evaluation.recommendedCategory);
    if (policy.action === "skip") {
      await writeSkip(evaluation.postId, policy.reason, stats);
      continue;
    }
    if (policy.action === "defer") {
      stats.deferred += 1;
      continue; // no row — the next tick retries once the window frees up
    }

    const link = await chooseLink(evaluation, evaluation.post);
    if (!link) {
      // No link the bot is confident in — a reply that links to junk is worse
      // than silence. Permanent, auditable skip.
      await writeSkip(
        evaluation.postId,
        `no confident link (query confidence ${evaluation.linkConfidence}, category ${evaluation.recommendedCategory ?? "none"})`,
        stats,
      );
      continue;
    }

    // The display text ends with the clickable anchor; the URL itself is
    // attached as a facet at posting time, never shown raw. When a live offer
    // exists the price clause rides after the anchor, so its length has to
    // come out of the model's budget too — otherwise every priced reply
    // overshoots and burns the retry.
    const priceSuffix = link.offer
      ? composeReplyPriceSuffix({
          priceCents: link.offer.priceCents,
          wasPriceCents: link.offer.wasPriceCents,
          priceAsOf: link.offer.priceAsOf,
        })
      : "";
    const reserved = link.anchor.length + 1 + priceSuffix.length;
    // Same visual + conversation context the classifier saw, so the reply can
    // reference what was actually shared. Comments are re-fetched fresh (cheap
    // public read) so the reply reflects the thread as it stands now.
    const images = evaluation.post.imageUrls.map((url, i) => ({
      url,
      alt: evaluation.post.imageAlts[i]?.trim() || null,
    }));
    const comments =
      config.llm.useFake || evaluation.post.replyCount === 0
        ? []
        : await fetchTopComments(evaluation.post.uri);

    const replyInput = {
      postText: evaluation.post.text,
      suggestedReplyAngle: evaluation.suggestedReplyAngle,
      textBudget: config.bot.replyMaxLength - reserved,
      isDirectRequest: evaluation.post.source === "MENTION",
      images,
      comments,
      operatorNote: evaluation.post.operatorNote,
      operatorGuidance,
      learnedGuidelines,
    };

    let draft: DraftResult;
    try {
      draft = await draftReply(llm, replyInput, link.anchor, priceSuffix);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientError(error)) {
        // API outage: back off the whole loop, don't blame the candidate.
        generationBackoffUntil = Date.now() + GENERATION_BACKOFF_MS;
        console.error(`[reply] transient API error — backing off: ${message}`);
        return;
      }
      await prisma.botReply.create({
        data: {
          postId: evaluation.postId,
          replyText: "",
          status: ReplyStatus.FAILED,
          skipReason: `generation failed: ${message}`,
        },
      });
      stats.failed += 1;
      continue;
    }

    if (!draft.ok) {
      await prisma.botReply.create({
        data: {
          postId: evaluation.postId,
          replyText: draft.text,
          status: ReplyStatus.FAILED,
          skipReason: `validation failed: ${draft.reason}`,
        },
      });
      stats.failed += 1;
      continue;
    }

    let text = draft.text;
    if (await isDuplicateText(text)) {
      await writeSkip(evaluation.postId, "duplicate reply text (used recently)", stats, text);
      continue;
    }

    let { status, approvedAt } = statusFor(evaluation, link, flags.autonomous);

    // Web-search fact check (does the product exist / is it orderable or
    // pre-orderable / are the claims right) runs on BOTH outcomes, and its
    // verdict GATES the result four ways:
    // - DISPROVED (confidently inaccurate — product missing/unorderable or a
    //   claim contradicted): auto-rejected. Never surface a provably-wrong
    //   reply to the human; the evidence feeds the learning loop instead.
    // - FLAGGED (unverifiable/low-confidence) on a self-approved reply: the
    //   verdict says WHAT is wrong, so hand those findings back to the
    //   generator, rewrite once, and check again — see the repair loop below.
    // - still flagged after the rewrite: fail-safe demote to the manual queue
    //   with both verdicts attached (a missed post beats a wrong one — but we
    //   lack positive disproof, so a human decides).
    // - otherwise: the verdict rides along informationally (queue-bound replies
    //   the operator judges against real evidence; passing self-approvals post).
    // Operator-linked replies skip it (the human already chose that link).
    let factCheck: FactCheckVerdict | null = null;
    let factChecked = false;
    let repair: RepairRecord | null = null;
    let skipReason: string | null = null;
    if (
      (status === ReplyStatus.APPROVED || status === ReplyStatus.PENDING_APPROVAL) &&
      config.factCheck.enabled &&
      !config.llm.useFake &&
      link.kind !== "operator"
    ) {
      const selfApproved = status === ReplyStatus.APPROVED;
      const checkInput = {
        postText: evaluation.post.text,
        linkKind: link.kind,
        linkQuery:
          link.kind === "search"
            ? (evaluation.recommendedSearchQuery ?? link.anchor)
            : link.anchor,
        suggestedReplyAngle: evaluation.suggestedReplyAngle,
      };
      factChecked = true;
      factCheck = await factCheckReply({ ...checkInput, replyText: text });
      stats.factChecked += 1;

      // ── Repair pass ─────────────────────────────────────────────────
      // A flagged verdict is a diagnosis, not a death sentence: it names the
      // claims that don't hold up. Feed those findings back as authoritative
      // corrections, rewrite the text (same product, same angle), and run a
      // fresh check. A rewrite that now passes posts autonomously instead of
      // costing the operator a review; one that doesn't lands in the queue as
      // before — with both verdicts, so the operator sees what was tried.
      //
      // Strictly fail-safe: a rewrite is adopted only when its route is at
      // least as good as the flagged draft's, and a generation error, failed
      // validation, or duplicate keeps the flagged draft untouched. The repair
      // can rescue a reply into posting; it can never bury one the operator
      // would otherwise have seen.
      let repairsLeft = config.factCheck.repairAttempts;
      while (routeVerdict({ verdict: factCheck, selfApproved, repairsLeft }) === "repair") {
        repairsLeft -= 1;
        const flaggedText = text;
        const flaggedVerdict = factCheck;
        let rewrite: DraftResult;
        try {
          rewrite = await draftReply(
            llm,
            {
              ...replyInput,
              repair: {
                previousText: stripAnchor(flaggedText, link.anchor),
                summary: flaggedVerdict?.summary ?? "the check could not be completed",
                issues: flaggedVerdict?.issues ?? [],
              },
            },
            link.anchor,
            priceSuffix,
          );
        } catch (error) {
          console.warn(
            `[factcheck] repair rewrite failed, keeping the flagged draft: ${
              error instanceof Error ? error.message : error
            }`,
          );
          break;
        }
        if (!rewrite.ok || rewrite.text === flaggedText || (await isDuplicateText(rewrite.text))) {
          break;
        }
        const recheck = await factCheckReply({ ...checkInput, replyText: rewrite.text });
        stats.factChecked += 1;
        stats.factRepaired += 1;
        // Compare terminal outcomes (no attempts left on either side) so a
        // rewrite that checks out WORSE is thrown away rather than acted on.
        const before = routeVerdict({ verdict: flaggedVerdict, selfApproved, repairsLeft: 0 });
        const after = routeVerdict({ verdict: recheck, selfApproved, repairsLeft: 0 });
        const adopted = routeIsAtLeastAsGood(after, before);
        repair = {
          attempts: config.factCheck.repairAttempts - repairsLeft,
          adopted,
          flaggedText,
          flaggedVerdict,
          rewriteVerdict: recheck,
        };
        if (!adopted) {
          console.log(
            `[factcheck] repair discarded (rewrite checked out worse: ${before} → ${after})`,
          );
          break;
        }
        text = rewrite.text;
        factCheck = recheck;
        if (after === "post") {
          stats.factRescued += 1;
          console.log(
            `[factcheck] repaired and cleared (confidence ${recheck!.confidence}) — posting without a human: ${recheck!.summary}`,
          );
        }
      }

      switch (routeVerdict({ verdict: factCheck, selfApproved, repairsLeft: 0 })) {
        case "reject":
          status = ReplyStatus.SKIPPED;
          approvedAt = null;
          skipReason = FACTCHECK_REJECT_SKIP_REASON;
          stats.factRejected += 1;
          console.log(
            `[factcheck] AUTO-REJECTED (disproved, confidence ${factCheck!.confidence}): ${factCheck!.summary}`,
          );
          break;
        case "queue":
          if (selfApproved) {
            status = ReplyStatus.PENDING_APPROVAL;
            approvedAt = null;
            stats.factFlagged += 1;
            console.log(
              `[factcheck] demoted to manual approval${repair ? " (rewrite didn't clear it)" : ""}: ${
                factCheck
                  ? `accurate=${factCheck.accurate} confidence=${factCheck.confidence} — ${factCheck.summary}`
                  : "check could not be completed"
              }`,
            );
          }
          break;
        case "post":
        case "repair":
          break; // the self-approval stands
      }
    }

    // Route the link through a click-tracking redirect (no-op when disabled).
    const tracked = await createTrackedLink(link.url, "reply");
    const created = await prisma.botReply.create({
      data: {
        postId: evaluation.postId,
        replyText: text,
        linkUrl: tracked.url,
        linkAnchor: link.anchor,
        status,
        approvedAt,
        ...(skipReason ? { skipReason } : {}),
        ...(factChecked
          ? {
              factCheck: {
                ...(factCheck ?? {
                  accurate: false,
                  confidence: 0,
                  issues: ["fact check could not be completed"],
                  summary: "check errored or was refused — unverified",
                  model: config.llm.model,
                  checkedAt: new Date().toISOString(),
                }),
                ...(repair ? { repair } : {}),
              } as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
      select: { id: true },
    });
    if (tracked.id) {
      await prisma.trackedLink
        .update({ where: { id: tracked.id }, data: { sourceId: created.id } })
        .catch(() => {}); // drill-down only — never fail the reply over it
    }
    stats.generated += 1;
    if (status === ReplyStatus.APPROVED && flags.autonomous) stats.autoApproved += 1;
  }
}
