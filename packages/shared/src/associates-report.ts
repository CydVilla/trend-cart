/**
 * Parser for Amazon Associates Central report downloads (Reports → Download
 * reports → Orders / Earnings, CSV or TSV).
 *
 * Amazon gives no API for these until Creators API access clears (10
 * qualifying sales in 30 days), so the operator downloads them by hand and
 * uploads them on the Insights page. They are the ONLY sales data we get, and
 * the only per-channel split is the tracking ID column — see affiliate-tags.ts.
 *
 * The format is not versioned or documented and has shifted over the years
 * (a "Fee-Orders reports from … to …" title line before the header, "($)"
 * suffixes on money columns, tabs vs commas, "Tag" vs "Tracking ID"), so the
 * parser locates the header row and columns by name rather than position and
 * skips — counting, never guessing — any line it can't read.
 */

import { extractAsin } from "./amazon";

export type AssociatesReportKind = "ORDERS" | "EARNINGS";

/** One per-day, per-tracking-ID, per-ASIN line (rows aggregated). */
export type AssociatesReportLine = {
  /** Calendar day as Amazon printed it, YYYY-MM-DD (order date / ship date). */
  day: string;
  trackingId: string;
  asin: string;
  title: string;
  category: string | null;
  /** ORDERS: items ordered. EARNINGS: items shipped. */
  items: number;
  /** EARNINGS only: items returned (0 for ORDERS). */
  returns: number;
  /** ORDERS: price × qty ordered. EARNINGS: shipped revenue. Integer cents. */
  salesCents: number;
  /** EARNINGS only: the commission ("Ad Fees") — what we actually earn. */
  feeCents: number;
  /** Items bought in the session but NOT the linked product (Amazon's
   *  "indirect" sales) — they still credit the tracking ID, but joining them
   *  back to a post by ASIN finds nothing, which is expected. */
  indirectItems: number;
};

export type ParsedAssociatesReport = {
  kind: AssociatesReportKind;
  lines: AssociatesReportLine[];
  /** Days the report covers: its title line's range when present, widened
   *  to every parsed row. Re-uploads replace rows inside this range. */
  range: { from: string; to: string } | null;
  /** Data rows that could not be read (bad ASIN / date / number). */
  skipped: number;
  /** First few reasons for skipped rows, for the upload banner. */
  warnings: string[];
};

export type AssociatesReportError = { error: string };

// ── CSV ─────────────────────────────────────────────────────

/** RFC 4180 split: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── Values ──────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // Feb 30 etc.
  return date.toISOString().slice(0, 10);
}

/**
 * Report date → YYYY-MM-DD. Accepts "2026-10-03", "2026-10-03 14:22:10",
 * "10/03/2026", "10-03-2026", "October 3, 2026", "3 Oct 2026". The time part
 * is dropped: Amazon reports in its own (US Pacific) day, and per-day is all
 * the precision the join needs.
 */
export function parseReportDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T].*)?$/);
  if (m) return ymd(+m[3]!, +m[1]!, +m[2]!); // US order: month first
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    return month ? ymd(+m[3]!, month, +m[2]!) : null;
  }
  m = s.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?,? (\d{4})/);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? ymd(+m[3]!, month, +m[1]!) : null;
  }
  return null;
}

/** "$1,299.99" / "-4.50" / "(4.50)" / "" → integer cents (empty = 0). */
export function parseMoneyCents(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]|USD/gi, "");
  if (s === "" || s === "-") return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Math.round(Number.parseFloat(s) * 100);
}

function parseCount(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  if (s === "") return 0;
  return /^-?\d+$/.test(s) ? Number.parseInt(s, 10) : null;
}

// ── Columns ─────────────────────────────────────────────────

