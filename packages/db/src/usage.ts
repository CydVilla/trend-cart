/**
 * LLM spend ledger — pricing, recording, aggregation.
 *
 * Every Anthropic call the bot makes writes one row here with the token counts
 * the API itself reported, priced at the rates in force when it ran. Cost is
 * computed and stored at write time on purpose: a spend history that silently
 * re-prices itself when Anthropic changes a rate card is not a history.
 *
 * Lives in @trendcart/db rather than @trendcart/shared because both the worker
 * (which writes) and the web dashboard (which reads, and also makes one call of
 * its own on "Regenerate") already depend on this package.
 */

import { prisma } from "./index";

/** Which loop spent the money. Used as the grouping key on the dashboard. */
export type LlmOperation =
  | "classify"
  | "reply"
  | "regenerate"
  | "factcheck"
  | "deal-factcheck"
  | "deal-lane"
  | "banter"
  | "apology"
  | "reflect"
  | "insights";

/** Human labels for the dashboard, and the order they read best in. */
export const LLM_OPERATIONS: { key: LlmOperation; label: string; note: string }[] = [
  { key: "classify", label: "Classify", note: "every candidate post the LLM evaluates" },
  { key: "reply", label: "Write reply", note: "drafting the reply text" },
  { key: "regenerate", label: "Regenerate", note: "your dashboard rewrite button" },
  { key: "factcheck", label: "Fact check", note: "web-search check before a self-approved reply posts" },
  { key: "deal-factcheck", label: "Deal check", note: "web-search corroboration before a deal posts" },
  { key: "deal-lane", label: "Deal lane gate", note: "is this RSS item on-topic for a lane" },
  { key: "banter", label: "Banter judge", note: "the daily humor lane" },
  { key: "apology", label: "Apology gate", note: "is a reply negative toward the bot" },
  { key: "reflect", label: "Reflection", note: "daily learning pass over your decisions" },
  { key: "insights", label: "Insights", note: "daily funnel report" },
];

type ModelPrice = { inputPerMTok: number; outputPerMTok: number };

/**
 * USD per million tokens, Anthropic first-party rates (verified 2026-08-05).
 * Keys are matched as prefixes so dated snapshots (claude-haiku-4-5-20251001)
 * resolve to their family.
 */
const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
};

/** Unknown model → priced at the most expensive card we know, so a surprise
 *  never reads as free. The dashboard flags these rows. */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };

/** Cache reads bill at 0.1x input. Writes bill at 1.25x (5-minute TTL) or
 *  2x (1-hour TTL) — classification uses the 1h TTL, see llm/anthropic.ts. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;
export type CacheWriteTtl = keyof typeof CACHE_WRITE_MULTIPLIER;

/** Anthropic's server-side web_search tool: $10 per 1,000 searches. */
const WEB_SEARCH_USD = 10 / 1000;

export function modelPrice(model: string): { price: ModelPrice; known: boolean } {
  const match = Object.entries(MODEL_PRICES)
    .filter(([key]) => model.startsWith(key))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match ? { price: match[1], known: true } : { price: FALLBACK_PRICE, known: false };
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
};

/** Cost in MICRO-dollars (1e-6 USD) — integers, so sums never drift. */
export function costMicros(model: string, usage: TokenUsage, ttl: CacheWriteTtl): number {
  const { price } = modelPrice(model);
  const usd =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      usage.cacheWriteTokens * price.inputPerMTok * CACHE_WRITE_MULTIPLIER[ttl]) /
      1_000_000 +
    usage.webSearches * WEB_SEARCH_USD;
  return Math.round(usd * 1_000_000);
}

/** The subset of Anthropic's `usage` object we care about, defensively read
 *  (fields come and go across SDK versions; a missing one must never throw). */
export function readAnthropicUsage(raw: unknown, webSearches = 0): TokenUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    webSearches,
  };
}

/**
 * Record one billed call. FIRE AND FORGET: accounting must never break a
 * pipeline loop, so every failure is swallowed with a warning. The caller is
 * expected NOT to await this on the hot path.
 */
export function recordLlmUsage(args: {
  operation: LlmOperation;
  model: string;
  usage: TokenUsage;
  /** TTL of the prompt-cache breakpoint, when this call has one. */
  cacheWriteTtl?: CacheWriteTtl;
}): void {
  const ttl = args.cacheWriteTtl ?? "5m";
  void prisma.llmUsage
    .create({
      data: {
        operation: args.operation,
        model: args.model,
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cacheReadTokens: args.usage.cacheReadTokens,
        cacheWriteTokens: args.usage.cacheWriteTokens,
        webSearches: args.usage.webSearches,
        costMicros: costMicros(args.model, args.usage, ttl),
      },
    })
    .catch((error: unknown) => {
      console.warn(`[usage] could not record ${args.operation} spend:`, error);
    });
}

