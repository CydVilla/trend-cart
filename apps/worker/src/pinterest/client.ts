/**
 * Minimal Pinterest v5 REST client for the single-account pinner. Auth is the
 * standard refresh-token grant: a long-lived refresh token (minted once via
 * OAuth) is exchanged for short-lived access tokens as needed. No SDK — the
 * three endpoints we use don't justify a dependency.
 *
 * Trial-tier note: pins created while the app has trial access are visible
 * only to the authenticated account. That makes trial a safe staging mode —
 * the full pipeline runs for real, and pins go public when Pinterest grants
 * standard access. Nothing here changes between tiers.
 */

const API_BASE = "https://api.pinterest.com/v5";
const TIMEOUT_MS = 15_000;
/** Refresh 5 minutes early so an access token never expires mid-call. */
const TOKEN_SLACK_MS = 5 * 60_000;

export type PinterestBoard = { id: string; name: string; privacy: string };
export type CreatePinInput = {
  boardId: string;
  title: string;
  description: string;
  link: string;
  imageUrl: string;
  altText?: string;
};

/** 4xx (except 429) = the request itself is bad; retrying can't help. */
export class PinterestPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinterestPermanentError";
  }
}

export class PinterestClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly refreshToken: string,
  ) {}

  private async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_SLACK_MS) {
      return this.accessToken;
    }
    const basic = Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64");
    const response = await fetch(`${API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // A rejected refresh token is permanent: re-auth needs the operator.
      const Err = response.status >= 400 && response.status < 500 && response.status !== 429
        ? PinterestPermanentError
        : Error;
      throw new Err(`token refresh failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.ensureAccessToken();
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = `${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PinterestPermanentError(message);
      }
      throw new Error(message);
    }
    return (await response.json()) as T;
  }

  /** First page is plenty: the bot owns a handful of boards at most. */
  async listBoards(): Promise<PinterestBoard[]> {
    const data = await this.request<{ items: PinterestBoard[] }>(
      "GET",
      "/boards?page_size=100",
    );
    return data.items ?? [];
  }

  async createBoard(name: string, description: string): Promise<PinterestBoard> {
    return await this.request<PinterestBoard>("POST", "/boards", {
      name,
      description,
      privacy: "PUBLIC",
    });
  }

  /** Create a pin from an externally hosted image URL. Returns the pin id. */
  async createPin(input: CreatePinInput): Promise<string> {
    const data = await this.request<{ id: string }>("POST", "/pins", {
      board_id: input.boardId,
      title: input.title,
      description: input.description,
      link: input.link,
      alt_text: input.altText,
      media_source: { source_type: "image_url", url: input.imageUrl },
    });
    return data.id;
  }
}
