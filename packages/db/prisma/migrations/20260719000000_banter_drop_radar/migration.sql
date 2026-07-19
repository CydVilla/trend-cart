-- AlterEnum
ALTER TYPE "PostSource" ADD VALUE 'BANTER';

-- DropTable (trending radar superseded by the automated deal channel;
-- posted radar posts live on in EngagementSnapshot kind='radar' rows)
DROP TABLE IF EXISTS "RadarPost";
