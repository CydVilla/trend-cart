-- AlterTable
ALTER TABLE "BotReply" ADD COLUMN     "replyRepostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyQuoteCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RadarPost" ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "repostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quoteCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outcomeCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DealPost" ADD COLUMN     "likeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "repostCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quoteCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "outcomeCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProductCategory" ADD COLUMN     "minEngagementScore" INTEGER;

-- CreateTable
CREATE TABLE "EngagementSnapshot" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "repostCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "quoteCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EngagementSnapshot_kind_sourceId_capturedAt_idx" ON "EngagementSnapshot"("kind", "sourceId", "capturedAt");
