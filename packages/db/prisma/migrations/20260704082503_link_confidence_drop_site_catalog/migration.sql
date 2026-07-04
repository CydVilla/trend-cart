-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "RecommendationPage" DROP CONSTRAINT "RecommendationPage_categoryId_fkey";

-- AlterTable
ALTER TABLE "BotReply" ADD COLUMN     "preEditText" TEXT;

-- AlterTable
ALTER TABLE "CandidateEvaluation" ADD COLUMN     "linkConfidence" INTEGER NOT NULL DEFAULT 100;

-- DropTable
DROP TABLE "Product";

-- DropTable
DROP TABLE "RecommendationPage";

