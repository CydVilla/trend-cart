import { config } from "./config.js";

/**
 * Amazon Creators API — getItems (watchlist price polling) + searchItems
 * (deal-feed discovery) client.
 *
 * Replaces the PA-API 5.0 SigV4 client: PA-API was deprecated 2026-04-30 and
 * its endpoint switched off 2026-05-15, so the old AWS-signed transport can
 * never succeed again. Creators API keeps the same operations but swaps the
 * whole envelope — OAuth 2.0 bearer tokens instead of SigV4, a new host, and
 * lowerCamelCase request/response keys.
 *
 * Hand-rolled rather than using Amazon's SDK on purpose: the SDK ships as a
 * downloadable zip (the `creatorsapi-nodejs-sdk` package on npm is an
 * unofficial republish with no repository, homepage, or named author), and
 * this client needs exactly two operations over HTTPS. Credentials never pass
 * through third-party code.
 *
 * Every response field path lives in ONE mapItem(), so schema surprises are a
 * one-place fix.
 */

/** Token endpoint is chosen by credential VERSION, not by target marketplace —
 *  credentials work globally; x-marketplace selects the storefront. */
const TOKEN_ENDPOINTS: Record<string, string> = {
  "3.1": "https://api.amazon.com/auth/o2/token", // NA: US, CA, MX, BR
  "3.2": "https://api.amazon.co.uk/auth/o2/token", // EU
  "3.3": "https://api.amazon.co.jp/auth/o2/token", // FE: JP, SG, AU
};
/** Literal, not a lookup: an unrecognised version must still resolve to a
 *  usable endpoint rather than `undefined`. */
const DEFAULT_TOKEN_ENDPOINT = "https://api.amazon.com/auth/o2/token";
const API_BASE = "https://creatorsapi.amazon";
const OPS = {
  getItems: "/catalog/v1/getItems",
  searchItems: "/catalog/v1/searchItems",
} as const;
type CatalogOp = keyof typeof OPS;

/** Resources are lowerCamelCase dotted paths now (PA-API used PascalCase). */
const RESOURCES = [
  "itemInfo.title",
  "images.primary.large",
  "offersV2.listings.price",
  "offersV2.listings.availability",
  "offersV2.listings.condition",
  "offersV2.listings.merchantInfo",
  "offersV2.listings.type",
];
/** Creators API exposes no customerReviews resource (PA-API had
 *  CustomerReviews.Count/StarRating). The feed's review-count gate is already
 *  null-tolerant, so it simply stops applying; the server-side
 *  minReviewsRating search filter still works. */
const SEARCH_RESOURCES = [...RESOURCES];
const MIN_GAP_MS = 1_100; // headroom under Amazon's 1 TPS floor
const MAX_RETRIES = 3;
/** Refresh this long before expiry so a token can't die mid-flight. */
const TOKEN_SLACK_MS = 60_000;

