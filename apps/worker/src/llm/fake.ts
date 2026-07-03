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
    if (input.operatorNote) {
      return {
        ...base,
        productIntentScore: 85,
        safetyStatus: "safe",
        recommendedCategorySlug: null,
        recommendedSearchQuery: input.operatorNote.split(/\s+/).slice(0, 4).join(" "),
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
    const products = input.productNames.slice(0, 3).join(", ");
    let text = `This is usually fixable with a few ${(input.categoryName ?? "practical").toLowerCase()} pieces${
      products ? ` — think ${products}` : ""
    }. I put together a quick list here:`;
    if (text.length > input.textBudget) {
      text = `${text.slice(0, Math.max(0, input.textBudget - 1)).trimEnd()}…`;
    }
    return text;
  }
}
