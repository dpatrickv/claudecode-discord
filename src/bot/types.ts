/**
 * Shared types for the Mattermost transport: slash-command request/response shapes,
 * interactive-message callback shapes, and command/interact-handler context.
 *
 * Keeps the HTTP server decoupled from individual command implementations.
 */

import type { Client4 } from "@mattermost/client";
import type { ChatAdapter, RichAttachment } from "../adapters/chat-adapter.js";
import type { SessionManager } from "../claude/session-manager.js";

// --- Slash commands ---

/** Normalized slash-command invocation extracted from Mattermost's x-www-form-urlencoded POST body. */
export interface SlashRequest {
  commandName: string;
  channelId: string;
  channelName: string;
  userId: string;
  username: string;
  teamId: string;
  text: string;
  /** Per-command verification token Mattermost generates at command creation time. */
  token: string;
  /** URL to call back at for delayed responses (response.text is immediate; this is for async work). */
  responseUrl?: string;
}

/** JSON body returned to Mattermost for a slash-command response. */
export interface SlashResponse {
  text?: string;
  /** "ephemeral" = only clicker sees. "in_channel" = visible to the whole channel. */
  response_type?: "ephemeral" | "in_channel";
  attachments?: RichAttachment[];
}

export interface CommandModule {
  /** Command trigger without leading slash. e.g. "register" */
  name: string;
  description: string;
  /** Optional autocomplete data for the "Add slash command" UI. */
  autoCompleteHint?: string;
  autoCompleteDesc?: string;
  execute(req: SlashRequest, ctx: HandlerContext): Promise<SlashResponse>;
}

// --- Interactive messages ---

/** Normalized action-callback payload extracted from Mattermost's POST to /interact. */
export interface InteractRequest {
  /** Stable logical action ID set by the builder (`ACTION_IDS.approve` etc.). */
  actionId: string;
  /** Arbitrary payload the builder attached to the action. */
  context: Record<string, unknown>;
  channelId: string;
  channelName: string;
  userId: string;
  username: string;
  teamId: string;
  postId: string;
  /** Non-null for select menus: the user's selected value(s). */
  selectedOption?: string;
}

/** JSON body returned to Mattermost for an interactive-message callback. */
export interface InteractResponse {
  /** Short message shown only to the clicker. */
  ephemeral_text?: string;
  /** If present, MM replaces the original post with this content in place. */
  update?: {
    message?: string;
    props?: Record<string, unknown>;
  };
}

// --- Shared context passed to every handler ---

export interface HandlerContext {
  adapter: ChatAdapter;
  sessionManager: SessionManager;
  client: Client4;
  /** Bot's own user ID — used to ignore the bot's own messages in ws-posted. */
  botUserId: string;
  /** Expected webhook_token value for action-callback verification. */
  webhookToken: string;
  /** Per-command tokens keyed by command name (populated by mm-startup after registering). */
  commandTokens: Map<string, string>;
}
