/**
 * Thin wrapper around @mattermost/client's Client4 (REST) + WebSocketClient (events).
 *
 * Responsibilities:
 *   - Authenticate with `MATTERMOST_TOKEN` and expose the Client4 instance for REST calls.
 *   - Open a long-lived WebSocket to /api/v4/websocket and emit server events to handlers.
 *   - Auto-reconnect the WebSocket on disconnect (exponential backoff, capped).
 *   - Track the bot's own user ID (used by handlers to ignore own messages).
 */

// @mattermost/client is CJS-only (its package.json has "type": "commonjs"), so
// we can't use named imports from an ESM build. Default-import + destructure for
// the runtime values, and a type-only import for the class-instance types used
// in field declarations (merged with the same name so downstream code is natural).
import type {
  Client4 as Client4Type,
  WebSocketClient as WebSocketClientType,
} from "@mattermost/client";
import mmClientPkg from "@mattermost/client";
const { Client4, WebSocketClient } = mmClientPkg as unknown as {
  Client4: new () => Client4Type;
  WebSocketClient: new () => WebSocketClientType;
};
import WebSocket from "ws";

type Client4 = Client4Type;
type WebSocketClient = WebSocketClientType;

// @mattermost/client's WebSocketClient assumes a browser environment — it uses the
// global WebSocket and calls window.addEventListener('online'/'offline', ...). In Node
// we polyfill both: the WebSocket global from the `ws` package, and `window` as a
// stub EventTarget so the addEventListener calls silently no-op.
const g = globalThis as any;
if (typeof g.WebSocket === "undefined") g.WebSocket = WebSocket;
if (typeof g.window === "undefined") {
  // Provide just the two methods WebSocketClient touches. EventTarget is too
  // heavy; a no-op stub is fine because Node already handles connectivity via
  // our manual reconnect-with-backoff loop.
  g.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

export interface MattermostClientOptions {
  url: string; // e.g. https://mattermost.vanderhop.com
  token: string; // bot personal access token
}

/** Payload shape Mattermost sends on the `posted` WebSocket event. */
export interface PostedEvent {
  channel_display_name: string;
  channel_name: string;
  channel_type: string;
  team_id: string;
  sender_name: string;
  post: {
    id: string;
    create_at: number;
    update_at: number;
    user_id: string;
    channel_id: string;
    root_id: string;
    original_id: string;
    message: string;
    type: string;
    file_ids?: string[];
    metadata?: {
      files?: { id: string; name: string; size: number; mime_type: string; extension?: string }[];
    };
  };
}

export type WSEventHandler = (eventType: string, data: Record<string, unknown>, broadcast: unknown) => void;
export type PostedHandler = (event: PostedEvent) => void | Promise<void>;

// How many consecutive close-with-failCount≥1 cycles before we give up and
// let the supervisor wrapper restart the process. This breaks the "sequence
// desync" tight loop: server closes → client reconnects → "long timeout" →
// server closes again → ... indefinitely. 5 consecutive failures ≈ 75–150s.
const MAX_WS_FAIL_CYCLES = 5;

export class MattermostClient {
  readonly client: Client4;
  private ws: WebSocketClient | null = null;
  private connected = false;
  private closing = false;
  private botUserId: string | null = null;
  private postedHandlers: PostedHandler[] = [];
  private rawHandlers: WSEventHandler[] = [];
  private wsCycleFailures = 0;

  constructor(private readonly opts: MattermostClientOptions) {
    this.client = new Client4();
    this.client.setUrl(opts.url);
    this.client.setToken(opts.token);
  }

  /** Returns the bot's own user ID (resolved on first connect). */
  getBotUserId(): string {
    if (!this.botUserId) {
      throw new Error("MattermostClient not connected yet — botUserId unknown");
    }
    return this.botUserId;
  }

  /** Register a handler for `posted` events (new messages in any channel the bot is in). */
  onPosted(handler: PostedHandler): void {
    this.postedHandlers.push(handler);
  }

  /** Register a handler for all WebSocket events — for diagnostics / extension. */
  onRawEvent(handler: WSEventHandler): void {
    this.rawHandlers.push(handler);
  }

  async connect(): Promise<void> {
    const me = await this.client.getMe();
    this.botUserId = me.id;
    console.log(`[mm-client] authenticated as ${me.username} (id=${me.id})`);

    this.openWebSocket();
  }

  private openWebSocket(): void {
    const ws = new WebSocketClient();
    this.ws = ws;

    // WebSocketClient wants the full ws(s)://…/api/v4/websocket URL.
    const wsUrl = this.opts.url.replace(/^http/, "ws").replace(/\/$/, "") + "/api/v4/websocket";

    ws.setFirstConnectCallback(() => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log("[mm-client] WebSocket connected");
    });

    ws.setReconnectCallback(() => {
      this.connected = true;
      this.wsCycleFailures = 0;
      console.log("[mm-client] WebSocket reconnected");
    });

    ws.setMissedEventCallback(() => {
      console.warn("[mm-client] Missed events during reconnect — state may be stale");
    });

    ws.setErrorCallback((err: unknown) => {
      console.error("[mm-client] WebSocket error:", err);
    });

    ws.setCloseCallback((failCount: number) => {
      this.connected = false;
      if (this.closing) return;
      // WebSocketClient has its own internal reconnect loop — it will fire
      // setReconnectCallback when it re-establishes. Do NOT call openWebSocket()
      // here; doing so creates a second WS connection which causes duplicate
      // events (2 responses per message). Log only.
      console.warn(`[mm-client] WebSocket closed (failCount=${failCount}) — waiting for internal reconnect`);

      // Track consecutive failures. A failure is any close that happens while
      // failCount > 0 (meaning the internal reconnect has already tried once).
      // The "sequence desync" storm (1006 → reconnect → 1006 → ...) triggers
      // this path on every cycle. After MAX_WS_FAIL_CYCLES we give up and exit
      // so the supervisor wrapper can do a clean restart with a fresh connection.
      if (failCount >= 1) {
        this.wsCycleFailures++;
        if (this.wsCycleFailures >= MAX_WS_FAIL_CYCLES) {
          console.error(
            `[mm-client] ${MAX_WS_FAIL_CYCLES} consecutive WS failures — exiting for supervisor restart`
          );
          process.exit(1);
        }
      } else {
        // Clean disconnect (failCount=0) — reset the counter.
        this.wsCycleFailures = 0;
      }
    });

    ws.setEventCallback((msg: any) => {
      // msg shape: { event: string, data: Record<string, unknown>, broadcast: ... }
      const event: string = msg?.event ?? "";
      const data = msg?.data ?? {};
      const broadcast = msg?.broadcast;

      for (const h of this.rawHandlers) {
        try {
          h(event, data, broadcast);
        } catch (e) {
          console.error("[mm-client] raw handler threw:", e);
        }
      }

      if (event === "posted") {
        // Mattermost sends post as a JSON-encoded string inside data.post
        let postObj: PostedEvent["post"] | undefined;
        try {
          postObj = typeof data.post === "string" ? JSON.parse(data.post) : data.post;
        } catch {
          console.warn("[mm-client] failed to parse posted event payload");
          return;
        }
        if (!postObj) return;

        const payload: PostedEvent = {
          channel_display_name: String(data.channel_display_name ?? ""),
          channel_name: String(data.channel_name ?? ""),
          channel_type: String(data.channel_type ?? ""),
          team_id: String(data.team_id ?? ""),
          sender_name: String(data.sender_name ?? ""),
          post: postObj,
        };

        for (const h of this.postedHandlers) {
          Promise.resolve(h(payload)).catch((e) => {
            console.error("[mm-client] posted handler threw:", e);
          });
        }
      }
    });

    // initialize(connectionUrl, token, postedAck?) — note URL comes first
    ws.initialize(wsUrl, this.opts.token);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
