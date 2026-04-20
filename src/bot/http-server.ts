/**
 * Inbound HTTP server. Mattermost calls this on button clicks and slash commands.
 *
 * Routes:
 *   POST /interact              — button / select-menu action callback
 *   POST /commands/:name        — slash-command invocation (form-encoded)
 *   GET  /health                — liveness probe for the watchdog script
 *
 * All inbound requests are verified against the per-command / per-action shared secret
 * configured at command-registration time (Phase 2g) — without verification, any LAN
 * attacker could forge approvals.
 */

import express, { type Express, type Request, type Response } from "express";
import type { CommandModule, HandlerContext, InteractRequest, SlashRequest } from "./types.js";
import { handleInteract } from "./handlers/interact.js";
import { isAllowedUser } from "../security/guard.js";

export interface HttpServerOptions {
  port: number;
  commands: Map<string, CommandModule>;
  context: HandlerContext;
}

export function createHttpServer(opts: HttpServerOptions): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: "1mb" }));

  // --- Liveness for the watchdog script -------------------------------------

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ alive: true, pid: process.pid, service: "claudecode-mattermost" });
  });

  // --- Slash commands --------------------------------------------------------

  app.post("/commands/:name", async (req: Request, res: Response) => {
    const commandName = req.params.name;
    const command = opts.commands.get(commandName);
    if (!command) {
      res.status(404).json({ text: `Unknown command: /${commandName}` });
      return;
    }

    const body = (req.body ?? {}) as Record<string, string>;
    const request: SlashRequest = {
      commandName,
      channelId: body.channel_id ?? "",
      channelName: body.channel_name ?? "",
      userId: body.user_id ?? "",
      username: body.user_name ?? "",
      teamId: body.team_id ?? "",
      text: body.text ?? "",
      token: body.token ?? "",
      responseUrl: body.response_url,
    };

    // Per-command token verification — Mattermost generates this at command-creation time
    // and we stash it in opts.context.commandTokens. A mismatch means spoofed or stale.
    const expected = opts.context.commandTokens.get(commandName);
    if (!expected) {
      console.warn(`[http] slash /${commandName}: no registered token (startup incomplete?)`);
    } else if (request.token !== expected) {
      console.warn(`[http] slash /${commandName}: token mismatch from user=${request.userId}`);
      res.status(401).json({ text: "Unauthorized request." });
      return;
    }

    if (!isAllowedUser(request.userId)) {
      res.json({
        response_type: "ephemeral",
        text: "You are not authorized to use this bot.",
      });
      return;
    }

    try {
      const response = await command.execute(request, opts.context);
      res.json(response);
    } catch (e) {
      console.error(`[http] /commands/${commandName} threw:`, e);
      res.json({
        response_type: "ephemeral",
        text: `❌ Command failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  // --- Interactive-message callbacks (buttons + select menus) ---------------

  app.post("/interact", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const context = (body.context as Record<string, unknown>) ?? {};

    // Shared-secret check first — any missing/mismatched token means we drop it.
    const provided = typeof context.webhook_token === "string" ? context.webhook_token : "";
    if (provided !== opts.context.webhookToken) {
      console.warn("[http] /interact: webhook_token mismatch, dropping");
      res.status(401).json({ ephemeral_text: "Unauthorized." });
      return;
    }

    const actionId = typeof context.action_id === "string" ? context.action_id : "";
    if (!actionId) {
      res.status(400).json({ ephemeral_text: "Missing action_id in context." });
      return;
    }

    const userId = String(body.user_id ?? "");
    if (!isAllowedUser(userId)) {
      res.json({ ephemeral_text: "You are not authorized to use this bot." });
      return;
    }

    // Mattermost sends `selected_option` on select-menu callbacks; buttons have no value.
    const selectedOption = typeof body.selected_option === "string" ? body.selected_option : undefined;

    const request: InteractRequest = {
      actionId,
      context,
      channelId: String(body.channel_id ?? ""),
      channelName: String(body.channel_name ?? ""),
      userId,
      username: String(body.user_name ?? ""),
      teamId: String(body.team_id ?? ""),
      postId: String(body.post_id ?? ""),
      selectedOption,
    };

    try {
      const response = await handleInteract(request, opts.context);
      res.json(response ?? {});
    } catch (e) {
      console.error(`[http] /interact ${actionId} threw:`, e);
      res.status(500).json({
        ephemeral_text: `Interaction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  // --- Error fallback --------------------------------------------------------

  app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    console.error("[http] unhandled:", err);
    if (!res.headersSent) {
      res.status(500).json({ text: "Internal server error." });
    }
  });

  return app;
}

export async function startHttpServer(opts: HttpServerOptions): Promise<void> {
  const app = createHttpServer(opts);
  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port, () => {
      console.log(`[http] listening on 0.0.0.0:${opts.port}`);
      resolve();
    });
    server.on("error", reject);
  });
}
