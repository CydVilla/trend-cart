import { prisma } from "@trendcart/db";
import { toggleCategoryActive, updateCategory } from "../actions";
import { Badge, EmptyState } from "../ui";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const categories = await prisma.productCategory.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { products: true } }, recommendationPage: true },
  });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Categories</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Keywords drive the cheap pre-filter; the worker reloads them within 5 minutes — no restart
        needed. One keyword or phrase per line (or comma-separated).
      </p>
      {categories.length === 0 ? (
        <EmptyState>
          No categories. Run <code>pnpm db:seed</code>.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {categories.map((category) => (
            <details key={category.id} className="rounded-lg border border-zinc-200 bg-white">
              <summary className="flex cursor-pointer items-center gap-3 px-4 py-3">
                <span className="font-medium">{category.name}</span>
                <code className="text-xs text-zinc-400">{category.slug}</code>
                <Badge tone={category.isActive ? "green" : "zinc"}>
                  {category.isActive ? "active" : "inactive"}
                </Badge>
                <span className="text-xs text-zinc-400">
                  {category.keywords.length} keywords · {category._count.products} products ·{" "}
                  {category.recommendationPage
                    ? category.recommendationPage.isPublished
                      ? "page published"
                      : "page draft"
                    : "no page"}
                </span>
                <form action={toggleCategoryActive} className="ml-auto">
                  <input type="hidden" name="id" value={category.id} />
                  <button
                    type="submit"
                    className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                  >
                    {category.isActive ? "Deactivate" : "Activate"}
                  </button>
                </form>
              </summary>
              <form action={updateCategory} className="space-y-3 border-t border-zinc-100 p-4 text-sm">
                <input type="hidden" name="id" value={category.id} />
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Name</span>
                    <input
                      name="name"
                      defaultValue={category.name}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Description</span>
                    <input
                      name="description"
                      defaultValue={category.description}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                    />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">Keywords</span>
                    <textarea
                      name="keywords"
                      rows={6}
                      defaultValue={category.keywords.join("\n")}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 font-mono text-xs"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium uppercase text-zinc-500">
                      Negative keywords
                    </span>
                    <textarea
                      name="negativeKeywords"
                      rows={6}
                      defaultValue={category.negativeKeywords.join("\n")}
                      className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 font-mono text-xs"
                    />
                  </label>
                </div>
                <button
                  type="submit"
                  className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                >
                  Save
                </button>
              </form>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
