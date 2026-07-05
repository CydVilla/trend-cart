import { prisma } from "@trendcart/db";
import {
  addTrackedListing,
  deleteListing,
  postDealNow,
  requestCheckNow,
  toggleListingActive,
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

function isStale(asOf: Date | null): boolean {
  return !!asOf && Date.now() - asOf.getTime() > MAX_PRICE_AGE_HOURS * 3_600_000;
}

export default async function DealsPage() {
  const [listings, recent, heartbeat] = await Promise.all([
    prisma.trackedListing.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { dealPosts: true } } },
    }),
    prisma.dealPost.findMany({
      include: { listing: { select: { title: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.workerHeartbeat.findUnique({ where: { id: "worker" } }),
  ]);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Deal tracker</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Watch specific Amazon listings and post a standalone deal alert to the bot&apos;s own
        profile when the price drops below the full price you set — with the % off shown against
        it. One sale = one post (it re-arms only after the price climbs back up). Every post
        carries your affiliate link and an in-post <code>#ad</code> disclosure.
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
        Automated price polling runs only when Amazon PA-API keys are configured on the worker
        (<code>PA_API_ACCESS_KEY</code>/<code>PA_API_SECRET_KEY</code>). Until then, use{" "}
        <strong>Post deal now</strong> on a listing to publish a deal manually — it needs no API
        keys.
      </div>

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
                    <td className="px-3 py-2">{dp.listing.title}</td>
                    <td className="px-3 py-2">
                      {formatMoney(dp.salePriceCents, dp.currency)}
                      <div className="text-xs text-zinc-400">as of {formatDate(dp.priceAsOf)}</div>
                    </td>
                    <td className="px-3 py-2 text-zinc-500">{dp.source}</td>
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
