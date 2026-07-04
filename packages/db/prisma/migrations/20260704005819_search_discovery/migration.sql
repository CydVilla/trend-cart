-- AlterEnum
ALTER TYPE "PostSource" ADD VALUE 'SEARCH';

-- AlterTable
ALTER TABLE "Post" DROP COLUMN "engagementVelocity";

