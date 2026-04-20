/**
 * /status — show all projects registered to the team and their current session state.
 */

import { getAllProjects, getSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";

const STATUS_EMOJI: Record<string, string> = {
  online: "🟢",
  waiting: "🟡",
  idle: "⚪",
  offline: "🔴",
};

// NOTE: triggered as `/claude-status` instead of `/status` because Mattermost
// reserves `/status` for the built-in user-presence command (online/away/dnd/offline).
export const command: CommandModule = {
  name: "claude-status",
  description: "Show status of all registered Claude Code project sessions",
  autoCompleteHint: "",
  autoCompleteDesc: "",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const projects = getAllProjects(req.teamId);

    if (projects.length === 0) {
      return {
        response_type: "ephemeral",
        text: L("No projects registered. Use `/register` in a channel first.", "등록된 프로젝트가 없습니다. 먼저 채널에서 `/register`를 사용하세요."),
      };
    }

    const fields = projects.map((project) => {
      const session = getSession(project.channel_id);
      const status = session?.status ?? "offline";
      const emoji = STATUS_EMOJI[status] ?? "🔴";
      const lastActivity = session?.last_activity ?? "never";

      return {
        title: `${emoji} ~${project.channel_id}`,
        value: [
          `\`${project.project_path}\``,
          `${L("Status", "상태")}: **${status}**`,
          `${L("Auto-approve", "자동 승인")}: ${project.auto_approve ? L("On", "켜짐") : L("Off", "꺼짐")}`,
          `${L("Last activity", "마지막 활동")}: ${lastActivity}`,
        ].join("\n"),
        short: false,
      };
    });

    return {
      response_type: "ephemeral",
      attachments: [{
        title: L("Claude Code Sessions", "Claude Code 세션"),
        color: COLORS.question,
        fields,
      }],
    };
  },
};
