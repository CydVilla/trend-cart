/** Structured result of evaluating one candidate post. */
export type CandidateEvaluationResult = {
  /** 0–100. How strongly does this post express a solvable product need? */
  productIntentScore: number;
  safetyStatus: "safe" | "unsafe" | "uncertain";
  /** Must map to an active ProductCategory, or null if nothing fits. */
  recommendedCategorySlug: string | null;
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

export type ClassifyPostInput = {
  postText: string;
  authorHandle: string | null;
  /** Active categories the classifier may choose from. */
  categories: CategoryContext[];
  /** Slugs matched by the cheap keyword pre-filter, as a hint. */
  keywordMatches: string[];
};

export type GenerateReplyInput = {
  postText: string;
  categoryName: string;
  suggestedReplyAngle: string | null;
  /** Full URL of our recommendation page to include in the reply. */
  recommendationPageUrl: string;
  /** Product names to optionally mention (never as links). */
  productNames: string[];
  maxLength: number;
};

/**
 * Provider-agnostic LLM interface. Implementations: AnthropicLlmClient (Phase 4).
 * Keeping this narrow makes it trivial to swap providers or mock in tests.
 */
export interface LlmClient {
  classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult>;
  generateReply(input: GenerateReplyInput): Promise<string>;
}
