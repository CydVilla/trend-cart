-- CreateTable
CREATE TABLE "ApologyReply" (
    "id" TEXT NOT NULL,
    "targetUri" TEXT NOT NULL,
    "authorDid" TEXT NOT NULL,
    "authorHandle" TEXT,
    "targetText" TEXT NOT NULL,
    "verdict" JSONB,
    "replyText" TEXT NOT NULL,
    "replyUri" TEXT,
    "status" "ReplyStatus" NOT NULL,
    "skipReason" TEXT,
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApologyReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApologyReply_targetUri_key" ON "ApologyReply"("targetUri");

-- CreateIndex
CREATE INDEX "ApologyReply_authorDid_createdAt_idx" ON "ApologyReply"("authorDid", "createdAt");

-- CreateIndex
CREATE INDEX "ApologyReply_status_createdAt_idx" ON "ApologyReply"("status", "createdAt");
