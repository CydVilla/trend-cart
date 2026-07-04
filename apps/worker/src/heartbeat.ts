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

/** Upsert the heartbeat row. Never touches `paused`/`autonomous` — those belong to the operator. */
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

export type OperatorFlags = {
  /** Kill switch: all pipeline ticks stand down. */
  paused: boolean;
  /** Self-approval mode: high-confidence replies skip the manual queue. */
  autonomous: boolean;
};

let flagsCache: { value: OperatorFlags; fetchedAt: number } = {
  value: { paused: false, autonomous: false },
  fetchedAt: 0,
};

/** Operator-owned toggles, set by the dashboard, read every tick (30s cache). */
export async function getOperatorFlags(): Promise<OperatorFlags> {
  if (Date.now() - flagsCache.fetchedAt < 30_000) return flagsCache.value;
  const row = await prisma.workerHeartbeat.findUnique({
    where: { id: HEARTBEAT_ID },
    select: { paused: true, autonomous: true },
  });
  flagsCache = {
    value: { paused: row?.paused ?? false, autonomous: row?.autonomous ?? false },
    fetchedAt: Date.now(),
  };
  return flagsCache.value;
}

/** Operator kill switch, checked by evaluate/reply/poster ticks. */
export async function isPaused(): Promise<boolean> {
  return (await getOperatorFlags()).paused;
}
