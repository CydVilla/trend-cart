import { prisma, DealPostStatus, ListingOrigin, SuggestionStatus } from "@trendcart/db";
import { PAAPI_SEARCH_INDEXES } from "@trendcart/shared";
import {
  approveDealPost,
  toggleListingActive,
  createDealFeed,
  createSuggestionSource,
  deleteDealFeed,
  deleteSuggestionSource,
  fetchSuggestionSourceNow,
  rejectDealPost,
  runDealFeedNow,
  toggleDealFeedActive,
  toggleSuggestionSourceActive,
  updateDealFeed,
  updateSuggestionSource,
} from "../actions";
import { SubmitButton } from "../submit-button";
import {
  Badge,
  EmptyState,
  SectionHeading,
  bskyPostUrl,
  dealPostTone,
  formatDate,
  formatMoney,
} from "../ui";

export const dynamic = "force-dynamic";

const MAX_PRICE_AGE_HOURS = Number(process.env.DEAL_MAX_PRICE_AGE_HOURS ?? 1);
// Same Heroku config vars reach both dynos, so the dashboard can tell the
// operator whether the worker's deal loops are actually running.
const DEALS_ENABLED = process.env.DEALS_ENABLED === "true";
const FEED_AUTOPOST = process.env.DEAL_FEED_AUTOPOST === "true";
const CLICK_TRACKING_ACTIVE =
  process.env.CLICK_TRACKING_ENABLED !== "false" && Boolean(process.env.PUBLIC_BASE_URL);

function isStale(asOf: Date | null): boolean {
  return !!asOf && Date.now() - asOf.getTime() > MAX_PRICE_AGE_HOURS * 3_600_000;
}

/** % off shown in the approval queue, computed the same way as the composer. */
function pctOff(saleCents: number, wasCents: number | null): number | null {
  if (wasCents == null || wasCents <= saleCents) return null;
  return Math.round(((wasCents - saleCents) / wasCents) * 100);
}

function candidateMeta(value: unknown): { lane: string; score: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { lane: "unknown", score: 0 };
  const candidate = (value as Record<string, unknown>).candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { lane: "unknown", score: 0 };
  }
  const row = candidate as Record<string, unknown>;
  return {
    lane: typeof row.lane === "string" ? row.lane : "unknown",
    score: typeof row.baseScore === "number" ? row.baseScore : 0,
  };
}

