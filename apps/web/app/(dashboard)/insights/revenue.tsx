import { prisma, computeRevenueReport } from "@trendcart/db";
import { formatMoney, type AffiliateChannel } from "@trendcart/shared";
import { SubmitButton } from "../submit-button";
import { Badge, SectionHeading } from "../ui";
import { uploadAssociatesReport } from "./actions";

const CHANNEL_LABEL: Record<AffiliateChannel, string> = {
  reply: "Replies",
  deal_rss: "RSS deals",
  deal_curated: "Curator relay",
  deal_feed: "Feed deals",
  deal_manual: "Manual deals",
};

const SOURCE_LABEL: Record<string, string> = {
  CURATED: "curator",
  DISCOVERED: "rss/feed",
  MANUAL: "manual",
  AUTOMATED: "watchlist",
};

const conv = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

export type UploadOutcome = Record<string, string | string[] | undefined>;

function UploadBanner({ outcome }: { outcome: UploadOutcome }) {
  const one = (k: string): string | undefined => {
    const v = outcome[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const error = one("uploadError");
  if (error) {
    return (
      <div className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
        Upload failed: {error}
      </div>
    );
  }
  const kind = one("imported");
  if (!kind) return null;
  return (
    <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
      Imported {one("rows")} {kind} rows{one("range") ? ` for ${one("range")!.replace("..", " → ")}` : ""}
      {Number(one("replaced")) > 0 ? ` (replaced ${one("replaced")} from an earlier upload)` : ""}.
      {one("skipped") ? (
        <span className="text-amber-800">
          {" "}
          Skipped {one("skipped")} unreadable row(s): {one("why")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Revenue by channel: the hand-uploaded Associates Orders/Earnings reports,
 * split by tracking ID (one per channel via AMAZON_TAG_*) and joined to our
 * own human-click counts. The question it answers: which channel converts.
 */
export async function RevenueSection({ outcome }: { outcome: UploadOutcome }) {
  const report = await computeRevenueReport(prisma);
  const t = report.totals;
  const shared = report.channels.some((c) => c.channels.length > 1);

  return (
    <section id="revenue">
      <SectionHeading>Revenue by channel</SectionHeading>
      <UploadBanner outcome={outcome} />
      <form
        action={uploadAssociatesReport}
        className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white p-3 text-sm"
      >
        <input
          type="file"
          name="report"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          required
          className="max-w-full text-xs"
        />
        <SubmitButton
          pendingLabel="Importing…"
          className="rounded bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700"
        >
          Upload report
        </SubmitButton>
        <span className="text-xs text-zinc-400">
          Associates Central → Reports → Download reports → <b>Orders</b> or <b>Earnings</b> (CSV).
          Re-uploading a range replaces it.
        </span>
      </form>

      {!report.coverage ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-500">
          No reports uploaded yet. Amazon only splits sales by tracking ID, so give each channel its
          own ID first (AMAZON_TAG_REPLY, AMAZON_TAG_DEAL_RSS, AMAZON_TAG_DEAL_CURATED, …) — until
          then every sale lands under the one shared tag.
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-zinc-500">
            {report.uploads.map((u) => (
              <span key={u.kind} className="mr-3">
                {u.kind.toLowerCase()}: {u.from} → {u.to}
              </span>
            ))}
            · clicks are human clicks on links created {report.clickWindow!.from} →{" "}
            {report.clickWindow!.to} (approximate: click counters are lifetime, not per day).
          </p>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Ordered items", value: String(t.orderedItems) },
              { label: "Ordered sales", value: formatMoney(t.orderedSalesCents) },
              { label: "Earned (ad fees)", value: formatMoney(t.feeCents) },
              { label: "Conversion", value: conv(t.conversion), hint: `${t.clicks} clicks` },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-zinc-200 bg-white p-3">
                <div className="text-xs text-zinc-500">{s.label}</div>
                <div className="text-lg font-semibold text-zinc-800">{s.value}</div>
                {s.hint && <div className="text-xs text-zinc-400">{s.hint}</div>}
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-100 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Tracking ID</th>
                  <th className="px-3 py-2">Clicks</th>
                  <th className="px-3 py-2">Ordered</th>
                  <th className="px-3 py-2">Conv.</th>
                  <th className="px-3 py-2">Sales</th>
                  <th className="px-3 py-2">Shipped / ret.</th>
                  <th className="px-3 py-2">Earned</th>
                </tr>
              </thead>
              <tbody>
                {report.channels.map((c) => (
                  <tr key={c.trackingId} className="border-b border-zinc-50 last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{c.trackingId}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {c.channels.length === 0 ? (
                          <Badge>no current channel</Badge>
                        ) : (
                          c.channels.map((ch) => (
                            <Badge key={ch} tone={c.channels.length > 1 ? "amber" : "blue"}>
                              {CHANNEL_LABEL[ch]}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{c.clicks}</td>
                    <td className="px-3 py-2">
                      {c.orderedItems}
                      {c.indirectItems > 0 && (
                        <span className="text-xs text-zinc-400"> ({c.indirectItems} indirect)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-medium">{conv(c.conversion)}</td>
                    <td className="px-3 py-2 text-zinc-600">{formatMoney(c.orderedSalesCents)}</td>
                    <td className="px-3 py-2 text-zinc-600">
                      {c.shippedItems} / {c.returnedItems}
                    </td>
                    <td className="px-3 py-2 font-medium text-emerald-700">{formatMoney(c.feeCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shared && (
            <p className="mt-2 text-xs text-amber-700">
              Amber channels share one tracking ID, so their sales can&apos;t be told apart. Create a
              tracking ID per channel in Associates Central and set its AMAZON_TAG_* var.
            </p>
          )}

          <h3 className="mb-2 mt-6 text-sm font-semibold">Top products</h3>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-100 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Promoted by</th>
                  <th className="px-3 py-2">Clicks</th>
                  <th className="px-3 py-2">Ordered</th>
                  <th className="px-3 py-2">Conv.</th>
                  <th className="px-3 py-2">Earned</th>
                </tr>
              </thead>
              <tbody>
                {report.asins.map((a) => (
                  <tr key={a.asin} className="border-b border-zinc-50 last:border-0">
                    <td className="max-w-xs px-3 py-2">
                      <div className="truncate" title={a.title}>
                        {a.title || a.asin}
                      </div>
                      <div className="font-mono text-xs text-zinc-400">
                        {a.asin} · {a.trackingIds.join(", ")}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-600">
                      {a.dealPosts.length === 0 && a.replyLinks === 0 && a.dealLinks === 0 ? (
                        <span
                          className="text-zinc-400"
                          title="No post or /dp/ link of ours named this ASIN: bought from a reply's search link, or another item in a session we referred"
                        >
                          via search / indirect
                        </span>
                      ) : (
                        <>
                          {a.dealPosts.length > 0
                            ? `${a.dealPosts.length} deal post${a.dealPosts.length > 1 ? "s" : ""} (${[
                                ...new Set(a.dealPosts.map((p) => SOURCE_LABEL[p.source] ?? p.source)),
                              ].join(", ")})`
                            : a.dealLinks > 0 && `${a.dealLinks} deal link${a.dealLinks > 1 ? "s" : ""}`}
                          {(a.dealPosts.length > 0 || a.dealLinks > 0) && a.replyLinks > 0 && " · "}
                          {a.replyLinks > 0 && `${a.replyLinks} reply link${a.replyLinks > 1 ? "s" : ""}`}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{a.clicks}</td>
                    <td className="px-3 py-2">{a.orderedItems}</td>
                    <td className="px-3 py-2">{conv(a.conversion)}</td>
                    <td className="px-3 py-2 font-medium text-emerald-700">{formatMoney(a.feeCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            Joined by ASIN to our deal posts and direct /dp/ reply links. Reply search links carry no
            ASIN, so reply sales show up per tracking ID above but rarely here.
          </p>
        </>
      )}
    </section>
  );
}
