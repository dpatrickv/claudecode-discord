/**
 * /unregister — remove the channel → project mapping. Stops any active session first.
 */

import { unregisterProject, getProject } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, HandlerContext, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "unregister",
  description: "Unregister this channel from its project",
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

    await ctx.sessionManager.stopSession(req.channelId);
    unregisterProject(req.channelId);

    return {
      response_type: "in_channel",
      attachments: [{
        title: L("Project Unregistered", "프로젝트 등록 해제됨"),
        text: L(`Removed link to \`${project.project_path}\``, `\`${project.project_path}\` 연결이 해제되었습니다`),
        color: COLORS.danger,
      }],
    };
  },
};
