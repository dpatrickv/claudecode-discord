/**
 * Thin wrapper around @mattermost/client's Client4 (REST) + WebSocketClient (events).
 *
 * Responsibilities:
 *   - Authenticate with `MATTERMOST_TOKEN` and expose the Client4 instance for REST calls.
 *   - Open a long-lived WebSocket to /api/v4/websocket and emit server events to handlers.
 *   - Auto-reconnect the WebSocket on disconnect (exponential backoff, capped).
 *   - Track the bot's own user ID (used by handlers to ignore own messages).
 */

import { Client4, WebSocketClient } from "@mattermost/client";
import WebSocket from "ws";

// @mattermost/client uses a `WebSocket` global; in Node we need to polyfill it from `ws`.
// Do this once at module load so every WebSocketClient created here picks it up.
if (typeof (globalThis as any).WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
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

export class MattermostClient {
  readonly client: Client4;
  private ws: WebSocketClient | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private closing = false;
  private botUserId: string | null = null;
  private postedHandlers: PostedHandler[] = [];
  private rawHandlers: WSEventHandler[] = [];

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

    // WebSocketClient builds its own URL from a base URL — it wants http(s) form.
    const wsUrl = this.opts.url; // WebSocketClient converts internally.

    ws.setFirstConnectCallback(() => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log("[mm-client] WebSocket connected");
    });

    ws.setReconnectCallback(() => {
      this.connected = true;
      console.log("[mm-client] WebSocket reconnected");
    });

    ws.setMissedEventCallback(() => {
      console.warn("[mm-client] Missed events during reconnect — state may be stale");
    });

    ws.setErrorCallback((err: unknown) => {
      console.error("[mm-client] WebSocket error:", err);
    });

    ws.setCloseCallback(() => {
      this.connected = false;
      if (this.closing) return;
      this.reconnectAttempts++;
      const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)));
      console.warn(`[mm-client] WebSocket closed, reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => {
        if (!this.closing) this.openWebSocket();
      }, delay);
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

    ws.initialize(this.opts.token, wsUrl);
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
