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
