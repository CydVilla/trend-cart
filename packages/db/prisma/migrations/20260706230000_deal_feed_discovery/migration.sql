-- CreateEnum
CREATE TYPE "ListingOrigin" AS ENUM ('WATCHLIST', 'DISCOVERED');

-- AlterEnum
ALTER TYPE "DealPostStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterEnum
ALTER TYPE "DealSource" ADD VALUE 'DISCOVERED';

-- AlterTable
ALTER TABLE "TrackedListing" ADD COLUMN     "origin" "ListingOrigin" NOT NULL DEFAULT 'WATCHLIST';

-- AlterTable
ALTER TABLE "DealPost" ADD COLUMN     "feedId" TEXT,
ADD COLUMN     "linkAnchor" TEXT;

-- CreateTable
CREATE TABLE "DealFeed" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "searchIndex" TEXT NOT NULL DEFAULT 'All',
    "minSavingPercent" INTEGER NOT NULL DEFAULT 20,
    "minPriceCents" INTEGER,
    "maxPriceCents" INTEGER,
    "minReviewCount" INTEGER NOT NULL DEFAULT 50,
    "minReviewRating" INTEGER NOT NULL DEFAULT 4,
    "amazonOnly" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastFoundCount" INTEGER NOT NULL DEFAULT 0,
    "lastQueuedCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealFeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealFeed_name_key" ON "DealFeed"("name");

-- CreateIndex
CREATE INDEX "DealFeed_isActive_lastRunAt_idx" ON "DealFeed"("isActive", "lastRunAt");

-- AddForeignKey
ALTER TABLE "DealPost" ADD CONSTRAINT "DealPost_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "DealFeed"("id") ON DELETE SET NULL ON UPDATE CASCADE;

