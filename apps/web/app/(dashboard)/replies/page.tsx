import { prisma, ReplyStatus } from "@trendcart/db";
import { approveReply, editReply, rateReply, refineReply, rejectReply } from "../actions";
import { SubmitButton } from "../submit-button";
import {
  Badge,
  EmptyState,
  FactCheckNote,
  Pagination,
  SectionHeading,
  bskyPostUrl,
  formatDate,
  parseAudienceReplies,
  replyStatusTone,
  truncate,
} from "../ui";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

export default async function RepliesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const recentWhere = { status: { not: ReplyStatus.PENDING_APPROVAL } } as const;
  const recentCount = await prisma.botReply.count({ where: recentWhere });
  const totalPages = Math.max(1, Math.ceil(recentCount / PAGE_SIZE));
  const rawPage = Number(typeof params.page === "string" ? params.page : "1");
  const page = Math.min(totalPages, Math.max(1, Number.isFinite(rawPage) ? Math.floor(rawPage) : 1));

  const [pending, recent] = await Promise.all([
    prisma.botReply.findMany({
      where: { status: ReplyStatus.PENDING_APPROVAL },
      include: { post: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.botReply.findMany({
      where: recentWhere,
      include: { post: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // Ground truth from the worker's heartbeat, not this web process's env.
  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });

  // Affiliate-link clicks for the rows on screen (empty until click tracking
  // has minted links).
  const clickRows = await prisma.trackedLink.findMany({
    where: { kind: "reply", sourceId: { in: recent.map((r) => r.id) } },
    select: { sourceId: true, clickCount: true },
  });
  const clicksByReply = new Map(clickRows.map((l) => [l.sourceId as string, l.clickCount]));

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Replies</h1>

      {heartbeat ? (
        heartbeat.dryRun ? (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>Worker is in DRY_RUN</strong> — approved replies will not be posted. Posting
            state: <code>{heartbeat.postingState}</code>.
          </div>
        ) : (
          <div className="mb-4 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900">
            <strong>Worker is LIVE</strong> ({heartbeat.replyMode} mode) — approving here posts to
            Bluesky. Posting state: <code>{heartbeat.postingState}</code>
            {heartbeat.paused && (
              <strong className="ml-2 text-red-700">· currently PAUSED</strong>
            )}
          </div>
        )
      ) : (
        <div className="mb-4 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-600">
          Worker has never reported in — its mode is unknown until it runs.
        </div>
      )}

      <SectionHeading>Awaiting approval ({pending.length})</SectionHeading>
      {pending.length === 0 ? (
        <EmptyState>Nothing waiting. New replies appear here in manual mode.</EmptyState>
      ) : (
        <div className="space-y-4">
          {pending.map((reply) => {
            const postUrl = bskyPostUrl(reply.post.uri);
            return (
              <div key={reply.id} className="rounded-lg border border-zinc-200 bg-white p-4">
                <div className="text-xs text-zinc-400">
                  Replying to{" "}
                  {postUrl ? (
                    <a href={postUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      @{reply.post.authorHandle ?? reply.post.authorDid}
                    </a>
                  ) : (
                    `@${reply.post.authorHandle ?? reply.post.authorDid}`
                  )}{" "}
                  · generated {formatDate(reply.createdAt)}
                </div>
                <blockquote className="mt-2 border-l-2 border-zinc-200 pl-3 text-sm text-zinc-600">
                  {reply.post.text}
                </blockquote>
                <div className="mt-3 rounded bg-zinc-50 p-3 text-sm">
                  {reply.linkAnchor && reply.replyText.includes(reply.linkAnchor) ? (
                    <>
                      {reply.replyText.slice(0, reply.replyText.lastIndexOf(reply.linkAnchor))}
                      <span className="font-medium text-blue-600 underline">{reply.linkAnchor}</span>
                      {reply.replyText.slice(
                        reply.replyText.lastIndexOf(reply.linkAnchor) + reply.linkAnchor.length,
                      )}
                    </>
                  ) : (
                    reply.replyText
                  )}
                  <div className="mt-1 text-xs text-zinc-400">{reply.replyText.length} chars</div>
                  {reply.linkUrl && (
                    <div className="mt-1 break-all text-xs text-zinc-400">
                      link destination: <span className="text-blue-600">{reply.linkUrl}</span>
                    </div>
                  )}
                </div>
                {/* Why this landed in the queue: the pre-publication fact
                    check flagged it instead of letting it auto-post. */}
                <FactCheckNote raw={reply.factCheck} />
                <div className="mt-3 flex gap-2">
                  <form action={approveReply}>
                    <input type="hidden" name="id" value={reply.id} />
                    <SubmitButton
                      pendingLabel="Approving…"
                      className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Approve
                    </SubmitButton>
                  </form>
                  <form action={rejectReply}>
                    <input type="hidden" name="id" value={reply.id} />
                    <SubmitButton
                      pendingLabel="Rejecting…"
                      className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
                    >
                      Reject
                    </SubmitButton>
                  </form>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-zinc-500">
                    Edit or refine before approving
                  </summary>
                  <form action={editReply} className="mt-2 space-y-1">
                    <input type="hidden" name="id" value={reply.id} />
                    <textarea
                      name="text"
                      rows={3}
                      defaultValue={reply.replyText}
                      className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <SubmitButton
                        pendingLabel="Saving…"
                        className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        Save edit
                      </SubmitButton>
                      {reply.linkAnchor && (
                        <span className="text-xs text-zinc-400">
                          keep &ldquo;{reply.linkAnchor}&rdquo; in the text — it stays the clickable link
                        </span>
                      )}
                    </div>
                  </form>
                  <form action={refineReply} className="mt-2 flex gap-2">
                    <input type="hidden" name="id" value={reply.id} />
                    <input
                      name="instruction"
                      placeholder='Direction for the bot, e.g. "mention the 75th anniversary" — regenerates the text'
                      className="flex-1 rounded border border-zinc-300 px-2 py-1.5 text-sm"
                    />
                    <SubmitButton
                      pendingLabel="Regenerating…"
                      className="rounded bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700"
                    >
                      Regenerate
                    </SubmitButton>
                  </form>
                </details>
              </div>
            );
          })}
        </div>
      )}

      <SectionHeading>Recent activity</SectionHeading>
      {recent.length === 0 ? (
        <EmptyState>No reply activity yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Reply / reason</th>
                <th className="px-3 py-2">Post</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Your verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {recent.map((reply) => {
                const replyUrl = reply.replyUri ? bskyPostUrl(reply.replyUri) : null;
                return (
                  <tr key={reply.id} className="align-top">
                    <td className="px-3 py-2">
                      <Badge tone={replyStatusTone(reply.status)}>{reply.status}</Badge>
                      {reply.takedownAt ? (
                        <span
                          className="ml-2 text-xs text-red-600"
                          title={`Deleted from Bluesky after your 👎 (${formatDate(reply.takedownAt)}). The record stays for learning.`}
                        >
                          removed
                        </span>
                      ) : (
                        replyUrl && (
                          <a
                            href={replyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 text-xs underline"
                          >
                            view
                          </a>
                        )
                      )}
                    </td>
                    <td className="max-w-md px-3 py-2 text-xs text-zinc-600">
                      {reply.replyText ? <div>{truncate(reply.replyText, 140)}</div> : null}
                      {reply.skipReason ? (
                        <div className="text-zinc-400">{truncate(reply.skipReason, 100)}</div>
                      ) : null}
                      {reply.status === ReplyStatus.POSTED && (
                        <div className="mt-1 text-zinc-400">
                          ♥ {reply.replyLikeCount} · ↩ {reply.replyReplyCount}
                          {clicksByReply.has(reply.id) && (
                            <span title="Affiliate-link clicks — the revenue signal">
                              {" "}
                              · 🔗 {clicksByReply.get(reply.id)} click
                              {clicksByReply.get(reply.id) === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                      )}
                      {(() => {
                        const audience = parseAudienceReplies(reply.receivedReplies);
                        if (audience.length === 0) return null;
                        return (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-zinc-400 underline decoration-dotted">
                              they said ({audience.length})
                            </summary>
                            <ul className="mt-1 space-y-1 border-l-2 border-zinc-200 pl-2">
                              {audience.map((a, i) => (
                                <li key={i} className="text-zinc-500">
                                  <span className="text-zinc-400">@{a.authorHandle}:</span>{" "}
                                  {truncate(a.text, 160)}
                                  {a.likeCount > 0 && (
                                    <span className="text-zinc-400"> ({a.likeCount}♥)</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </details>
                        );
                      })()}
                    </td>
                    <td className="max-w-xs px-3 py-2 text-xs text-zinc-500" title={reply.post.text}>
                      {truncate(reply.post.text, 80)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                      {formatDate(reply.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      {reply.status === ReplyStatus.POSTED && (
                        <div className="min-w-40">
                          <div className="flex items-center gap-1">
                            <form action={rateReply}>
                              <input type="hidden" name="id" value={reply.id} />
                              <input type="hidden" name="rating" value="up" />
                              <SubmitButton
                                title="Good reply — do more like this (feeds the bot's learning)"
                                className={`rounded border px-2 py-0.5 text-sm ${
                                  reply.operatorRating === "up"
                                    ? "border-emerald-400 bg-emerald-100"
                                    : "border-zinc-200 hover:bg-zinc-100"
                                }`}
                              >
                                👍
                              </SubmitButton>
                            </form>
                            <form action={rateReply}>
                              <input type="hidden" name="id" value={reply.id} />
                              <input type="hidden" name="rating" value="down" />
                              <SubmitButton
                                title="Bad reply — DELETES it from Bluesky (within ~2 min) and feeds the bot's learning. The record stays here."
                                className={`rounded border px-2 py-0.5 text-sm ${
                                  reply.operatorRating === "down"
                                    ? "border-red-400 bg-red-100"
                                    : "border-zinc-200 hover:bg-zinc-100"
                                }`}
                              >
                                👎
                              </SubmitButton>
                            </form>
                          </div>
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-zinc-400 underline decoration-dotted">
                              {reply.operatorFeedback ? "note ✓" : "+ note"}
                            </summary>
                            <form action={rateReply} className="mt-1.5 space-y-1">
                              <input type="hidden" name="id" value={reply.id} />
                              <input
                                type="hidden"
                                name="rating"
                                value={reply.operatorRating ?? "down"}
                              />
                              <textarea
                                name="feedback"
                                rows={2}
                                defaultValue={reply.operatorFeedback ?? ""}
                                placeholder="Why? e.g. wrong product, too salesy, post wasn't a fit…"
                                className="w-48 rounded border border-zinc-200 px-2 py-1 text-xs"
                              />
                              <SubmitButton
                                pendingLabel="Saving…"
                                className="block rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                              >
                                Save note
                              </SubmitButton>
                            </form>
                          </details>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={page}
        totalPages={totalPages}
        totalCount={recentCount}
        hrefFor={(p) => `/replies?page=${p}`}
      />
    </div>
  );
}
