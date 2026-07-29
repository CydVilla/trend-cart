import { prisma, DealPostStatus, PinterestPinStatus } from "@trendcart/db";
import { isAmazonHost } from "@trendcart/shared";
import { config } from "../config.js";
import { isPaused } from "../heartbeat.js";
import { createTrackedLink } from "../tracking.js";
import { PinterestClient, PinterestPermanentError } from "./client.js";
import { composePinCopy } from "./compose.js";

const MAX_POST_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10 * 60_000;
/** Amazon-hosted product images only, same allowlist as the Bluesky poster. */
const IMAGE_HOST_RE = /(^|\.)media-amazon\.com$|(^|\.)images-amazon\.com$|(^|\.)ssl-images-amazon\.com$/i;

export type PinterestStats = { pinned: number; pinFailed: number; disabled: boolean };
export type PinterestPoster = { tick: () => Promise<void>; enabled: boolean };

/**
 * Mirrors POSTED deals onto the bot's Pinterest board, one pin per deal.
 * Structural twin of the Bluesky deal poster: exactly-once claim before any
 * network call, transient/permanent error split, DB-derived daily cap.
 *
 * Runs even under trial-tier API access (pins are then visible only to the
 * bot's own account) — that IS the staging mode. DRY_RUN still disables it:
 * dry run means "no writes to any platform", private or not.
 */
