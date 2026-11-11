import { DealSource, prisma } from "@trendcart/db";
import { config } from "./config.js";

/**
 * Hourly read of eBay conversions from the Impact Actions API (ADR-0018), the
 * per-post half of the eBay channel: each post's link carries its DealPost ID
 * as `customid`, and a matching sub-ID on the conversion ties the sale back.
 * Conversions that match no post are still stored, so money is never lost
 * from the Insights totals.
 */

const API_BASE = "https://api.impact.com/Mediapartners";
const FETCH_TIMEOUT_MS = 30_000;
/** Long enough to catch payouts and reversals on recent orders. */
const WINDOW_DAYS = 45;
const PAGE_SIZE = 2000;
const MAX_PAGES = 20;
const SUB_ID_FIELDS = ["SubId1", "SubId2", "SubId3", "SharedId"] as const;

export type ParsedConversion = {
  id: string;
  subIds: string[];
  state: string;
  saleCents: number;
  payoutCents: number;
  currency: string;
  eventAt: Date;
};

type JsonRecord = Record<string, unknown>;

function cents(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/** One Actions page → rows for our program. Rows missing an ID or date drop. */
export function parseImpactActions(json: unknown, programId: string): ParsedConversion[] {
  const actions = (json as JsonRecord | null)?.Actions;
  if (!Array.isArray(actions)) return [];
  const rows: ParsedConversion[] = [];
  for (const raw of actions as JsonRecord[]) {
    if (String(raw.CampaignId ?? "") !== programId) continue;
    const id = String(raw.Id ?? "");
    const eventAt = new Date(String(raw.EventDate ?? ""));
    if (!id || Number.isNaN(eventAt.getTime())) continue;
    rows.push({
      id,
      subIds: SUB_ID_FIELDS.map((f) => String(raw[f] ?? "").trim()).filter(Boolean),
      state: String(raw.State ?? "PENDING").toUpperCase(),
      saleCents: cents(raw.Amount),
      payoutCents: cents(raw.Payout),
      currency: String(raw.Currency ?? "USD") || "USD",
      eventAt,
    });
  }
  return rows;
}

/** Every action in the window, across pages. Never logs the credentials. */
export async function fetchImpactConversions(
  creds: { accountSid: string; authToken: string; programId: string },
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedConversion[]> {
  const stamp = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");
  const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 3_600_000);
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");
  const rows: ParsedConversion[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`${API_BASE}/${creds.accountSid}/Actions`);
    url.searchParams.set("CampaignId", creds.programId);
    url.searchParams.set("ActionDateStart", stamp(start));
    url.searchParams.set("ActionDateEnd", stamp(now));
    url.searchParams.set("PageSize", String(PAGE_SIZE));
    url.searchParams.set("Page", String(page));
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Impact Actions failed: HTTP ${response.status}`);
    const json = (await response.json()) as JsonRecord;
    rows.push(...parseImpactActions(json, creds.programId));
    if (page >= Number(json["@numpages"] ?? 0)) break;
  }
  return rows;
}

export type EbaySync = { tick: () => Promise<void>; enabled: boolean };

export function createEbaySync(): EbaySync {
  const { accountSid, authToken, ebayProgramId: programId } = config.impact;
  if (!accountSid || !authToken) {
    console.log("  ebay conversions: disabled (set IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN)");
    return { tick: async () => {}, enabled: false };
  }
  console.log(`  ebay conversions: Impact program ${programId}, hourly`);

  async function tick(): Promise<void> {
    const rows = await fetchImpactConversions({ accountSid, authToken, programId });
    if (rows.length === 0) return;
    const posts = await prisma.dealPost.findMany({
      where: { source: DealSource.EBAY, id: { in: [...new Set(rows.flatMap((r) => r.subIds))] } },
      select: { id: true },
    });
    const postIds = new Set(posts.map((p) => p.id));
    for (const { id, subIds, ...fields } of rows) {
      const data = {
        ...fields,
        subId: subIds[0] ?? null,
        dealPostId: subIds.find((s) => postIds.has(s)) ?? null,
      };
      await prisma.ebayConversion.upsert({ where: { id }, create: { id, ...data }, update: data });
    }
    console.log(`[ebaySync] ${rows.length} conversion(s), ${rows.filter((r) => r.subIds.some((s) => postIds.has(s))).length} tied to a post`);
  }

  return { tick, enabled: true };
}
