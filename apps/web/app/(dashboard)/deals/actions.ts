"use server";

import { prisma, DealPostStatus } from "@trendcart/db";
import { attachImageToPost, BLUESKY_IMAGE_TYPES, BLUESKY_MAX_IMAGE_BYTES } from "@trendcart/shared";

export type AttachImageState = { ok: boolean; message: string } | null;

/**
 * Add an operator-picked image to a deal post that is already live. The post
 * is rewritten in place (same URL, likes kept); only an image embed is added.
 * The browser shrinks the file under Bluesky's size cap before it gets here.
 */
export async function attachDealImage(
  _previous: AttachImageState,
  formData: FormData,
): Promise<AttachImageState> {
  const fail = (message: string): AttachImageState => ({ ok: false, message });

  const id = String(formData.get("id") ?? "");
  const file = formData.get("image");
  if (!id || !(file instanceof File) || file.size === 0) return fail("Pick an image first.");
  if (!BLUESKY_IMAGE_TYPES.includes(file.type)) return fail("Use a JPEG, PNG or WebP image.");
  if (file.size > BLUESKY_MAX_IMAGE_BYTES) return fail("Image is over Bluesky's 976 KB limit.");

  const handle = process.env.BOT_ACCOUNT_HANDLE ?? "";
  const appPassword = process.env.BOT_APP_PASSWORD ?? "";
  if (!handle || !appPassword) return fail("Bluesky credentials aren't configured for the dashboard.");

  const deal = await prisma.dealPost.findUnique({
    where: { id },
    select: { status: true, source: true, postUri: true, listing: { select: { title: true } } },
  });
  if (!deal || deal.status !== DealPostStatus.POSTED || !deal.postUri) {
    return fail("That post isn't live on Bluesky.");
  }
  if (String(deal.source) === "EBAY") return fail("Images are for Amazon posts only.");

  const dimension = (name: string): number | null => {
    const value = Number(formData.get(name));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const result = await attachImageToPost({
    handle,
    appPassword,
    postUri: deal.postUri,
    image: {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      width: dimension("width"),
      height: dimension("height"),
    },
    alt: deal.listing.title,
  });
  return result.ok
    ? { ok: true, message: "Image added. Bluesky can take a moment to show it." }
    : fail(result.error);
}
