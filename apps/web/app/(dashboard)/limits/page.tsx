import {
  prisma,
  withDbRetry,
  computeLimitUsage,
  recentScoreSamples,
  summarizeLlmSpend,
  dailyLlmSpend,
  formatUsd,
  formatTokens,
  LLM_OPERATIONS,
  type LimitUsage,
  type ScoreSample,
  type SpendWindow,
  type DailySpend,
} from "@trendcart/db";
import {
  parseSettingsSnapshot,
  type SettingsSnapshot,
  type ThresholdEntry,
} from "@trendcart/shared";
import { Badge, EmptyState, SectionHeading } from "../ui";

export const dynamic = "force-dynamic";

/** Heroku's cost ceiling for this project — the number the spend estimate is
 *  really being judged against. Dyno + Postgres are fixed; the LLM bill is the
 *  only part that moves, so the page shows it against the slack. */
const MONTHLY_INFRA_USD = 19;

export default async function LimitsPage() {
  // Sequential, not Promise.all: essential-0 shares a ~20-connection cap with
  // the worker and this app's pool is 4 (see packages/db/src/index.ts).
  const heartbeat = await withDbRetry(() =>
    prisma.workerHeartbeat.findUnique({ where: { id: "worker" } }),
  );
  const usage = await withDbRetry(() => computeLimitUsage());
  const scores = await withDbRetry(() => recentScoreSamples());
  const spend = await withDbRetry(() => summarizeLlmSpend());
  const daily = await withDbRetry(() => dailyLlmSpend(14));

  const settings = parseSettingsSnapshot(heartbeat?.settings);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Limits &amp; spend</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every number the bot checks before it acts, and what the checking costs.
        </p>
      </div>

      <SpendSummary spend={spend} daily={daily} model={settings?.model ?? heartbeat?.model ?? null} />
      <SectionHeading>Where the money goes</SectionHeading>
      <SpendByOperation window={spend.month} />
      {spend.unknownModels.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          Priced at the highest known rate (no rate card on file):{" "}
          {spend.unknownModels.join(", ")} — the real bill may be lower.
        </p>
      )}

      <SectionHeading>Budgets right now</SectionHeading>
      {settings ? (
        <Thresholds settings={settings} usage={usage} scores={scores} />
      ) : (
        <EmptyState>
          The worker hasn&apos;t published its settings yet. This appears within ~30 seconds of the
          worker starting on a build that includes the snapshot.
        </EmptyState>
      )}
    </div>
  );
}

/* ── Spend ──────────────────────────────────────────────────── */

function SpendSummary({
  spend,
  daily,
  model,
}: {
  spend: { today: SpendWindow; week: SpendWindow; month: SpendWindow };
  daily: DailySpend[];
  model: string | null;
}) {
  // Projection uses the 7-day rate, not the 24h one: a single quiet or busy
  // day shouldn't swing a monthly number the operator plans against.
  const projectedMonthly = (spend.week.totalMicros / 7) * 30;
  const cacheRate = spend.week.cacheHitRate;

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Last 24h" value={formatUsd(spend.today.totalMicros)} sub={`${spend.today.calls} calls`} />
        <Stat label="Last 7 days" value={formatUsd(spend.week.totalMicros)} sub={`${spend.week.calls} calls`} />
        <Stat label="Last 30 days" value={formatUsd(spend.month.totalMicros)} sub={`${spend.month.calls} calls`} />
        <Stat
          label="Projected / month"
          value={formatUsd(projectedMonthly)}
          sub={`at the last 7 days' rate`}
          tone={projectedMonthly / 1_000_000 > MONTHLY_INFRA_USD * 0.5 ? "amber" : "plain"}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span>
          Model <span className="font-medium text-zinc-700">{model ?? "unknown"}</span>
        </span>
        {cacheRate !== null && (
          <span>
            Prompt cache{" "}
            <span className={`font-medium ${cacheRate < 0.5 ? "text-amber-700" : "text-emerald-700"}`}>
              {Math.round(cacheRate * 100)}% read
            </span>{" "}
            over 7 days — cached tokens bill at 0.1×, so higher is cheaper.
          </span>
        )}
        <span>
          Infra is a flat ~${MONTHLY_INFRA_USD}/mo; LLM spend is the part that moves.
        </span>
      </div>

      {daily.some((d) => d.costMicros > 0) ? (
        <DailyBars daily={daily} />
      ) : (
        <p className="mt-4 text-sm text-zinc-500">
          No LLM calls recorded yet. The ledger starts filling the moment the worker runs a build
          that includes it — spend before then isn&apos;t retroactively knowable.
        </p>
      )}
    </div>
  );
}

