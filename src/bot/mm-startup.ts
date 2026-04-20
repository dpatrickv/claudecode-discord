/**
 * Idempotent slash-command registration with Mattermost.
 *
 * On each bot startup we diff our local command list against what Mattermost
 * has registered for this team and create / update as needed. Every command
 * Mattermost creates gets a secret token that's included in the form body of
 * every invocation — we stash those tokens in `commandTokens` so the HTTP
 * server can validate inbound requests.
 *
 * Reference: https://docs.mattermost.com/developer/slash-commands.html
 */

import type { Client4 } from "@mattermost/client";
import type { CommandModule } from "./types.js";

export interface MMCommandSpec {
  id?: string;
  team_id: string;
  trigger: string;
  method: "P" | "G"; // POST / GET
  url: string;
  username?: string;
  icon_url?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  display_name: string;
  description: string;
  token?: string;
}

export interface RegisterOptions {
  client: Client4;
  teamId: string;
  /** Public URL Mattermost will call for each slash command, e.g. http://10.0.2.244:9887. */
  botPublicUrl: string;
  /** Human-friendly display name to show as the command's author. */
  botUsername?: string;
  commands: CommandModule[];
}

/**
 * Registers (or updates) every command and returns a Map<name, token> the HTTP
 * server uses to authenticate inbound slash-command POSTs.
 */
export async function registerCommands(opts: RegisterOptions): Promise<Map<string, string>> {
  const { client, teamId, botPublicUrl, commands } = opts;
  const commandTokens = new Map<string, string>();

  // Fetch what's already registered on the team so we can update-in-place
  // instead of duplicate-registering (which MM rejects on trigger clash).
  let existing: MMCommandSpec[] = [];
  try {
    const raw = await (client as unknown as {
      getCommandsList: (teamId: string) => Promise<MMCommandSpec[]>;
    }).getCommandsList(teamId);
    existing = Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.warn("[mm-startup] Failed to fetch existing commands:", e instanceof Error ? e.message : e);
  }

  for (const cmd of commands) {
    const desired: MMCommandSpec = {
      team_id: teamId,
      trigger: cmd.name,
      method: "P",
      url: `${botPublicUrl}/commands/${cmd.name}`,
      username: opts.botUsername ?? "claudecode",
      auto_complete: true,
      auto_complete_desc: cmd.autoCompleteDesc ?? cmd.description,
      auto_complete_hint: cmd.autoCompleteHint ?? "",
      display_name: `/${cmd.name}`,
      description: cmd.description,
    };

    const match = existing.find((c) => c.trigger === cmd.name);

    try {
      if (!match) {
        const created = await (client as unknown as {
          createCommand: (spec: MMCommandSpec) => Promise<MMCommandSpec>;
        }).createCommand(desired);
        if (created.token) commandTokens.set(cmd.name, created.token);
        console.log(`[mm-startup] created /${cmd.name}`);
      } else {
        // Update only if something meaningful changed — the URL is the common case,
        // since it changes every time BOT_PUBLIC_URL changes (e.g. moving hosts).
        const needsUpdate =
          match.url !== desired.url ||
          match.method !== desired.method ||
          match.auto_complete !== desired.auto_complete ||
          match.auto_complete_desc !== desired.auto_complete_desc ||
          match.auto_complete_hint !== desired.auto_complete_hint ||
          match.description !== desired.description;

        if (needsUpdate) {
          const patched: MMCommandSpec = { ...match, ...desired, id: match.id };
          await (client as unknown as {
            updateCommand: (spec: MMCommandSpec) => Promise<MMCommandSpec>;
          }).updateCommand(patched);
          console.log(`[mm-startup] updated /${cmd.name}`);
        }

        // MM's token is returned on create only — for existing commands we need
        // to call regenCommandToken (client4: regenCommandToken) to get a fresh
        // one. We only do this if we don't already have a token stashed from
        // a previous run. For simplicity, call it every startup — cheap and
        // ensures we always have the current token.
        if (match.id) {
          try {
            const regen = await (client as unknown as {
              regenCommandToken: (id: string) => Promise<{ token: string }>;
            }).regenCommandToken(match.id);
            if (regen?.token) commandTokens.set(cmd.name, regen.token);
          } catch (e) {
            console.warn(`[mm-startup] regen token for /${cmd.name} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    } catch (e) {
      console.error(`[mm-startup] failed to register /${cmd.name}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`[mm-startup] ${commandTokens.size}/${commands.length} commands have verified tokens`);
  return commandTokens;
}
