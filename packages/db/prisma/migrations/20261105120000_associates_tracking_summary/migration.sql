-- Amazon's own per-tracking-ID clicks and totals from uploaded Tracking Id
-- summary reports (Insights page). Additive only.

-- CreateTable
CREATE TABLE "AssociatesTrackingSummary" (
    "id" TEXT NOT NULL,
    "fromDay" DATE NOT NULL,
    "toDay" DATE NOT NULL,
    "trackingId" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "orderedItems" INTEGER NOT NULL,
    "orderedSalesCents" INTEGER NOT NULL,
    "shippedItems" INTEGER NOT NULL,
    "returnedItems" INTEGER NOT NULL,
    "shippedSalesCents" INTEGER NOT NULL,
    "earningsCents" INTEGER NOT NULL,
    "bonusCents" INTEGER NOT NULL DEFAULT 0,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssociatesTrackingSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssociatesTrackingSummary_importedAt_idx" ON "AssociatesTrackingSummary"("importedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssociatesTrackingSummary_fromDay_toDay_trackingId_key" ON "AssociatesTrackingSummary"("fromDay", "toDay", "trackingId");
