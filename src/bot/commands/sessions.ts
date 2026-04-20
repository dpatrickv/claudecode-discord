/**
 * /sessions slash command + session-file helpers.
 *
 * `findSessionDir` and `getLastAssistantMessage` are platform-neutral file-system
 * utilities — lifted verbatim from upstream chadingTV/claudecode-discord. They
 * scan `~/.claude/projects/` for session JSONL files and are called from the
 * /sessions command flow as well as from the interact handler when deleting
 * a resumed session.
 *
 * The slash-command handler itself (CommandModule export) is stubbed for now —
 * it ships in Phase 2f. The helpers below are published independently so
 * interact.ts can resolve its dynamic import of this module.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import type { CommandModule } from "../types.js";

export function findSessionDir(projectPath: string): string | null {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return null;

  // Claude Code normalizes project paths by replacing `/` and `_` with `-`.
  const simpleName = projectPath.replace(/[\\/_]/g, "-");
  const simplePath = path.join(claudeDir, simpleName);
  if (fs.existsSync(simplePath)) return simplePath;

  // Fallback: scan directories and match by reading each JSONL's cwd field.
  const dirs = fs.readdirSync(claudeDir);
  for (const dir of dirs) {
    const dirPath = path.join(claudeDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const jsonlFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) continue;

    const firstFile = path.join(dirPath, jsonlFiles[0]);
    const content = fs.readFileSync(firstFile, { encoding: "utf-8" });
    const lines = content.split("\n").slice(0, 10);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.cwd === projectPath) return dirPath;
      } catch {
        /* skip invalid json */
      }
    }
  }
  return null;
}

/** Short one-line preview of the last assistant message in a session's JSONL. */
export async function getLastAssistantMessage(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastText = "";
  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.content) {
        const content = entry.message.content;
        let raw = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) raw += block.text;
          }
        } else if (typeof content === "string") {
          raw = content;
        }
        if (raw.trim()) lastText = raw.trim();
      }
    } catch {
      /* skip */
    }
  }
  rl.close();
  stream.destroy();

  if (!lastText) return "(no message)";
  const lines = lastText.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || lastText.slice(-200);
}

/** Full assistant message — used by /last. */
export async function getLastAssistantMessageFull(filePath: string): Promise<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lastText = "";
  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant" && entry.message?.content) {
        const content = entry.message.content;
        let raw = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) raw += block.text;
          }
        } else if (typeof content === "string") {
          raw = content;
        }
        if (raw.trim()) lastText = raw.trim();
      }
    } catch {
      /* skip */
    }
  }
  rl.close();
  stream.destroy();

  return lastText || "(no message)";
}

// Slash command handler — filled in Phase 2f.
export const command: CommandModule = {
  name: "sessions",
  description: "List existing Claude Code sessions for this project.",
  autoCompleteHint: "",
  autoCompleteDesc: "Show session picker UI with Resume / Delete buttons.",
  async execute() {
    return {
      response_type: "ephemeral",
      text: "⚠️ /sessions not yet implemented — pending Phase 2f port.",
    };
  },
};
