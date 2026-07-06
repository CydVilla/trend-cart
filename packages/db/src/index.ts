import { PrismaClient } from "@prisma/client";

// Singleton so Next.js hot-reload in dev doesn't exhaust DB connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Hosted Postgres (e.g. Heroku) enforces TLS with a self-signed chain, and its
 * managed DATABASE_URL carries no sslmode param. Append one for remote hosts;
 * local URLs and URLs that already specify sslmode pass through untouched.
 */
function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes("sslmode=") || /@(localhost|127\.0\.0\.1)/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sslmode=no-verify`;
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl: databaseUrl() });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export generated model types and enums (Post, ProductCategory, SafetyStatus, ...)
export * from "@prisma/client";

// Funnel analytics (dashboard + insights report)
export * from "./analytics";
