/**
 * /last — show the full text of the last Claude response in this channel's session.
 */

import path from "node:path";
import { getProject, getSession } from "../../db/database.js";
import { findSessionDir, getLastAssistantMessageFull } from "./sessions.js";
import { splitMessage } from "../../claude/output-formatter.js";
import { L } from "../../utils/i18n.js";
import type { CommandModule, HandlerContext, SlashRequest, SlashResponse } from "../types.js";

export const command: CommandModule = {
  name: "last",
  description: "Show the last Claude response from the current session",
  autoCompleteHint: "",
  autoCompleteDesc: "",

  async execute(req: SlashRequest, ctx: HandlerContext): Promise<SlashResponse> {
    const project = getProject(req.channelId);
    if (!project) {
      return {
        response_type: "ephemeral",
        text: L("This channel is not registered to any project. Use `/register` first.", "이 채널은 프로젝트에 등록되지 않았습니다. `/register`를 먼저 사용하세요."),
      };
    }

    const session = getSession(req.channelId);
    if (!session?.session_id) {
      return {
        response_type: "ephemeral",
        text: L("No active session. Select a session from `/sessions`.", "활성 세션이 없습니다. `/sessions`에서 세션을 선택하세요."),
      };
    }

    const sessionDir = findSessionDir(project.project_path);
    if (!sessionDir) {
      return { response_type: "ephemeral", text: L("Session directory not found.", "세션 디렉토리를 찾을 수 없습니다.") };
    }

    const filePath = path.join(sessionDir, `${session.session_id}.jsonl`);
    let lastMessage: string;
    try {
      lastMessage = await getLastAssistantMessageFull(filePath);
    } catch {
      return { response_type: "ephemeral", text: L("Cannot read session file.", "세션 파일을 읽을 수 없습니다.") };
    }

    if (lastMessage === "(no message)") {
      return { response_type: "ephemeral", text: L("No Claude response in this session.", "이 세션에 Claude 응답이 없습니다.") };
    }

    const chunks = splitMessage(lastMessage, ctx.adapter.maxMessageLength);

    // First chunk goes as the immediate response; remaining chunks are sent as
    // separate messages via the adapter. We return response_type=in_channel so
    // the first chunk is visible to everyone (matches Discord's followUp pattern).
    for (let i = 1; i < chunks.length; i++) {
      await ctx.adapter.send(req.channelId, chunks[i]).catch(() => {});
    }

    return {
      response_type: "in_channel",
      text: chunks[0] ?? "",
    };
  },
};
