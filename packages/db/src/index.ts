import { PrismaClient } from "./generated/client/index.js";

// Singleton so Next.js hot-reload in dev doesn't exhaust DB connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export generated model types and enums (Post, ProductCategory, SafetyStatus, ...)
export * from "./generated/client/index.js";
