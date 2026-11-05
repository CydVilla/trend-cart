"use server";

import { prisma, importAssociatesReport, importTrackingSummary } from "@trendcart/db";
import {
  detectAssociatesReport,
  parseAssociatesReport,
  parseReportDate,
  parseTrackingSummaryReport,
} from "@trendcart/shared";
import { redirect } from "next/navigation";

/** Associates reports for a small store are kilobytes; anything near this is
 *  the wrong file. Kept under next.config's serverActions.bodySizeLimit. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/** The range a summary report covers — the file itself never says. */
function formRange(formData: FormData): { from: string; to: string } | { error: string } {
  const from = parseReportDate(String(formData.get("from") ?? ""));
  const to = parseReportDate(String(formData.get("to") ?? ""));
  if (!from || !to) {
    return {
      error:
        "summary reports don't say which dates they cover — enter the From/To range you picked " +
        "in Associates Central, then upload again",
    };
  }
  return { from, to };
}

/**
 * Upload an Associates Central report (CSV/TSV): Orders or Earnings, or the
 * Tracking Id summary with the operator-entered range. The
 * outcome rides back as query params — counts and a parser message only,
 * never report contents beyond what the parser quotes in a warning.
 */
export async function uploadAssociatesReport(formData: FormData): Promise<void> {
  const params = new URLSearchParams();
  const file = formData.get("report");
  if (!(file instanceof File) || file.size === 0) {
    params.set("uploadError", "choose a report file first");
  } else if (file.size > MAX_REPORT_BYTES) {
    params.set("uploadError", `file is ${Math.round(file.size / 1024)} KB — too large for an Associates report`);
  } else {
    const text = await file.text();
    const shape = detectAssociatesReport(text);
    if (shape === "product_summary" || shape === "category_summary") {
      params.set(
        "uploadError",
        `that's the ${shape === "product_summary" ? "Linked Product" : "Category"} summary — it has no ` +
          "tracking IDs. Upload the Tracking Id summary, or the Orders / Earnings report",
      );
    } else if (shape === "tracking_summary") {
      const range = formRange(formData);
      const parsed = "error" in range ? range : parseTrackingSummaryReport(text, range);
      if ("error" in parsed) {
        params.set("uploadError", parsed.error.slice(0, 300));
      } else {
        const result = await importTrackingSummary(prisma, parsed);
        params.set("imported", "tracking ID summary");
        params.set("rows", String(result.written));
        params.set("replaced", String(result.replaced));
        params.set("range", `${parsed.range.from}..${parsed.range.to}`);
      }
    } else {
      // Orders / Earnings, or an unrecognised file (the parser explains).
      const parsed = parseAssociatesReport(text);
      if ("error" in parsed) {
        params.set("uploadError", parsed.error.slice(0, 300));
      } else {
        const result = await importAssociatesReport(prisma, parsed);
        params.set("imported", result.kind.toLowerCase());
        params.set("rows", String(result.written));
        params.set("replaced", String(result.replaced));
        if (parsed.range) params.set("range", `${parsed.range.from}..${parsed.range.to}`);
        if (parsed.skipped > 0) {
          params.set("skipped", String(parsed.skipped));
          params.set("why", parsed.warnings.join("; ").slice(0, 300));
        }
      }
    }
  }
  redirect(`/insights?${params.toString()}#revenue`);
}
