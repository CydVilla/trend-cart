import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type {
  CandidateEvaluationResult,
  ClassifyPostInput,
  GenerateReplyInput,
  LlmClient,
} from "@trendcart/shared";

/** Schema the model's structured output must satisfy. */
const EvaluationSchema = z.object({
  productIntentScore: z.number(),
  safetyStatus: z.enum(["safe", "unsafe", "uncertain"]),
  recommendedCategorySlug: z.string().nullable(),
  shouldReply: z.boolean(),
  reason: z.string(),
  suggestedReplyAngle: z.string().nullable(),
});

const CLASSIFY_SYSTEM = `You are the candidate-evaluation engine for TrendCart, a deliberately conservative Bluesky bot. TrendCart replies to posts where someone describes a real, everyday problem that curated products could genuinely help with, and links to a recommendation page on its own site. Its survival depends on NEVER being spammy, intrusive, or tone-deaf.

Evaluate the post and decide whether a reply would be genuinely welcome.

Rules, in priority order:
1. Safety first. Mark safetyStatus "unsafe" if the post touches tragedy, death, illness (physical or mental), personal crisis, politics, religion, violence, adult content, financial hardship, or anything where a product suggestion could feel exploitative. When unsure, use "uncertain". Only use "safe" when the topic is clearly benign.
2. Ads are not opportunities. If the post is itself promotional (deals, affiliate links, product announcements, self-promotion, giveaways, bot-generated content), set productIntentScore near 0 and shouldReply false.
3. Product intent means a PROBLEM, not a mention. "My cables are a mess" is high intent. "I bought new cable ties today" is low intent (already solved). Someone proudly showing off their setup is low intent.
4. recommendedCategorySlug MUST be exactly one of the provided category slugs, or null if none fits well. Never invent a slug. A weak or forced fit is null.
5. shouldReply only when ALL hold: safetyStatus is "safe", productIntentScore is at least 70, a category fits well, and an unsolicited product suggestion would plausibly land as helpful rather than intrusive. A rant that wants sympathy, not solutions, is a no.
6. reason: one or two sentences explaining the decision — stored in a human-reviewed audit log.
7. suggestedReplyAngle: when shouldReply is true, one short line on what the reply should focus on (e.g. "cable management fixes the mess, not a new desk"); otherwise null.

Be strict. When in doubt, do not reply: a missed opportunity costs nothing, a bad reply damages trust permanently.`;

const REPLY_SYSTEM = `You write replies for TrendCart, a Bluesky account that suggests practical product categories to people describing everyday problems. You sound like a helpful person, never a marketer.

Hard requirements:
- Stay under the character limit you are given. This is a hard cap.
- Acknowledge the specific problem in the post, suggest 2-3 concrete product types in plain text (no links on them), then include the ONE provided URL verbatim as the only link.
- Exactly one link in the reply: the provided recommendation page URL.
- No hashtags, no @-mentions, no emoji unless it feels truly natural.
- No hype ("game changer", "you NEED this"), no fake urgency, no exclamation-point pileups.
- No medical, legal, or financial claims. No invented facts about products.
- Never say "as an AI" or similar.

Return ONLY the reply text, nothing else.`;

function buildClassifyPrompt(input: ClassifyPostInput): string {
  const categoryList = input.categories
    .map(
      (c) =>
        `- ${c.slug}: ${c.name} — ${c.description}\n  example problems: ${c.exampleProblems.join(" | ")}`,
    )
    .join("\n");
  return `Categories (recommendedCategorySlug must be one of these slugs, or null):
${categoryList}

Keyword pre-filter matched: ${input.keywordMatches.join(", ") || "none"}

Post by @${input.authorHandle ?? "unknown"}:
"""
${input.postText}
"""`;
}

function buildReplyPrompt(input: GenerateReplyInput): string {
  return `Character limit: ${input.maxLength}
Category: ${input.categoryName}
Product types you may mention: ${input.productNames.join(", ")}
Reply angle: ${input.suggestedReplyAngle ?? "address the specific problem in the post"}
Recommendation page URL (include verbatim, as the only link): ${input.recommendationPageUrl}

Post you are replying to:
"""
${input.postText}
"""`;
}

/**
 * Anthropic implementation of LlmClient.
 * Classification uses structured outputs (messages.parse + zod), so the result
 * always matches the schema; business-rule gates are enforced in evaluate.ts,
 * not here.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    // Zero-arg fallback lets the SDK resolve env/profile credentials.
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async classifyPost(input: ClassifyPostInput): Promise<CandidateEvaluationResult> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      // Classification is a scoped task — low effort keeps latency/cost down.
      output_config: { effort: "low", format: zodOutputFormat(EvaluationSchema) },
      system: CLASSIFY_SYSTEM,
      messages: [{ role: "user", content: buildClassifyPrompt(input) }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new Error(`classification produced no parseable output (stop: ${response.stop_reason})`);
    }
    return response.parsed_output;
  }

  async generateReply(input: GenerateReplyInput): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      output_config: { effort: "low" },
      system: REPLY_SYSTEM,
      messages: [{ role: "user", content: buildReplyPrompt(input) }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("reply generation was refused");
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new Error("reply generation returned empty text");
    return text;
  }
}
