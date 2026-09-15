import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@trendcart/db";
import { config } from "./config.js";
import { HEARTBEAT_ID } from "./heartbeat.js";

/**
 * LLM FALLBACK MODE — what the bot does when the Anthropic credits run out.
 *
 * Running dry is not an error the pipeline can retry its way out of: it lasts
 * until someone tops the account up, which may be weeks. Before this module
 * that failure arrived as a plain 400 and was treated as a CONTENT failure —
 * each candidate was blamed, retried three times, and written off as
 * permanently UNCERTAIN/FAILED. A month of that would have ground the whole
 * queue into tombstones and left nothing to resume.
 *
 * So credit exhaustion is its own class of failure. The first one LATCHES a
 * persisted flag; every model-dependent loop then stands down without writing
 * a verdict, leaving candidates PENDING exactly where they were. Everything
 * that costs nothing keeps running — posting, engagement measurement,
 * takedowns, opt-outs, click tracking, and the whole deal channel (which makes
 * no Anthropic calls at all). A periodic probe clears the latch by itself once
 * credits return; no redeploy needed.
 */

/** How often the probe re-checks whether credits are back. */
const PROBE_INTERVAL_MS = 60 * 60_000;
/** Latch state is read on every LLM-driven tick — cache it like operator flags. */
const CACHE_MS = 30_000;

/** Billing/credit language across the shapes Anthropic has used for it. The
 *  match is deliberately narrow: a false latch silences the bot, so anything
 *  that isn't clearly about money stays a normal (retryable) error. */
const CREDIT_PATTERN =
  /credit balance|insufficient (credit|funds|balance|quota)|billing|payment (method|required)|purchase credits|spending limit|quota exceeded/i;

/**
 * True when Anthropic refused because the account cannot pay, not because the
 * request was wrong. Checks the message rather than the status code alone: the
 * same 400 carries both ordinary validation errors and the credit refusal, and
 * blaming a post for the latter is what this whole module exists to prevent.
 */
export function isCreditExhaustionError(error: unknown): boolean {
  if (
    !(
      error instanceof Anthropic.BadRequestError ||
      error instanceof Anthropic.PermissionDeniedError ||
      error instanceof Anthropic.RateLimitError
    )
  ) {
    return false;
  }
  // `type` is the API's own error classification; "billing_error" is
  // unambiguous, everything else has to clear the message test.
  const type = (error as { type?: unknown }).type;
  if (typeof type === "string" && type === "billing_error") return true;
  return CREDIT_PATTERN.test(error.message ?? "");
}

type LatchState = { outOfCreditsAt: Date | null };
let cache: { value: LatchState; fetchedAt: number } | null = null;

async function readLatch(): Promise<LatchState> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.value;
  const row = await prisma.workerHeartbeat.findUnique({
    where: { id: HEARTBEAT_ID },
    select: { llmOutOfCreditsAt: true },
  });
  const value = { outOfCreditsAt: row?.llmOutOfCreditsAt ?? null };
  cache = { value, fetchedAt: Date.now() };
  return value;
}

/**
 * The guard every model-dependent tick calls first. True = stand down.
 *
 * Also true when there is no API key at all: a keyless deploy should run the
 * free channels rather than throw its way through every loop. USE_FAKE_LLM is
 * exempt — the fake client is the offline test path and costs nothing.
 */
export async function llmUnavailable(): Promise<boolean> {
  if (config.llm.useFake) return false;
  if (!config.llm.anthropicApiKey) return true;
  return (await readLatch()).outOfCreditsAt !== null;
}

/** When the bot ran dry, for the dashboard and the startup banner. */
export async function outOfCreditsSince(): Promise<Date | null> {
  return (await readLatch()).outOfCreditsAt;
}

/**
 * Enter fallback mode. Idempotent — the first caller stamps the time and the
 * rest are no-ops, so a burst of in-flight calls failing together reads as one
 * event rather than repeatedly resetting the clock.
 */
export async function latchOutOfCredits(source: string, message: string): Promise<void> {
  const existing = await readLatch();
  if (existing.outOfCreditsAt !== null) return;
  const now = new Date();
  await prisma.workerHeartbeat.updateMany({
    where: { id: HEARTBEAT_ID, llmOutOfCreditsAt: null },
    data: { llmOutOfCreditsAt: now },
  });
  cache = { value: { outOfCreditsAt: now }, fetchedAt: Date.now() };
  console.error(
    `[credits] OUT OF CREDITS (via ${source}): ${message}\n` +
      `[credits] LLM fallback mode ON — evaluation, replies, banter and the learning loop ` +
      `stand down; posting, outcomes, takedowns, opt-outs and the deal channel keep running. ` +
      `Candidates stay PENDING, not failed. Re-probing hourly.`,
  );
}

/** Leave fallback mode (probe succeeded, or the operator cleared it). */
export async function clearOutOfCredits(reason: string): Promise<void> {
  const existing = await readLatch();
  if (existing.outOfCreditsAt === null) return;
  await prisma.workerHeartbeat.update({
    where: { id: HEARTBEAT_ID },
    data: { llmOutOfCreditsAt: null },
  });
  cache = { value: { outOfCreditsAt: null }, fetchedAt: Date.now() };
  console.log(`[credits] credits are back (${reason}) — LLM fallback mode OFF, loops resume.`);
}

/**
 * Shared catch-block handler. Returns true when the error was a credit refusal
 * (and the latch is now set), telling the caller to abandon the tick WITHOUT
 * blaming whatever it was working on.
 */
export async function handleLlmError(source: string, error: unknown): Promise<boolean> {
  if (!isCreditExhaustionError(error)) return false;
  await latchOutOfCredits(source, error instanceof Error ? error.message : String(error));
  return true;
}

export type CreditProbeStats = { probes: number; recovered: number };

/**
 * Hourly: is the account payable again? One 1-token call — a few
 * hundredths of a cent when it works, and free when it doesn't, because the
 * refusal happens before any tokens are billed.
 */
export async function creditProbeTick(stats: CreditProbeStats): Promise<void> {
  const latch = await readLatch();
  if (latch.outOfCreditsAt === null) return;
  if (Date.now() - latch.outOfCreditsAt.getTime() < PROBE_INTERVAL_MS) return;
  if (!config.llm.anthropicApiKey) return; // nothing to probe with

  stats.probes += 1;
  const client = new Anthropic({ apiKey: config.llm.anthropicApiKey, timeout: 30_000 });
  try {
    await client.messages.create({
      model: config.llm.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }],
    });
  } catch (error) {
    if (isCreditExhaustionError(error)) {
      // Still dry. Re-stamp so the next probe is an hour from NOW, not an hour
      // from the original outage — otherwise every tick would probe.
      await prisma.workerHeartbeat.update({
        where: { id: HEARTBEAT_ID },
        data: { llmOutOfCreditsAt: new Date() },
      });
      cache = null;
      return;
    }
    // Anything else (network blip, overload) is inconclusive: leave the latch
    // alone and try again next hour rather than declaring recovery.
    console.warn(
      `[credits] probe inconclusive: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
  stats.recovered += 1;
  await clearOutOfCredits("probe succeeded");
}
