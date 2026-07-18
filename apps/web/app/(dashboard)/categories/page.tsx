import { prisma } from "@trendcart/db";
import { toggleCategoryActive, updateCategory } from "../actions";
import { SubmitButton } from "../submit-button";
import { Badge, EmptyState } from "../ui";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const categories = await prisma.productCategory.findMany({
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Categories</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Keywords are the Bluesky <strong>search queries</strong> used to discover trending
        candidates (top posts of the last 24h per query; the first 12 per category are polled each
        cycle). One query per line — phrase them like searches. Changes apply on the next
        discovery cycle.
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
                  {category.keywords.length} search queries
                </span>
                <form action={toggleCategoryActive} className="ml-auto">
                  <input type="hidden" name="id" value={category.id} />
                  <SubmitButton className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100">
                    {category.isActive ? "Deactivate" : "Activate"}
                  </SubmitButton>
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
                <label className="block md:w-1/2">
                  <span className="text-xs font-medium uppercase text-zinc-500">
                    Min engagement floor
                  </span>
                  <input
                    name="minEngagementScore"
                    type="number"
                    min={0}
                    defaultValue={category.minEngagementScore ?? ""}
                    placeholder="global default"
                    className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                  />
                  <span className="mt-1 block text-xs text-zinc-400">
                    Blank = the global MIN_ENGAGEMENT_SCORE. Lower it for high-conviction
                    categories whose candidates expire waiting; raise it for noisy ones.
                  </span>
                </label>
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
                <SubmitButton
                  pendingLabel="Saving…"
                  className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                >
                  Save
                </SubmitButton>
              </form>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