/** Convenience wrapper for the common shape: an SDK response with `.usage`. */
export function recordResponseUsage(
  operation: LlmOperation,
  model: string,
  response: { usage?: unknown } | null | undefined,
  options: { webSearches?: number; cacheWriteTtl?: CacheWriteTtl } = {},
): void {
  recordLlmUsage({
    operation,
    model,
    usage: readAnthropicUsage(response?.usage, options.webSearches ?? 0),
    cacheWriteTtl: options.cacheWriteTtl,
  });
}

export type SpendRow = {
  operation: string;
  calls: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
};

export type SpendWindow = {
  since: Date;
  totalMicros: number;
  calls: number;
  byOperation: SpendRow[];
  /** Cache effectiveness: reads / (reads + writes). Null when nothing cached. */
  cacheHitRate: number | null;
};

async function windowFor(since: Date): Promise<SpendWindow> {
  const grouped = await prisma.llmUsage.groupBy({
    by: ["operation"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: {
      costMicros: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      webSearches: true,
    },
  });
  const byOperation: SpendRow[] = grouped
    .map((g) => ({
      operation: g.operation,
      calls: g._count._all,
      costMicros: g._sum.costMicros ?? 0,
      inputTokens: g._sum.inputTokens ?? 0,
      outputTokens: g._sum.outputTokens ?? 0,
      cacheReadTokens: g._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: g._sum.cacheWriteTokens ?? 0,
      webSearches: g._sum.webSearches ?? 0,
    }))
    .sort((a, b) => b.costMicros - a.costMicros);

  const reads = byOperation.reduce((sum, r) => sum + r.cacheReadTokens, 0);
  const writes = byOperation.reduce((sum, r) => sum + r.cacheWriteTokens, 0);
  return {
    since,
    totalMicros: byOperation.reduce((sum, r) => sum + r.costMicros, 0),
    calls: byOperation.reduce((sum, r) => sum + r.calls, 0),
    byOperation,
    cacheHitRate: reads + writes > 0 ? reads / (reads + writes) : null,
  };
}

export type DailySpend = { day: string; costMicros: number; calls: number };

/**
 * Per-day totals for the last `days` days, oldest first, with empty days
 * filled in — a bar chart with holes in it lies about the trend.
 */
export async function dailyLlmSpend(days: number): Promise<DailySpend[]> {
  const since = startOfUtcDay(new Date(Date.now() - (days - 1) * 86_400_000));
  const rows = await prisma.llmUsage.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, costMicros: true },
  });
  const buckets = new Map<string, DailySpend>();
  for (let i = 0; i < days; i += 1) {
    const day = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(day, { day, costMicros: 0, calls: 0 });
  }
  for (const row of rows) {
    const bucket = buckets.get(row.createdAt.toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.costMicros += row.costMicros;
    bucket.calls += 1;
  }
  return [...buckets.values()];
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Spend over the three windows the dashboard shows. Queried in SEQUENCE, not
 * Promise.all — essential-0 shares a ~20-connection cap with the worker and
 * the pool here is 4 (see packages/db/src/index.ts).
 */
export async function summarizeLlmSpend(): Promise<{
  today: SpendWindow;
  week: SpendWindow;
  month: SpendWindow;
  /** Rows priced with the unknown-model fallback — surfaced so a wrong number
   *  announces itself instead of quietly under- or over-reporting. */
  unknownModels: string[];
}> {
  const now = Date.now();
  const today = await windowFor(new Date(now - 86_400_000));
  const week = await windowFor(new Date(now - 7 * 86_400_000));
  const month = await windowFor(new Date(now - 30 * 86_400_000));
  const models = await prisma.llmUsage.groupBy({
    by: ["model"],
    where: { createdAt: { gte: new Date(now - 30 * 86_400_000) } },
  });
  const unknownModels = models
    .map((m) => m.model)
    .filter((model) => model !== "fake" && !modelPrice(model).known);
  return { today, week, month, unknownModels };
}

/** Ledger rows older than this are pruned — the dashboard only looks back 30d. */
export const USAGE_RETENTION_DAYS = 90;

export async function pruneLlmUsage(): Promise<number> {
  const { count } = await prisma.llmUsage.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000) } },
  });
  return count;
}

/** Micro-dollars → "$1.23" / "$0.0041" (small numbers need the precision). */
export function formatUsd(micros: number): string {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
