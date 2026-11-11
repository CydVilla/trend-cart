import { productMatchConfidence } from "@trendcart/shared";
import type { CatalogItem } from "../creators-api.js";

/**
 * Product photos for deal posts.
 *
 * The only image a post may carry is the primary image Amazon's own catalog
 * returns for the EXACT ASIN the post links to — never a search hit, a feed
 * thumbnail or a scraped page. Two guards sit on top of that, because a wrong
 * photo is worse than none:
 *   1. the catalog row must be for the same ASIN we asked about;
 *   2. Amazon's title for that ASIN must still agree with the title we post
 *      (a recycled or mis-extracted ASIN shows up as a title mismatch).
 * Anything short of that → the post goes out text-only, as before.
 */

/** Share of the posted title's words that must appear in Amazon's title.
 *  50, not higher: feed titles abbreviate ("PS5" vs "PlayStation 5"). */
export const MIN_IMAGE_TITLE_MATCH = 50;

export type ImageChoice = { imageUrl: string } | { skip: string };

export function chooseListingImage(
  listing: { asin: string; title: string },
  item: CatalogItem | undefined,
): ImageChoice {
  if (!item) return { skip: "asin not in catalog" };
  if (item.asin !== listing.asin) return { skip: "catalog returned a different asin" };
  if (!item.imageUrl) return { skip: "catalog has no image" };
  const match = productMatchConfidence(listing.title, item.title);
  if (match < MIN_IMAGE_TITLE_MATCH) {
    return { skip: `title mismatch (${match}): "${item.title ?? ""}"` };
  }
  return { imageUrl: item.imageUrl };
}

/** Pixel size of a JPEG or PNG, for the embed's aspect ratio (so Bluesky
 *  doesn't crop the photo). null = unknown format; the post still works. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const u16 = (o: number) => (bytes[o]! << 8) | bytes[o + 1]!;
  // PNG: 8-byte signature, then IHDR with width/height as 32-bit big-endian.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = u16(16) * 65536 + u16(18);
    const height = u16(20) * 65536 + u16(22);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1]!;
      if (marker === 0xff) {
        o += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2; // standalone markers carry no length
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        const height = u16(o + 5);
        const width = u16(o + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      const length = u16(o + 2);
      if (length < 2) return null;
      o += 2 + length;
    }
  }
  return null;
}
