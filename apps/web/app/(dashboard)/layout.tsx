import Link from "next/link";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/candidates", label: "Candidates" },
  { href: "/replies", label: "Replies" },
  { href: "/categories", label: "Categories" },
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-zinc-200 bg-white">
        {/* Mobile: logo + public link on row one, horizontally-scrollable nav
            on row two. ≥sm: everything on a single row. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:flex-nowrap">
          <Link href="/" className="text-lg font-semibold">
            TrendCart
          </Link>
          <Link
            href="/about"
            className="ml-auto whitespace-nowrap text-sm text-zinc-400 hover:text-zinc-600 sm:order-last"
          >
            about page ↗
          </Link>
          <nav className="-mx-4 flex w-screen gap-4 overflow-x-auto px-4 pb-1 pt-1 text-sm sm:m-0 sm:w-auto sm:p-0">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="whitespace-nowrap text-zinc-600 hover:text-zinc-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </>
  );
}
