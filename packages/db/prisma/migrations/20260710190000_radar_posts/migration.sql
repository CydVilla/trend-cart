-- CreateTable
CREATE TABLE "RadarPost" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "linkUrl" TEXT NOT NULL,
    "linkAnchor" TEXT NOT NULL,
    "basis" JSONB,
    "status" "ReplyStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "skipReason" TEXT,
    "postUri" TEXT,
    "approvedAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RadarPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RadarPost_status_createdAt_idx" ON "RadarPost"("status", "createdAt");
