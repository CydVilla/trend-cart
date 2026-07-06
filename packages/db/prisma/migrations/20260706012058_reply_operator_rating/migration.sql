-- AlterTable
ALTER TABLE "BotReply" ADD COLUMN     "operatorFeedback" TEXT,
ADD COLUMN     "operatorRating" TEXT,
ADD COLUMN     "ratedAt" TIMESTAMP(3);