export function createPinterestPoster(stats: PinterestStats): PinterestPoster {
  if (config.bot.dryRun) {
    console.log("  pinterest:        disabled (DRY_RUN=true)");
    return { tick: async () => {}, enabled: false };
  }
  const { appId, appSecret, refreshToken } = config.pinterest;
  if (!appId || !appSecret || !refreshToken) {
    console.log("  pinterest:        disabled — missing app credentials or refresh token");
    return { tick: async () => {}, enabled: false };
  }
  console.log(`  pinterest:        enabled, board "${config.pinterest.boardName}"`);

  const client = new PinterestClient(appId, appSecret, refreshToken);
  let boardId: string | null = null;
  let stopped = false;

  /** Resolve (or create) the target board once; cache for the process life. */
  async function ensureBoard(): Promise<string | null> {
    if (boardId) return boardId;
    const wanted = config.pinterest.boardName;
    try {
      const boards = await client.listBoards();
      const existing = boards.find((b) => b.name.toLowerCase() === wanted.toLowerCase());
      boardId = existing
        ? existing.id
        : (
            await client.createBoard(
              wanted,
              "Amazon finds and price drops from TrendCart. #ad — as an Amazon Associate, TrendCart earns from qualifying purchases.",
            )
          ).id;
      return boardId;
    } catch (error) {
      if (error instanceof PinterestPermanentError) {
        // Bad/revoked token or missing scope: retrying every tick is noise.
        console.error(`[pinterest] disabling until restart: ${error.message}`);
        stats.disabled = true;
        stopped = true;
      } else {
        console.warn(
          `[pinterest] board lookup failed, will retry: ${error instanceof Error ? error.message : error}`,
        );
      }
      return null;
    }
  }

  async function terminal(id: string, status: PinterestPinStatus, skipReason: string): Promise<void> {
    await prisma.pinterestPin.update({ where: { id }, data: { status, skipReason } });
  }

  /** Queue rows for POSTED deals that don't have a pin yet. */
  async function enqueueNewDeals(): Promise<void> {
    const deals = await prisma.dealPost.findMany({
      where: { status: DealPostStatus.POSTED, pinterestPin: null },
      orderBy: { postedAt: "asc" },
      take: 5,
      include: { listing: true },
    });
    for (const deal of deals) {
      const imageUrl = deal.listing.imageUrl;
      let imageOk = false;
      try {
        imageOk = !!imageUrl && IMAGE_HOST_RE.test(new URL(imageUrl).hostname);
      } catch {
        imageOk = false;
      }
      // Rows are created even when skipped so the sweep never re-reads the
      // same deal — the unique dealPostId is both dedup and audit trail.
      if (!imageUrl || !imageOk) {
        await prisma.pinterestPin.create({
          data: {
            dealPostId: deal.id,
            status: PinterestPinStatus.SKIPPED,
            skipReason: imageUrl
              ? "listing image is not Amazon-hosted"
              : "listing has no image (Pinterest requires one)",
            title: "",
            description: "",
            link: "",
            imageUrl: "",
          },
        });
        continue;
      }
      const priceFree = deal.salePriceCents <= 0;
      const copy = composePinCopy({
        title: deal.listing.title,
        salePriceCents: deal.salePriceCents,
        wasPriceCents: deal.wasPriceCents,
        currency: deal.currency,
        priceFree,
      });
      const tracked = await createTrackedLink(deal.linkUrl, "pin", deal.id);
      await prisma.pinterestPin.create({
        data: {
          dealPostId: deal.id,
          title: copy.title,
          description: copy.description,
          link: tracked.url,
          imageUrl,
        },
      });
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (await isPaused()) return;

    await enqueueNewDeals();

    const candidate = await prisma.pinterestPin.findFirst({
      where: {
        status: PinterestPinStatus.PENDING,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!candidate) return;

    // DB-derived daily cap — restart-proof, like every other cap in the worker.
    const pinnedToday = await prisma.pinterestPin.count({
      where: {
        status: PinterestPinStatus.POSTED,
        postedAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      },
    });
    if (pinnedToday >= config.pinterest.maxPinsPerDay) return;

    // CLAIM before any network call — count===1 makes pinning exactly-once.
    const claim = await prisma.pinterestPin.updateMany({
      where: { id: candidate.id, status: PinterestPinStatus.PENDING },
      data: { status: PinterestPinStatus.POSTING },
    });
    if (claim.count !== 1) return;

    const pin = await prisma.pinterestPin.findUniqueOrThrow({ where: { id: candidate.id } });

    // The tracked /r link is first-party; a direct link must be Amazon.
    try {
      const host = new URL(pin.link).hostname;
      const trackedHost = config.clickTracking.baseUrl
        ? new URL(config.clickTracking.baseUrl).hostname
        : null;
      if (host !== trackedHost && !isAmazonHost(host)) {
        await terminal(pin.id, PinterestPinStatus.FAILED, "pin link is neither tracked nor Amazon");
        return;
      }
    } catch {
      await terminal(pin.id, PinterestPinStatus.FAILED, "invalid pin link URL");
      return;
    }

    const board = await ensureBoard();
    if (!board) {
      await prisma.pinterestPin.update({
        where: { id: pin.id },
        data: {
          status: PinterestPinStatus.PENDING,
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
        },
      });
      return;
    }

    try {
      const pinId = await client.createPin({
        boardId: board,
        title: pin.title,
        description: pin.description,
        link: pin.link,
        imageUrl: pin.imageUrl,
        altText: `Product photo: ${pin.title}`,
      });
      await prisma.pinterestPin.update({
        where: { id: pin.id },
        data: { status: PinterestPinStatus.POSTED, pinId, boardId: board, postedAt: new Date() },
      });
      stats.pinned += 1;
      console.log(`[pinterest] pinned "${pin.title}" (${pinId})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = pin.attemptCount + 1;
      if (error instanceof PinterestPermanentError || attempts >= MAX_POST_ATTEMPTS) {
        await prisma.pinterestPin.update({
          where: { id: pin.id },
          data: {
            status: PinterestPinStatus.FAILED,
            skipReason: `pin failed (attempt ${attempts}): ${message}`,
            attemptCount: attempts,
          },
        });
        stats.pinFailed += 1;
        console.error(`[pinterest] permanent pin failure: ${message}`);
      } else {
        await prisma.pinterestPin.update({
          where: { id: pin.id },
          data: {
            status: PinterestPinStatus.PENDING,
            attemptCount: attempts,
            nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
          },
        });
        console.warn(`[pinterest] transient pin error (attempt ${attempts}), will retry: ${message}`);
      }
    }
  }

  return { tick, enabled: true };
}
