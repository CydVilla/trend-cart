import Link from "next/link";
import type { ReactNode } from "react";

const TONES = {
  green: "bg-emerald-100 text-emerald-800",
  red: "bg-red-100 text-red-800",
  amber: "bg-amber-100 text-amber-800",
  blue: "bg-blue-100 text-blue-800",
  zinc: "bg-zinc-100 text-zinc-600",
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function safetyTone(status: string): Tone {
  if (status === "SAFE") return "green";
  if (status === "UNSAFE") return "red";
  if (status === "UNCERTAIN") return "amber";
  return "zinc";
}

export function replyStatusTone(status: string): Tone {
  if (status === "POSTED") return "green";
  if (status === "APPROVED") return "blue";
  if (status === "PENDING_APPROVAL") return "amber";
  if (status === "FAILED") return "red";
  return "zinc";
}

export function dealPostTone(status: string): Tone {
  if (status === "POSTED") return "green";
  if (status === "POSTING") return "blue";
  if (status === "READY" || status === "PENDING" || status === "DRY_RUN") return "amber";
  if (status === "FAILED") return "red";
  return "zinc";
}

export function armStateTone(state: string): Tone {
  if (state === "ARMED") return "green";
  if (state === "FIRED") return "blue";
  return "zinc";
}

/** Integer cents → localized currency string; re-exported for pages. */
export { formatMoney } from "@trendcart/shared";

export function formatDate(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** at://did:plc:xyz/app.bsky.feed.post/rkey → https://bsky.app/profile/did:plc:xyz/post/rkey */
export function bskyPostUrl(atUri: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  return match ? `https://bsky.app/profile/${match[1]}/post/${match[2]}` : null;
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 mt-8 text-lg font-semibold first:mt-0">{children}</h2>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

/** Row of sort chips; the active one is highlighted. Server-side links. */
export function SortBar({
  options,
  current,
  hrefFor,
}: {
  options: { key: string; label: string }[];
  current: string;
  hrefFor: (key: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="text-xs uppercase text-zinc-400">Sort</span>
      {options.map((o) => (
        <Link
          key={o.key}
          href={hrefFor(o.key)}
          className={`rounded-full border px-2.5 py-0.5 text-xs ${
            current === o.key
              ? "border-zinc-800 bg-zinc-900 font-medium text-white"
              : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}

/** Prev/next pagination footer; hidden when everything fits on one page. */
export function Pagination({
  page,
  totalPages,
  totalCount,
  hrefFor,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  hrefFor: (page: number) => string;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)} className="text-zinc-600 underline hover:text-zinc-900">
          ← Prev
        </Link>
      ) : (
        <span className="text-zinc-300">← Prev</span>
      )}
      <span className="text-xs text-zinc-400">
        Page {page} of {totalPages} · {totalCount} total
      </span>
      {page < totalPages ? (
        <Link href={hrefFor(page + 1)} className="text-zinc-600 underline hover:text-zinc-900">
          Next →
        </Link>
      ) : (
        <span className="text-zinc-300">Next →</span>
      )}
    </div>
  );
}
