/**
 * Mattermost transport entry point. Instantiates every moving piece and
 * returns once the bot is live (WebSocket connected, HTTP server listening,
 * slash commands registered).
 *
 * Wiring order matters:
 *   1. Connect MM client (fetches bot user ID, opens WebSocket)
 *   2. Build the MattermostAdapter (implements ChatAdapter)
 *   3. Init SessionManager with the adapter
 *   4. Register slash commands (fetches per-command tokens)
 *   5. Build the HandlerContext (adapter + sessionManager + commandTokens)
 *   6. Start the HTTP server (uses the context for slash-command + interact routes)
 *   7. Attach the `posted` handler (uses the same context)
 */

import { getConfig } from "../utils/config.js";
import { MattermostClient } from "./mattermost-client.js";
import { MattermostAdapter } from "../adapters/mattermost-adapter.js";
import { initSessionManager } from "../claude/session-manager.js";
import { ALL_COMMANDS, buildCommandMap } from "./commands/index.js";
import { registerCommands } from "./mm-startup.js";
import { startHttpServer } from "./http-server.js";
import { handlePosted } from "./handlers/ws-posted.js";
import type { HandlerContext } from "./types.js";

export async function startBot(): Promise<void> {
  const config = getConfig();

  // 1. Mattermost client
  const mmClient = new MattermostClient({
    url: config.MATTERMOST_URL,
    token: config.MATTERMOST_TOKEN,
  });
  await mmClient.connect();
  const botUserId = mmClient.getBotUserId();

  // 2. Adapter
  const adapter = new MattermostAdapter({
    client: mmClient.client,
    botUserId,
    botPublicUrl: config.BOT_PUBLIC_URL,
    webhookToken: config.MATTERMOST_WEBHOOK_TOKEN,
  });

  // 3. Session manager
  const sessionManager = initSessionManager(adapter);

  // 4. Slash command registration — idempotent, stash tokens
  const commandTokens = await registerCommands({
    client: mmClient.client,
    teamId: config.MATTERMOST_TEAM_ID,
    botPublicUrl: config.BOT_PUBLIC_URL,
    commands: ALL_COMMANDS,
  });

  // 5. HandlerContext shared by HTTP routes + WS callbacks
  const context: HandlerContext = {
    adapter,
    sessionManager,
    client: mmClient.client,
    botUserId,
    webhookToken: config.MATTERMOST_WEBHOOK_TOKEN,
    commandTokens,
  };

  // 6. HTTP server (inbound webhooks)
  await startHttpServer({
    port: config.HTTP_BIND_PORT,
    commands: buildCommandMap(),
    context,
    mmClient,
  });

  // 7. `posted` events → session-manager
  mmClient.onPosted((event) => handlePosted(event, context));

  console.log(`[bot] claudecode-mattermost online — ${ALL_COMMANDS.length} commands, HTTP :${config.HTTP_BIND_PORT}`);
}
