/**
 * /sessions — list existing Claude Code JSONL sessions for this project and present
 * a select-menu UI for resuming or deleting any of them. When the user picks one
 * the interact handler rebuilds the post with Resume/Delete/Cancel buttons.
 *
 * This file also exports the platform-neutral filesystem helpers (findSessionDir,
 * getLastAssistantMessage, getLastAssistantMessageFull) consumed by /last and by
 * the interact handler.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { getProject, getSession, upsertSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { ACTION_IDS, COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";

interface SessionInfo {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  fileSize: number;
}

export function findSessionDir(projectPath: string): string | null {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return null;

  const simpleName = projectPath.replace(/[\\/_]/g, "-");
  const simplePath = path.join(claudeDir, simpleName);
  if (fs.existsSync(simplePath)) return simplePath;

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
        /* skip */
      }
    }
  }
  return null;
}

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

async function getFirstUserMessage(filePath: string): Promise<{ text: string; timestamp: string }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp = "";
  let text = "";

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);
      if (!timestamp && entry.timestamp) timestamp = entry.timestamp;
      if (entry.type === "user" && entry.message?.content) {
        const content = entry.message.content;
        let raw = "";
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              raw = block.text;
              break;
            }
          }
        } else if (typeof content === "string") {
          raw = content;
        }
        const cleaned = raw.replace(/<[^>]+>[^<]*<\/[^>]+>/g, "").replace(/<[^>]+>/g, "").trim();
        if (cleaned) {
          text = cleaned;
          break;
        }
      }
    } catch {
      /* skip */
    }
  }
  rl.close();
  stream.destroy();
  return { text: text || "(empty session)", timestamp };
}

async function listSessions(projectPath: string): Promise<SessionInfo[]> {
  const sessionDir = findSessionDir(projectPath);
  if (!sessionDir) return [];

  const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const stat = fs.statSync(filePath);
    if (stat.size < 512) continue;

    const sessionId = file.replace(".jsonl", "");
    const { text } = await getFirstUserMessage(filePath);
    if (text === "(empty session)") continue;

    sessions.push({
      sessionId,
      firstMessage: text.slice(0, 80),
      timestamp: stat.mtime.toISOString(),
      fileSize: stat.size,
    });
  }

  sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return sessions;
}

export const command: CommandModule = {
  name: "sessions",
  description: "List and resume existing Claude Code sessions for this project",
  autoCompleteHint: "",
  autoCompleteDesc: "",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const project = getProject(req.channelId);
    if (!project) {
      return {
        response_type: "ephemeral",
        text: L("This channel is not registered to any project. Use `/register` first.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요."),
      };
    }

    const sessions = await listSessions(project.project_path);

    if (sessions.length === 0) {
      upsertSession(randomUUID(), req.channelId, null, "idle");
      return {
        response_type: "in_channel",
        attachments: [{
          title: L("✨ New Session", "✨ 새 세션"),
          text: L(
            `No existing sessions found for \`${project.project_path}\`.\nA new session is ready — your next message will start a new conversation.`,
            `\`${project.project_path}\`에 대한 기존 세션이 없습니다.\n새 세션이 준비되었습니다 — 다음 메시지부터 새로운 대화가 시작됩니다.`,
          ),
          color: COLORS.success,
        }],
      };
    }

    const dbSession = getSession(req.channelId);
    const activeSessionId = dbSession?.session_id ?? null;

    // Select-menu options — one "New Session" sentinel + up to 24 real sessions
    type Opt = { text: string; value: string };
    const selectOptions: Opt[] = [
      { text: L("✨ Create New Session", "✨ 새 세션 만들기"), value: "__new_session__" },
    ];

    const summary: string[] = [];
    sessions.slice(0, 24).forEach((s, i) => {
      const date = new Date(s.timestamp);
      const diffMs = Date.now() - date.getTime();
      const diffMin = Math.floor(diffMs / 60_000);
      const diffHr = Math.floor(diffMs / 3_600_000);
      const diffDay = Math.floor(diffMs / 86_400_000);
      const timeStr =
        diffMin < 1 ? L("just now", "방금") :
        diffMin < 60 ? L(`${diffMin}m ago`, `${diffMin}분 전`) :
        diffHr < 24 ? L(`${diffHr}h ago`, `${diffHr}시간 전`) :
        diffDay < 7 ? L(`${diffDay}d ago`, `${diffDay}일 전`) :
        date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

      const sizeKB = Math.round(s.fileSize / 1024);
      const isActive = s.sessionId === activeSessionId;
      const label = isActive ? `▶ ${s.firstMessage.slice(0, 48)}` : s.firstMessage.slice(0, 50) || `Session ${i + 1}`;

      selectOptions.push({ text: `${label}  —  ${timeStr}, ${sizeKB}KB`.slice(0, 140), value: s.sessionId });
      summary.push(`**${i + 1}.** ${isActive ? "▶ " : ""}${s.firstMessage.slice(0, 60)} — ${timeStr}`);
    });

    return {
      response_type: "ephemeral",
      attachments: [{
        title: L("Claude Code Sessions", "Claude Code 세션"),
        text: [
          `Project: \`${project.project_path}\``,
          L(`Found **${sessions.length}** session(s)`, `**${sessions.length}**개의 세션을 찾았습니다`),
          "",
          summary.join("\n"),
        ].join("\n"),
        color: COLORS.question,
        actions: [{
          id: ACTION_IDS.sessionSelect,
          name: L("Select a session to resume...", "재개할 세션을 선택하세요..."),
          type: "select",
          context: { channelId: req.channelId },
          options: selectOptions,
        }],
      }],
    };
  },
};
