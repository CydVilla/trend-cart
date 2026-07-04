/** Structured result of evaluating one candidate post. */
export type CandidateEvaluationResult = {
  /** 0–100. How strongly would a product recommendation be welcomed here? */
  productIntentScore: number;
  safetyStatus: "safe" | "unsafe" | "uncertain";
  /** Must map to an active ProductCategory, or null if nothing fits. */
  recommendedCategorySlug: string | null;
  /**
   * Direct Amazon search query for a specific identifiable product (e.g. a
   * game title someone is raving about). Used when no curated category
   * fits but a concrete recommendation still adds value. Null otherwise.
   */
  recommendedSearchQuery: string | null;
  /**
   * 0–100: how confident the model is that the first page of Amazon results
   * for recommendedSearchQuery shows the product itself or closely related
   * same-franchise items. Below the floor, the query is never linked.
   */
  linkConfidence: number;
  /** When real intent exists but no category fits: what category is missing? */
  suggestedNewCategory: string | null;
  shouldReply: boolean;
  /** Human-readable justification — stored for the audit log. */
  reason: string;
  /** One-line angle the reply should take, e.g. "cable management, not a new desk". */
  suggestedReplyAngle: string | null;
};

/** A category summary passed to the LLM so it can only pick from real, active categories. */
export type CategoryContext = {
  slug: string;
  name: string;
  description: string;
  exampleProblems: string[];
};

/** Public-profile snapshot of the post's author (null when the fetch failed). */
export type AuthorProfileContext = {
  followers: number;
  follows: number;
  posts: number;
  bio: string;
  accountAgeDays: number | null;
} | null;

export type ClassifyPostInput = {
  postText: string;
  authorHandle: string | null;
  /** Active categories the classifier may choose from. */
  categories: CategoryContext[];
  /** Slugs matched by the cheap keyword pre-filter, as a hint. */
  keywordMatches: string[];
  /** Engagement counts at evaluation time (post has matured before eval). */
  engagement: { likeCount: number; repostCount: number; replyCount: number; quoteCount: number };
  postAgeMinutes: number;
  authorProfile: AuthorProfileContext;
  /** True when the author tagged the bot asking for a recommendation. */
  isDirectRequest?: boolean;
  /** Parent-post text when the request was made under someone else's post. */
  threadContext?: string | null;
  /** TRUSTED note from the bot's operator (e.g. what a post's image shows). */
  operatorNote?: string | null;
  /** TRUSTED guidelines the bot distilled from past operator decisions. */
  learnedGuidelines?: string | null;
};

export type GenerateReplyInput = {
  postText: string;
  /** Null for dynamic search recommendations with no curated category. */
  categoryName: string | null;
  suggestedReplyAngle: string | null;
  /**
   * Character budget for the model's TEXT ONLY. The caller composes the final
   * reply as `${text} ${linkAnchor}${suffix}` with the link attached as a
   * rich-text facet — the model never sees or writes URLs.
   */
  textBudget: number;
  /** True when answering someone who tagged the bot — address them directly. */
  isDirectRequest?: boolean;
  /** TRUSTED note from the bot's operator, overrides inferences from the post. */
  operatorNote?: string | null;
  /** TRUSTED guidelines the bot distilled from past operator decisions. */
  learnedGuidelines?: string | null;
};

/**
 * Provider-agnostic LLM interface. Implementations: AnthropicLlmClient,
 * FakeLlmClient. Keeping this narrow makes it trivial to swap or mock.
 */
export interface LlmClient {
  classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult>;
  generateReply(input: GenerateReplyInput): Promise<string>;
}
