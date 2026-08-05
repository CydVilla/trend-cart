/**
 * The shape of the threshold snapshot the worker publishes on its heartbeat
 * and the dashboard renders.
 *
 * The VALUES are produced by the worker from its own resolved `config` (see
 * apps/worker/src/settings.ts) — never re-read from env in the web process.
 * Both dynos share Heroku's config vars today, so re-reading would usually
 * agree, but "usually" is exactly the failure the dashboard exists to catch:
 * what's shown is what the running worker is actually enforcing.
 */

/** How a threshold should be drawn. */
export type ThresholdKind =
  /** A budget with a live usage count — drawn as a filled bar. */
  | "cap"
  /** A 0–100 confidence/quality floor — drawn on a shared score axis. */
  | "score"
  /** Minutes or hours of enforced silence — drawn as a labelled duration. */
  | "duration"
  /** On/off. */
  | "toggle"
  /** A plain number with no natural scale. */
  | "count";

/**
 * Which live count fills a "cap" bar. Resolved by the dashboard against the
 * SAME rolling windows the worker's own gates use — a bar that measured a
 * calendar day while the worker enforced a rolling 24h would mislead exactly
 * when it matters (just after a burst).
 */
export type MeterKey =
  | "repliesLastHour"
  | "repliesLastDay"
  | "evalsLastHour"
  | "dealPostsLastDay"
  | "banterLastDay"
  | "apologiesLastDay"
  | "pinsLastDay";

export type ThresholdEntry = {
  /** The env var that sets it — the thing you'd change to move the line. */
  key: string;
  label: string;
  value: number | boolean;
  kind: ThresholdKind;
  /** Section heading on the dashboard. */
  group: string;
  /** One line on what the number actually gates. */
  note?: string;
  /** Present on "cap" entries: which live count fills the bar. */
  meter?: MeterKey;
  /** Unit suffix for "duration"/"count" entries ("min", "h", "/day"). */
  unit?: string;
  /** Set when this threshold is currently inert (feature switched off). */
  inactive?: boolean;
};

export type SettingsSnapshot = {
  /** ISO timestamp the worker wrote it. */
  capturedAt: string;
  model: string;
  thresholds: ThresholdEntry[];
};

/** Parse the heartbeat's `settings` JSON column defensively — it is written by
 *  the worker, so an older worker (mid-deploy) may not have written it yet. */
export function parseSettingsSnapshot(raw: unknown): SettingsSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.capturedAt !== "string" || !Array.isArray(o.thresholds)) return null;
  const thresholds = o.thresholds.filter(isThresholdEntry);
  if (thresholds.length === 0) return null;
  return {
    capturedAt: o.capturedAt,
    model: typeof o.model === "string" ? o.model : "unknown",
    thresholds,
  };
}

function isThresholdEntry(raw: unknown): raw is ThresholdEntry {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    typeof o.label === "string" &&
    typeof o.group === "string" &&
    (typeof o.value === "number" || typeof o.value === "boolean")
  );
}
