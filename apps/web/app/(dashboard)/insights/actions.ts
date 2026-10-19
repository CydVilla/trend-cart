"use server";

import { prisma, importAssociatesReport } from "@trendcart/db";
import { parseAssociatesReport } from "@trendcart/shared";
import { redirect } from "next/navigation";

/** Associates reports for a small store are kilobytes; anything near this is
 *  the wrong file. Kept under next.config's serverActions.bodySizeLimit. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * Upload an Associates Central Orders or Earnings report (CSV/TSV). The
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
    const parsed = parseAssociatesReport(await file.text());
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
  redirect(`/insights?${params.toString()}#revenue`);
}
