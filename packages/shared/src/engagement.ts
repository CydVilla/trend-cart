export type EngagementCounts = {
  likeCount: number;
  repostCount: number;
  replyCount: number;
  quoteCount: number;
};

/** Weighted engagement: reposts/quotes signal reach, replies signal discussion. */
export function computeEngagementScore(c: EngagementCounts): number {
  return c.likeCount * 1 + c.repostCount * 3 + c.replyCount * 2 + c.quoteCount * 3;
}
