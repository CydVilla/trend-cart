-- CreateEnum
CREATE TYPE "DealArmState" AS ENUM ('ARMED', 'DISARMED', 'FIRED');

-- CreateEnum
CREATE TYPE "DealPostStatus" AS ENUM ('PENDING', 'READY', 'POSTING', 'POSTED', 'SKIPPED', 'FAILED', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "DealSource" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateTable
CREATE TABLE "TrackedListing" (
    "id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'www.amazon.com',
    "productUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "targetPriceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "armState" "DealArmState" NOT NULL DEFAULT 'ARMED',
    "lastPriceCents" INTEGER,
    "lastPriceAsOf" TIMESTAMP(3),
    "lastPostedPriceCents" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "lastAvailability" TEXT,
    "lastCheckError" TEXT,
    "lastPostedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealPost" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "status" "DealPostStatus" NOT NULL DEFAULT 'PENDING',
    "source" "DealSource" NOT NULL DEFAULT 'AUTOMATED',
    "salePriceCents" INTEGER NOT NULL,
    "targetPriceCents" INTEGER NOT NULL,
    "wasPriceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "priceAsOf" TIMESTAMP(3) NOT NULL,
    "linkUrl" TEXT NOT NULL,
    "postText" TEXT,
    "postUri" TEXT,
    "skipReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedListing_isActive_armState_nextCheckAt_idx" ON "TrackedListing"("isActive", "armState", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedListing_asin_marketplace_key" ON "TrackedListing"("asin", "marketplace");

-- CreateIndex
CREATE INDEX "DealPost_listingId_idx" ON "DealPost"("listingId");

-- CreateIndex
CREATE INDEX "DealPost_status_createdAt_idx" ON "DealPost"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DealPost_createdAt_idx" ON "DealPost"("createdAt");

-- AddForeignKey
ALTER TABLE "DealPost" ADD CONSTRAINT "DealPost_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "TrackedListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
