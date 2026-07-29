import { PrismaClient } from "@prisma/client";

// Singleton so Next.js hot-reload in dev doesn't exhaust DB connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Prisma sizes its pool at (cpus * 2 + 1) per client, which is 17 on a Heroku
 * dyno regardless of dyno size. web and worker each hold their own pool, so the
 * two can demand 34 connections against essential-0's hard cap of 20 — pools
 * grow lazily, so this surfaces as an intermittent "FATAL: too many
 * connections" under burst rather than a steady failure. Budget instead:
 * 8 + 8 leaves 4 for release-phase migrations, `heroku run`, and psql.
 */
const DEFAULT_CONNECTION_LIMIT = 8;

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

// Re-export generated model types and enums (Post, ProductCategory, SafetyStatus, ...)
export * from "@prisma/client";

// Funnel analytics (dashboard + insights report)
export * from "./analytics";
