import path from "node:path";
import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";

// Single source of truth: load the repo-root .env (Next only auto-loads app-local env files).
loadEnv({ path: path.resolve(process.cwd(), "../../.env") });
loadEnv({ path: path.resolve(process.cwd(), ".env") });

const nextConfig: NextConfig = {
  // Workspace packages ship TS source; Next transpiles them.
  transpilePackages: ["@trendcart/db", "@trendcart/shared"],
};

export default nextConfig;
