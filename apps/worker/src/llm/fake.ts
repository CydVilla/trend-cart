import type {
  CandidateEvaluationResult,
  ClassifyPostInput,
  GenerateReplyInput,
  JudgeSuggestionInput,
  LlmClient,
  SuggestionVerdict,
} from "@trendcart/shared";
import { findPromotionalMatch, findSensitiveMatch } from "../filters.js";

/**
 * Deterministic heuristic client for exercising the full evaluation/reply
 * pipeline without API calls (USE_FAKE_LLM=true). Mirrors the real client's
 * decision shape. Evaluations it produces are stamped model="fake" and are
 * never acted on by a real-LLM reply pipeline.
 */
export class FakeLlmClient implements LlmClient {
  async classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult> {
    const base = {
      recommendedSearchQuery: null,
      linkConfidence: 0,
      suggestedNewCategory: null,
    };
    if (findSensitiveMatch(input.postText)) {
      return {
        ...base,
        productIntentScore: 0,
        safetyStatus: "unsafe",
        recommendedCategorySlug: null,
        shouldReply: false,
        reason: "fake: sensitive-topic pattern matched",
        suggestedReplyAngle: null,
      };
    }
    if (findPromotionalMatch(input.postText)) {
      return {
        ...base,
        productIntentScore: 5,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        shouldReply: false,
        reason: "fake: post is itself promotional",
        suggestedReplyAngle: null,
      };
    }
    if (input.operatorNote) {
      return {
        ...base,
        productIntentScore: 85,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        recommendedSearchQuery: input.operatorNote.split(/\s+/).slice(0, 4).join(" "),
        linkConfidence: 90,
        shouldReply: true,
        reason: "fake: operator note provided — recommending per note",
        suggestedReplyAngle: input.operatorNote,
      };
    }
    if (input.isDirectRequest) {
      return {
        ...base,
        productIntentScore: 80,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        recommendedSearchQuery: input.postText
          .replace(/@[\w.-]+/g, "")
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .join(" "),
        linkConfidence: 75,
        shouldReply: true,
        reason: "fake: direct request — answering with a search recommendation",
        suggestedReplyAngle: "answer the requester directly",
      };
    }
    const slug = input.keywordMatches[0] ?? null;
    if (!slug) {
      return {
        ...base,
        productIntentScore: 25,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        shouldReply: false,
        reason: "fake: no category keyword matched",
        suggestedReplyAngle: null,
      };
    }
    return {
      ...base,
      productIntentScore: 78,
      safetyStatus: "safe",
      recommendedCategorySlug: slug,
      shouldReply: true,
      reason: `fake: keyword match on ${slug}, text reads as a genuine problem`,
      suggestedReplyAngle: "address the specific problem mentioned in the post",
    };
  }

  async generateReply(input: GenerateReplyInput): Promise<string> {
    // Mirror the real client: return TEXT ONLY within the budget; the caller
    // composes the anchor/facet, so truncation can never chop the link off.
    let text = "This is usually fixable with a specific well-reviewed pick. Solid option here:";
    if (text.length > input.textBudget) {
      text = `${text.slice(0, Math.max(0, input.textBudget - 1)).trimEnd()}…`;
    }
    return text;
  }

  async judgeDealSuggestion(input: JudgeSuggestionInput): Promise<SuggestionVerdict> {
    // Deterministic word overlap: the headline matches when it shares any
    // meaningful word with the lane criteria. No semantics — fake mode only
    // exercises the pipeline shape, and its verdicts are labeled as such.
    const words = new Set(
      input.topic
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
    const matches = input.itemTitle
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((w) => words.has(w));
    const title = input.itemTitle.toLowerCase();
    const highConversionLane = /nintendo|switch|joy-?con/.test(title)
      ? "nintendo-switch"
      : /playstation|\bps[45]\b|xbox/.test(title)
        ? "playstation-xbox"
        : /ssd|micro\s*sd|memory card|storage/.test(title)
          ? "storage-ssd"
          : /controller|replacement|charging dock|thumbstick/.test(title)
            ? "controllers-parts"
            : /gaming|keyboard|mouse|headset|gpu|graphics card/.test(title)
              ? "pc-gaming"
              : /figure|collectible|lego|pokemon|zelda|mario|marvel|star wars/.test(title)
                ? "collectibles-fandom"
                : /game|pre-?order|new release/.test(title)
                  ? "recent-games"
                  : "other";
    return {
      matches,
      confidence: matches ? 75 : 40,
      highConversionLane,
      purchaseIntentScore: highConversionLane === "other" ? 35 : 72,
      reason: `fake: ${matches ? "shares a keyword with" : "no keyword overlap with"} the lane topic`,
    };
  }
}
