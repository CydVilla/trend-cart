import { prisma } from "@trendcart/db";
import { withAffiliateTag } from "@trendcart/shared";
import { togglePagePublished, upsertRecommendationPage } from "../actions";
import { Badge, SectionHeading } from "../ui";

export const dynamic = "force-dynamic";

export default async function PagesAdminPage() {
  const categories = await prisma.productCategory.findMany({
    orderBy: { name: "asc" },
    include: {
      recommendationPage: true,
      products: { where: { isActive: true }, orderBy: { name: "asc" } },
    },
  });
  const affiliateTag = process.env.AMAZON_ASSOCIATE_TAG ?? "";
  const siteUrl = process.env.PUBLIC_SITE_URL ?? "http://localhost:3000";

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Recommendation pages</h1>
      <p className="mb-4 text-sm text-zinc-500">
        The bot only replies for categories with a <strong>published</strong> page — an unpublished
        page silently disables replies for its category. Pages go live at{" "}
        <code>/recommendations/[slug]</code>.
      </p>

      <div className="space-y-4">
        {categories.map((category) => {
          const page = category.recommendationPage;
          return (
            <div key={category.id} className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-center gap-3">
                <span className="font-medium">{category.name}</span>
                <code className="text-xs text-zinc-400">/recommendations/{category.slug}</code>
                {page ? (
                  <Badge tone={page.isPublished ? "green" : "amber"}>
                    {page.isPublished ? "published" : "draft"}
                  </Badge>
                ) : (
                  <Badge tone="zinc">no page</Badge>
                )}
                <span className="text-xs text-zinc-400">
                  {category.products.length} active products
                </span>
                {page && (
                  <form action={togglePagePublished} className="ml-auto">
                    <input type="hidden" name="id" value={page.id} />
                    <button
                      type="submit"
                      className={`rounded px-3 py-1 text-xs font-medium ${
                        page.isPublished
                          ? "border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                          : "bg-emerald-600 text-white hover:bg-emerald-700"
                      }`}
                    >
                      {page.isPublished ? "Unpublish" : "Publish"}
                    </button>
                  </form>
                )}
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-zinc-500">
                  {page ? "Edit" : "Create page"}
                </summary>
                <form action={upsertRecommendationPage} className="mt-3 space-y-3 text-sm">
                  <input type="hidden" name="categoryId" value={category.id} />
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Title *</span>
                    <input
                      name="title"
                      required
                      defaultValue={page?.title ?? category.name}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Intro (the problem this solves)
                    </span>
                    <textarea
                      name="intro"
                      rows={3}
                      defaultValue={page?.intro ?? ""}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                  >
                    Save
                  </button>
                </form>
              </details>

              {page && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-zinc-500">Preview</summary>
                  <div className="mt-3 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-5">
                    <div className="text-xs uppercase tracking-wide text-zinc-400">
                      {siteUrl}/recommendations/{page.slug}
                    </div>
                    <h2 className="mt-2 text-xl font-bold">{page.title}</h2>
                    <p className="mt-1 text-sm text-zinc-600">{page.intro}</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {category.products.map((product) => (
                        <div key={product.id} className="rounded border border-zinc-200 bg-white p-3">
                          <div className="text-sm font-medium">{product.name}</div>
                          <div className="text-xs text-zinc-500">{product.description}</div>
                          <div className="mt-1 text-xs text-zinc-400">
                            {product.priceRange} · {product.merchant}
                          </div>
                          <a
                            href={withAffiliateTag(product.url, affiliateTag)}
                            target="_blank"
                            rel="noopener noreferrer nofollow sponsored"
                            className="mt-2 inline-block rounded bg-zinc-900 px-2 py-1 text-xs text-white"
                          >
                            View on Amazon
                          </a>
                        </div>
                      ))}
                      {category.products.length === 0 && (
                        <div className="text-sm text-zinc-400">
                          No active products — the live page will look empty.
                        </div>
                      )}
                    </div>
                    <p className="mt-4 text-xs text-zinc-400">
                      As an Amazon Associate I earn from qualifying purchases.
                    </p>
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
