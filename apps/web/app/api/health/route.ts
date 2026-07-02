import { NextResponse } from "next/server";
import { prisma } from "@trendcart/db";

export const dynamic = "force-dynamic";

const HEARTBEAT_STALE_MS = 2 * 60_000;

/** 200 while the worker heartbeat is fresh; 500 otherwise (external pingers). */
export async function GET(): Promise<NextResponse> {
  try {
    const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });
    const ageMs = heartbeat ? Date.now() - heartbeat.updatedAt.getTime() : null;
    const workerAlive = ageMs !== null && ageMs < HEARTBEAT_STALE_MS;
    return NextResponse.json(
      {
        db: true,
        workerAlive,
        workerLastSeen: heartbeat?.updatedAt ?? null,
        paused: heartbeat?.paused ?? false,
        dryRun: heartbeat?.dryRun ?? null,
      },
      { status: workerAlive ? 200 : 500 },
    );
  } catch {
    return NextResponse.json({ db: false, workerAlive: false }, { status: 500 });
  }
}
