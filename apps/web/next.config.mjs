import path from "node:path";
import { config as loadEnv } from "dotenv";

// Single source of truth: load the repo-root .env (Next only auto-loads
// app-local env files). Missing files are a no-op, e.g. on Heroku where
// config comes from real env vars.
loadEnv({ path: path.resolve(process.cwd(), "../../.env") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

/**
 * Plain .mjs on purpose: next.config.ts requires the TypeScript compiler at
 * runtime, which production installs prune (this crashed the Heroku dyno).
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  // Workspace packages ship TS source; Next transpiles them.
  transpilePackages: ["@trendcart/db", "@trendcart/shared"],
  // Prisma's generated client (with its native query engine) must be loaded
  // from node_modules at runtime, never bundled — bundling strands the
  // engine binary and crashes on hosted Linux.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
