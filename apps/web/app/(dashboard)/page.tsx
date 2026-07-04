import Link from "next/link";
import { prisma, ReplyStatus } from "@trendcart/db";
import { toggleAutonomous, toggleWorkerPaused, updateOperatorGuidance } from "./actions";
import { Badge } from "./ui";

export const dynamic = "force-dynamic";

const HEARTBEAT_STALE_MS = 2 * 60_000;

async function WorkerStatusCard() {
  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "worker" } });
  if (!heartbeat) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500">
        <span className="font-medium text-zinc-700">Worker:</span> never seen — start it with{" "}
        <code>pnpm dev:worker</code>.
      </div>
    );
  }
  const stale = Date.now() - heartbeat.updatedAt.getTime() > HEARTBEAT_STALE_MS;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm ${
        stale ? "border-red-300 bg-red-50" : "border-zinc-200 bg-white"
      }`}
    >
      <span className="font-medium">Worker</span>
      <Badge tone={stale ? "red" : "green"}>{stale ? "STALE / DOWN" : "live"}</Badge>
      <Badge tone={heartbeat.dryRun ? "amber" : "blue"}>
        {heartbeat.dryRun ? "dry run" : `LIVE · ${heartbeat.replyMode}`}
      </Badge>
      {heartbeat.autonomous && <Badge tone="amber">AUTONOMOUS</Badge>}
      <span className="text-zinc-500">{heartbeat.model}</span>
      <span className="text-zinc-400">{heartbeat.postingState}</span>
      {heartbeat.paused && <Badge tone="red">PAUSED</Badge>}
      <span className="text-xs text-zinc-400">
        last tick {heartbeat.updatedAt.toLocaleTimeString("en-US")}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <form action={toggleAutonomous}>
          <button
            type="submit"
            className={`rounded px-3 py-1 text-xs font-medium ${
              heartbeat.autonomous
                ? "bg-amber-500 text-white hover:bg-amber-600"
                : "border border-zinc-300 text-zinc-600 hover:bg-zinc-50"
            }`}
            title="Self-approve replies with intent ≥ 80 and link confidence ≥ 75; weaker ones still queue for you. DRY_RUN overrides."
          >
            {heartbeat.autonomous ? "Autonomous: ON" : "Autonomous: off"}
          </button>
        </form>
        <form action={toggleWorkerPaused}>
          <button
            type="submit"
            className={`rounded px-3 py-1 text-xs font-medium ${
              heartbeat.paused
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "border border-red-300 text-red-700 hover:bg-red-50"
            }`}
          >
            {heartbeat.paused ? "Resume bot" : "Pause bot"}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * The operator's direct override channel: standing instructions the bot
 * treats as authoritative in every evaluation and reply, above anything it
 * learned. Applied within ~2 minutes of saving.
 */
async function OperatorGuidanceCard() {
  const row = await prisma.botMemory.findUnique({ where: { id: "operator-guidance" } });
  return (
    <details className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 text-sm" open={!row?.content}>
      <summary className="cursor-pointer font-medium text-blue-900">
        Operator guidance{" "}
        <span className="font-normal text-blue-700/70">
          — your standing instructions to the bot (overrides its own judgment)
        </span>
      </summary>
      <form action={updateOperatorGuidance} className="mt-3 space-y-2">
        <textarea
          name="guidance"
          rows={4}
          defaultValue={row?.content ?? ""}
          placeholder={
            "e.g. It's fine to recommend a product when a post is abstract commentary, as long as a specific product is clearly being alluded to so readers know what it is. Keep replies short and never salesy."
          }
          className="w-full rounded border border-blue-200 bg-white px-3 py-2 font-sans text-zinc-700"
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            Save guidance
          </button>
          <span className="text-xs text-blue-700/60">
            Applies within ~2 min · leave empty to clear · max 2000 chars
          </span>
        </div>
      </form>
    </details>
  );
}

/** What the daily reflection job distilled from the operator's decisions. */
async function LessonsCard() {
  const lessons = await prisma.botMemory.findUnique({ where: { id: "lessons" } });
  if (!lessons) return null;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-medium">What the bot has learned</span>
        <span className="text-xs text-zinc-400">
          from your approvals, edits &amp; rejections · refreshed{" "}
          {lessons.updatedAt.toLocaleDateString("en-US")}
        </span>
      </div>
      <pre className="whitespace-pre-wrap font-sans text-zinc-600">{lessons.content}</pre>
    </div>
  );
}

type Stats = {
  posts: number;
  evaluations: number;
  pendingApproval: number;
  posted: number;
  replyLikes: number;
  categories: number;
};

async function getStats(): Promise<{ ok: true; stats: Stats } | { ok: false; error: string }> {
  try {
    const [posts, evaluations, pendingApproval, posted, likeAgg, categories] = await Promise.all([
      prisma.post.count(),
      prisma.candidateEvaluation.count(),
      prisma.botReply.count({ where: { status: ReplyStatus.PENDING_APPROVAL } }),
      prisma.botReply.count({ where: { status: ReplyStatus.POSTED } }),
      prisma.botReply.aggregate({ _sum: { replyLikeCount: true } }),
      prisma.productCategory.count({ where: { isActive: true } }),
    ]);
    return {
      ok: true,
      stats: {
        posts,
        evaluations,
        pendingApproval,
        posted,
        replyLikes: likeAgg._sum.replyLikeCount ?? 0,
        categories,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export default async function HomePage() {
  const result = await getStats();

  if (!result.ok) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Database not reachable.</strong> Start it with <code>pnpm db:up</code> and run{" "}
        <code>pnpm db:migrate</code>.
        <div className="mt-2 font-mono text-xs text-amber-700">{result.error}</div>
      </div>
    );
  }

  const { stats } = result;
  const cards = [
    { label: "Candidate posts", value: stats.posts, href: "/candidates" },
    { label: "Evaluations", value: stats.evaluations, href: "/candidates" },
    { label: "Awaiting approval", value: stats.pendingApproval, href: "/replies", highlight: stats.pendingApproval > 0 },
    { label: "Posted replies", value: stats.posted, href: "/replies" },
    { label: "Likes on bot replies", value: stats.replyLikes, href: "/replies" },
    { label: "Active categories", value: stats.categories, href: "/categories" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>
      <WorkerStatusCard />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className={`rounded-lg border p-4 transition hover:shadow-sm ${
              card.highlight ? "border-amber-400 bg-amber-50" : "border-zinc-200 bg-white"
            }`}
          >
            <div className="text-3xl font-semibold">{card.value}</div>
            <div className="text-sm text-zinc-500">{card.label}</div>
          </Link>
        ))}
      </div>
      <OperatorGuidanceCard />
      <LessonsCard />
      <p className="text-sm text-zinc-500">
        The worker discovers trending Bluesky posts, evaluates them, and queues replies. Approve
        pending replies under <Link href="/replies" className="underline">Replies</Link>; tune the
        search queries under <Link href="/categories" className="underline">Categories</Link>.
      </p>
    </div>
  );
}