/** 14-day bar chart. Pure CSS heights — no chart library on a page this small. */
function DailyBars({ daily }: { daily: DailySpend[] }) {
  const peak = Math.max(...daily.map((d) => d.costMicros), 1);
  return (
    <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Daily spend · 14 days
        </span>
        <span className="text-xs text-zinc-400">peak {formatUsd(peak)}</span>
      </div>
      <div className="flex h-24 items-end gap-1">
        {daily.map((d) => (
          // h-full is load-bearing: without it the column shrinks to its
          // content and the bars' percentage heights resolve against auto (0).
          <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
            <div
              className="rounded-t bg-zinc-800 transition-colors group-hover:bg-emerald-600"
              style={{ height: `${Math.max(2, (d.costMicros / peak) * 100)}%` }}
              title={`${d.day}: ${formatUsd(d.costMicros)} over ${d.calls} calls`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-400">
        <span>{daily[0]?.day.slice(5)}</span>
        <span>{daily[daily.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

function SpendByOperation({ window }: { window: SpendWindow }) {
  if (window.byOperation.length === 0) {
    return <EmptyState>Nothing recorded in the last 30 days.</EmptyState>;
  }
  const peak = window.byOperation[0]?.costMicros || 1;
  const labels = new Map(LLM_OPERATIONS.map((o) => [o.key as string, o]));

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
      <table className="w-full min-w-[42rem] text-sm">
        <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-400">
          <tr>
            <th className="px-4 py-2 font-medium">Operation</th>
            <th className="px-4 py-2 font-medium">Share of 30-day spend</th>
            <th className="px-4 py-2 text-right font-medium">Cost</th>
            <th className="px-4 py-2 text-right font-medium">Calls</th>
            <th className="px-4 py-2 text-right font-medium">Tokens in / out</th>
            <th className="px-4 py-2 text-right font-medium">Searches</th>
          </tr>
        </thead>
        <tbody>
          {window.byOperation.map((row) => {
            const meta = labels.get(row.operation);
            return (
              <tr key={row.operation} className="border-b border-zinc-100 last:border-0">
                <td className="px-4 py-2">
                  <div className="font-medium">{meta?.label ?? row.operation}</div>
                  {meta && <div className="text-xs text-zinc-400">{meta.note}</div>}
                </td>
                <td className="px-4 py-2">
                  <div className="h-2 w-full min-w-[6rem] rounded-full bg-zinc-100">
                    <div
                      className="h-2 rounded-full bg-zinc-800"
                      style={{ width: `${Math.max(2, (row.costMicros / peak) * 100)}%` }}
                    />
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-medium tabular-nums">
                  {formatUsd(row.costMicros)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-600">{row.calls}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-600">
                  {formatTokens(row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens)} /{" "}
                  {formatTokens(row.outputTokens)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-600">
                  {row.webSearches || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Thresholds ─────────────────────────────────────────────── */

function Thresholds({
  settings,
  usage,
  scores,
}: {
  settings: SettingsSnapshot;
  usage: LimitUsage;
  scores: ScoreSample[];
}) {
  const groups = new Map<string, ThresholdEntry[]>();
  for (const entry of settings.thresholds) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-zinc-400">
        Published by the running worker{" "}
        {new Date(settings.capturedAt).toLocaleTimeString("en-US")} — these are the values it is
        actually enforcing, not what this page&apos;s environment says. Change one with{" "}
        <code className="rounded bg-zinc-100 px-1">heroku config:set</code>.
      </p>

      {[...groups.entries()].map(([group, entries]) => (
        <div key={group}>
          <h3 className="mb-2 text-sm font-semibold text-zinc-700">{group}</h3>
          <div className="grid gap-2 lg:grid-cols-2">
            {entries.map((entry) => (
              <ThresholdCard key={entry.key} entry={entry} usage={usage} scores={scores} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ThresholdCard({
  entry,
  usage,
  scores,
}: {
  entry: ThresholdEntry;
  usage: LimitUsage;
  scores: ScoreSample[];
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        entry.inactive ? "border-dashed border-zinc-200 bg-zinc-50/60" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-sm font-medium ${entry.inactive ? "text-zinc-400" : ""}`}>
          {entry.label}
        </span>
        {entry.inactive ? (
          <Badge tone="zinc">off</Badge>
        ) : (
          <ThresholdValue entry={entry} usage={usage} />
        )}
      </div>

      {!entry.inactive && entry.kind === "cap" && entry.meter && (
        <CapBar used={usage[entry.meter]} cap={Number(entry.value)} />
      )}
      {!entry.inactive && entry.kind === "score" && (
        <ScoreAxis threshold={Number(entry.value)} entry={entry} scores={scores} />
      )}

      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs text-zinc-400">{entry.note ?? " "}</span>
        <code className="shrink-0 text-[10px] text-zinc-300">{entry.key}</code>
      </div>
    </div>
  );
}

function ThresholdValue({ entry, usage }: { entry: ThresholdEntry; usage: LimitUsage }) {
  if (entry.kind === "toggle") {
    return <Badge tone={entry.value ? "green" : "zinc"}>{entry.value ? "on" : "off"}</Badge>;
  }
  if (entry.kind === "cap" && entry.meter) {
    const used = usage[entry.meter];
    const cap = Number(entry.value);
    return (
      <span className="whitespace-nowrap text-sm tabular-nums">
        <span className={used >= cap ? "font-semibold text-amber-700" : "font-semibold"}>{used}</span>
        <span className="text-zinc-400"> / {cap}</span>
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap text-sm font-semibold tabular-nums">
      {String(entry.value)}
      {entry.unit ? <span className="font-normal text-zinc-400">{entry.unit}</span> : null}
    </span>
  );
}

/** Filled budget bar. Amber at the cap — that's the state where the bot is
 *  deliberately silent and the operator might otherwise think it's broken. */
function CapBar({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const full = used >= cap;
  return (
    <div className="mt-2">
      <div className="h-2 w-full rounded-full bg-zinc-100">
        <div
          className={`h-2 rounded-full ${full ? "bg-amber-500" : "bg-emerald-600"}`}
          style={{ width: `${Math.max(pct === 0 ? 0 : 3, pct)}%` }}
        />
      </div>
      {full && (
        <p className="mt-1 text-xs text-amber-700">
          At the cap — further attempts defer until the window rolls forward.
        </p>
      )}
    </div>
  );
}

/**
 * A 0–100 axis with the threshold marked and recent classifier scores plotted
 * behind it. The distribution is the point: it shows whether a bar is doing
 * real filtering or sitting in dead space where nothing lands.
 */
function ScoreAxis({
  threshold,
  entry,
  scores,
}: {
  threshold: number;
  entry: ThresholdEntry;
  scores: ScoreSample[];
}) {
  const values = scoreValuesFor(entry, scores);
  const buckets = new Array(20).fill(0) as number[];
  for (const v of values) {
    const i = Math.min(19, Math.max(0, Math.floor(v / 5)));
    buckets[i] = (buckets[i] ?? 0) + 1;
  }
  const peak = Math.max(...buckets, 1);
  const above = values.filter((v) => v >= threshold).length;

  return (
    <div className="mt-2">
      <div className="relative h-8">
        {/* Distribution of recent scores, 5-point buckets. */}
        <div className="absolute inset-x-0 bottom-1 flex h-7 items-end gap-px">
          {buckets.map((count, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm ${
                i * 5 + 5 > threshold ? "bg-emerald-200" : "bg-zinc-200"
              }`}
              style={{ height: `${Math.max(count === 0 ? 0 : 8, (count / peak) * 100)}%` }}
            />
          ))}
        </div>
        {/* The bar itself. */}
        <div
          className="absolute bottom-0 top-0 w-px bg-zinc-900"
          style={{ left: `${threshold}%` }}
          aria-hidden
        />
      </div>
      <div className="flex justify-between text-[10px] text-zinc-400">
        <span>0</span>
        {values.length > 0 ? (
          <span>
            {above}/{values.length} recent scores clear it
          </span>
        ) : (
          <span>no recent scores</span>
        )}
        <span>100</span>
      </div>
    </div>
  );
}

/**
 * Which measured score belongs under which bar. Bars with no measured
 * counterpart (fact-check confidence, match score, lane fit — none of which is
 * stored as a plain column) render the axis with the line only, rather than
 * borrowing an unrelated distribution.
 */
function scoreValuesFor(entry: ThresholdEntry, scores: ScoreSample[]): number[] {
  if (entry.key === "MIN_PRODUCT_INTENT_SCORE" || entry.key === "AUTO_MIN_INTENT_SCORE") {
    return scores.map((s) => s.intent);
  }
  if (entry.key === "MIN_LINK_CONFIDENCE" || entry.key === "AUTO_MIN_LINK_CONFIDENCE") {
    return scores.filter((s) => s.wouldReply).map((s) => s.linkConfidence);
  }
  return [];
}

/* ── Bits ───────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  sub,
  tone = "plain",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "plain" | "amber";
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        tone === "amber" ? "border-amber-300 bg-amber-50" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-zinc-500">{sub}</div>
    </div>
  );
}
