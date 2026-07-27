import { prisma } from "@trendcart/db";
import { isAmazonHost } from "@trendcart/shared";
import { NextResponse } from "next/server";

// Public first-party click redirect: /r/<id> → the tagged Amazon URL, counting
// the click on the way. Design rule: the REDIRECT is guaranteed, the COUNT is
// best-effort — a click must always reach Amazon even if the DB write fails, so
// tracking can never break the revenue path.
export const dynamic = "force-dynamic";

function fallbackUrl(): string {
  const tag = process.env.AMAZON_ASSOCIATE_TAG ?? "";
  return tag ? `https://www.amazon.com/?tag=${encodeURIComponent(tag)}` : "https://www.amazon.com/";
}

/**
 * Bot / preview-fetcher detection. Bluesky's firehose is public, and crawlers
 * subscribed to it fetch every posted URL within seconds — measured
 * 2026-07-27: MEDIAN 0.4s from reply post to "first click" across 283 links,
 * which no human feed-scroller produces. Those fetches must still get their
 * 302 (never break anyone's redirect), but they are not the revenue signal:
 * they land in `botClickCount`, humans in `clickCount`.
 *
 * A UA denylist can't be exhaustive — sophisticated crawlers fake browser
 * UAs — so `clickCount` stays an upper bound on humans; this just strips the
 * honest majority of the noise.
 */
const BOT_UA_RE =
  /bot|crawl|spider|preview|scan|monitor|probe|fetch|scrape|curl|wget|python|httpx|aiohttp|java\/|okhttp|go-http|libwww|headless|phantom|lighthouse|facebookexternalhit|slackbot|discordbot|telegrambot|whatsapp|twitterbot|bluesky|bsky|cardyb|mastodon|pleroma|misskey|iframely|embedly|unfurl|pinterest|redditbot|applebot|googlebot|bingbot|duckduck|yandex|baidu|semrush|ahrefs|mj12|dotbot|petalbot|archive/i;

function isBotRequest(req: Request): boolean {
  if (req.method === "HEAD") return true;
  const ua = req.headers.get("user-agent") ?? "";
  return ua.length === 0 || BOT_UA_RE.test(ua);
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  let target = fallbackUrl();
  // Why the fallback was served, when it is. A degraded click still reaches
  // Amazon but lands on the homepage instead of the product search — it LOOKS
  // fine to us and broken to the clicker, so it must never happen silently.
  // (Observed live 2026-07-27: a click during a dyno restart served the
  // fallback; the row was intact and later clicks redirected correctly.)
  let fallbackCause: string | null = "unknown";
  let linkId = "(unparsed)";
  try {
    const { id } = await ctx.params;
    linkId = id;
    const link = await prisma.trackedLink.findUnique({
      where: { id },
      select: { targetUrl: true, firstClickAt: true },
    });
    if (link) {
      // Only ever bounce to Amazon — never let this become an open redirect.
      try {
        if (isAmazonHost(new URL(link.targetUrl).hostname)) {
          target = link.targetUrl;
          fallbackCause = null;
        } else {
          fallbackCause = "target not an Amazon host";
        }
      } catch {
        fallbackCause = "malformed target URL";
      }
      // Bots get their redirect but never the revenue counter — clickCount,
      // firstClickAt, and lastClickAt describe HUMAN behavior only.
      await prisma.trackedLink
        .update({
          where: { id },
          data: isBotRequest(req)
            ? { botClickCount: { increment: 1 } }
            : {
                clickCount: { increment: 1 },
                lastClickAt: new Date(),
                ...(link.firstClickAt ? {} : { firstClickAt: new Date() }),
              },
        })
        .catch(() => {}); // count is best-effort; the redirect below is not
    } else {
      fallbackCause = "no TrackedLink row";
    }
  } catch (error) {
    fallbackCause = `DB error: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (fallbackCause) {
    console.warn(`[redirect] /r/${linkId} served the FALLBACK (${fallbackCause}) — a real click lost its product landing`);
  }
  return NextResponse.redirect(target, 302);
}
