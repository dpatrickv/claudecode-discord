/**
 * /clear-sessions — delete all Claude Code JSONL session files for this project.
 * Destructive; admin-only by convention (ALLOWED_USER_IDS already gates all commands).
 */

import fs from "node:fs";
import path from "node:path";
import { getProject } from "../../db/database.js";
import { findSessionDir } from "./sessions.js";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "clear-sessions",
  description: "Delete all Claude Code session files for this project",
  autoCompleteHint: "",
  autoCompleteDesc: "Destructive — deletes every JSONL for this project.",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const project = getProject(req.channelId);
    if (!project) {
      return {
        response_type: "ephemeral",
        text: L("This channel is not registered to any project. Use `/register` first.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다. 먼저 `/register`를 사용하세요."),
      };
    }

    const sessionDir = findSessionDir(project.project_path);
    if (!sessionDir) {
      return {
        response_type: "ephemeral",
        text: L(`No session directory found for \`${project.project_path}\``, `\`${project.project_path}\`에 대한 세션 디렉토리를 찾을 수 없습니다`),
      };
    }

    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) {
      return {
        response_type: "ephemeral",
        text: L("No session files to delete.", "삭제할 세션 파일이 없습니다."),
      };
    }

    let deleted = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(sessionDir, file));
        deleted++;
      } catch {
        /* skip files that can't be deleted */
      }
    }

    return {
      response_type: "in_channel",
      attachments: [{
        title: L("Sessions Cleared", "세션 정리됨"),
        text: [
          `Project: \`${project.project_path}\``,
          L(`Deleted **${deleted}** session file(s)`, `**${deleted}**개의 세션 파일이 삭제되었습니다`),
        ].join("\n"),
        color: COLORS.danger,
      }],
    };
  },
};