/** "Price($)" → "price", "Tracking ID" → "tracking id", "Ad Fees ($)" → "ad fees". */
function normalizeHeader(cell: string): string {
  return cell
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/\((\$|usd|[a-z]{3})\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Accepted header names per field, in preference order. */
const COLUMNS = {
  asin: ["asin"],
  title: ["name", "product name", "item name", "title"],
  category: ["category", "product line"],
  trackingId: ["tracking id", "tag", "trackingid"],
  orderDate: ["date", "order date", "ordered date"],
  shipDate: ["date shipped", "shipped date", "ship date"],
  qty: ["qty", "quantity", "items ordered", "ordered items"],
  shipped: ["items shipped", "shipped items"],
  returns: ["returns", "items returned", "returned items"],
  price: ["price", "item price"],
  revenue: ["revenue", "shipped revenue", "shipped items revenue"],
  fees: ["ad fees", "advertising fees", "earnings", "commission"],
  direct: ["direct"],
  indirect: ["indirect sales", "indirect"],
} as const;

type Field = keyof typeof COLUMNS;

function locateColumns(header: string[]): Partial<Record<Field, number>> {
  const names = header.map(normalizeHeader);
  const out: Partial<Record<Field, number>> = {};
  for (const field of Object.keys(COLUMNS) as Field[]) {
    for (const alias of COLUMNS[field]) {
      const idx = names.indexOf(alias);
      if (idx >= 0) {
        out[field] = idx;
        break;
      }
    }
  }
  return out;
}

const TRUTHY = /^(y|yes|true|1)$/i;

/** Indirect-sale flag from whichever column the report carries. */
function isIndirect(row: string[], cols: Partial<Record<Field, number>>): boolean {
  const read = (f: Field): string | null => (cols[f] === undefined ? null : (row[cols[f]!] ?? "").trim());
  for (const value of [read("indirect"), read("direct")]) {
    if (value && /^indirect/i.test(value)) return true;
    if (value && /^direct/i.test(value)) return false;
  }
  const indirect = read("indirect");
  if (indirect) return TRUTHY.test(indirect);
  const direct = read("direct");
  if (direct) return !TRUTHY.test(direct);
  return false;
}

// ── Report ──────────────────────────────────────────────────

const MAX_WARNINGS = 5;

/**
 * Parse an Orders or Earnings report (CSV or TSV) into per-day,
 * per-tracking-ID, per-ASIN lines. Rows Amazon splits finer (one per order,
 * or per seller / device type) are summed into their key.
 */
export function parseAssociatesReport(
  text: string,
): ParsedAssociatesReport | AssociatesReportError {
  const clean = text.replace(/^\uFEFF/, "");
  const firstLines = clean.split(/\r?\n/, 10);
  const delimiter = firstLines.some((l) => l.split("\t").length > 3) ? "\t" : ",";
  const rows = parseDelimited(clean, delimiter);

  // The header is the first row naming both an ASIN and a tracking-ID column;
  // everything above it is Amazon's title preamble.
  let headerAt = -1;
  let cols: Partial<Record<Field, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const found = locateColumns(rows[i]!);
    if (found.asin !== undefined && found.trackingId !== undefined) {
      headerAt = i;
      cols = found;
      break;
    }
  }
  if (headerAt < 0) {
    return {
      error:
        "no header row with ASIN and Tracking ID/Tag columns — upload the Orders or Earnings " +
        "report from Associates Central (Reports → Download reports), not the summary",
    };
  }

  // Earnings reports are keyed by ship date and carry ad fees; Orders by
  // order date and quantity. Checked in that order: an earnings header can
  // also contain a bare "Date"-like column, an orders header never ships.
  const kind: AssociatesReportKind =
    cols.shipDate !== undefined || cols.shipped !== undefined || cols.fees !== undefined
      ? "EARNINGS"
      : "ORDERS";
  const dateCol = kind === "EARNINGS" ? (cols.shipDate ?? cols.orderDate) : cols.orderDate;
  if (dateCol === undefined) return { error: `${kind.toLowerCase()} report has no date column` };
  const itemsCol = kind === "EARNINGS" ? cols.shipped : cols.qty;
  if (itemsCol === undefined) {
    return { error: `${kind.toLowerCase()} report has no ${kind === "EARNINGS" ? "Items Shipped" : "Qty"} column` };
  }

  const byKey = new Map<string, AssociatesReportLine>();
  let skipped = 0;
  const warnings: string[] = [];
  const warn = (line: number, reason: string): void => {
    skipped++;
    if (warnings.length < MAX_WARNINGS) warnings.push(`line ${line}: ${reason}`);
  };
  const cell = (row: string[], col: number | undefined): string =>
    col === undefined ? "" : (row[col] ?? "").trim();

  for (let i = headerAt + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every((c) => c.trim() === "")) continue;
    const lineNo = i + 1;
    const rawAsin = cell(row, cols.asin);
    // Trailing "Total" rows and the like carry no ASIN — not data, not an error.
    if (!rawAsin && /total/i.test(row.join(" "))) continue;
    const asin = extractAsin(rawAsin);
    if (!asin) {
      warn(lineNo, `bad ASIN "${rawAsin.slice(0, 20)}"`);
      continue;
    }
    const trackingId = cell(row, cols.trackingId);
    if (!trackingId) {
      warn(lineNo, "missing tracking ID");
      continue;
    }
    const day = parseReportDate(cell(row, dateCol));
    if (!day) {
      warn(lineNo, `bad date "${cell(row, dateCol).slice(0, 30)}"`);
      continue;
    }
    const items = parseCount(cell(row, itemsCol));
    const returns = kind === "EARNINGS" ? parseCount(cell(row, cols.returns)) : 0;
    const price = parseMoneyCents(cell(row, cols.price));
    const revenue = cols.revenue !== undefined ? parseMoneyCents(cell(row, cols.revenue)) : null;
    const fee = kind === "EARNINGS" ? parseMoneyCents(cell(row, cols.fees)) : 0;
    if (items === null || returns === null || price === null || fee === null) {
      warn(lineNo, "unreadable number");
      continue;
    }
    // Orders list a unit price; Earnings a shipped-revenue total when present.
    const salesCents = revenue ?? price * items;

    const key = `${day}|${trackingId}|${asin}`;
    const line = byKey.get(key) ?? {
      day,
      trackingId,
      asin,
      title: "",
      category: null,
      items: 0,
      returns: 0,
      salesCents: 0,
      feeCents: 0,
      indirectItems: 0,
    };
    line.items += items;
    line.returns += returns;
    line.salesCents += salesCents;
    line.feeCents += fee;
    if (isIndirect(row, cols)) line.indirectItems += items;
    line.title ||= cell(row, cols.title).slice(0, 300);
    line.category ??= cell(row, cols.category) || null;
    byKey.set(key, line);
  }

  const lines = [...byKey.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.trackingId.localeCompare(b.trackingId) || a.asin.localeCompare(b.asin),
  );
  if (lines.length === 0 && skipped > 0) {
    return { error: `no readable rows (${skipped} skipped): ${warnings.join("; ")}` };
  }

  // Title line, e.g. "Fee-Orders reports from 09-20-2026 to 10-19-2026".
  let range: { from: string; to: string } | null = null;
  for (const row of rows.slice(0, headerAt)) {
    const m = row.join(" ").match(/from\s+(.+?)\s+to\s+(.+?)\s*$/i);
    const from = m ? parseReportDate(m[1]!) : null;
    const to = m ? parseReportDate(m[2]!) : null;
    if (from && to && from <= to) {
      range = { from, to };
      break;
    }
  }
  for (const line of lines) {
    range = range
      ? { from: line.day < range.from ? line.day : range.from, to: line.day > range.to ? line.day : range.to }
      : { from: line.day, to: line.day };
  }

  return { kind, lines, range, skipped, warnings };
}