export type CatalogItem = {
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

/** One deal-feed search — mirrors the searchItems request surface we use. */
export type SearchItemsParams = {
  keywords: string;
  searchIndex: string;
  minSavingPercent: number;
  /** Prices in the lowest currency denomination (cents). */
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  /** 1–4: only items rated above this many stars. */
  minReviewRating?: number | null;
  /** true → Amazon-only merchant filter (third-party strikethroughs are often
   *  inflated). Creators API has no Merchant param, so this is enforced
   *  client-side against offersV2.listings.merchantInfo. */
  amazonOnly?: boolean;
  /** 1–10; each page is one API call returning up to 10 items. */
  itemPage?: number;
};

export type CatalogClient = {
  getItemsByAsin: (asins: string[]) => Promise<Map<string, CatalogItem>>;
  searchItems: (params: SearchItemsParams) => Promise<CatalogItem[]>;
};

/** Bad or revoked credentials — the caller disables for the process. */
export class CatalogAuthError extends Error {}
/** 429/5xx after retries — the caller applies a global backoff. */
export class CatalogTransientError extends Error {}
/**
 * `AssociateNotEligible` (403). NOT a credential problem: it is returned for
 * up to 48h while Amazon reviews a new application, and again any time the
 * account drops under 10 qualifying sales in the trailing 30 days. It resolves
 * on its own, so it must back off rather than permanently disable the client —
 * otherwise eligibility returning would still leave the checker dark until a
 * dyno restart.
 */
export class CatalogNotEligibleError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toCents(amount: number | null | undefined): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

/** Money objects are `{ amount, currency, displayAmount }` throughout offersV2. */
type Money = { amount?: number; currency?: string; displayAmount?: string };

let shapeLogged = false;
/** One-time structural dump of the first live offersV2 listing. The schema is
 *  the one piece Amazon's docs never show, so log its KEYS (plus prices, which
 *  are public) once to confirm the mapping below against reality. */
function logOffersShapeOnce(listing: unknown): void {
  if (shapeLogged || !listing || typeof listing !== "object") return;
  shapeLogged = true;
  try {
    console.log(`[creatorsApi] first offersV2 listing shape: ${JSON.stringify(listing).slice(0, 900)}`);
  } catch {
    /* diagnostics must never break a call */
  }
}

/** THE isolation point: all Creators API response shape knowledge lives here. */
function mapItem(it: Record<string, unknown>): CatalogItem {
  const item = it as {
    asin?: string;
    itemInfo?: { title?: { displayValue?: string } };
    images?: { primary?: { large?: { url?: string } } };
    customerReviews?: { count?: number; starRating?: { value?: number } };
    offersV2?: {
      listings?: Array<{
        availability?: { type?: string; message?: string };
        condition?: { value?: string; subCondition?: string };
        isBuyBoxWinner?: boolean;
        merchantInfo?: { id?: string; name?: string };
        type?: string;
        price?: {
          money?: Money;
          savingBasis?: { money?: Money; savingBasisType?: string };
          savings?: { money?: Money; percentage?: number };
        };
      }>;
    };
  };
  const listing = item.offersV2?.listings?.[0];
  if (listing) logOffersShapeOnce(listing);

  // OffersV2 nests money one level deeper than V1 did (price.money.amount vs
  // Price.Amount) and reports availability as a `type` enum with a human
  // `message` alongside; accept either signal.
  const availabilityType = listing?.availability?.type ?? "";
  const availabilityMessage = listing?.availability?.message ?? "";
  const conditionValue = listing?.condition?.value ?? listing?.type ?? "";
  const available =
    !!listing &&
    (/now|in_?stock|available/i.test(availabilityType) || /in stock/i.test(availabilityMessage)) &&
    (conditionValue === "" || /new/i.test(conditionValue));

  return {
    asin: item.asin ?? "",
    priceCents: toCents(listing?.price?.money?.amount),
    savingsCents: toCents(listing?.price?.savings?.money?.amount),
    wasPriceCents: toCents(listing?.price?.savingBasis?.money?.amount),
    title: item.itemInfo?.title?.displayValue ?? null,
    imageUrl: item.images?.primary?.large?.url ?? null,
    available,
    currency: listing?.price?.money?.currency ?? null,
    // Not offered as a Creators API resource; left null so the (null-tolerant)
    // feed gates stand down rather than silently rejecting everything.
    reviewCount: item.customerReviews?.count ?? null,
    reviewRating: item.customerReviews?.starRating?.value ?? null,
  };
}

/** True when the sole listing is sold by Amazon itself. */
function isAmazonMerchant(it: Record<string, unknown>): boolean {
  const listing = (
    it as { offersV2?: { listings?: Array<{ merchantInfo?: { name?: string } }> } }
  ).offersV2?.listings?.[0];
  return /^amazon(\.com)?$/i.test(listing?.merchantInfo?.name ?? "");
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
  return callsToday < config.deals.maxApiCallsPerDay;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── OAuth 2.0 client-credentials token, cached until shortly before expiry ──
let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiresAt - TOKEN_SLACK_MS) return accessToken;
  const endpoint = TOKEN_ENDPOINTS[config.creatorsApi.version] ?? DEFAULT_TOKEN_ENDPOINT;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: config.creatorsApi.clientId,
        client_secret: config.creatorsApi.clientSecret,
        scope: "creatorsapi::default",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CatalogTransientError(
      `token request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 400 || response.status === 401) {
    // The token endpoint rejects the credential pair itself — never transient.
    throw new CatalogAuthError(`token rejected (${response.status}) — check Creators API credentials`);
  }
  if (!response.ok) {
    throw new CatalogTransientError(`token endpoint ${response.status}`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new CatalogAuthError("token response carried no access_token");
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return accessToken;
}

async function callCatalog(op: CatalogOp, requestBody: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({
    ...requestBody,
    partnerTag: config.creatorsApi.partnerTag,
    marketplace: config.creatorsApi.marketplace,
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const token = await getAccessToken();
    callsToday += 1;
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${OPS[op]}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-marketplace": config.creatorsApi.marketplace,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) {
        throw new CatalogTransientError(error instanceof Error ? error.message : String(error));
      }
      await sleep(2_000 * 2 ** attempt);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      const text = await response.text().catch(() => "");
      // Eligibility is a temporary state (48h review window, or a dip under 10
      // qualifying sales in 30 days) — distinct from bad credentials.
      if (/AssociateNotEligible/i.test(text)) {
        throw new CatalogNotEligibleError(
          "Creators API access not yet granted (AssociateNotEligible) — review takes up to 48h, " +
            "and access also requires 10 qualifying sales in the trailing 30 days",
        );
      }
      // A stale cached token would also 401; drop it so the next try re-mints.
      accessToken = null;
      throw new CatalogAuthError(`Creators API auth failed (${response.status}): ${text.slice(0, 160)}`);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_RETRIES - 1) {
        throw new CatalogTransientError(`Creators API ${response.status} after ${MAX_RETRIES} tries`);
      }
      await sleep(2_000 * 2 ** attempt);
      continue;
    }
    return await response.json().catch(() => ({}));
  }
  throw new CatalogTransientError("Creators API exhausted retries");
}

async function callGetItems(asins: string[]): Promise<Map<string, CatalogItem>> {
  const json = (await callCatalog("getItems", {
    itemIds: asins,
    itemIdType: "ASIN",
    condition: "New",
    resources: RESOURCES,
  })) as { itemsResult?: { items?: Array<Record<string, unknown>> } };
  const out = new Map<string, CatalogItem>();
  for (const raw of json.itemsResult?.items ?? []) {
    const mapped = mapItem(raw);
    if (mapped.asin) out.set(mapped.asin, mapped);
  }
  return out; // ASINs absent from the map = not found → caller handles
}

async function callSearchItems(params: SearchItemsParams): Promise<CatalogItem[]> {
  const json = (await callCatalog("searchItems", {
    keywords: params.keywords,
    searchIndex: params.searchIndex,
    // Server-side sale filter: only items discounted at least this % off list.
    // The discovery gates re-verify — never trust it alone. 0 = no filter.
    ...(params.minSavingPercent > 0 ? { minSavingPercent: params.minSavingPercent } : {}),
    ...(params.minPriceCents ? { minPrice: params.minPriceCents } : {}),
    ...(params.maxPriceCents ? { maxPrice: params.maxPriceCents } : {}),
    ...(params.minReviewRating ? { minReviewsRating: params.minReviewRating } : {}),
    availability: "Available",
    condition: "New",
    itemCount: 10,
    itemPage: params.itemPage ?? 1,
    sortBy: "Featured",
    resources: SEARCH_RESOURCES,
  })) as { searchResult?: { items?: Array<Record<string, unknown>> } };
  const raw = json.searchResult?.items ?? [];
  // PA-API had a Merchant=Amazon request filter; Creators API does not, so the
  // Amazon-only constraint moves client-side.
  const filtered = params.amazonOnly === false ? raw : raw.filter(isAmazonMerchant);
  return filtered.map(mapItem).filter((item) => item.asin);
}

/** Returns null when credentials are absent — callers then stand down to
 *  manual-only, exactly like the poster with no Bluesky creds. */
export function createCatalogClient(): CatalogClient | null {
  if (!config.creatorsApi.enabled) return null;
  return {
    async getItemsByAsin(asins: string[]): Promise<Map<string, CatalogItem>> {
      const merged = new Map<string, CatalogItem>();
      for (const group of chunk([...new Set(asins)], 10)) {
        if (!underDailyCap()) {
          console.warn("[creatorsApi] daily call cap reached — skipping remaining groups this tick");
          break;
        }
        const result = await schedule(() => callGetItems(group));
        for (const [asin, item] of result) merged.set(asin, item);
      }
      return merged;
    },
    async searchItems(params: SearchItemsParams): Promise<CatalogItem[]> {
      if (!underDailyCap()) {
        console.warn("[creatorsApi] daily call cap reached — skipping search this tick");
        return [];
      }
      return schedule(() => callSearchItems(params));
    },
  };
}
