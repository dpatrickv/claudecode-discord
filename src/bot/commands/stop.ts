/**
 * /stop — interrupt the active Claude Code session in this channel.
 */

import { getProject } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, HandlerContext, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "stop",
  description: "Stop the active Claude Code session in this channel",
  autoCompleteHint: "",
  autoCompleteDesc: "",

  async execute(req: SlashRequest, ctx: HandlerContext): Promise<SlashResponse> {
    const project = getProject(req.channelId);
    if (!project) {
      return {
        response_type: "ephemeral",
        text: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
      };
    }

    const stopped = await ctx.sessionManager.stopSession(req.channelId);
    if (!stopped) {
      return {
        response_type: "ephemeral",
        text: L("No active session in this channel.", "이 채널에 활성 세션이 없습니다."),
      };
    }

    return {
      response_type: "in_channel",
      attachments: [{
        title: L("Session Stopped", "세션 중지됨"),
        text: L(
          `Stopped Claude Code session for \`${project.project_path}\``,
          `\`${project.project_path}\` Claude Code 세션이 중지되었습니다`,
        ),
        color: COLORS.warning,
      }],
    };
  },
};
