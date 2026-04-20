/**
 * Interactive-message callback dispatcher.
 *
 * Mattermost POSTs here whenever a user clicks a button or selects a menu option.
 * We route on `actionId` (set by the builder via RichAction.id) and pull the rest
 * of the payload from `context` (arbitrary JSON set by the builder at message-send time).
 *
 * Replaces the Discord-specific src/bot/handlers/interaction.ts. Behaviour parity:
 *   approve / deny / approve-all  — resolve a pending tool-approval
 *   stop                          — interrupt the active Claude session
 *   ask-opt / ask-other / ask-select — AskUserQuestion flow
 *   answer-yes / answer-no        — quick-reply buttons
 *   session-resume / -delete / -cancel — /sessions UI
 *   queue-yes / queue-no / queue-clear / queue-remove — queue UI
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { upsertSession, getProject, getSession } from "../../db/database.js";
import { L } from "../../utils/i18n.js";
import {
  createCompletedButton,
  ACTION_IDS,
  COLORS,
} from "../../claude/output-formatter.js";
import type { RichMessageSpec } from "../../adapters/chat-adapter.js";
import type { HandlerContext, InteractRequest, InteractResponse } from "../types.js";

/**
 * Build an `update` payload from a RichMessageSpec.
 * Mattermost accepts the same attachments shape inline in callback responses,
 * so we render via the adapter's translator to keep styling consistent.
 */
function spec2update(spec: RichMessageSpec): NonNullable<InteractResponse["update"]> {
  const out: NonNullable<InteractResponse["update"]> = {};
  if (spec.text !== undefined) out.message = spec.text;
  if (spec.attachments && spec.attachments.length > 0) {
    // attachments here are already in RichAttachment shape which is a structural
    // superset of Mattermost's native attachments; MM ignores fields it doesn't know.
    out.props = { attachments: spec.attachments };
  } else {
    out.props = { attachments: [] };
  }
  return out;
}

function plainUpdate(text: string): NonNullable<InteractResponse["update"]> {
  return { message: text, props: { attachments: [] } };
}

