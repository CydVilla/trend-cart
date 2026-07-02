import type {
  CandidateEvaluationResult,
  ClassifyPostInput,
  GenerateReplyInput,
  LlmClient,
} from "@trendcart/shared";
import { findPromotionalMatch, findSensitiveMatch } from "../filters.js";

/**
 * Deterministic heuristic client for exercising the full evaluation/reply
 * pipeline without API calls (USE_FAKE_LLM=true). Mirrors the real client's
 * decision shape: sensitive → unsafe, promo → reject, keyword match → high
 * intent, otherwise low intent.
 */
export class FakeLlmClient implements LlmClient {
  async classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult> {
    if (findSensitiveMatch(input.postText)) {
      return {
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
        productIntentScore: 5,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        shouldReply: false,
        reason: "fake: post is itself promotional",
        suggestedReplyAngle: null,
      };
    }
    const slug = input.keywordMatches[0] ?? null;
    if (!slug) {
      return {
        productIntentScore: 25,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        shouldReply: false,
        reason: "fake: no category keyword matched",
        suggestedReplyAngle: null,
      };
    }
    return {
      productIntentScore: 78,
      safetyStatus: "safe",
      recommendedCategorySlug: slug,
      shouldReply: true,
      reason: `fake: keyword match on ${slug}, text reads as a genuine problem`,
      suggestedReplyAngle: "address the specific problem mentioned in the post",
    };
  }

  async generateReply(input: GenerateReplyInput): Promise<string> {
    // Mirror the real client's shape: text is budgeted around the URL and the
    // URL is appended last, so truncation can never chop the link off.
    const textBudget = input.maxLength - input.recommendationPageUrl.length - 1;
    const products = input.productNames.slice(0, 3).join(", ");
    let text = `This is usually fixable with a few ${input.categoryName.toLowerCase()} pieces${
      products ? ` — think ${products}` : ""
    }. I put together a quick list here:`;
    if (text.length > textBudget) {
      text = `${text.slice(0, Math.max(0, textBudget - 1)).trimEnd()}…`;
    }
    return `${text} ${input.recommendationPageUrl}`;
  }
}
