/**
 * Mattermost transport entry point.
 *
 * Wires together:
 *   - MattermostAdapter (implements ChatAdapter against Client4 REST API)
 *   - MattermostWebSocketClient (receives `posted` events etc. from MM server)
 *   - HTTP server on HTTP_BIND_PORT (receives button callbacks + slash commands from MM)
 *   - SessionManager (platform-neutral Claude session orchestration)
 *   - Idempotent slash-command registration via Client4
 *
 * Not yet implemented — this is a stub that keeps the build green while
 * Phases 2c–2h fill in the concrete pieces.
 */

export async function startBot(): Promise<void> {
  throw new Error(
    "Mattermost transport not yet implemented. " +
      "Run after Phases 2c–2h are complete — see /root/.claude/plans/1-rustling-fog.md.",
  );
}
