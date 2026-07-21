-- Durable lane attribution and strict-sale verification for ranked RSS deals.
ALTER TYPE "SuggestionStatus" ADD VALUE 'VERIFYING';

ALTER TABLE "DealPost"
  ADD COLUMN "laneKey" TEXT,
  ADD COLUMN "candidateScore" INTEGER,
  ADD COLUMN "saleVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "suggestionId" TEXT;

ALTER TABLE "DealSuggestion"
  ADD COLUMN "verificationStartedAt" TIMESTAMP(3);

CREATE INDEX "DealPost_laneKey_postedAt_idx" ON "DealPost"("laneKey", "postedAt");
CREATE UNIQUE INDEX "DealPost_suggestionId_key" ON "DealPost"("suggestionId");

ALTER TABLE "DealPost"
  ADD CONSTRAINT "DealPost_suggestionId_fkey"
  FOREIGN KEY ("suggestionId") REFERENCES "DealSuggestion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
