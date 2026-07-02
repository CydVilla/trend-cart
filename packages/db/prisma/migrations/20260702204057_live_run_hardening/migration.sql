-- CreateEnum
CREATE TYPE "PostSource" AS ENUM ('FIREHOSE', 'MANUAL');

-- AlterEnum
ALTER TYPE "ReplyStatus" ADD VALUE 'POSTING';

-- AlterTable
ALTER TABLE "BotReply" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "postedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CandidateEvaluation" ADD COLUMN     "model" TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN     "recommendedSearchQuery" TEXT,
ADD COLUMN     "suggestedNewCategory" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "deadAt" TIMESTAMP(3),
ADD COLUMN     "matchedKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "source" "PostSource" NOT NULL DEFAULT 'FIREHOSE';

-- CreateTable
CREATE TABLE "AuthorOptOut" (
    "did" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthorOptOut_pkey" PRIMARY KEY ("did")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "replyMode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "postingState" TEXT NOT NULL,
    "loops" JSONB NOT NULL,
    "counters" JSONB NOT NULL,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);
