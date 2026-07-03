-- AlterEnum
ALTER TYPE "PostSource" ADD VALUE 'MENTION';

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "contextText" TEXT,
ADD COLUMN     "threadRootCid" TEXT,
ADD COLUMN     "threadRootUri" TEXT;
