/**
 * ChatAdapter backed by Mattermost's Client4 REST client.
 *
 * Translates platform-neutral RichMessageSpec into Mattermost's native "attachments"
 * structure (Slack-compatible), which is the closest equivalent to Discord embeds
 * and supports interactive buttons/menus via `integration.url` + `integration.context`
 * callback metadata.
 *
 * Reference: https://docs.mattermost.com/developer/interactive-messages.html
 */

import { Client4 } from "@mattermost/client";
import type {
  ChatAdapter,
  ContentSpec,
  MessageRef,
  RichMessageSpec,
  RichAttachment,
  RichAction,
} from "./chat-adapter.js";

/** Mattermost's per-post message cap (as of v11). */
const MATTERMOST_MAX_MESSAGE_LENGTH = 16383;

/** Interactive-message attachment payload understood by Mattermost posts `props.attachments`. */
interface MMAttachment {
  title?: string;
  text?: string;
  color?: string;
  footer?: string;
  fields?: { title: string; value: string; short?: boolean }[];
  actions?: MMAction[];
}

interface MMAction {
  id: string;
  name: string;
  type: "button" | "select";
  style?: "default" | "primary" | "success" | "danger" | "good" | "warning";
  integration: {
    url: string;
    context: Record<string, unknown>;
  };
  options?: { text: string; value: string }[];
}

export interface MattermostAdapterOptions {
  client: Client4;
  botUserId: string;
  /** Base URL the MM server uses to call us back on button clicks. e.g. http://10.0.2.244:9887 */
  botPublicUrl: string;
  /** Shared secret included in every action context so our HTTP server can verify the caller. */
  webhookToken: string;
}

export class MattermostAdapter implements ChatAdapter {
  readonly maxMessageLength = MATTERMOST_MAX_MESSAGE_LENGTH;

  constructor(private readonly opts: MattermostAdapterOptions) {}

  async send(channelId: string, content: ContentSpec): Promise<MessageRef> {
    const post = this.buildPost(channelId, content);
    const created = await this.opts.client.createPost(post as any);
    return { channelId, messageId: created.id };
  }

  async edit(ref: MessageRef, content: ContentSpec): Promise<void> {
    const patch: { id: string; message?: string; props?: Record<string, unknown> } = {
      id: ref.messageId,
    };
    const { message, props } = this.buildMessageAndProps(content);
    if (message !== undefined) patch.message = message;
    if (props !== undefined) patch.props = props;
    await this.opts.client.patchPost(patch as any);
  }

  async delete(ref: MessageRef): Promise<void> {
    await this.opts.client.deletePost(ref.messageId);
  }

  async react(ref: MessageRef, emoji: string): Promise<void> {
    // Strip leading/trailing colons if the caller passed `:+1:`-style shortcode
    const name = emoji.replace(/^:|:$/g, "");
    await this.opts.client.saveReaction({
      user_id: this.opts.botUserId,
      post_id: ref.messageId,
      emoji_name: name,
      create_at: 0,
    } as any);
  }

  async sendEphemeral(channelId: string, userId: string, content: ContentSpec): Promise<void> {
    const post = this.buildPost(channelId, content);
    // createPostEphemeral exists on recent Client4 — fall back to a raw POST if missing
    const client = this.opts.client as unknown as {
      createPostEphemeral?: (userId: string, post: unknown) => Promise<unknown>;
      getUrl: () => string;
      getOptions: (opts: unknown) => unknown;
    };
    if (typeof client.createPostEphemeral === "function") {
      await client.createPostEphemeral(userId, post);
      return;
    }

    // Raw-POST fallback (older client versions don't expose createPostEphemeral)
    const resp = await fetch(`${this.opts.client.getUrl()}/api/v4/posts/ephemeral`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(this.opts.client as any).getToken?.() ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId, post }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to send ephemeral post: ${resp.status} ${await resp.text()}`);
    }
  }

  // --- internals ---

  private buildPost(channelId: string, content: ContentSpec): Record<string, unknown> {
    const { message, props } = this.buildMessageAndProps(content);
    const post: Record<string, unknown> = { channel_id: channelId };
    if (message !== undefined) post.message = message;
    if (props !== undefined) post.props = props;
    return post;
  }

  private buildMessageAndProps(content: ContentSpec): { message?: string; props?: Record<string, unknown> } {
    if (typeof content === "string") {
      return { message: content };
    }
    const spec = content as RichMessageSpec;
    const out: { message?: string; props?: Record<string, unknown> } = {};
    if (spec.text !== undefined) out.message = spec.text;
    if (spec.attachments && spec.attachments.length > 0) {
      out.props = { attachments: spec.attachments.map((a) => this.translateAttachment(a)) };
    } else {
      // Empty attachments array clears props.attachments on edit — matches desired UX
      // (so that completedButton replaces stopButton).
      out.props = { attachments: [] };
    }
    return out;
  }

  private translateAttachment(att: RichAttachment): MMAttachment {
    const mm: MMAttachment = {};
    if (att.title !== undefined) mm.title = att.title;
    if (att.text !== undefined) mm.text = att.text;
    if (att.color !== undefined) mm.color = att.color;
    if (att.footer !== undefined) mm.footer = att.footer;
    if (att.fields && att.fields.length > 0) {
      mm.fields = att.fields.map((f) => ({
        title: f.title,
        value: f.value,
        short: f.short ?? false,
      }));
    }
    if (att.actions && att.actions.length > 0) {
      mm.actions = att.actions.map((a) => this.translateAction(a));
    }
    return mm;
  }

  private translateAction(a: RichAction): MMAction {
    const integration = {
      url: `${this.opts.botPublicUrl}/interact`,
      context: {
        ...a.context,
        action_id: a.id,
        webhook_token: this.opts.webhookToken,
      },
    };

    // Mattermost button styles: default | primary | success | good | warning | danger
    // Our abstract styles: default | primary | success | danger
    // Map 1:1.
    const mm: MMAction = {
      id: a.id,
      name: a.name,
      type: a.type,
      integration,
      ...(a.style ? { style: a.style } : {}),
    };

    if (a.type === "select" && a.options) {
      mm.options = a.options;
    }

    return mm;
  }
}
