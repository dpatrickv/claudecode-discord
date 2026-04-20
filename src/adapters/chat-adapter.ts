/**
 * Platform-neutral chat abstraction used by session-manager and output-formatter.
 *
 * A concrete adapter (e.g. MattermostAdapter) translates these primitives to
 * its native client. This lets the core Claude-session logic stay transport-agnostic
 * so future ports (Matrix, Slack, Revolt, etc.) don't touch session-manager.ts.
 *
 * RichMessageSpec is Slack-flavoured (title + fields + actions) because that maps
 * directly onto Mattermost's attachment model; adapters for other platforms translate
 * from this canonical shape to their native rich-message format.
 */

export interface MessageRef {
  /** Platform channel / room / DM ID. */
  channelId: string;
  /** Platform message ID. Used for subsequent edit/delete/react. */
  messageId: string;
}

export type ContentSpec = string | RichMessageSpec;

export interface RichMessageSpec {
  /** Plain message text rendered above any attachments. */
  text?: string;
  attachments?: RichAttachment[];
}

export interface RichAttachment {
  title?: string;
  /** Short description; renders as the main body of the attachment. */
  text?: string;
  /** Hex color code, e.g. "#00ff00". Rendered as a left border in most clients. */
  color?: string;
  fields?: RichField[];
  actions?: RichAction[];
  footer?: string;
}

export interface RichField {
  title: string;
  value: string;
  /** Inline fields sit side-by-side; long-form fields take the full row. */
  short?: boolean;
}

/**
 * An interactive button or menu attached to a message.
 *
 * The adapter is responsible for wiring this to its native interaction mechanism
 * (Mattermost attaches buttons with a POST webhook URL; Discord uses Gateway-delivered
 * InteractionCreate events). When the user interacts, the adapter invokes
 * the bot's shared interaction-dispatch logic with `action.id` + `action.context`.
 */
export interface RichAction {
  /** Stable logical ID for this action — bot dispatches on this. */
  id: string;
  /** Button label shown to the user. */
  name: string;
  type: "button" | "select";
  /**
   * Visual style. Adapters map to native equivalents:
   *   primary/success → green (Success)
   *   danger          → red   (Danger)
   *   default         → grey  (Secondary)
   */
  style?: "default" | "primary" | "success" | "danger";
  /** Arbitrary JSON payload returned to the bot when the action fires. */
  context: Record<string, unknown>;
  /** Options for select menus only. */
  options?: { text: string; value: string }[];
}

export interface ChatAdapter {
  /** Send a new message to a channel. Returns a reference for later edit/delete/react. */
  send(channelId: string, content: ContentSpec): Promise<MessageRef>;

  /** Replace an existing message's content in place. */
  edit(ref: MessageRef, content: ContentSpec): Promise<void>;

  /** Delete a previously-sent message. */
  delete(ref: MessageRef): Promise<void>;

  /** Add an emoji reaction to a message. `emoji` is the Unicode char or shortcode (`:white_check_mark:`). */
  react(ref: MessageRef, emoji: string): Promise<void>;

  /** Send a message only visible to one specific user in the channel (Mattermost: ephemeral; Discord: flag). */
  sendEphemeral(channelId: string, userId: string, content: ContentSpec): Promise<void>;

  /**
   * Maximum message length for this platform. Used by splitMessage() to
   * chunk long content. Mattermost: 16383. Discord: 2000.
   */
  readonly maxMessageLength: number;
}
