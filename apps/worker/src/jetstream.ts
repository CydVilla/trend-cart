import WebSocket from "ws";

/** Post record inside a Jetstream commit event (subset we care about). */
export type JetstreamPostRecord = {
  $type: string;
  text?: string;
  createdAt?: string;
  langs?: string[];
  /** Present when the post is a reply to another post. */
  reply?: unknown;
  embed?: unknown;
};

export type JetstreamEvent = {
  did: string;
  /** Microseconds since epoch — also used as the resume cursor. */
  time_us: number;
  kind: "commit" | "identity" | "account";
  commit?: {
    rev: string;
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    record?: JetstreamPostRecord;
    cid?: string;
  };
};

export type JetstreamClientOptions = {
  /** Base subscribe URL, e.g. wss://jetstream2.us-east.bsky.network/subscribe */
  url: string;
  wantedCollections: string[];
  onEvent: (event: JetstreamEvent) => void;
  log?: (message: string) => void;
};

/** If no event arrives for this long, assume a dead socket and reconnect. */
const STALE_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Minimal Jetstream WebSocket client with exponential-backoff reconnect and
 * in-memory cursor resume. The cursor is intentionally not persisted: for
 * trend detection, missing events during downtime is acceptable — we sample
 * the firehose, we don't need exhaustive coverage.
 */
export class JetstreamClient {
  private ws: WebSocket | null = null;
  private cursor: number | null = null;
  private stopped = true;
  private reconnectAttempts = 0;
  private lastEventAt = 0;
  private staleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: JetstreamClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.staleTimer = setInterval(() => this.checkStale(), 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  private log(message: string): void {
    (this.options.log ?? console.log)(`[jetstream] ${message}`);
  }

  private buildUrl(): string {
    const url = new URL(this.options.url);
    for (const collection of this.options.wantedCollections) {
      url.searchParams.append("wantedCollections", collection);
    }
    if (this.cursor !== null) {
      // Rewind 1s so we don't drop events that raced the disconnect.
      url.searchParams.set("cursor", String(this.cursor - 1_000_000));
    }
    return url.toString();
  }

  private connect(): void {
    if (this.stopped) return;

    const url = this.buildUrl();
    this.log(`connecting (attempt ${this.reconnectAttempts + 1})`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.log("connected");
      this.lastEventAt = Date.now();
    });

    ws.on("message", (data) => {
      this.lastEventAt = Date.now();
      this.reconnectAttempts = 0;
      let event: JetstreamEvent;
      try {
        event = JSON.parse(data.toString()) as JetstreamEvent;
      } catch {
        return; // ignore malformed frames
      }
      if (typeof event.time_us === "number") {
        this.cursor = event.time_us;
      }
      this.options.onEvent(event);
    });

    ws.on("error", (error) => {
      this.log(`socket error: ${error.message}`);
    });

    ws.on("close", (code) => {
      if (this.stopped) return;
      this.log(`closed (code ${code})`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const backoff = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.reconnectAttempts);
    const jitter = Math.random() * 500;
    this.reconnectAttempts += 1;
    setTimeout(() => this.connect(), backoff + jitter);
  }

  private checkStale(): void {
    if (this.stopped || this.lastEventAt === 0) return;
    if (Date.now() - this.lastEventAt > STALE_AFTER_MS) {
      this.log("no events for 60s — reconnecting");
      this.ws?.terminate(); // triggers close → scheduleReconnect
    }
  }
}
