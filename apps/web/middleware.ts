import { NextResponse, type NextRequest } from "next/server";

/**
 * HTTP Basic auth for the dashboard. Public recommendation pages are excluded
 * via the matcher below. Auth activates only when DASHBOARD_PASSWORD is set —
 * unset locally means no prompt in dev; ALWAYS set it on any public deploy.
 */
export function middleware(request: NextRequest): NextResponse {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const [user, pass] = atob(header.slice(6)).split(":");
    if (user === (process.env.DASHBOARD_USER ?? "admin") && pass === password) {
      return NextResponse.next();
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TrendCart dashboard"' },
  });
}

export const config = {
  // Everything except the public site and framework assets requires auth.
  matcher: ["/((?!recommendations|_next/static|_next/image|favicon.ico).*)"],
};
