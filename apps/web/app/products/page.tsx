import { prisma } from "@trendcart/db";
import { withAffiliateTag } from "@trendcart/shared";
import { createProduct, toggleProductActive } from "../actions";
import { Badge, EmptyState, SectionHeading, truncate } from "../ui";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const categories = await prisma.productCategory.findMany({
    orderBy: { name: "asc" },
    include: { products: { orderBy: { name: "asc" } } },
  });
  const affiliateTag = process.env.AMAZON_ASSOCIATE_TAG ?? "";

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Products</h1>
      <p className="mb-4 text-sm text-zinc-500">
        Store plain Amazon URLs — the affiliate tag{affiliateTag ? ` (${affiliateTag})` : ""} is
        appended automatically when links render on recommendation pages.
      </p>

      <SectionHeading>Add product</SectionHeading>
      <form
        action={createProduct}
        className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm md:grid-cols-3"
      >
        <label className="block">
          <span className="text-xs font-medium uppercase text-zinc-500">Category</span>
          <select name="categoryId" className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5">
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase text-zinc-500">Name *</span>
          <input name="name" required className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5" />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase text-zinc-500">Price range</span>
          <input
            name="priceRange"
            placeholder="$15–$25"
            className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
          />
        </label>
        <label className="block md:col-span-2">
          <span className="text-xs font-medium uppercase text-zinc-500">URL * (plain, no tag)</span>
          <input
            name="url"
            required
            placeholder="https://www.amazon.com/dp/..."
            className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase text-zinc-500">Image URL</span>
          <input name="imageUrl" className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5" />
        </label>
        <label className="block md:col-span-3">
          <span className="text-xs font-medium uppercase text-zinc-500">Description</span>
          <input name="description" className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5" />
        </label>
        <div>
          <button
            type="submit"
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Add product
          </button>
        </div>
      </form>

      {categories.map((category) =>
        category.products.length === 0 ? null : (
          <div key={category.id}>
            <SectionHeading>
              {category.name} ({category.products.length})
            </SectionHeading>
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Price</th>
                    <th className="px-3 py-2">Link (with tag)</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {category.products.map((product) => (
                    <tr key={product.id} className="align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{product.name}</div>
                        <div className="text-xs text-zinc-400">{truncate(product.description, 80)}</div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">{product.priceRange}</td>
                      <td className="max-w-xs px-3 py-2 text-xs">
                        <a
                          href={withAffiliateTag(product.url, affiliateTag)}
                          target="_blank"
                          rel="noopener noreferrer nofollow sponsored"
                          className="break-all text-blue-600 underline"
                        >
                          {truncate(withAffiliateTag(product.url, affiliateTag), 70)}
                        </a>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={product.isActive ? "green" : "zinc"}>
                          {product.isActive ? "active" : "inactive"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <form action={toggleProductActive}>
                          <input type="hidden" name="id" value={product.id} />
                          <button
                            type="submit"
                            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100"
                          >
                            {product.isActive ? "Deactivate" : "Activate"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ),
      )}

      {categories.every((c) => c.products.length === 0) && (
        <div className="mt-6">
          <EmptyState>No products yet — add them above or run the Phase 9 seed.</EmptyState>
        </div>
      )}
    </div>
  );
}
