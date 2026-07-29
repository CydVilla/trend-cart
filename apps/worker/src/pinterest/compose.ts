import { formatMoney } from "@trendcart/shared";

/** Pinterest API hard limits. */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 800;
const MAX_ALT_TEXT = 500;

export type PinCopyInput = {
  title: string;
  salePriceCents: number;
  wasPriceCents: number | null;
  currency: string;
  /** Price-free posts (RSS-sourced) never advertise a number. */
  priceFree: boolean;
};

export type PinCopy = { title: string; description: string; altText: string };

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pin copy is evergreen, unlike a Bluesky deal alert: pins surface in search
 * for months, so the description leans on what the product IS rather than
 * urgency. The #ad disclosure leads and the Associates line closes — both
 * survive any truncation because the product title is bounded first.
 */
export function composePinCopy(input: PinCopyInput): PinCopy {
  const title = truncate(input.title, MAX_TITLE);

  const price =
    !input.priceFree && input.salePriceCents > 0
      ? input.wasPriceCents && input.wasPriceCents > input.salePriceCents
        ? `${formatMoney(input.salePriceCents, input.currency)} (was ${formatMoney(input.wasPriceCents, input.currency)}) when pinned. `
        : `${formatMoney(input.salePriceCents, input.currency)} when pinned. `
      : "";

  const body = `#ad ${truncate(input.title, 300)}. ${price}` +
    "Price and availability may have changed — check the current listing. " +
    "As an Amazon Associate, TrendCart earns from qualifying purchases.";

  return {
    title,
    description: truncate(body, MAX_DESCRIPTION),
    altText: truncate(`Product photo: ${input.title}`, MAX_ALT_TEXT),
  };
}
