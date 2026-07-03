-- AlterTable
ALTER TABLE "BotReply" ADD COLUMN     "linkAnchor" TEXT,
ADD COLUMN     "linkUrl" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "operatorLinkUrl" TEXT,
ADD COLUMN     "operatorNote" TEXT;
