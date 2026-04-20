/**
 * /auto-approve on|off — toggle channel-wide auto-approval for tool use.
 */

import { getProject, setAutoApprove } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "auto-approve",
  description: "Toggle auto-approve mode for tool use in this channel",
  autoCompleteHint: "[on|off]",
  autoCompleteDesc: "e.g. /auto-approve on",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const mode = req.text.trim().toLowerCase();
    if (mode !== "on" && mode !== "off") {
      return {
        response_type: "ephemeral",
        text: L("Usage: `/auto-approve on` or `/auto-approve off`", "사용법: `/auto-approve on` 또는 `/auto-approve off`"),
      };
    }

    const project = getProject(req.channelId);
    if (!project) {
      return {
        response_type: "ephemeral",
        text: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
      };
    }

    const enabled = mode === "on";
    setAutoApprove(req.channelId, enabled);

    return {
      response_type: "in_channel",
      attachments: [{
        title: L(`Auto-approve: ${enabled ? "ON" : "OFF"}`, `자동 승인: ${enabled ? "ON" : "OFF"}`),
        text: enabled
          ? L("Claude will automatically approve all tool uses (Edit, Write, Bash, etc.)", "Claude가 모든 도구 사용을 자동으로 승인합니다 (Edit, Write, Bash 등)")
          : L("Claude will ask for approval before using tools", "Claude가 도구 사용 전에 승인을 요청합니다"),
        color: enabled ? COLORS.success : COLORS.warning,
      }],
    };
  },
};
