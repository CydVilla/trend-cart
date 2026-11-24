/**
 * Bot / preview-fetcher detection for the /r/<id> click redirect.
 *
 * Bluesky's firehose is public, and crawlers subscribed to it fetch every
 * posted URL within seconds. The user-agent denylist catches the honest ones.
 * Measured 2026-11-24 against Amazon's own count for Oct 24 - Nov 23: we
 * counted 5,226 "human" clicks to Amazon's 1,605, and EVERY link created in
 * that window got its first "human" click within 60s of being minted (median
 * 0.66s for deals). Those are crawlers sending a browser user-agent, so two
 * more signals are checked:
 *
 * - a click within EARLY_CLICK_WINDOW_MS of the link being minted. Links are
 *   minted just before posting, so no person scrolling a feed is that fast;
 * - a request with no Accept-Language header, which every real browser sends.
 *
 * `clickCount` is still an upper bound on humans, not an exact count.
 */
export const EARLY_CLICK_WINDOW_MS = 60_000;

const BOT_UA_RE =
  /bot|crawl|spider|preview|scan|monitor|probe|fetch|scrape|curl|wget|python|httpx|aiohttp|java\/|okhttp|go-http|libwww|headless|phantom|lighthouse|facebookexternalhit|slackbot|discordbot|telegrambot|whatsapp|twitterbot|bluesky|bsky|cardyb|mastodon|pleroma|misskey|iframely|embedly|unfurl|pinterest|redditbot|applebot|googlebot|bingbot|duckduck|yandex|baidu|semrush|ahrefs|mj12|dotbot|petalbot|archive|node|undici|axios|deno|bun\//i;

export type ClickBotReason = "head" | "empty-ua" | "bot-ua" | "no-accept-language" | "early";

/** Why a click counts as a bot, or null when it counts as a human. */
export function clickBotReason(
  req: { method: string; headers: { get(name: string): string | null } },
  linkCreatedAt: Date | null,
  now: Date = new Date(),
): ClickBotReason | null {
  if (req.method === "HEAD") return "head";
  const ua = req.headers.get("user-agent") ?? "";
  if (ua.length === 0) return "empty-ua";
  if (BOT_UA_RE.test(ua)) return "bot-ua";
  if (!(req.headers.get("accept-language") ?? "").trim()) return "no-accept-language";
  if (linkCreatedAt && now.getTime() - linkCreatedAt.getTime() < EARLY_CLICK_WINDOW_MS) return "early";
  return null;
}
