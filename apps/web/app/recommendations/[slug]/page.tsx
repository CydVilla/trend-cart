import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@trendcart/db";
import { withAffiliateTag } from "@trendcart/shared";

export const dynamic = "force-dynamic";

async function getPublishedPage(slug: string) {
  return prisma.recommendationPage.findFirst({
    where: { slug, isPublished: true },
    include: {
      category: {
        include: { products: { where: { isActive: true }, orderBy: { name: "asc" } } },
      },
    },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) return { title: "Not found" };
  return { title: page.title, description: page.intro };
}

export default async function PublicRecommendationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) notFound();

  const affiliateTag = process.env.AMAZON_ASSOCIATE_TAG ?? "";
  const products = page.category.products;
  const lastUpdated = page.updatedAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8">
        <Link href="/recommendations" className="text-sm text-zinc-400 hover:text-zinc-600">
          ← all recommendations
        </Link>
        <h1 className="mt-3 text-3xl font-bold">{page.title}</h1>
        <p className="mt-3 text-lg text-zinc-600">{page.intro}</p>
        {page.generatedSummary && <p className="mt-2 text-zinc-600">{page.generatedSummary}</p>}
      </header>

      <div className="space-y-4">
        {products.map((product) => (
          <div
            key={product.id}
            className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-5"
          >
            {product.imageUrl && (
              <img
                src={product.imageUrl}
                alt={product.name}
                className="h-24 w-24 shrink-0 rounded-lg object-cover"
              />
            )}
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold">{product.name}</h2>
              <p className="mt-1 text-sm text-zinc-600">{product.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-zinc-900">{product.priceRange}</span>
                <span className="text-xs uppercase tracking-wide text-zinc-400">
                  {product.merchant}
                </span>
                <a
                  href={withAffiliateTag(product.url, affiliateTag)}
                  target="_blank"
                  rel="noopener noreferrer nofollow sponsored"
                  className="ml-auto rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
                >
                  View on {product.merchant === "amazon" ? "Amazon" : product.merchant}
                </a>
              </div>
            </div>
          </div>
        ))}
        {products.length === 0 && (
          <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-zinc-500">
            Products for this list are being curated — check back soon.
          </p>
        )}
      </div>

      <footer className="mt-10 space-y-2 border-t border-zinc-200 pt-6 text-sm text-zinc-500">
        <p>
          <strong>Affiliate disclosure:</strong> As an Amazon Associate I earn from qualifying
          purchases. Links on this page may earn a commission at no extra cost to you.
        </p>
        <p>Last updated {lastUpdated}.</p>
      </footer>
    </div>
  );
}
