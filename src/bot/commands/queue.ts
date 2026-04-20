/**
 * /queue list | clear — view or clear pending messages waiting for the active session.
 */

import { getProject } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import { ACTION_IDS, COLORS } from "../../claude/output-formatter.js";
import type { RichAction } from "../../adapters/chat-adapter.js";
import type { CommandModule, HandlerContext, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "queue",
  description: "View and manage queued messages in this channel",
  autoCompleteHint: "[list|clear]",
  autoCompleteDesc: "e.g. /queue list  or  /queue clear",

  async execute(req: SlashRequest, ctx: HandlerContext): Promise<SlashResponse> {
    const project = getProject(req.channelId);
    if (!project) {
      return {
        response_type: "ephemeral",
        text: L("This channel is not registered to any project.", "이 채널은 어떤 프로젝트에도 등록되어 있지 않습니다."),
      };
    }

    const sub = req.text.trim().toLowerCase() || "list";

    if (sub === "clear") {
      const cleared = ctx.sessionManager.clearQueue(req.channelId);
      return {
        response_type: "in_channel",
        attachments: [{
          title: L("Queue Cleared", "큐 초기화됨"),
          text: L(`Cleared ${cleared} queued message(s).`, `${cleared}개의 대기 중이던 메시지를 취소했습니다.`),
          color: COLORS.warning,
        }],
      };
    }

    if (sub !== "list") {
      return {
        response_type: "ephemeral",
        text: L("Usage: `/queue list` or `/queue clear`", "사용법: `/queue list` 또는 `/queue clear`"),
      };
    }

    const queue = ctx.sessionManager.getQueue(req.channelId);
    if (queue.length === 0) {
      return {
        response_type: "ephemeral",
        text: L("No messages in queue.", "큐에 대기 중인 메시지가 없습니다."),
      };
    }

    const list = queue
      .map((item, idx) => {
        const preview = item.prompt.length > 100 ? item.prompt.slice(0, 100) + "…" : item.prompt;
        return `**${idx + 1}.** ${preview}`;
      })
      .join("\n\n");

    const actions: RichAction[] = queue.slice(0, 19).map((_, idx) => ({
      id: ACTION_IDS.queueRemove,
      name: `❌ ${idx + 1}`,
      type: "button" as const,
      style: "default" as const,
      context: { channelId: req.channelId, index: idx },
    }));
    actions.push({
      id: ACTION_IDS.queueClear,
      name: L("Clear All", "모두 취소"),
      type: "button",
      style: "danger",
      context: { channelId: req.channelId },
    });

    return {
      response_type: "ephemeral",
      attachments: [{
        title: L(`📋 Message Queue (${queue.length})`, `📋 메시지 큐 (${queue.length}개)`),
        text: list,
        color: COLORS.info,
        actions,
      }],
    };
  },
};
