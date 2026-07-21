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
   * for recommendedSearchQuery both shows the product itself (or closely
   * related same-franchise items) AND lets a buyer order it right now (a
   * genuine pre-order page counts). Out-of-print/collector-only items and
   * titles with no listing yet score low even when results look relevant.
   * Below the floor, the query is never linked.
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

/** An image attached to the post: a thumbnail URL for vision + author alt text. */
export type PostImage = { url: string; alt: string | null };

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
  /** Images attached to the post (thumbnails + alt) — vision context so the
   *  model can SEE what was shared instead of guessing from text/hashtags. */
  images?: PostImage[];
  /** Top replies under the post — UNTRUSTED conversation context (what people
   *  are saying about it), used to sharpen the judgment and reply angle. */
  comments?: string[];
  /** TRUSTED note from the bot's operator (e.g. what a post's image shows). */
  operatorNote?: string | null;
  /** TRUSTED standing guidance the operator set — authoritative, overrides
   *  default judgment and learned guidelines (safety rules still apply). */
  operatorGuidance?: string | null;
  /** TRUSTED guidelines the bot distilled from past operator decisions. */
  learnedGuidelines?: string | null;
};

export type GenerateReplyInput = {
  postText: string;
  suggestedReplyAngle: string | null;
  /**
   * Character budget for the model's TEXT ONLY. The caller composes the final
   * reply as `${text} ${linkAnchor}${suffix}` with the link attached as a
   * rich-text facet — the model never sees or writes URLs.
   */
  textBudget: number;
  /** True when answering someone who tagged the bot — address them directly. */
  isDirectRequest?: boolean;
  /** Images attached to the post (thumbnails + alt) — lets the reply reference
   *  what was actually shared. */
  images?: PostImage[];
  /** Top replies under the post — UNTRUSTED context so the reply fits the
   *  conversation already happening. */
  comments?: string[];
  /** TRUSTED note from the bot's operator, overrides inferences from the post. */
  operatorNote?: string | null;
  /** TRUSTED standing guidance the operator set — authoritative for tone and
   *  what to recommend (overrides default judgment and learned guidelines). */
  operatorGuidance?: string | null;
  /** TRUSTED guidelines the bot distilled from past operator decisions. */
  learnedGuidelines?: string | null;
};

/** Revenue-oriented lane assigned to an RSS deal candidate. `other` is never
 * eligible for autonomous promotion; it exists so uncertain classifications
 * fail closed without inventing a fit. */
export type HighConversionLane =
  | "nintendo-switch"
  | "playstation-xbox"
  | "pc-gaming"
  | "storage-ssd"
  | "controllers-parts"
  | "collectibles-fandom"
  | "recent-games"
  | "giftable-under-75"
  | "other";

/** One RSS deal headline judged against a suggestion source's topical lane. */
export type JudgeSuggestionInput = {
  /** Raw RSS item title — UNTRUSTED external text. */
  itemTitle: string;
  /** The source's plain-words criteria for what belongs in its lane. */
  topic: string;
};

/** Topical-gate verdict for one deal suggestion (advisory; stored for audit). */
export type SuggestionVerdict = {
  matches: boolean;
  /** 0–100: how confidently the item fits the lane. */
  confidence: number;
  /** The single best revenue-oriented lane. `other` is not postable. */
  highConversionLane: HighConversionLane;
  /** 0–100: likelihood that a deal-account follower would click with real
   * purchase intent, independent of the reported discount amount. */
  purchaseIntentScore: number;
  /** One short line for the audit trail. */
  reason: string;
};

/**
 * Provider-agnostic LLM interface. Implementations: AnthropicLlmClient,
 * FakeLlmClient. Keeping this narrow makes it trivial to swap or mock.
 */
export interface LlmClient {
  classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult>;
  generateReply(input: GenerateReplyInput): Promise<string>;
  judgeDealSuggestion(input: JudgeSuggestionInput): Promise<SuggestionVerdict>;
}
