-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('NEW', 'QUEUED', 'DISMISSED', 'EXPIRED');

-- CreateTable
CREATE TABLE "DealSuggestionSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "includeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minPriceCents" INTEGER,
    "maxPriceCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "lastItemCount" INTEGER NOT NULL DEFAULT 0,
    "lastQueuedCount" INTEGER NOT NULL DEFAULT 0,
    "lastFetchError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealSuggestionSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealSuggestion" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL DEFAULT 'www.amazon.com',
    "productUrl" TEXT NOT NULL,
    "hintPriceCents" INTEGER,
    "sourceUrl" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'NEW',
    "gateVerdict" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealSuggestionSource_name_key" ON "DealSuggestionSource"("name");

-- CreateIndex
CREATE INDEX "DealSuggestionSource_isActive_lastFetchedAt_idx" ON "DealSuggestionSource"("isActive", "lastFetchedAt");

-- CreateIndex
CREATE INDEX "DealSuggestion_status_createdAt_idx" ON "DealSuggestion"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DealSuggestion_asin_idx" ON "DealSuggestion"("asin");

-- CreateIndex
CREATE UNIQUE INDEX "DealSuggestion_sourceId_guid_key" ON "DealSuggestion"("sourceId", "guid");

-- AddForeignKey
ALTER TABLE "DealSuggestion" ADD CONSTRAINT "DealSuggestion_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DealSuggestionSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

