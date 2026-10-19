-- Pinterest mirror: never configured on prod, 0 rows ever written (verified
-- 2026-10-19). Removed in code alongside this migration.
DROP TABLE "PinterestPin";
DROP TYPE "PinterestPinStatus";

-- Watchlist price poller (ADR-0011) was removed 2026-07-18; these columns and
-- its poll index have had no reader or writer since. Verified empty on prod
-- 2026-10-19 (0 of 699 TrackedListing rows set any of them).
DROP INDEX "TrackedListing_isActive_armState_nextCheckAt_idx";

ALTER TABLE "TrackedListing"
  DROP COLUMN "targetPriceCents",
  DROP COLUMN "lastCheckError",
  DROP COLUMN "consecutiveErrors",
  DROP COLUMN "nextCheckAt";
