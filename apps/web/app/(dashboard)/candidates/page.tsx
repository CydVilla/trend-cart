import { prisma } from "@trendcart/db";
import { injectPost, skipPost } from "../actions";
import { Badge, EmptyState, formatDate, bskyPostUrl, replyStatusTone, safetyTone, truncate } from "../ui";

export const dynamic = "force-dynamic";

export default async function CandidatesPage() {
  const posts = await prisma.post.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      evaluations: { orderBy: { createdAt: "desc" }, take: 1 },
      replies: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Candidate posts</h1>

      <form
        action={injectPost}
        className="mb-4 flex gap-2 rounded-lg border border-zinc-200 bg-white p-3"
      >
        <input
          name="url"
          placeholder="Test a post: paste a bsky.app post URL (top-level posts only) — it enters the pipeline immediately"
          className="flex-1 rounded border border-zinc-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Inject
        </button>
      </form>
      {posts.length === 0 ? (
        <EmptyState>
          No candidates yet — run <code>pnpm dev:worker</code> and posts matching category
          keywords will appear here.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2">Post</th>
                <th className="px-3 py-2">Engagement</th>
                <th className="px-3 py-2">Categories</th>
                <th className="px-3 py-2">Intent</th>
                <th className="px-3 py-2">Safety</th>
                <th className="px-3 py-2">Evaluation</th>
                <th className="px-3 py-2">Reply</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {posts.map((post) => {
                const evaluation = post.evaluations[0];
                const reply = post.replies[0];
                const url = bskyPostUrl(post.uri);
                return (
                  <tr key={post.id} className="align-top">
                    <td className="max-w-xs px-3 py-2">
                      <div title={post.text}>{truncate(post.text, 110)}</div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
                            @{post.authorHandle ?? post.authorDid.slice(0, 16)}
                          </a>
                        ) : (
                          `@${post.authorHandle ?? post.authorDid.slice(0, 16)}`
                        )}{" "}
                        · {formatDate(post.indexedAt)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div>score {post.engagementScore}</div>
                      <div className="text-zinc-400">{post.engagementVelocity.toFixed(1)}/h</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{post.detectedCategories.join(", ")}</td>
                    <td className="px-3 py-2">
                      {post.productIntentScore !== null ? (
                        <Badge tone={post.productIntentScore >= 70 ? "green" : "zinc"}>
                          {post.productIntentScore}
                        </Badge>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={safetyTone(post.safetyStatus)}>{post.safetyStatus}</Badge>
                    </td>
                    <td className="max-w-xs px-3 py-2 text-xs text-zinc-600">
                      {evaluation ? (
                        <div title={evaluation.reason}>
                          {evaluation.shouldReply ? (
                            <Badge tone="green">would reply</Badge>
                          ) : (
                            <Badge tone="zinc">no reply</Badge>
                          )}{" "}
                          {evaluation.recommendedCategory && (
                            <span className="text-zinc-500">→ {evaluation.recommendedCategory}</span>
                          )}
                          <div className="mt-1">{truncate(evaluation.reason, 90)}</div>
                        </div>
                      ) : (
                        <span className="text-zinc-400">not evaluated</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {reply ? (
                        <Badge tone={replyStatusTone(reply.status)}>{reply.status}</Badge>
                      ) : (
                        <span className="text-xs text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {!reply && (
                        <form action={skipPost}>
                          <input type="hidden" name="postId" value={post.id} />
                          <button
                            type="submit"
                            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                          >
                            Skip
                          </button>
                        </form>
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
