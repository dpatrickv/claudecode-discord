/**
 * Canonical registry of all slash-command modules. The HTTP server looks up
 * commands by name in this map; mm-startup iterates it to register each one
 * with Mattermost.
 */

import type { CommandModule } from "../types.js";

import { command as registerCmd } from "./register.js";
import { command as unregisterCmd } from "./unregister.js";
import { command as statusCmd } from "./status.js";
import { command as stopCmd } from "./stop.js";
import { command as autoApproveCmd } from "./auto-approve.js";
import { command as sessionsCmd } from "./sessions.js";
import { command as clearSessionsCmd } from "./clear-sessions.js";
import { command as lastCmd } from "./last.js";
import { command as queueCmd } from "./queue.js";
import { command as usageCmd } from "./usage.js";
import { command as brewCmd } from "./brew.js";
import { command as bfStatusCmd } from "./bf-status.js";

export const ALL_COMMANDS: CommandModule[] = [
  registerCmd,
  unregisterCmd,
  statusCmd,
  stopCmd,
  autoApproveCmd,
  sessionsCmd,
  clearSessionsCmd,
  lastCmd,
  queueCmd,
  usageCmd,
  brewCmd,
  bfStatusCmd,
];

export function buildCommandMap(): Map<string, CommandModule> {
  const m = new Map<string, CommandModule>();
  for (const c of ALL_COMMANDS) m.set(c.name, c);
  return m;
}
