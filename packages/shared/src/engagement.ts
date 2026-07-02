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

/**
 * Score change per hour between two measurements.
 * Returns 0 when the window is too small to be meaningful (< 1 minute).
 */
export function computeEngagementVelocity(
  previousScore: number,
  currentScore: number,
  previousAt: Date,
  currentAt: Date,
): number {
  const hours = (currentAt.getTime() - previousAt.getTime()) / 3_600_000;
  if (hours < 1 / 60) return 0;
  return (currentScore - previousScore) / hours;
}
