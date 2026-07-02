import Link from "next/link";
import { prisma, ReplyStatus } from "@trendcart/db";

export const dynamic = "force-dynamic";

type Stats = {
  posts: number;
  evaluations: number;
  pendingApproval: number;
  posted: number;
  categories: number;
  products: number;
};

async function getStats(): Promise<{ ok: true; stats: Stats } | { ok: false; error: string }> {
  try {
    const [posts, evaluations, pendingApproval, posted, categories, products] = await Promise.all([
      prisma.post.count(),
      prisma.candidateEvaluation.count(),
      prisma.botReply.count({ where: { status: ReplyStatus.PENDING_APPROVAL } }),
      prisma.botReply.count({ where: { status: ReplyStatus.POSTED } }),
      prisma.productCategory.count({ where: { isActive: true } }),
      prisma.product.count({ where: { isActive: true } }),
    ]);
    return { ok: true, stats: { posts, evaluations, pendingApproval, posted, categories, products } };
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
    { label: "Active categories", value: stats.categories, href: "/categories" },
    { label: "Active products", value: stats.products, href: "/products" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>
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
      <p className="text-sm text-zinc-500">
        The worker ingests Bluesky posts, evaluates them, and queues replies. Approve pending
        replies under <Link href="/replies" className="underline">Replies</Link>; tune matching
        under <Link href="/categories" className="underline">Categories</Link>.
      </p>
    </div>
  );
}
