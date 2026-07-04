-- AlterTable
ALTER TABLE "TrackedListing" ADD COLUMN     "fullPriceCents" INTEGER,
ALTER COLUMN "targetPriceCents" DROP NOT NULL;
