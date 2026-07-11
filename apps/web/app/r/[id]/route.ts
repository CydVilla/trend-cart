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

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  let target = fallbackUrl();
  try {
    const { id } = await ctx.params;
    const link = await prisma.trackedLink.findUnique({
      where: { id },
      select: { targetUrl: true, firstClickAt: true },
    });
    if (link) {
      // Only ever bounce to Amazon — never let this become an open redirect.
      try {
        if (isAmazonHost(new URL(link.targetUrl).hostname)) target = link.targetUrl;
      } catch {
        /* malformed target — keep the fallback */
      }
      await prisma.trackedLink
        .update({
          where: { id },
          data: {
            clickCount: { increment: 1 },
            lastClickAt: new Date(),
            ...(link.firstClickAt ? {} : { firstClickAt: new Date() }),
          },
        })
        .catch(() => {}); // count is best-effort; the redirect below is not
    }
  } catch {
    /* DB unreachable / bad id — fall through to the fallback redirect */
  }
  return NextResponse.redirect(target, 302);
}
