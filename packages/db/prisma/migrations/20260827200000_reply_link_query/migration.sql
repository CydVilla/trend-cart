-- Records which product query a reply's link resolves to, so regenerating
-- with operator direction can correct a wrong link instead of only the text.
ALTER TABLE "BotReply" ADD COLUMN     "linkQuery" TEXT;
