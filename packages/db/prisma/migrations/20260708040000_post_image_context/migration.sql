-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "imageAlts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];
