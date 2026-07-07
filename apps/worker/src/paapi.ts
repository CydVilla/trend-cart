import { createHash, createHmac } from "node:crypto";
import { config } from "./config.js";

/**
 * Amazon Product Advertising API 5.0 — GetItems (watchlist price polling) +
 * SearchItems (deal-feed discovery) client.
 *
 * SigV4 is hand-signed (Node crypto) rather than pulled from a heavy,
 * often-stale SDK: the signing core is verifiable against AWS's published
 * test vectors (see scratch tests), and every response field path lives in
 * ONE mapItem() so the eventual classic-Offers → OffersV2 migration is a
 * one-place change.
 *
 * NOTE: unexercised until real PA-API credentials exist. On the first live
 * call, watch the worker log for auth/signature errors.
 */

const SERVICE = "ProductAdvertisingAPI";
/** Each PA-API operation = its own path + x-amz-target pair. */
const OPS = {
  GetItems: {
    path: "/paapi5/getitems",
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
  },
  SearchItems: {
    path: "/paapi5/searchitems",
    target: "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
  },
} as const;
type PaapiOp = keyof typeof OPS;
const RESOURCES = [
  "ItemInfo.Title",
  "Images.Primary.Large",
  "Offers.Listings.Price",
  "Offers.Listings.SavingBasis",
  "Offers.Listings.Availability.Message",
  "Offers.Listings.Condition",
];
/** Search additionally pulls review data for the feed quality floors. Amazon
 *  omits these fields for many items — the gates only apply when present. */
const SEARCH_RESOURCES = [...RESOURCES, "CustomerReviews.Count", "CustomerReviews.StarRating"];
const MIN_GAP_MS = 1_100; // headroom under Amazon's 1 TPS floor
const MAX_RETRIES = 3;

export type PaapiItem = {
  asin: string;
  priceCents: number | null;
  savingsCents: number | null;
  wasPriceCents: number | null;
  title: string | null;
  imageUrl: string | null;
  available: boolean;
  currency: string | null;
  reviewCount: number | null;
  reviewRating: number | null;
};

/** One deal-feed search — mirrors the SearchItems request surface we use. */
export type SearchItemsParams = {
  keywords: string;
  searchIndex: string;
  minSavingPercent: number;
  /** PA-API expects prices in the lowest currency denomination (cents). */
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  /** 1–4: only items rated above this many stars. */
  minReviewRating?: number | null;
  /** true → Merchant=Amazon (third-party strikethroughs are often inflated). */
  amazonOnly?: boolean;
  /** 1–10; each page is one API call returning up to 10 items. */
  itemPage?: number;
};

export type PaapiClient = {
  getItemsByAsin: (asins: string[]) => Promise<Map<string, PaapiItem>>;
  searchItems: (params: SearchItemsParams) => Promise<PaapiItem[]>;
};

/** Thrown on 401/403 — bad keys or an unapproved Associate account. The caller
 *  disables the checker for the process (Amazon revokes keys after 30 days
 *  with no sales, and we must not hammer a dead credential). */
export class PaapiAuthError extends Error {}
/** Thrown on 429/5xx after retries — the caller applies a global backoff. */
export class PaapiTransientError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

