import { prisma, DealPostStatus, ListingOrigin } from "@trendcart/db";
import { PAAPI_SEARCH_INDEXES } from "@trendcart/shared";
import {
  addTrackedListing,
  approveDealPost,
  createDealFeed,
  deleteDealFeed,
  deleteListing,
  postDealNow,
  rejectDealPost,
  requestCheckNow,
  runDealFeedNow,
  toggleDealFeedActive,
  toggleListingActive,
  updateDealFeed,
  updateListingPricing,
} from "../actions";
import { SubmitButton } from "../submit-button";
import {
  Badge,
  EmptyState,
  SectionHeading,
  armStateTone,
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

function isStale(asOf: Date | null): boolean {
  return !!asOf && Date.now() - asOf.getTime() > MAX_PRICE_AGE_HOURS * 3_600_000;
}

/** % off shown in the approval queue, computed the same way as the composer. */
function pctOff(saleCents: number, wasCents: number | null): number | null {
  if (wasCents == null || wasCents <= saleCents) return null;
  return Math.round(((wasCents - saleCents) / wasCents) * 100);
}

export default async function DealsPage() {
  const [listings, discovered, feeds, pendingApproval, recent, heartbeat] = await Promise.all([
    prisma.trackedListing.findMany({
      where: { origin: ListingOrigin.WATCHLIST },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { dealPosts: true } } },
    }),
    prisma.trackedListing.findMany({
      where: { origin: ListingOrigin.DISCOVERED },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { _count: { select: { dealPosts: true } } },
    }),
    prisma.dealFeed.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.dealPost.findMany({
      where: { status: DealPostStatus.PENDING_APPROVAL },
      include: { listing: { select: { title: true, asin: true } }, feed: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.dealPost.findMany({
      include: {
        listing: { select: { title: true } },
        feed: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.workerHeartbeat.findUnique({ where: { id: "worker" } }),
  ]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Deal tracker</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Two ways deals land on the bot&apos;s profile: <strong>deal feeds</strong> search Amazon
        for products currently on sale (Wario64-style — real strikethrough discounts only) and{" "}
        <strong>the watchlist</strong> fires when a specific listing you track drops below your
        price. Every post carries your affiliate link and an in-post <code>#ad</code> disclosure.
      </p>

      {!DEALS_ENABLED && (
        <div className="mb-4 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-700">
          <strong>Deal tracker is off on the worker.</strong> You can add listings and queue deals
          now, but nothing publishes until <code>DEALS_ENABLED=true</code> is set on the worker.
        </div>
      )}
      {heartbeat?.dryRun ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Worker is in DRY_RUN</strong> — queued deals are recorded but never posted to
          Bluesky. Flip <code>DRY_RUN=false</code> on the worker to go live.
        </div>
      ) : (
        <div className="mb-4 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
          <strong>Worker is LIVE</strong> — a fired or manually-queued deal will post to the
          bot&apos;s profile.
        </div>
      )}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
        Deal feeds and automated price polling run only when Amazon PA-API keys are configured on
        the worker (<code>PA_API_ACCESS_KEY</code>/<code>PA_API_SECRET_KEY</code>). Until then,
        use <strong>Post deal now</strong> on a listing to publish a deal manually — it needs no
        API keys.
      </div>

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

      {/* Add listing */}
      <form
        action={addTrackedListing}
        className="mb-8 space-y-3 rounded-lg border border-zinc-200 bg-white p-4"
      >
        <SectionHeading>Track a new listing</SectionHeading>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block md:col-span-2">
            <span className="text-xs font-medium uppercase text-zinc-500">Amazon product URL</span>
            <input
              name="url"
              required
              placeholder="https://www.amazon.com/dp/B0CL5KNB9M"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="text-xs font-medium uppercase text-zinc-500">Title (shown in post)</span>
            <input
              name="title"
              required
              placeholder="Sony PS5 Slim console"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">Full price ($)</span>
            <input
              name="fullPrice"
              inputMode="decimal"
              placeholder="499.99"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase text-zinc-500">
              Alert price ($, optional)
            </span>
            <input
              name="targetPrice"
              inputMode="decimal"
              placeholder="any drop below full"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block md:col-span-2">
            <span className="text-xs font-medium uppercase text-zinc-500">
              Image URL (optional, Amazon-hosted)
            </span>
            <input
              name="imageUrl"
              placeholder="https://m.media-amazon.com/images/I/....jpg"
              className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <p className="text-xs text-zinc-500">
          Set the <strong>full price</strong> to post on any drop below it, with the % off shown
          against it. Add an <strong>alert price</strong> only if you want to hold out for a
          steeper discount (post at or below that instead).
        </p>
        <SubmitButton
          pendingLabel="Tracking…"
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Track listing
        </SubmitButton>
      </form>

      <SectionHeading>Watchlist ({listings.length})</SectionHeading>
      {listings.length === 0 ? (
        <EmptyState>No tracked listings yet. Add one above.</EmptyState>
      ) : (
        <div className="space-y-3">
          {listings.map((listing) => {
            const threshold = listing.targetPriceCents ?? listing.fullPriceCents ?? null;
            const belowTarget =
              listing.lastPriceCents != null &&
              threshold != null &&
              listing.lastPriceCents <= threshold;
            return (
              <details key={listing.id} className="rounded-lg border border-zinc-200 bg-white">
                <summary className="flex flex-wrap items-center gap-2 px-4 py-3">
                  <span className="font-medium">{listing.title}</span>
                  <code className="text-xs text-zinc-400">{listing.asin}</code>
                  <Badge tone={armStateTone(listing.armState)}>{listing.armState}</Badge>
                  <Badge tone={listing.isActive ? "green" : "zinc"}>
                    {listing.isActive ? "active" : "paused"}
                  </Badge>
                  <span className="text-sm">
                    <span className={belowTarget ? "font-semibold text-emerald-700" : "text-zinc-600"}>
                      {listing.lastPriceCents != null
                        ? formatMoney(listing.lastPriceCents, listing.currency)
                        : "no price yet"}
                    </span>
                    <span className="text-zinc-400">
                      {listing.fullPriceCents != null &&
                        ` / full ${formatMoney(listing.fullPriceCents, listing.currency)}`}
                      {listing.targetPriceCents != null &&
                        ` · alert ${formatMoney(listing.targetPriceCents, listing.currency)}`}
                    </span>
                  </span>
                  {listing.lastPriceAsOf && (
                    <span className="text-xs text-zinc-400">
                      as of {formatDate(listing.lastPriceAsOf)}
                      {isStale(listing.lastPriceAsOf) && (
                        <span className="ml-1">
                          <Badge tone="amber">STALE</Badge>
                        </span>
                      )}
                    </span>
                  )}
                  {listing.lastCheckError && (
                    <span className="text-xs text-red-600">{listing.lastCheckError}</span>
                  )}
                </summary>

                <div className="space-y-4 border-t border-zinc-100 p-4 text-sm">
                  <div className="flex flex-wrap items-end gap-3">
                    <form action={updateListingPricing} className="flex items-end gap-2">
                      <input type="hidden" name="id" value={listing.id} />
                      <label className="block">
                        <span className="text-xs font-medium uppercase text-zinc-500">Full ($)</span>
                        <input
                          name="fullPrice"
                          inputMode="decimal"
                          defaultValue={
                            listing.fullPriceCents != null
                              ? (listing.fullPriceCents / 100).toFixed(2)
                              : ""
                          }
                          className="mt-1 w-24 rounded border border-zinc-300 px-2 py-1.5"
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-medium uppercase text-zinc-500">
                          Alert ($)
                        </span>
                        <input
                          name="targetPrice"
                          inputMode="decimal"
                          placeholder="optional"
                          defaultValue={
                            listing.targetPriceCents != null
                              ? (listing.targetPriceCents / 100).toFixed(2)
                              : ""
                          }
                          className="mt-1 w-24 rounded border border-zinc-300 px-2 py-1.5"
                        />
                      </label>
                      <SubmitButton
                        pendingLabel="Saving…"
                        className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                      >
                        Save prices
                      </SubmitButton>
                    </form>
                    <form action={toggleListingActive}>
                      <input type="hidden" name="id" value={listing.id} />
                      <SubmitButton className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100">
                        {listing.isActive ? "Pause" : "Activate"}
                      </SubmitButton>
                    </form>
                    <form action={requestCheckNow}>
                      <input type="hidden" name="id" value={listing.id} />
                      <SubmitButton
                        title="Ask the worker to re-poll on its next tick (needs PA-API keys)"
                        pendingLabel="Queuing…"
                        className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100"
                      >
                        Check now
                      </SubmitButton>
                    </form>
                    <form action={deleteListing}>
                      <input type="hidden" name="id" value={listing.id} />
                      <SubmitButton
                        pendingLabel="Deleting…"
                        className="rounded border border-red-300 px-2 py-1.5 text-xs text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </SubmitButton>
                    </form>
                  </div>

                  <form
                    action={postDealNow}
                    className="flex flex-wrap items-end gap-2 rounded border border-blue-200 bg-blue-50/40 p-3"
                  >
                    <input type="hidden" name="id" value={listing.id} />
                    <label className="block">
                      <span className="text-xs font-medium uppercase text-blue-800">
                        Sale price ($)
                      </span>
                      <input
                        name="salePrice"
                        inputMode="decimal"
                        required
                        placeholder="399.99"
                        className="mt-1 w-28 rounded border border-blue-200 px-2 py-1.5"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium uppercase text-blue-800">
                        Seen at (optional)
                      </span>
                      <input
                        type="datetime-local"
                        name="priceAsOf"
                        className="mt-1 rounded border border-blue-200 px-2 py-1.5"
                      />
                    </label>
                    <SubmitButton
                      pendingLabel="Posting…"
                      className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      Post deal now
                    </SubmitButton>
                    <span className="text-xs text-blue-700/70">
                      Queues a standalone #ad post now — works without PA-API. Price must be under{" "}
                      {MAX_PRICE_AGE_HOURS}h old.
                    </span>
                  </form>

                  <div className="text-xs text-zinc-400">
                    <a
                      href={listing.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {listing.productUrl}
                    </a>{" "}
                    · {listing._count.dealPosts} deal post(s) · {listing.marketplace}
                  </div>
                </div>
              </details>
            );
          })}
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
                      <div className="flex gap-2">
                        <form action={toggleListingActive}>
                          <input type="hidden" name="id" value={listing.id} />
                          <SubmitButton className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100">
                            {listing.isActive ? "Pause" : "Allow"}
                          </SubmitButton>
                        </form>
                        <form action={deleteListing}>
                          <input type="hidden" name="id" value={listing.id} />
                          <SubmitButton
                            pendingLabel="Deleting…"
                            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            Delete
                          </SubmitButton>
                        </form>
                      </div>
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
                      {formatMoney(dp.salePriceCents, dp.currency)}
                      <div className="text-xs text-zinc-400">as of {formatDate(dp.priceAsOf)}</div>
                    </td>
                    <td className="px-3 py-2 text-zinc-500">
                      {dp.source}
                      {dp.feed && <div className="text-xs text-zinc-400">{dp.feed.name}</div>}
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
