-- CreateEnum
CREATE TYPE "SafetyStatus" AS ENUM ('PENDING', 'SAFE', 'UNSAFE', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "ReplyStatus" AS ENUM ('DRY_RUN', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "authorDid" TEXT NOT NULL,
    "authorHandle" TEXT,
    "text" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "repostCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "quoteCount" INTEGER NOT NULL DEFAULT 0,
    "engagementScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "engagementVelocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "detectedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productIntentScore" INTEGER,
    "safetyStatus" "SafetyStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "negativeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exampleProblems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceRange" TEXT NOT NULL,
    "merchant" TEXT NOT NULL DEFAULT 'amazon',
    "url" TEXT NOT NULL,
    "imageUrl" TEXT,
    "affiliateDisclosureRequired" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "generatedSummary" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecommendationPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotReply" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "replyUri" TEXT,
    "status" "ReplyStatus" NOT NULL,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateEvaluation" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "rawInput" JSONB NOT NULL,
    "llmOutput" JSONB,
    "productIntentScore" INTEGER NOT NULL,
    "safetyDecision" "SafetyStatus" NOT NULL,
    "recommendedCategory" TEXT,
    "shouldReply" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestedReplyAngle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Post_uri_key" ON "Post"("uri");

-- CreateIndex
CREATE INDEX "Post_authorDid_idx" ON "Post"("authorDid");

-- CreateIndex
CREATE INDEX "Post_createdAt_idx" ON "Post"("createdAt");

-- CreateIndex
CREATE INDEX "Post_engagementScore_idx" ON "Post"("engagementScore");

-- CreateIndex
CREATE INDEX "Post_safetyStatus_productIntentScore_idx" ON "Post"("safetyStatus", "productIntentScore");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_slug_key" ON "ProductCategory"("slug");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationPage_slug_key" ON "RecommendationPage"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationPage_categoryId_key" ON "RecommendationPage"("categoryId");

-- CreateIndex
CREATE INDEX "BotReply_postId_idx" ON "BotReply"("postId");

-- CreateIndex
CREATE INDEX "BotReply_status_createdAt_idx" ON "BotReply"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BotReply_createdAt_idx" ON "BotReply"("createdAt");

-- CreateIndex
CREATE INDEX "CandidateEvaluation_postId_idx" ON "CandidateEvaluation"("postId");

-- CreateIndex
CREATE INDEX "CandidateEvaluation_createdAt_idx" ON "CandidateEvaluation"("createdAt");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationPage" ADD CONSTRAINT "RecommendationPage_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotReply" ADD CONSTRAINT "BotReply_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateEvaluation" ADD CONSTRAINT "CandidateEvaluation_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
