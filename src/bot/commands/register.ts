/**
 * /register <path> — map the current channel to a project directory.
 * Mirrors the Discord version: validates path stays within BASE_PROJECT_DIR,
 * creates the directory if missing, stores channel → project in SQLite.
 */

import fs from "node:fs";
import path from "node:path";
import { registerProject, getProject } from "../../db/database.js";
import { validateProjectPath } from "../../security/guard.js";
import { getConfig } from "../../utils/config.js";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "register",
  description: "Register this channel to a project directory",
  autoCompleteHint: "[project-folder-name]",
  autoCompleteDesc: "e.g. /register my-project  — relative to BASE_PROJECT_DIR",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const input = req.text.trim();
    if (!input) {
      return {
        response_type: "ephemeral",
        text: L("Usage: `/register <folder>`", "사용법: `/register <폴더>`"),
      };
    }

    const config = getConfig();
    const projectPath = path.isAbsolute(input)
      ? input
      : path.join(config.BASE_PROJECT_DIR, input);

    const existing = getProject(req.channelId);
    if (existing) {
      return {
        response_type: "ephemeral",
        text: L(
          `This channel is already registered to \`${existing.project_path}\`. Use \`/unregister\` first.`,
          `이 채널은 이미 \`${existing.project_path}\`에 등록되어 있습니다. 먼저 \`/unregister\`를 사용하세요.`,
        ),
      };
    }

    if (!fs.existsSync(projectPath)) {
      const resolved = path.resolve(projectPath);
      const baseDir = path.resolve(config.BASE_PROJECT_DIR);
      if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
        return {
          response_type: "ephemeral",
          text: L(
            `Invalid path: must be within ${baseDir}`,
            `잘못된 경로: ${baseDir} 내에 있어야 합니다`,
          ),
        };
      }
      if (projectPath.includes("..")) {
        return {
          response_type: "ephemeral",
          text: L("Invalid path: must not contain '..'", "잘못된 경로: '..'을 포함할 수 없습니다"),
        };
      }
      fs.mkdirSync(projectPath, { recursive: true });
    }

    const error = validateProjectPath(projectPath);
    if (error) {
      return {
        response_type: "ephemeral",
        text: L(`Invalid path: ${error}`, `잘못된 경로: ${error}`),
      };
    }

    registerProject(req.channelId, projectPath, req.teamId);

    return {
      response_type: "in_channel",
      attachments: [{
        title: L("Project Registered", "프로젝트 등록됨"),
        text: L(
          `This channel is now linked to:\n\`${projectPath}\``,
          `이 채널이 연결되었습니다:\n\`${projectPath}\``,
        ),
        color: COLORS.success,
        fields: [
          { title: L("Status", "상태"), value: L("🔴 Offline", "🔴 오프라인"), short: true },
          { title: L("Auto-approve", "자동 승인"), value: L("Off", "꺼짐"), short: true },
        ],
      }],
    };
  },
};
