import { prisma, type Prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * Worker liveness + ground-truth mode, persisted so the dashboard shows what
 * the worker is ACTUALLY doing (not what the web process's env vars claim).
 * `paused` is operator-owned: the dashboard writes it, the worker only reads.
 */

export const HEARTBEAT_ID = "worker";

type LoopStatus = { lastTickAt: string; lastError: string | null };

const loops: Record<string, LoopStatus> = {};
let postingState = "unknown";
let countersRef: Record<string, unknown> = {};
const startedAt = new Date();

export function recordLoopTick(name: string, error?: unknown): void {
  loops[name] = {
    lastTickAt: new Date().toISOString(),
    lastError: error ? (error instanceof Error ? error.message : String(error)) : null,
  };
}

export function setPostingState(state: string): void {
  postingState = state;
}

export function setCountersRef(counters: Record<string, unknown>): void {
  countersRef = counters;
}

/** Upsert the heartbeat row. Never touches `paused` — that belongs to the operator. */
export async function flushHeartbeat(): Promise<void> {
  const data = {
    startedAt,
    dryRun: config.bot.dryRun,
    replyMode: config.bot.replyMode,
    model: config.llm.useFake ? "fake" : config.llm.model,
    postingState,
    loops: loops as unknown as Prisma.InputJsonValue,
    counters: countersRef as unknown as Prisma.InputJsonValue,
  };
  await prisma.workerHeartbeat.upsert({
    where: { id: HEARTBEAT_ID },
    create: { id: HEARTBEAT_ID, ...data },
    update: data,
  });
}

let pausedCache = { value: false, fetchedAt: 0 };

/** Operator kill switch, checked by evaluate/reply/poster ticks (30s cache). */
export async function isPaused(): Promise<boolean> {
  if (Date.now() - pausedCache.fetchedAt < 30_000) return pausedCache.value;
  const row = await prisma.workerHeartbeat.findUnique({
    where: { id: HEARTBEAT_ID },
    select: { paused: true },
  });
  pausedCache = { value: row?.paused ?? false, fetchedAt: Date.now() };
  return pausedCache.value;
}
