/**
 * One-time OAuth mint for the Pinterest refresh token.
 *
 * Usage:
 *   PINTEREST_APP_ID=... PINTEREST_APP_SECRET=... pnpm --filter @trendcart/worker exec tsx scripts/pinterest-auth.ts
 *
 * Requires http://localhost:8976/callback to be listed under Redirect URIs in
 * the app's settings (developers.pinterest.com → Trend-Cart Publisher).
 * Opens nothing on its own: it prints the authorize URL, you open it as the
 * bot's Pinterest account and approve, and the local server catches the
 * redirect, swaps the code for tokens, and prints the refresh token to set as
 * PINTEREST_REFRESH_TOKEN (heroku config:set + local .env).
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = "boards:read,boards:write,pins:read,pins:write,user_accounts:read";

const appId = process.env.PINTEREST_APP_ID ?? "";
const appSecret = process.env.PINTEREST_APP_SECRET ?? "";
if (!appId || !appSecret) {
  console.error("Set PINTEREST_APP_ID and PINTEREST_APP_SECRET first.");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authorizeUrl =
  `https://www.pinterest.com/oauth/?response_type=code` +
  `&client_id=${encodeURIComponent(appId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&state=${state}`;

console.log("\n1. Open this URL in the browser where the bot's Pinterest account is logged in:\n");
console.log(`   ${authorizeUrl}\n`);
console.log("2. Approve the requested scopes. This window waits for the redirect...\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const gotState = url.searchParams.get("state");
  if (!code || gotState !== state) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing code or state mismatch — re-run the script and use the fresh URL.");
    return;
  }
  try {
    const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");
    const response = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = (await response.json()) as {
      refresh_token?: string;
      refresh_token_expires_in?: number;
      error?: string;
      message?: string;
    };
    if (!response.ok || !data.refresh_token) {
      throw new Error(`token exchange failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Token minted — check the terminal. You can close this tab.");
    const days = data.refresh_token_expires_in
      ? Math.round(data.refresh_token_expires_in / 86_400)
      : null;
    console.log("Refresh token minted. Set it in both places:\n");
    console.log(`   heroku config:set PINTEREST_REFRESH_TOKEN=${data.refresh_token} -a trend-cart`);
    console.log(`   (and PINTEREST_REFRESH_TOKEN=... in .env for local runs)\n`);
    if (days) console.log(`   Note: this refresh token expires in ~${days} days — re-run this script to rotate it.\n`);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Exchange failed — see terminal.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, () => console.log(`   (listening on ${REDIRECT_URI})`));
