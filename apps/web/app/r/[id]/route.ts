import { prisma } from "@trendcart/db";
import {
  canonicalEbayUrl,
  clickBotReason,
  extractEbayItemId,
  isAmazonHost,
  isEbayHost,
} from "@trendcart/shared";
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

// Bot detection lives in @trendcart/shared (clickBotReason) so it can be tested.

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
      select: { targetUrl: true, firstClickAt: true, createdAt: true },
    });
    if (link) {
      const botReason = clickBotReason(req, link.createdAt);
      const isBot = botReason !== null;
      // Only ever bounce to Amazon or eBay — never let this become an open
      // redirect. Bots get eBay's bare listing URL: its campaign parameters
      // register a click with eBay, and crawlers aren't our traffic to report.
      try {
        const { hostname } = new URL(link.targetUrl);
        const itemId = isEbayHost(hostname) ? extractEbayItemId(link.targetUrl) : null;
        if (isAmazonHost(hostname) || isEbayHost(hostname)) {
          target = itemId && isBot ? canonicalEbayUrl(itemId) : link.targetUrl;
          fallbackCause = null;
        } else {
          fallbackCause = "target not an Amazon or eBay host";
        }
      } catch {
        fallbackCause = "malformed target URL";
      }
      // Bots get their redirect but never the revenue counter — clickCount,
      // firstClickAt, and lastClickAt describe HUMAN behavior only.
      await prisma.trackedLink
        .update({
          where: { id },
          data: isBot
            ? { botClickCount: { increment: 1 } }
            : {
                clickCount: { increment: 1 },
                lastClickAt: new Date(),
                ...(link.firstClickAt ? {} : { firstClickAt: new Date() }),
              },
        })
        .catch(() => {}); // count is best-effort; the redirect below is not
      // One line per click so leaks past the filter can be found in the logs
      // and added to it. The user-agent is a browser string, not personal data.
      const ua = (req.headers.get("user-agent") ?? "").slice(0, 200);
      console.log(`[click] /r/${id} ${botReason ? `bot:${botReason}` : "human"} ua="${ua}"`);
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