export async function handleInteract(
  req: InteractRequest,
  ctx: HandlerContext,
): Promise<InteractResponse> {
  const { actionId, context, channelId, userId, username } = req;

  // -------------------------------------------------------------------------
  // Stop button
  if (actionId === ACTION_IDS.stop) {
    const targetChannel = String(context.channelId ?? channelId);
    const stopped = await ctx.sessionManager.stopSession(targetChannel);
    return {
      update: plainUpdate(L("⏹️ Task has been stopped.", "⏹️ 작업이 중지되었습니다.")),
      ...(stopped ? {} : { ephemeral_text: L("No active session.", "활성 세션이 없습니다.") }),
    };
  }

  // -------------------------------------------------------------------------
  // Approvals
  if (actionId === ACTION_IDS.approve || actionId === ACTION_IDS.deny || actionId === ACTION_IDS.approveAll) {
    const requestId = String(context.requestId ?? "");
    if (!requestId) return { ephemeral_text: "Invalid approval request." };

    const decision = actionId === ACTION_IDS.approve
      ? "approve"
      : actionId === ACTION_IDS.deny
        ? "deny"
        : "approve-all";
    const resolved = ctx.sessionManager.resolveApproval(requestId, decision);
    if (!resolved) {
      return { ephemeral_text: L("This approval request has expired.", "이 승인 요청은 만료되었습니다.") };
    }

    const labels: Record<string, string> = {
      approve: L("✅ Approved", "✅ 승인됨"),
      deny: L("❌ Denied", "❌ 거부됨"),
      "approve-all": L("⚡ Auto-approve enabled for this channel", "⚡ 이 채널에서 자동 승인이 활성화되었습니다"),
    };
    return { update: plainUpdate(labels[decision]) };
  }

  // -------------------------------------------------------------------------
  // AskUserQuestion — single-option button
  if (actionId === ACTION_IDS.askOption) {
    const requestId = String(context.requestId ?? "");
    const optionIndex = typeof context.optionIndex === "number" ? context.optionIndex : -1;
    if (!requestId || optionIndex < 0) {
      return { ephemeral_text: "Invalid option button." };
    }

    // We don't have the option label in context directly — but the action's `name`
    // is what was shown to the user, so Mattermost sends us back a meaningful answer
    // via the response wrapper. Simpler: pass the index back to session-manager as a
    // string reply; session-manager doesn't care about the specific shape, it just
    // forwards it to Claude.
    //
    // Problem: session-manager stores options[label] in the answers map keyed by
    // header. We need the label here. The build-site put the label in the button
    // `name`, which Mattermost echoes back in the callback request. So use that.

    // Newer MM versions echo it as `trigger_id` or `data_source`; but the most
    // reliable source is `context.optionLabel` which we can attach at build time.
    const label = typeof context.optionLabel === "string"
      ? context.optionLabel
      : `Option ${optionIndex + 1}`;

    const resolved = ctx.sessionManager.resolveQuestion(requestId, label);
    if (!resolved) {
      return { ephemeral_text: L("This question has expired.", "이 질문은 만료되었습니다.") };
    }
    return {
      update: plainUpdate(L(`✅ Selected: **${label}**`, `✅ 선택됨: **${label}**`)),
    };
  }

  // AskUserQuestion — custom text input
  if (actionId === ACTION_IDS.askOther) {
    const requestId = String(context.requestId ?? "");
    if (!requestId) return { ephemeral_text: "Invalid custom-input button." };
    ctx.sessionManager.enableCustomInput(requestId, channelId);
    return {
      update: plainUpdate(L("✏️ Type your answer in this channel...", "✏️ 이 채널에 답변을 입력하세요...")),
    };
  }

  // AskUserQuestion — multi-select
  if (actionId === ACTION_IDS.askSelect) {
    const requestId = String(context.requestId ?? "");
    if (!requestId) return { ephemeral_text: "Invalid select menu." };

    // Mattermost sends multi-select values as `selected_option`. The action
    // builder attaches `optionLabels` (map: value → label) at build time so we
    // can render a readable response.
    const labels = (context.optionLabels as Record<string, string> | undefined) ?? {};
    const selected = req.selectedOption ?? "";
    const answer = selected
      .split(",")
      .map((v) => v.trim())
      .map((v) => labels[v] ?? v)
      .filter(Boolean)
      .join(", ");

    const resolved = ctx.sessionManager.resolveQuestion(requestId, answer);
    if (!resolved) {
      return { ephemeral_text: L("This question has expired.", "이 질문은 만료되었습니다.") };
    }
    return {
      update: plainUpdate(L(`✅ Selected: **${answer}**`, `✅ 선택됨: **${answer}**`)),
    };
  }

  // -------------------------------------------------------------------------
  // Yes/No quick-reply — behaves exactly like a typed user reply
  if (actionId === ACTION_IDS.answerYes || actionId === ACTION_IDS.answerNo) {
    const targetChannel = String(context.channelId ?? channelId);
    const answerText = actionId === ACTION_IDS.answerYes ? "Yes" : "No";

    // Echo the choice as a visible quote so the transcript records it.
    await ctx.adapter.send(targetChannel, `> **${username}:** ${answerText}`).catch(() => {});

    if (ctx.sessionManager.isActive(targetChannel)) {
      const queued = ctx.sessionManager.enqueueDirect(targetChannel, answerText, userId);
      if (!queued) {
        await ctx.adapter.send(targetChannel, L(
          "⏳ Queue is full (max 5). Message not added.",
          "⏳ 큐가 가득 찼습니다 (최대 5개). 메시지를 추가하지 못했습니다.",
        )).catch(() => {});
      }
    } else {
      // Fire-and-forget — the session will stream into this channel on its own
      ctx.sessionManager.sendMessage(targetChannel, answerText, userId).catch((err) => {
        console.error("[answer] sendMessage error:", err);
      });
    }

    // Strip the yes/no buttons from the completed message by rewriting its
    // attachments to contain only the disabled "completed" button, matching
    // the look of a normally-completed session. Uses adapter so the native
    // MM attachment shape (with integration wrapper) is emitted correctly.
    if (req.postId) {
      ctx.adapter.edit(
        { channelId: targetChannel, messageId: req.postId },
        { attachments: [createCompletedButton()] },
      ).catch((e) => {
        console.warn(`[answer] Failed to strip buttons from post ${req.postId}:`, e instanceof Error ? e.message : e);
      });
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // Session resume / delete / cancel (from /sessions UI)
  if (actionId === ACTION_IDS.sessionResume) {
    const sessionId = String(context.sessionId ?? "");
    if (!sessionId) return { ephemeral_text: "Invalid session id." };
    upsertSession(randomUUID(), channelId, sessionId, "idle");
    return {
      update: spec2update({
        attachments: [{
          title: L("Session Resumed", "세션 재개됨"),
          text: L(
            `Session: \`${sessionId.slice(0, 8)}...\`\n\nNext message you send will resume this conversation.`,
            `세션: \`${sessionId.slice(0, 8)}...\`\n\n다음 메시지부터 이 대화가 재개됩니다.`,
          ),
          color: COLORS.success,
        }],
      }),
    };
  }

  if (actionId === ACTION_IDS.sessionCancel) {
    return { update: plainUpdate(L("Cancelled.", "취소되었습니다.")) };
  }

  if (actionId === ACTION_IDS.sessionDelete) {
    const sessionId = String(context.sessionId ?? "");
    if (!sessionId) return { ephemeral_text: "Invalid session id." };

    const project = getProject(channelId);
    if (!project) {
      return { update: plainUpdate(L("Project not found.", "프로젝트를 찾을 수 없습니다.")) };
    }

    // Lazy-require sessions command to avoid circular import at startup
    const { findSessionDir } = await import("../commands/sessions.js");
    const sessionDir = findSessionDir(project.project_path);
    if (!sessionDir) {
      return { update: plainUpdate(L("Session directory not found.", "세션 디렉토리를 찾을 수 없습니다.")) };
    }

    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
    try {
      fs.unlinkSync(filePath);
      const dbSession = getSession(channelId);
      if (dbSession?.session_id === sessionId) {
        upsertSession(randomUUID(), channelId, null, "idle");
      }
      return {
        update: spec2update({
          attachments: [{
            title: L("Session Deleted", "세션 삭제됨"),
            text: L(
              `Session \`${sessionId.slice(0, 8)}...\` has been deleted.\nYour next message will start a new conversation.`,
              `세션 \`${sessionId.slice(0, 8)}...\`이(가) 삭제되었습니다.\n다음 메시지부터 새로운 대화가 시작됩니다.`,
            ),
            color: COLORS.danger,
          }],
        }),
      };
    } catch {
      return { update: plainUpdate(L("Failed to delete session file.", "세션 파일 삭제에 실패했습니다.")) };
    }
  }

  // -------------------------------------------------------------------------
  // Queue management
  if (actionId === ACTION_IDS.queueYes) {
    const ch = String(context.channelId ?? channelId);
    const confirmed = ctx.sessionManager.confirmQueue(ch);
    if (!confirmed) {
      return { update: plainUpdate(L("⏳ Queue request has expired.", "⏳ 큐 요청이 만료되었습니다.")) };
    }
    const size = ctx.sessionManager.getQueueSize(ch);
    return {
      update: plainUpdate(L(
        `📨 Message added to queue (${size}/5). It will be processed after the current task.`,
        `📨 메시지가 큐에 추가되었습니다 (${size}/5). 이전 작업 완료 후 자동으로 처리됩니다.`,
      )),
    };
  }

  if (actionId === ACTION_IDS.queueNo) {
    const ch = String(context.channelId ?? channelId);
    ctx.sessionManager.cancelQueue(ch);
    return { update: plainUpdate(L("Cancelled.", "취소되었습니다.")) };
  }

  if (actionId === ACTION_IDS.queueClear) {
    const ch = String(context.channelId ?? channelId);
    const cleared = ctx.sessionManager.clearQueue(ch);
    return {
      update: spec2update({
        attachments: [{
          title: L("Queue Cleared", "큐 초기화됨"),
          text: L(`Cleared ${cleared} queued message(s).`, `${cleared}개의 대기 중이던 메시지를 취소했습니다.`),
          color: COLORS.warning,
        }],
      }),
    };
  }

  if (actionId === ACTION_IDS.queueRemove) {
    const ch = String(context.channelId ?? channelId);
    const index = typeof context.index === "number" ? context.index : -1;
    if (index < 0) return { ephemeral_text: "Invalid queue index." };

    const removed = ctx.sessionManager.removeFromQueue(ch, index);
    if (!removed) {
      return { update: plainUpdate(L("This item is no longer in the queue.", "이 항목은 이미 큐에 없습니다.")) };
    }

    const preview = removed.length > 60 ? removed.slice(0, 60) + "…" : removed;
    const queue = ctx.sessionManager.getQueue(ch);

    if (queue.length === 0) {
      return {
        update: spec2update({
          attachments: [{
            title: L("Message Removed", "메시지 취소됨"),
            text: L(`Removed: ${preview}\n\nQueue is now empty.`, `취소됨: ${preview}\n\n큐가 비었습니다.`),
            color: COLORS.warning,
          }],
        }),
      };
    }

    // Rebuild the queue UI with one-per-item remove buttons + a clear-all button.
    const list = queue
      .map((item, idx) => {
        const p = item.prompt.length > 100 ? item.prompt.slice(0, 100) + "…" : item.prompt;
        return `**${idx + 1}.** ${p}`;
      })
      .join("\n\n");

    const actions = queue.slice(0, 19).map((_, idx) => ({
      id: ACTION_IDS.queueRemove,
      name: `❌ ${idx + 1}`,
      type: "button" as const,
      style: "default" as const,
      context: { channelId: ch, index: idx },
    }));
    actions.push({
      id: ACTION_IDS.queueClear,
      name: L("Clear All", "모두 취소"),
      type: "button" as const,
      style: "danger" as const,
      context: { channelId: ch, index: -1 },
    });

    return {
      update: spec2update({
        attachments: [{
          title: L(`📋 Message Queue (${queue.length})`, `📋 메시지 큐 (${queue.length}개)`),
          text: `~~${preview}~~ ${L("removed", "취소됨")}\n\n${list}`,
          color: COLORS.info,
          actions,
        }],
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Unknown — ignore silently rather than surfacing a confusing error.
  console.warn(`[interact] unknown actionId: ${actionId}`);
  return {};
}

