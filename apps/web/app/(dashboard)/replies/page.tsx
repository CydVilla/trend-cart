import { prisma, ReplyStatus } from "@trendcart/db";
import { approveReply, editReply, refineReply, rejectReply } from "../actions";
import { Badge, EmptyState, SectionHeading, bskyPostUrl, formatDate, replyStatusTone, truncate } from "../ui";

export const dynamic = "force-dynamic";

export default async function RepliesPage() {
  const [pending, recent] = await Promise.all([
    prisma.botReply.findMany({
      where: { status: ReplyStatus.PENDING_APPROVAL },
      include: { post: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.botReply.findMany({
      where: { status: { not: ReplyStatus.PENDING_APPROVAL } },
      include: { post: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  // Ground truth from the worker's heartbeat, not this web process's env.
  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });

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
                <div className="mt-3 flex gap-2">
                  <form action={approveReply}>
                    <input type="hidden" name="id" value={reply.id} />
                    <button
                      type="submit"
                      className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      Approve
                    </button>
                  </form>
                  <form action={rejectReply}>
                    <input type="hidden" name="id" value={reply.id} />
                    <button
                      type="submit"
                      className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
                    >
                      Reject
                    </button>
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
                      <button
                        type="submit"
                        className="rounded border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        Save edit
                      </button>
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
                    <button
                      type="submit"
                      className="rounded bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-700"
                    >
                      Regenerate
                    </button>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {recent.map((reply) => {
                const replyUrl = reply.replyUri ? bskyPostUrl(reply.replyUri) : null;
                return (
                  <tr key={reply.id} className="align-top">
                    <td className="px-3 py-2">
                      <Badge tone={replyStatusTone(reply.status)}>{reply.status}</Badge>
                      {replyUrl && (
                        <a
                          href={replyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 text-xs underline"
                        >
                          view
                        </a>
                      )}
                    </td>
                    <td className="max-w-md px-3 py-2 text-xs text-zinc-600">
                      {reply.replyText ? <div>{truncate(reply.replyText, 140)}</div> : null}
                      {reply.skipReason ? (
                        <div className="text-zinc-400">{truncate(reply.skipReason, 100)}</div>
                      ) : null}
                    </td>
                    <td className="max-w-xs px-3 py-2 text-xs text-zinc-500" title={reply.post.text}>
                      {truncate(reply.post.text, 80)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">
                      {formatDate(reply.createdAt)}
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
