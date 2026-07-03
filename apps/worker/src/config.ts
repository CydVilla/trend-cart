import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { envBool, envInt, envString, requireEnv } from "@trendcart/shared";

// Load the repo-root .env whether we're run from the repo root or apps/worker.
for (const candidate of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(candidate)) {
    loadEnv({ path: candidate });
    break;
  }
}

export type ReplyMode = "dry_run" | "manual" | "auto";

function parseReplyMode(raw: string): ReplyMode {
  if (raw === "dry_run" || raw === "manual" || raw === "auto") return raw;
  throw new Error(`REPLY_MODE must be dry_run | manual | auto, got: ${raw}`);
}

const useFakeLlm = envBool("USE_FAKE_LLM", false);
let dryRun = envBool("DRY_RUN", true);
// Fail-safe: heuristic fake verdicts must never post to real people. A
// leftover USE_FAKE_LLM=true forces dry-run rather than trusting env-var
// discipline across three independent variables.
if (useFakeLlm && !dryRun) {
  console.warn("USE_FAKE_LLM=true forces DRY_RUN=true — fake verdicts never post live.");
  dryRun = true;
}

export const config = {
  databaseUrl: requireEnv("DATABASE_URL"),

  bluesky: {
    handle: envString("BOT_ACCOUNT_HANDLE", ""),
    appPassword: envString("BOT_APP_PASSWORD", ""),
    jetstreamUrl: envString("JETSTREAM_URL", "wss://jetstream2.us-east.bsky.network/subscribe"),
  },

  llm: {
    anthropicApiKey: envString("ANTHROPIC_API_KEY", ""),
    model: envString("ANTHROPIC_MODEL", "claude-opus-4-8"),
    /* Deterministic fake client for pipeline testing without API spend */
    useFake: useFakeLlm,
    maxEvalsPerHour: envInt("MAX_LLM_EVALS_PER_HOUR", 40),
    /* Firehose posts wait this long before evaluation so the engagement
       snapshot is meaningful; manually injected posts skip the wait. */
    evalMinPostAgeMinutes: envInt("EVAL_MIN_POST_AGE_MINUTES", 30),
  },

  site: {
    publicUrl: envString("PUBLIC_SITE_URL", "http://localhost:3000"),
    amazonAssociateTag: envString("AMAZON_ASSOCIATE_TAG", ""),
  },

  ingest: {
    minPostLength: envInt("MIN_POST_LENGTH", 40),
    requireEnglish: envBool("REQUIRE_ENGLISH", true),
    rehydrateIntervalMinutes: envInt("REHYDRATE_INTERVAL_MINUTES", 15),
    rehydrateMaxAgeHours: envInt("REHYDRATE_MAX_AGE_HOURS", 24),
  },

  bot: {
    dryRun,
    replyMode: parseReplyMode(envString("REPLY_MODE", "manual")),
    maxRepliesPerHour: envInt("MAX_REPLIES_PER_HOUR", 3),
    maxRepliesPerDay: envInt("MAX_REPLIES_PER_DAY", 20),
    replyMaxLength: envInt("REPLY_MAX_LENGTH", 240),
    minProductIntentScore: envInt("MIN_PRODUCT_INTENT_SCORE", 70),
    authorCooldownHours: envInt("AUTHOR_COOLDOWN_HOURS", 168),
    categoryCooldownMinutes: envInt("CATEGORY_COOLDOWN_MINUTES", 120),
    globalReplyCooldownMinutes: envInt("GLOBAL_REPLY_COOLDOWN_MINUTES", 10),
  },
} as const;
