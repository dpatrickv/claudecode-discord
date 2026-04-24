/**
 * Platform-neutral rich-message builders.
 *
 * Emits RichMessageSpec (see src/adapters/chat-adapter.ts), which concrete adapters
 * translate into native rich-message types (Mattermost attachments, Discord embeds, etc.).
 *
 * Action IDs are stable logical strings — ACTION_IDS object below is the canonical list.
 * Context payloads carry the data previously encoded into Discord's colon-delimited
 * customId (e.g. customId="approve:<uuid>" becomes {id: "approve", context: {requestId}}).
 */

import type { RichMessageSpec, RichAttachment, RichAction } from "../adapters/chat-adapter.js";
import { L } from "../utils/i18n.js";

/**
 * Canonical action-ID vocabulary. Handlers dispatch on these.
 * Kept centralized so the interact handler and the builders agree on spelling.
 */
export const ACTION_IDS = {
  stop: "stop",
  completed: "completed",
  approve: "approve",
  deny: "deny",
  // Mattermost v11+ router rejects action IDs containing hyphens — use camelCase only.
  approveAll: "approveAll",
  askOption: "askOpt",
  askOther: "askOther",
  askSelect: "askSelect",
  answerYes: "answerYes",
  answerNo: "answerNo",
  sessionResume: "sessionResume",
  sessionDelete: "sessionDelete",
  sessionCancel: "sessionCancel",
  sessionSelect: "sessionSelect",
  queueYes: "queueYes",
  queueNo: "queueNo",
  queueClear: "queueClear",
  queueRemove: "queueRemove",
} as const;

/** Platform-independent colour palette. Adapters interpret these hex strings natively. */
export const COLORS = {
  info: "#5865F2",     // blue
  success: "#00FF00",  // green
  warning: "#FFA500",  // orange
  danger: "#FF0000",   // red
  question: "#7C3AED", // purple
} as const;

/** Default chunk length cap; adapters may override when calling splitMessage(). */
const DEFAULT_MAX_LENGTH = 16383;

export function formatStreamChunk(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n" + L("... (truncated)", "... (잘림)");
}

/**
 * Split a long message at code-fence-safe boundaries. Preserves open code blocks
 * by closing them in chunk N and reopening in chunk N+1 with the same language.
 * maxLength is platform-dependent — pass the adapter's `maxMessageLength`.
 */
export function splitMessage(text: string, maxLength = DEFAULT_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Detect if we're splitting inside an unclosed code block
    const fenceRegex = /^```/gm;
    let insideBlock = false;
    let blockLang = "";
    let match;
    while ((match = fenceRegex.exec(chunk)) !== null) {
      if (insideBlock) {
        insideBlock = false;
        blockLang = "";
      } else {
        insideBlock = true;
        const lineEnd = chunk.indexOf("\n", match.index);
        blockLang = chunk.slice(match.index + 3, lineEnd === -1 ? undefined : lineEnd).trim();
      }
    }

    if (insideBlock) {
      // Close the code block in this chunk, reopen in the next
      chunk += "\n```";
      remaining = "```" + blockLang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Detect whether a completed assistant message ends with a yes/no question,
 * so the UI can attach Yes/No quick-reply buttons. Conservative heuristic —
 * only matches when the last sentence is a question AND starts with a modal
 * or is explicitly marked (y/n).
 */
export function detectYesNoQuestion(text: string): { isQuestion: boolean } {
  if (!text) return { isQuestion: false };
  const trimmed = text.trim();
  if (!trimmed.endsWith("?")) return { isQuestion: false };

  const match = trimmed.match(/[^.!?\n]*\?$/);
  if (!match) return { isQuestion: false };
  const question = match[0].trim();

  if (/\((?:y\/n|yes\/no)\)/i.test(question)) return { isQuestion: true };

  const clean = question.replace(/^[*_`>\-\s]+/, "").toLowerCase();
  const yesNoStarters = [
    "want ", "should ", "shall ", "do you", "does ", "did ",
    "can ", "could ", "will ", "would ", "may ", "might ",
    "is ", "are ", "was ", "were ", "has ", "have ", "had ",
    "ready ", "confirm", "proceed", "go ahead",
  ];
  return { isQuestion: yesNoStarters.some((s) => clean.startsWith(s)) };
}

/** Yes/No quick-reply buttons — attached to a completed assistant message when it ends with a yes/no question. */
export function createYesNoButtons(channelId: string): RichAttachment {
  return {
    actions: [
      {
        id: ACTION_IDS.answerYes,
        name: `✅  ${L("Yes", "예")}`,
        type: "button",
        style: "success",
        context: { channelId },
      },
      {
        id: ACTION_IDS.answerNo,
        name: `❌  ${L("No", "아니요")}`,
        type: "button",
        style: "danger",
        context: { channelId },
      },
    ],
  };
}

/** Stop button attachment — pair with any in-progress message. */
export function createStopButton(channelId: string): RichAttachment {
  return {
    actions: [{
      id: ACTION_IDS.stop,
      name: `⏹️  ${L("Stop", "중지")}`,
      type: "button",
      style: "danger",
      context: { channelId },
    }],
  };
}

/** Disabled "completed" button — replaces Stop once a session finishes. */
export function createCompletedButton(): RichAttachment {
  return {
    actions: [{
      id: ACTION_IDS.completed,
      name: `✅  ${L("Completed", "완료됨")}`,
      type: "button",
      style: "default",
      context: { disabled: true },
    }],
  };
}

/**
 * Tool-approval request. Shown to the user before Claude runs a non-read-only tool.
 * Buttons: Approve / Deny / Auto-approve-all.
 */
export function createToolApprovalSpec(
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
): RichMessageSpec {
  const attachment: RichAttachment = {
    title: L(`🔧 Tool Use: ${toolName}`, `🔧 도구 사용: ${toolName}`),
    color: COLORS.warning,
    fields: [],
  };

  if (toolName === "Edit" || toolName === "Write") {
    const filePath = (input.file_path as string) ?? "unknown";
    attachment.fields!.push({ title: L("File", "파일"), value: `\`${filePath}\`` });

    if (input.old_string && input.new_string) {
      const diff = `\`\`\`diff\n- ${String(input.old_string).slice(0, 500)}\n+ ${String(input.new_string).slice(0, 500)}\n\`\`\``;
      attachment.fields!.push({ title: L("Changes", "변경 사항"), value: diff });
    } else if (input.content) {
      const preview = String(input.content).slice(0, 500);
      attachment.fields!.push({
        title: L("Content Preview", "내용 미리보기"),
        value: `\`\`\`\n${preview}\n\`\`\``,
      });
    }
  } else if (toolName === "Bash") {
    const command = (input.command as string) ?? "unknown";
    const description = (input.description as string) ?? "";
    attachment.fields!.push({
      title: L("Command", "명령어"),
      value: `\`\`\`bash\n${command}\n\`\`\``,
    });
    if (description) {
      attachment.fields!.push({ title: L("Description", "설명"), value: description });
    }
  } else {
    const summary = JSON.stringify(input, null, 2);
    if (summary && summary !== "{}") {
      attachment.fields!.push({
        title: L("Input", "입력"),
        value: `\`\`\`json\n${summary.slice(0, 800)}\n\`\`\``,
      });
    }
  }

  attachment.actions = [
    {
      id: ACTION_IDS.approve,
      name: `✅  ${L("Approve", "승인")}`,
      type: "button",
      style: "success",
      context: { requestId },
    },
    {
      id: ACTION_IDS.deny,
      name: `❌  ${L("Deny", "거부")}`,
      type: "button",
      style: "danger",
      context: { requestId },
    },
    {
      id: ACTION_IDS.approveAll,
      name: `⚡  ${L("Auto-approve All", "모두 자동 승인")}`,
      type: "button",
      style: "default",
      context: { requestId },
    },
  ];

  return { attachments: [attachment] };
}

