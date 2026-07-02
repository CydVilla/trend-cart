import Link from "next/link";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/candidates", label: "Candidates" },
  { href: "/replies", label: "Replies" },
  { href: "/categories", label: "Categories" },
  { href: "/products", label: "Products" },
  { href: "/pages", label: "Pages" },
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-lg font-semibold">
            TrendCart
          </Link>
          <nav className="flex gap-4 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-zinc-600 hover:text-zinc-900">
                {item.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/recommendations"
            className="ml-auto text-sm text-zinc-400 hover:text-zinc-600"
          >
            public site ↗
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </>
  );
}
