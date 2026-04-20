/**
 * ntfy push notification utility.
 *
 * Publishes fire-and-forget push notifications to a self-hosted ntfy server.
 * Configured via env vars — if NTFY_URL is unset the module is a no-op.
 *
 * Env vars (all optional — feature is disabled if NTFY_URL is absent):
 *   NTFY_URL    Base URL of the ntfy server, e.g. https://ntfy.vanderhop.com
 *   NTFY_TOPIC  Topic to publish to (default: "claudecode")
 *   NTFY_TOKEN  Bearer token for auth (created with `ntfy token add <user>`)
 */

const NTFY_URL   = process.env.NTFY_URL?.replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "claudecode";
const NTFY_TOKEN = process.env.NTFY_TOKEN;

export type NtfyPriority = "min" | "low" | "default" | "high" | "urgent";

export interface NtfyOptions {
  priority?: NtfyPriority;
  tags?: string[];
  /** Click action URL opened when the notification is tapped. */
  clickUrl?: string;
}

/**
 * Send a push notification via ntfy. Fire-and-forget — never throws.
 * If NTFY_URL is not configured the call is a silent no-op.
 */
export async function notify(
  title: string,
  message: string,
  opts: NtfyOptions = {},
): Promise<void> {
  if (!NTFY_URL) return;

  const endpoint = `${NTFY_URL}/${NTFY_TOPIC}`;
  // ntfy header values must be Latin-1 safe (HTTP spec). Emoji and other
  // characters with codepoint > 255 cause a ByteString error in Node's fetch.
  // encodeURIComponent produces ASCII-safe output; ntfy decodes percent-encoded
  // header values automatically.
  const headers: Record<string, string> = {
    "Content-Type": "text/plain",
    "Title": encodeURIComponent(title),
    "Priority": opts.priority ?? "default",
  };

  if (NTFY_TOKEN) {
    headers["Authorization"] = `Bearer ${NTFY_TOKEN}`;
  }
  if (opts.tags?.length) {
    headers["Tags"] = opts.tags.map(encodeURIComponent).join(",");
  }
  if (opts.clickUrl) {
    headers["Click"] = opts.clickUrl;
  }

  try {
    await fetch(endpoint, {
      method: "POST",
      headers,
      body: message,
    });
  } catch (err) {
    // Never let a notification failure affect the main flow
    console.warn("[ntfy] Failed to send notification:", err instanceof Error ? err.message : err);
  }
}