export interface AskQuestionData {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * AskUserQuestion tool UI. Emits either buttons (single-select) or a select menu (multi-select),
 * plus a "Custom input" button for free-text answers.
 */
export function createAskUserQuestionSpec(
  questionData: AskQuestionData,
  requestId: string,
  questionIndex: number,
  totalQuestions: number,
): RichMessageSpec {
  const title = totalQuestions > 1
    ? `❓ ${questionData.header} (${questionIndex + 1}/${totalQuestions})`
    : `❓ ${questionData.header}`;

  const attachment: RichAttachment = {
    title,
    text: questionData.question,
    color: COLORS.question,
    fields: questionData.options.map((opt) => ({
      title: opt.label,
      value: opt.description || "\u200b",
    })),
  };

  if (questionData.multiSelect) {
    attachment.actions = [
      {
        id: ACTION_IDS.askSelect,
        name: L("Select options...", "옵션을 선택하세요..."),
        type: "select",
        context: { requestId },
        options: questionData.options.map((opt, i) => ({
          text: opt.label.slice(0, 100),
          value: String(i),
        })),
      },
      {
        id: ACTION_IDS.askOther,
        name: `✏️  ${L("Custom input", "직접 입력")}`,
        type: "button",
        style: "default",
        context: { requestId },
      },
    ];
  } else {
    attachment.actions = questionData.options.map((opt, i): RichAction => ({
      id: ACTION_IDS.askOption,
      name: opt.label.slice(0, 80),
      type: "button",
      style: i === 0 ? "primary" : "default",
      context: { requestId, optionIndex: i },
    }));
    attachment.actions.push({
      id: ACTION_IDS.askOther,
      name: `✏️  ${L("Custom input", "직접 입력")}`,
      type: "button",
      style: "default",
      context: { requestId },
    });
  }

  return { attachments: [attachment] };
}

/** Final-result summary. Emitted when the Claude session completes a request. */
export function createResultSpec(
  result: string,
  costUsd: number,
  durationMs: number,
  showCost = true,
): RichMessageSpec {
  const duration = `${(durationMs / 1000).toFixed(1)}s`;
  const footer = showCost
    ? `${L("Cost (est.)", "비용 (추정)")}: $${costUsd.toFixed(4)}  |  ${L("Duration", "소요 시간")}: ${duration}`
    : `${L("Duration", "소요 시간")}: ${duration}`;

  return {
    attachments: [{
      title: L("✅ Task Complete", "✅ 작업 완료"),
      text: result.slice(0, 4000),
      color: COLORS.success,
      footer,
    }],
  };
}
