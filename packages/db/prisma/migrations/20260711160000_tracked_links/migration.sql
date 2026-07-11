-- CreateTable
CREATE TABLE "TrackedLink" (
    "id" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "firstClickAt" TIMESTAMP(3),
    "lastClickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackedLink_kind_createdAt_idx" ON "TrackedLink"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "TrackedLink_sourceId_idx" ON "TrackedLink"("sourceId");