function verifiedSaleEvidenceUrl(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const promotion = (value as Record<string, unknown>).promotion;
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) return null;
  const factCheck = (promotion as Record<string, unknown>).factCheck;
  if (!factCheck || typeof factCheck !== "object" || Array.isArray(factCheck)) return null;
  const raw = (factCheck as Record<string, unknown>).saleEvidenceUrl;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export default async function DealsPage() {
  const [discovered, feeds, suggestionSources, pendingApproval, recent, heartbeat, stagedRaw] = await Promise.all([
    prisma.trackedListing.findMany({
      where: { origin: ListingOrigin.DISCOVERED },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { _count: { select: { dealPosts: true } } },
    }),
    prisma.dealFeed.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.dealSuggestionSource.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.dealPost.findMany({
      where: { status: DealPostStatus.PENDING_APPROVAL },
      include: { listing: { select: { title: true, asin: true } }, feed: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.dealPost.findMany({
      include: {
        listing: { select: { title: true } },
        feed: { select: { name: true } },
        suggestion: { select: { gateVerdict: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.workerHeartbeat.findUnique({ where: { id: "worker" } }),
    prisma.dealSuggestion.findMany({
      where: { status: SuggestionStatus.NEW },
      include: { source: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  const staged = stagedRaw
    .map((candidate) => ({ candidate, meta: candidateMeta(candidate.gateVerdict) }))
    .sort((a, b) => b.meta.score - a.meta.score || b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime())
    .slice(0, 30);
  const clickRows =
    recent.length > 0
      ? await prisma.trackedLink.findMany({
          where: { kind: "deal", sourceId: { in: recent.map((post) => post.id) } },
          select: { sourceId: true, clickCount: true },
        })
      : [];
  const clicksByDeal = new Map<string, number>();
  for (const link of clickRows) {
    if (!link.sourceId) continue;
    clicksByDeal.set(link.sourceId, (clicksByDeal.get(link.sourceId) ?? 0) + link.clickCount);
  }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Deal channel</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Fully automated, two paths into one poster: <strong>deal RSS sources</strong> (live today,
        no Amazon keys — items enter a ranked high-intent queue, then exact-ASIN/current-sale
        evidence is verified before the winner self-posts with
        PRICE-FREE copy attributed to the source) and <strong>deal feeds</strong> (Wario64-style
        PA-API sale discovery with real attested prices — lights up once you have API keys).
        Every post carries your affiliate link and an in-post <code>#ad</code> disclosure.
      </p>

      {!DEALS_ENABLED && (
        <div className="mb-4 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-700">
          <strong>Deal channel is off on the worker.</strong> Configure sources and feeds now;
          nothing runs until <code>DEALS_ENABLED=true</code> is set on the worker (and{" "}
          <code>DEAL_RSS_AUTOPOST=true</code> for the RSS channel to publish).
        </div>
      )}
      {heartbeat?.dryRun ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Worker is in DRY_RUN</strong> — queued deals are recorded but never posted to
          Bluesky. Flip <code>DRY_RUN=false</code> on the worker to go live.
        </div>
      ) : (
        <div className="mb-4 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
          <strong>Worker is LIVE</strong> — a discovered deal that clears the gates will post to
          the bot&apos;s profile.
        </div>
      )}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
        Deal feeds (attested prices) run only when Amazon PA-API keys are configured on the worker
        (<code>PA_API_ACCESS_KEY</code>/<code>PA_API_SECRET_KEY</code>). Until then, the RSS
        sources below are the whole channel — automated, price-free posts that need no API keys.
      </div>
      {!CLICK_TRACKING_ACTIVE && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>Click-based lane learning is inactive.</strong> Set{" "}
          <code>CLICK_TRACKING_ENABLED=true</code> and <code>PUBLIC_BASE_URL</code> on both dynos;
          engagement can still influence lanes, but untracked posts are never treated as zero-click
          failures.
        </div>
      )}

      <SectionHeading>High-intent RSS candidate queue ({stagedRaw.length})</SectionHeading>
      <p className="-mt-2 mb-3 text-xs text-zinc-500">
        Candidates across every source compete here before a posting slot or expensive sale check
        is spent. Scores combine purchase intent, exact Amazon-link confidence, freshness, lane
        value, and a bounded click-performance boost at promotion time. Showing the top 30.
      </p>
      {staged.length === 0 ? (
        <EmptyState>No staged RSS candidates right now.</EmptyState>
      ) : (
        <div className="mb-8 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs uppercase text-zinc-400">
              <tr>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Lane</th>
                <th className="px-3 py-2">Candidate</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Staged</th>
              </tr>
            </thead>
            <tbody>
              {staged.map(({ candidate, meta }) => (
                <tr key={candidate.id} className="border-b border-zinc-50 last:border-0">
                  <td className="px-3 py-2 font-semibold">{meta.score}</td>
                  <td className="px-3 py-2"><Badge tone="blue">{meta.lane}</Badge></td>
                  <td className="max-w-md px-3 py-2">
                    <a href={candidate.productUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      {candidate.title.length > 90 ? `${candidate.title.slice(0, 90)}…` : candidate.title}
                    </a>
                    <div className="text-xs text-zinc-400"><code>{candidate.asin}</code></div>
                  </td>
                  <td className="px-3 py-2 text-zinc-500">{candidate.source.name}</td>
                  <td className="px-3 py-2 text-zinc-500">{formatDate(candidate.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Feed-discovered deals awaiting approval */}
      {pendingApproval.length > 0 && (
        <>
          <SectionHeading>Awaiting approval ({pendingApproval.length})</SectionHeading>
          <p className="-mt-2 mb-3 text-xs text-zinc-500">
            Deals are perishable: anything not approved within {MAX_PRICE_AGE_HOURS}h of its price
            snapshot expires on its own. Set <code>DEAL_FEED_AUTOPOST=true</code> to skip this
            queue entirely.
          </p>
          <div className="mb-8 space-y-3">
            {pendingApproval.map((dp) => {
              const pct = pctOff(dp.salePriceCents, dp.wasPriceCents);
              return (
                <div key={dp.id} className="rounded-lg border border-amber-200 bg-white p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                    <Badge tone="amber">PENDING_APPROVAL</Badge>
                    <span className="font-medium text-zinc-700">
                      {formatMoney(dp.salePriceCents, dp.currency)}
                    </span>
                    {dp.wasPriceCents != null && (
                      <span className="line-through">
                        {formatMoney(dp.wasPriceCents, dp.currency)}
                      </span>
                    )}
                    {pct != null && <Badge tone="green">{pct}% off</Badge>}
                    {dp.feed && <span>found by “{dp.feed.name}”</span>}
                    <code>{dp.listing.asin}</code>
                    <span>
                      as of {formatDate(dp.priceAsOf)}
                      {isStale(dp.priceAsOf) && (
                        <span className="ml-1">
                          <Badge tone="amber">STALE</Badge>
                        </span>
                      )}
                    </span>
                  </div>
                  {dp.postText && (
                    <p className="mb-2 whitespace-pre-line rounded border border-zinc-100 bg-zinc-50 p-2 text-sm">
                      {dp.postText}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-zinc-400">
                      link →{" "}
                      <a
                        href={dp.linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        {dp.linkUrl}
                      </a>
                    </span>
                    <span className="grow" />
                    <form action={approveDealPost}>
                      <input type="hidden" name="id" value={dp.id} />
                      <SubmitButton
                        pendingLabel="Approving…"
                        className="rounded bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-700"
                      >
                        Approve &amp; post
                      </SubmitButton>
                    </form>
                    <form action={rejectDealPost}>
                      <input type="hidden" name="id" value={dp.id} />
                      <SubmitButton
                        pendingLabel="Rejecting…"
                        className="rounded border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50"
                      >
                        Reject
                      </SubmitButton>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Deal feeds — Wario64-style sale discovery */}
      <SectionHeading>Deal feeds ({feeds.length})</SectionHeading>
      <p className="-mt-2 mb-3 text-xs text-zinc-500">
        Each feed is a saved Amazon search the worker polls for products currently on sale — only
        items with a real strikethrough discount (Amazon&apos;s own list price) qualify, re-checked
        server-side. Discovered deals{" "}
        {FEED_AUTOPOST ? (
          <strong>post automatically (DEAL_FEED_AUTOPOST=true)</strong>
        ) : (
          <>queue above for your approval (flip <code>DEAL_FEED_AUTOPOST=true</code> to go full
          auto)</>
        )}
        , spend their own daily budget, and never repost the same item within the per-listing
        cooldown.
      </p>

      <form
        action={createDealFeed}
        className="mb-4 space-y-3 rounded-lg border border-zinc-200 bg-white p-4"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Feed name</span>
            <input
              name="name"
              required
              placeholder="Video game deals"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Keywords</span>
            <input
              name="keywords"
              required
              placeholder="video games"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Category</span>
            <select
              name="searchIndex"
              defaultValue="All"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            >
              {PAAPI_SEARCH_INDEXES.map((index) => (
                <option key={index} value={index}>
                  {index}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Min % off</span>
            <input
              name="minSavingPercent"
              inputMode="numeric"
              defaultValue="20"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Min price ($)</span>
            <input
              name="minPrice"
              inputMode="decimal"
              placeholder="optional"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Max price ($)</span>
            <input
              name="maxPrice"
              inputMode="decimal"
              placeholder="optional"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Min reviews</span>
            <input
              name="minReviewCount"
              inputMode="numeric"
              defaultValue="50"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Min stars (1–4)</span>
            <input
              name="minReviewRating"
              inputMode="numeric"
              defaultValue="4"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex items-end gap-2 pb-1.5 text-sm text-zinc-700">
            <input type="checkbox" name="amazonOnly" defaultChecked className="h-4 w-4" />
            Sold by Amazon only
          </label>
        </div>
        <p className="text-xs text-zinc-500">
          “Sold by Amazon only” keeps third-party sellers with inflated strikethrough prices out.
          Review floors apply when Amazon returns review data.
        </p>
        <SubmitButton
          pendingLabel="Saving…"
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Add feed
        </SubmitButton>
      </form>

      {feeds.length === 0 ? (
        <EmptyState>No deal feeds yet. Add one above — try “video games” in VideoGames.</EmptyState>
      ) : (
        <div className="mb-8 space-y-3">
          {feeds.map((feed) => (
            <details key={feed.id} className="rounded-lg border border-zinc-200 bg-white">
              <summary className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="font-medium">{feed.name}</span>
                <Badge tone={feed.isActive ? "green" : "zinc"}>
                  {feed.isActive ? "active" : "paused"}
                </Badge>
                <span className="text-xs text-zinc-500">
                  “{feed.keywords}” in {feed.searchIndex} · ≥{feed.minSavingPercent}% off
                </span>
                <span className="text-xs text-zinc-400">
                  {feed.lastRunAt
                    ? `last run ${formatDate(feed.lastRunAt)} — found ${feed.lastFoundCount}, queued ${feed.lastQueuedCount}`
                    : "never run"}
                </span>
                {feed.lastRunError && (
                  <span className="text-xs text-red-600">{feed.lastRunError}</span>
                )}
              </summary>
              <div className="space-y-3 border-t border-zinc-100 p-4 text-sm">
                <form action={updateDealFeed} className="grid gap-3 md:grid-cols-4">
                  <input type="hidden" name="id" value={feed.id} />
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Keywords</span>
                    <input
                      name="keywords"
                      defaultValue={feed.keywords}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Category</span>
                    <select
                      name="searchIndex"
                      defaultValue={feed.searchIndex}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    >
                      {PAAPI_SEARCH_INDEXES.map((index) => (
                        <option key={index} value={index}>
                          {index}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Min % off</span>
                    <input
                      name="minSavingPercent"
                      inputMode="numeric"
                      defaultValue={String(feed.minSavingPercent)}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Min / max price ($)
                    </span>
                    <span className="mt-1 flex gap-2">
                      <input
                        name="minPrice"
                        inputMode="decimal"
                        defaultValue={
                          feed.minPriceCents != null ? (feed.minPriceCents / 100).toFixed(2) : ""
                        }
                        className="w-full rounded border border-zinc-300 px-2 py-1.5"
                      />
                      <input
                        name="maxPrice"
                        inputMode="decimal"
                        defaultValue={
                          feed.maxPriceCents != null ? (feed.maxPriceCents / 100).toFixed(2) : ""
                        }
                        className="w-full rounded border border-zinc-300 px-2 py-1.5"
                      />
                    </span>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Min reviews</span>
                    <input
                      name="minReviewCount"
                      inputMode="numeric"
                      defaultValue={String(feed.minReviewCount)}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Min stars (1–4)
                    </span>
                    <input
                      name="minReviewRating"
                      inputMode="numeric"
                      defaultValue={String(feed.minReviewRating)}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-1.5 text-zinc-700">
                    <input
                      type="checkbox"
                      name="amazonOnly"
                      defaultChecked={feed.amazonOnly}
                      className="h-4 w-4"
                    />
                    Sold by Amazon only
                  </label>
                  <div className="flex items-end">
                    <SubmitButton
                      pendingLabel="Saving…"
                      className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Save feed
                    </SubmitButton>
                  </div>
                </form>
                <div className="flex flex-wrap gap-2">
                  <form action={runDealFeedNow}>
                    <input type="hidden" name="id" value={feed.id} />
                    <SubmitButton
                      title="Make the feed due immediately (worker picks it up within a minute)"
                      pendingLabel="Queuing…"
                      className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Run now
                    </SubmitButton>
                  </form>
                  <form action={toggleDealFeedActive}>
                    <input type="hidden" name="id" value={feed.id} />
                    <SubmitButton className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100">
                      {feed.isActive ? "Pause" : "Activate"}
                    </SubmitButton>
                  </form>
                  <form action={deleteDealFeed}>
                    <input type="hidden" name="id" value={feed.id} />
                    <SubmitButton
                      pendingLabel="Deleting…"
                      className="rounded border border-red-300 px-2 py-1.5 text-xs text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </SubmitButton>
                  </form>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}

      {/* RSS deal sources — the automated no-PA-API channel */}
      <SectionHeading>Deal RSS sources ({suggestionSources.length})</SectionHeading>
      <p className="-mt-2 mb-3 text-xs text-zinc-500">
        Deal-site RSS feeds (e.g. Slickdeals) the worker reads for Amazon items —{" "}
        <strong>works without PA-API keys, fully automated</strong>. Each source keeps one topical
        lane: keyword filters run first, an LLM assigns a high-conversion lane and purchase-intent
        score, candidates compete globally, and strict web verification must confirm the exact
        ASIN is currently discounted on Amazon before a survivor can self-post with
        price-free copy attributed to the source (max{" "}
        <code>DEAL_RSS_MAX_POSTS_PER_DAY</code>/day). No third-party price is ever advertised.
      </p>

      <form
        action={createSuggestionSource}
        className="mb-4 space-y-3 rounded-lg border border-zinc-200 bg-white p-4"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Source name</span>
            <input
              name="name"
              required
              placeholder="Tech & electronics (Slickdeals)"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">RSS URL</span>
            <input
              name="url"
              required
              placeholder="https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="text-xs font-medium uppercase text-zinc-500">
              Lane — what belongs here, in plain words
            </span>
            <textarea
              name="topic"
              required
              rows={2}
              placeholder="Clothing tied to TV, movie, video game, or pop-culture fandoms: graphic tees, hoodies… Plain unbranded clothing does NOT match."
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">
              Include keywords (optional, comma-separated)
            </span>
            <input
              name="includeKeywords"
              placeholder="shirt, tee, hoodie — headline must contain one"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">
              Exclude keywords (optional)
            </span>
            <input
              name="excludeKeywords"
              placeholder="refurbished, renewed"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Min price ($)</span>
            <input
              name="minPrice"
              inputMode="decimal"
              placeholder="optional"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Max price ($)</span>
            <input
              name="maxPrice"
              inputMode="decimal"
              placeholder="optional"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <SubmitButton
          pendingLabel="Saving…"
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Add source
        </SubmitButton>
      </form>

      {suggestionSources.length === 0 ? (
        <EmptyState>No RSS sources yet — add one above; it&apos;s the automated no-PA-API deal channel.</EmptyState>
      ) : (
        <div className="mb-8 space-y-3">
          {suggestionSources.map((source) => (
            <details key={source.id} className="rounded-lg border border-zinc-200 bg-white">
              <summary className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="font-medium">{source.name}</span>
                <Badge tone={source.isActive ? "green" : "zinc"}>
                  {source.isActive ? "active" : "paused"}
                </Badge>
                <span className="text-xs text-zinc-400">
                  {source.lastFetchedAt
                    ? `last fetch ${formatDate(source.lastFetchedAt)} — ${source.lastItemCount} items, ${source.lastQueuedCount} candidates staged`
                    : "never fetched"}
                </span>
                {source.lastFetchError && (
                  <span className="text-xs text-red-600">{source.lastFetchError}</span>
                )}
              </summary>
              <div className="space-y-3 border-t border-zinc-100 p-4 text-sm">
                <form action={updateSuggestionSource} className="grid gap-3 md:grid-cols-2">
                  <input type="hidden" name="id" value={source.id} />
                  <label className="block md:col-span-2">
                    <span className="text-xs font-medium uppercase text-zinc-500">RSS URL</span>
                    <input
                      name="url"
                      defaultValue={source.url}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block md:col-span-2">
                    <span className="text-xs font-medium uppercase text-zinc-500">Lane</span>
                    <textarea
                      name="topic"
                      rows={2}
                      defaultValue={source.topic}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Include keywords
                    </span>
                    <input
                      name="includeKeywords"
                      defaultValue={source.includeKeywords.join(", ")}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Exclude keywords
                    </span>
                    <input
                      name="excludeKeywords"
                      defaultValue={source.excludeKeywords.join(", ")}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Min / max price ($)
                    </span>
                    <span className="mt-1 flex gap-2">
                      <input
                        name="minPrice"
                        inputMode="decimal"
                        defaultValue={
                          source.minPriceCents != null
                            ? (source.minPriceCents / 100).toFixed(2)
                            : ""
                        }
                        className="w-full rounded border border-zinc-300 px-2 py-1.5"
                      />
                      <input
                        name="maxPrice"
                        inputMode="decimal"
                        defaultValue={
                          source.maxPriceCents != null
                            ? (source.maxPriceCents / 100).toFixed(2)
                            : ""
                        }
                        className="w-full rounded border border-zinc-300 px-2 py-1.5"
                      />
                    </span>
                  </label>
                  <div className="flex items-end">
                    <SubmitButton
                      pendingLabel="Saving…"
                      className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Save source
                    </SubmitButton>
                  </div>
                </form>
                <div className="flex flex-wrap gap-2">
                  <form action={fetchSuggestionSourceNow}>
                    <input type="hidden" name="id" value={source.id} />
                    <SubmitButton
                      title="Fetch this feed on the worker's next tick"
                      pendingLabel="Queuing…"
                      className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                    >
                      Fetch now
                    </SubmitButton>
                  </form>
                  <form action={toggleSuggestionSourceActive}>
                    <input type="hidden" name="id" value={source.id} />
                    <SubmitButton className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100">
                      {source.isActive ? "Pause" : "Activate"}
                    </SubmitButton>
                  </form>
                  <form action={deleteSuggestionSource}>
                    <input type="hidden" name="id" value={source.id} />
                    <SubmitButton
                      pendingLabel="Deleting…"
                      className="rounded border border-red-300 px-2 py-1.5 text-xs text-red-700 hover:bg-red-50"
                    >
                      Delete
                    </SubmitButton>
                  </form>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}

      {/* Feed-discovered listings: dedup/cooldown state per ASIN. */}
      {discovered.length > 0 && (
        <>
          <SectionHeading>Discovered by feeds ({discovered.length})</SectionHeading>
          <p className="-mt-2 mb-3 text-xs text-zinc-500">
            Every ASIN a feed has queued, newest first (last 50). These are never price-polled —
            they exist so the same item can&apos;t repost within the cooldown. <strong>Pause</strong>{" "}
            one to ban it from ever being posted again.
          </p>
          <div className="mb-8 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-100 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Last queued price</th>
                  <th className="px-3 py-2">Posts</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {discovered.map((listing) => (
                  <tr key={listing.id} className="border-b border-zinc-50 last:border-0">
                    <td className="max-w-md px-3 py-2">
                      <a
                        href={listing.productUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        {listing.title.length > 80
                          ? `${listing.title.slice(0, 80)}…`
                          : listing.title}
                      </a>
                      <div className="text-xs text-zinc-400">
                        <code>{listing.asin}</code>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {listing.lastPostedPriceCents != null
                        ? formatMoney(listing.lastPostedPriceCents, listing.currency)
                        : "—"}
                      {listing.fullPriceCents != null && (
                        <span className="ml-1 text-xs text-zinc-400 line-through">
                          {formatMoney(listing.fullPriceCents, listing.currency)}
                        </span>
                      )}
                      <div className="text-xs text-zinc-400">
                        {listing.lastPriceAsOf ? formatDate(listing.lastPriceAsOf) : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{listing._count.dealPosts}</td>
                    <td className="px-3 py-2">
                      <Badge tone={listing.isActive ? "green" : "red"}>
                        {listing.isActive ? "eligible" : "banned"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <form action={toggleListingActive}>
                        <input type="hidden" name="id" value={listing.id} />
                        <SubmitButton
                          title={
                            listing.isActive
                              ? "Ban this ASIN — the automated channel will never post it again"
                              : "Allow this ASIN to be posted again"
                          }
                          className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                        >
                          {listing.isActive ? "Ban" : "Allow"}
                        </SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SectionHeading>Recent deal posts</SectionHeading>
      {recent.length === 0 ? (
        <EmptyState>No deal posts yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-100 text-xs uppercase text-zinc-400">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Listing</th>
                <th className="px-3 py-2">Price</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Post</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((dp) => {
                const url = dp.postUri ? bskyPostUrl(dp.postUri) : null;
                const evidenceUrl = verifiedSaleEvidenceUrl(dp.suggestion?.gateVerdict);
                return (
                  <tr key={dp.id} className="border-b border-zinc-50 last:border-0">
                    <td className="px-3 py-2">
                      <Badge tone={dealPostTone(dp.status)}>{dp.status}</Badge>
                      {dp.skipReason && (
                        <div className="mt-0.5 text-xs text-zinc-400">{dp.skipReason}</div>
                      )}
                    </td>
                    <td className="max-w-md px-3 py-2">
                      {dp.listing.title.length > 80
                        ? `${dp.listing.title.slice(0, 80)}…`
                        : dp.listing.title}
                    </td>
                    <td className="px-3 py-2">
                      {dp.salePriceCents > 0 ? formatMoney(dp.salePriceCents, dp.currency) : "price-free"}
                      <div className="text-xs text-zinc-400">
                        {dp.saleVerifiedAt
                          ? `sale verified ${formatDate(dp.saleVerifiedAt)}`
                          : dp.status === DealPostStatus.DRY_RUN && dp.laneKey
                            ? "simulated verification (dry run)"
                          : `as of ${formatDate(dp.priceAsOf)}`}
                      </div>
                      {evidenceUrl && (
                        <a
                          href={evidenceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 underline"
                        >
                          sale evidence ↗
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-500">
                      {dp.source}
                      {dp.feed && <div className="text-xs text-zinc-400">{dp.feed.name}</div>}
                      {dp.laneKey && <div className="text-xs text-zinc-400">{dp.laneKey} · score {dp.candidateScore ?? "—"}</div>}
                      <div className="text-xs text-zinc-400">
                        {clicksByDeal.has(dp.id)
                          ? `${clicksByDeal.get(dp.id) ?? 0} clicks`
                          : "clicks untracked"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{formatDate(dp.createdAt)}</td>
                    <td className="px-3 py-2">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
                          view ↗
                        </a>
                      ) : (
                        <span className="text-zinc-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