function toCents(dollars: number | null | undefined): number | null {
  if (dollars == null || !Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

/** THE isolation point: all PA-API response shape knowledge lives here. */
function mapItem(it: Record<string, unknown>): PaapiItem {
  const item = it as {
    ASIN?: string;
    ItemInfo?: { Title?: { DisplayValue?: string } };
    Images?: { Primary?: { Large?: { URL?: string } } };
    CustomerReviews?: { Count?: number; StarRating?: { Value?: number } };
    Offers?: {
      Listings?: Array<{
        Price?: { Amount?: number; Currency?: string; Savings?: { Amount?: number } };
        SavingBasis?: { Amount?: number };
        Availability?: { Message?: string };
        Condition?: { Value?: string } | string;
      }>;
    };
  };
  const listing = item.Offers?.Listings?.[0];
  const conditionValue =
    typeof listing?.Condition === "string" ? listing?.Condition : listing?.Condition?.Value;
  const available =
    !!listing &&
    /in stock/i.test(listing.Availability?.Message ?? "") &&
    (conditionValue == null || /new/i.test(conditionValue));
  return {
    asin: item.ASIN ?? "",
    priceCents: toCents(listing?.Price?.Amount),
    savingsCents: toCents(listing?.Price?.Savings?.Amount),
    wasPriceCents: toCents(listing?.SavingBasis?.Amount),
    title: item.ItemInfo?.Title?.DisplayValue ?? null,
    imageUrl: item.Images?.Primary?.Large?.URL ?? null,
    available,
    currency: listing?.Price?.Currency ?? null,
    reviewCount: item.CustomerReviews?.Count ?? null,
    reviewRating: item.CustomerReviews?.StarRating?.Value ?? null,
  };
}

/** Serialize all calls with a min gap so overlapping loops can't exceed 1 TPS. */
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let dayKey = "";
let callsToday = 0;
function underDailyCap(): boolean {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== dayKey) {
    dayKey = key;
    callsToday = 0;
  }
  return callsToday < config.deals.maxPaApiCallsPerDay;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * AWS SigV4 signature = HMAC chain over the string-to-sign. Isolated + exported
 * so it can be verified against AWS's published test vectors (the crypto is the
 * part most likely to be subtly wrong, and can't be exercised without keys).
 */
export function sigv4Signature(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
  stringToSign: string,
): string {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
}

/**
 * Build the SigV4 Authorization header + amz-date for a PA-API POST.
 * Exported for the signing test.
 */
export function signPaapiRequest(
  op: PaapiOp,
  body: string,
  now: Date,
  creds: { accessKey: string; secretKey: string; host: string; region: string },
): { authorization: string; amzDate: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    "content-encoding": "amz-1.0",
    host: creds.host,
    "x-amz-date": amzDate,
    "x-amz-target": OPS[op].target,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");
  const canonicalRequest = [
    "POST",
    OPS[op].path,
    "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");
  const scope = `${dateStamp}/${creds.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = sigv4Signature(creds.secretKey, dateStamp, creds.region, SERVICE, stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate };
}

/** Kept for the signing test's published-vector check. */
export function signGetItems(
  body: string,
  now: Date,
  creds: { accessKey: string; secretKey: string; host: string; region: string },
): { authorization: string; amzDate: string } {
  return signPaapiRequest("GetItems", body, now, creds);
}

/** POST one PA-API operation with retry/backoff; returns the parsed JSON. */
async function callPaapi(op: PaapiOp, requestBody: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({
    ...requestBody,
    PartnerTag: config.paapi.partnerTag,
    PartnerType: "Associates",
    Marketplace: config.paapi.marketplace,
  });
  const creds = {
    accessKey: config.paapi.accessKey,
    secretKey: config.paapi.secretKey,
    host: config.paapi.host,
    region: config.paapi.region,
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const { authorization, amzDate } = signPaapiRequest(op, body, new Date(), creds);
    callsToday += 1;
    let response: Response;
    try {
      response = await fetch(`https://${creds.host}${OPS[op].path}`, {
        method: "POST",
        headers: {
          authorization,
          "content-encoding": "amz-1.0",
          "content-type": "application/json; charset=utf-8",
          host: creds.host,
          "x-amz-date": amzDate,
          "x-amz-target": OPS[op].target,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // network/timeout — transient
      if (attempt === MAX_RETRIES - 1) {
        throw new PaapiTransientError(error instanceof Error ? error.message : String(error));
      }
      await sleep(2_000 * 2 ** attempt);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new PaapiAuthError(`PA-API auth failed (${response.status}) — check keys/approval`);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_RETRIES - 1) {
        throw new PaapiTransientError(`PA-API ${response.status} after ${MAX_RETRIES} tries`);
      }
      await sleep(2_000 * 2 ** attempt);
      continue;
    }
    return await response.json().catch(() => ({}));
  }
  throw new PaapiTransientError("PA-API exhausted retries");
}

async function callGetItems(asins: string[]): Promise<Map<string, PaapiItem>> {
  const json = (await callPaapi("GetItems", {
    ItemIds: asins,
    ItemIdType: "ASIN",
    Condition: "New",
    Resources: RESOURCES,
  })) as { ItemsResult?: { Items?: Array<Record<string, unknown>> } };
  const out = new Map<string, PaapiItem>();
  for (const raw of json.ItemsResult?.Items ?? []) {
    const mapped = mapItem(raw);
    if (mapped.asin) out.set(mapped.asin, mapped);
  }
  return out; // ASINs absent from the map = not found (Errors[]) → caller handles
}

async function callSearchItems(params: SearchItemsParams): Promise<PaapiItem[]> {
  const json = (await callPaapi("SearchItems", {
    Keywords: params.keywords,
    SearchIndex: params.searchIndex,
    // Server-side sale filter: only items discounted at least this % off the
    // list price. The discovery gates re-verify — never trust it alone.
    MinSavingPercent: params.minSavingPercent,
    ...(params.minPriceCents ? { MinPrice: params.minPriceCents } : {}),
    ...(params.maxPriceCents ? { MaxPrice: params.maxPriceCents } : {}),
    ...(params.minReviewRating ? { MinReviewsRating: params.minReviewRating } : {}),
    Merchant: params.amazonOnly === false ? "All" : "Amazon",
    Availability: "Available",
    Condition: "New",
    ItemCount: 10,
    ItemPage: params.itemPage ?? 1,
    SortBy: "Featured",
    Resources: SEARCH_RESOURCES,
  })) as { SearchResult?: { Items?: Array<Record<string, unknown>> } };
  return (json.SearchResult?.Items ?? []).map(mapItem).filter((item) => item.asin);
}

/** Returns null when credentials are absent — the deal checker then stands
 *  down to manual-only, exactly like the poster with no Bluesky creds. */
export function createPaapiClient(): PaapiClient | null {
  if (!config.paapi.enabled) return null;
  return {
    async getItemsByAsin(asins: string[]): Promise<Map<string, PaapiItem>> {
      const merged = new Map<string, PaapiItem>();
      for (const group of chunk([...new Set(asins)], 10)) {
        if (!underDailyCap()) {
          console.warn("[paapi] daily call cap reached — skipping remaining groups this tick");
          break;
        }
        const result = await schedule(() => callGetItems(group));
        for (const [asin, item] of result) merged.set(asin, item);
      }
      return merged;
    },
    async searchItems(params: SearchItemsParams): Promise<PaapiItem[]> {
      if (!underDailyCap()) {
        console.warn("[paapi] daily call cap reached — skipping search this tick");
        return [];
      }
      return schedule(() => callSearchItems(params));
    },
  };
}
