import Anthropic from "@anthropic-ai/sdk";
import { modelCapabilities } from "@trendcart/shared";
import { llmBillingBlocked, noteLlmBillingBlocked, noteLlmCallSucceeded } from "./llm-health.js";

/**
 * Plumbing for the worker's periodic LLM jobs — banter, reflection, insights.
 * They call the SDK directly (structured output via messages.parse) rather
 * than through LlmClient, which left them outside both safety rails the
 * per-candidate loops get for free:
 *
 *  - The billing gate. Through the Sep 20 – Oct 19 credit outage these three
 *    kept firing a doomed request every tick while evaluate/reply stood down.
 *    gatedLlmCall() gives them the same contract: skip while the gate is
 *    armed, arm it on a billing error, clear it on success.
 *  - modelCapabilities(). Their params were hard-coded for Haiku 4.5; on a
 *    model that thinks by default, thinking spends from max_tokens first and a
 *    cap sized for the answer alone truncates the JSON mid-object.
 *
 * Deliberately config-free so the stand-down contract is unit-testable.
 */

let client: { apiKey: string; instance: Anthropic } | null = null;

/** One shared client for the jobs (was a fresh one per call). 60s timeout: a
 *  hung call must never wedge a worker loop. */
export function llmJobClient(apiKey: string): Anthropic {
  if (client?.apiKey !== apiKey) {
    client = { apiKey, instance: new Anthropic({ apiKey, timeout: 60_000 }) };
  }
  return client.instance;
}

export type JobEffort = "low" | "medium" | "high";

/**
 * Request params that stay valid across models. `answerTokens` is what the
 * structured answer itself needs; models that think by default get 4× (floor
 * 1024) — the same headroom AnthropicLlmClient uses. `effort` is dropped where
 * the model rejects it (Haiku 4.5), and omitted entirely when the job wants
 * the model's default.
 *
 * No temperature knob: none of these jobs pin it (banter wants the default
 * variance) and Haiku 5.5 400s on a non-default value. A job that ever needs
 * one should gate it on `modelCapabilities().temperature` here.
 */
export function llmJobParams(
  model: string,
  opts: { answerTokens: number; effort?: JobEffort },
): { max_tokens: number; effort: { effort?: JobEffort } } {
  const caps = modelCapabilities(model);
  return {
    max_tokens: caps.thinksByDefault ? Math.max(opts.answerTokens * 4, 1024) : opts.answerTokens,
    effort: caps.effort && opts.effort ? { effort: opts.effort } : {},
  };
}

/**
 * Run one job call behind the shared billing gate. Returns null when the job
 * should stand down — the gate was already armed (no request sent) or this
 * call armed it (an out-of-credit request is rejected before inference, so
 * nothing was spent). Every other error is rethrown untouched: an ordinary
 * failure is still the job's to count and log.
 */
export async function gatedLlmCall<T>(call: () => Promise<T>): Promise<T | null> {
  if (llmBillingBlocked()) return null;
  try {
    const result = await call();
    noteLlmCallSucceeded();
    return result;
  } catch (error) {
    if (noteLlmBillingBlocked(error)) return null;
    throw error;
  }
}
