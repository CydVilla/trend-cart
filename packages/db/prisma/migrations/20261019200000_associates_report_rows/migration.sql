-- Per-channel revenue: hand-uploaded Amazon Associates Orders/Earnings rows,
-- per day x tracking ID x ASIN, plus each upload's covered range (Insights
-- page). Additive only.

-- CreateEnum
CREATE TYPE "AssociatesReportKind" AS ENUM ('ORDERS', 'EARNINGS');

-- CreateTable
CREATE TABLE "AssociatesReportRow" (
    "id" TEXT NOT NULL,
    "kind" "AssociatesReportKind" NOT NULL,
    "day" DATE NOT NULL,
    "trackingId" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "items" INTEGER NOT NULL,
    "returns" INTEGER NOT NULL DEFAULT 0,
    "salesCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "indirectItems" INTEGER NOT NULL DEFAULT 0,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssociatesReportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssociatesReportUpload" (
    "id" TEXT NOT NULL,
    "kind" "AssociatesReportKind" NOT NULL,
    "fromDay" DATE NOT NULL,
    "toDay" DATE NOT NULL,
    "rows" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssociatesReportUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssociatesReportRow_asin_idx" ON "AssociatesReportRow"("asin");

-- CreateIndex
CREATE INDEX "AssociatesReportRow_trackingId_day_idx" ON "AssociatesReportRow"("trackingId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AssociatesReportRow_kind_day_trackingId_asin_key" ON "AssociatesReportRow"("kind", "day", "trackingId", "asin");

-- CreateIndex
CREATE INDEX "AssociatesReportUpload_kind_createdAt_idx" ON "AssociatesReportUpload"("kind", "createdAt");
