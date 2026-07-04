-- AlterTable
ALTER TABLE "BotReply" ADD COLUMN     "editedByOperator" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outcomeCheckedAt" TIMESTAMP(3),
ADD COLUMN     "replyLikeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyReplyCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WorkerHeartbeat" ADD COLUMN     "autonomous" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BotMemory" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "basis" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotMemory_pkey" PRIMARY KEY ("id")
);
