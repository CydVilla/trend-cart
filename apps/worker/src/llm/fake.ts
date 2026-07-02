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
 * decision shape. Evaluations it produces are stamped model="fake" and are
 * never acted on by a real-LLM reply pipeline.
 */
export class FakeLlmClient implements LlmClient {
  async classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult> {
    const base = {
      recommendedSearchQuery: null,
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
    // Mirror the real client's shape: text is budgeted around the URL+suffix
    // and both are appended last, so truncation can never chop the link off.
    const reservedChars = input.linkUrl.length + input.linkSuffix.length + 1;
    const textBudget = input.maxLength - reservedChars;
    const products = input.productNames.slice(0, 3).join(", ");
    let text = `This is usually fixable with a few ${(input.categoryName ?? "practical").toLowerCase()} pieces${
      products ? ` — think ${products}` : ""
    }. I put together a quick list here:`;
    if (text.length > textBudget) {
      text = `${text.slice(0, Math.max(0, textBudget - 1)).trimEnd()}…`;
    }
    return `${text} ${input.linkUrl}${input.linkSuffix}`;
  }
}
