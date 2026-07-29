-- CreateEnum
CREATE TYPE "PinterestPinStatus" AS ENUM ('PENDING', 'POSTING', 'POSTED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "PinterestPin" (
    "id" TEXT NOT NULL,
    "dealPostId" TEXT NOT NULL,
    "status" "PinterestPinStatus" NOT NULL DEFAULT 'PENDING',
    "boardId" TEXT,
    "pinId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "skipReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinterestPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PinterestPin_dealPostId_key" ON "PinterestPin"("dealPostId");

-- CreateIndex
CREATE INDEX "PinterestPin_status_createdAt_idx" ON "PinterestPin"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PinterestPin" ADD CONSTRAINT "PinterestPin_dealPostId_fkey" FOREIGN KEY ("dealPostId") REFERENCES "DealPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
