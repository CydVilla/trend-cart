import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * eBay Marketplace Account Deletion endpoint. eBay will not activate a
 * production keyset until the app either opts out of these notifications or
 * subscribes a working endpoint; this is that endpoint.
 *
 *  - GET  ?challenge_code=…  eBay proving we own the URL. Reply with
 *    sha256(challengeCode + verificationToken + endpointUrl) as hex.
 *  - POST                    an eBay user asked for their data to be deleted.
 *
 * TrendCart stores no eBay user data — only public listing IDs, titles and
 * prices — so there is nothing to delete and a notification only needs an
 * acknowledgement. The body (a username and user ID) is deliberately neither
 * read nor logged. If the app ever starts storing eBay user data, this handler
 * must verify the x-ebay-signature header and delete that user's rows.
 */

const PATH = "/api/ebay/account-deletion";

/** Must equal, character for character, the URL saved in eBay's portal. */
function endpointUrl(): string {
  const explicit = process.env.EBAY_DELETION_ENDPOINT_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}${PATH}` : "";
}

export function GET(request: NextRequest): NextResponse {
  const token = process.env.EBAY_VERIFICATION_TOKEN?.trim() ?? "";
  const endpoint = endpointUrl();
  if (!token || !endpoint) {
    return NextResponse.json({ error: "endpoint not configured" }, { status: 503 });
  }
  const challengeCode = request.nextUrl.searchParams.get("challenge_code");
  if (!challengeCode) {
    return NextResponse.json({ error: "challenge_code is required" }, { status: 400 });
  }
  const challengeResponse = createHash("sha256")
    .update(challengeCode)
    .update(token)
    .update(endpoint)
    .digest("hex");
  // NextResponse.json: eBay rejects a hand-built body that carries a BOM.
  return NextResponse.json({ challengeResponse });
}

export function POST(): NextResponse {
  return new NextResponse(null, { status: 204 });
}
