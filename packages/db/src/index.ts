import { PrismaClient } from "@prisma/client";

// Singleton so Next.js hot-reload in dev doesn't exhaust DB connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Prisma sizes its pool at (cpus * 2 + 1) per client, which is 17 on a Heroku
 * dyno regardless of dyno size. web and worker each hold their own pool, so the
 * two can demand 34 connections against essential-0's hard cap of 20 — pools
 * grow lazily, so this surfaces as an intermittent "FATAL: too many
 * connections" under burst rather than a steady failure. Budget: 4 + 4
 * steady leaves room for the real killer — the deploy window, where old AND
 * new dynos hold pools simultaneously (4x4=16) alongside the release-phase
 * migration and any operator psql. Largest query batch is 7, so a pool of 4
 * briefly queues instead of erroring; queries are milliseconds each.
 */
const DEFAULT_CONNECTION_LIMIT = 4;

function connectionLimit(): number {
  const parsed = Number(process.env.DATABASE_CONNECTION_LIMIT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECTION_LIMIT;
}

/**
 * Hosted Postgres (e.g. Heroku) enforces TLS with a self-signed chain, and its
 * managed DATABASE_URL carries no sslmode param. Append one for remote hosts;
 * local URLs and URLs that already specify sslmode pass through untouched.
 * The pool bound applies everywhere so dev matches prod. Params are appended as
 * text rather than via URL parsing so the credentials are never re-encoded.
 */
function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return url;

  const params = new URLSearchParams();
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  if (!isLocal && !url.includes("sslmode=")) params.set("sslmode", "no-verify");
  if (!url.includes("connection_limit=")) params.set("connection_limit", String(connectionLimit()));

  if ([...params].length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl: databaseUrl() });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Essential-0 rides shared infrastructure that drops connections for a second
 * or two, several times a day (measured 2026-07-30: ~24 P1001s across 5h,
 * each self-healing instantly). One retry after a short pause absorbs a blip;
 * a genuine outage still surfaces on the second attempt.
 */
export async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "too many connections" is transient too: it appears in the ~1-minute
    // dyno-overlap window during deploys (old + new web/worker pools coexist)
    // and clears as the old dynos drain.
    if (
      !/Can't reach database server|Connection reset|ECONNREFUSED|ETIMEDOUT|too many connections/i.test(
        message,
      )
    ) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return await fn();
  }
}

// Re-export generated model types and enums (Post, ProductCategory, SafetyStatus, ...)
export * from "@prisma/client";

// Funnel analytics (dashboard + insights report)
export * from "./analytics";
