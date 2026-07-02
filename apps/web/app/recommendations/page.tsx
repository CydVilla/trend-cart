import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@trendcart/db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recommendations",
  description: "Curated product picks for everyday problems.",
};

export default async function RecommendationsIndexPage() {
  const pages = await prisma.recommendationPage.findMany({
    where: { isPublished: true },
    orderBy: { title: "asc" },
    include: {
      category: { include: { _count: { select: { products: { where: { isActive: true } } } } } },
    },
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-bold">Recommendations</h1>
      <p className="mt-2 text-zinc-600">
        Short, honest lists of things that fix specific everyday problems.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {pages.map((page) => (
          <Link
            key={page.id}
            href={`/recommendations/${page.slug}`}
            className="rounded-xl border border-zinc-200 bg-white p-5 transition hover:shadow-sm"
          >
            <h2 className="font-semibold">{page.title}</h2>
            <p className="mt-1 line-clamp-2 text-sm text-zinc-600">{page.intro}</p>
            <p className="mt-2 text-xs text-zinc-400">
              {page.category._count.products} picks
            </p>
          </Link>
        ))}
        {pages.length === 0 && (
          <p className="text-zinc-500 sm:col-span-2">Nothing published yet — check back soon.</p>
        )}
      </div>
      <footer className="mt-10 border-t border-zinc-200 pt-6 text-sm text-zinc-500">
        As an Amazon Associate I earn from qualifying purchases.
      </footer>
    </div>
  );
}
