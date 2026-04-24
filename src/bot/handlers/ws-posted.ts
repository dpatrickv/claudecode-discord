/**
 * Handler for Mattermost WebSocket `posted` events — the Mattermost analog of
 * Discord's `messageCreate`. Filters bot/system posts, enforces the user allowlist
 * and rate limit, handles attachments, and dispatches user prompts to the
 * SessionManager (either directly or via the queue-confirmation UX).
 *
 * Attachment download uses Mattermost's file API (Client4.getFileRoute + auth)
 * rather than Discord's pre-signed URLs — otherwise behaviour is identical to
 * the Discord version: images and documents downloaded into
 * <project>/.claude-uploads/, dangerous executables blocked, 25 MB cap.
 */

import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getProject } from "../../db/database.js";
import { isAllowedUser, checkRateLimit } from "../../security/guard.js";
import { L } from "../../utils/i18n.js";
import { ACTION_IDS } from "../../claude/output-formatter.js";
import type { HandlerContext } from "../types.js";
import type { PostedEvent } from "../mattermost-client.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".scr", ".pif",
  ".dll", ".sys", ".drv",
  ".vbs", ".vbe", ".wsf", ".wsh",
]);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — matches Discord bot for parity

interface FileMeta {
  id: string;
  name: string;
  size: number;
  extension?: string;
}

async function downloadFile(
  file: FileMeta,
  projectPath: string,
  ctx: HandlerContext,
): Promise<{ filePath: string; isImage: boolean } | { skipped: string } | null> {
  const ext = ("." + (file.extension ?? path.extname(file.name).replace(/^\./, ""))).toLowerCase();

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { skipped: L(`Blocked: \`${file.name}\` (dangerous file type)`, `차단됨: \`${file.name}\` (위험한 파일 형식)`) };
  }
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    return { skipped: L(`Skipped: \`${file.name}\` (${sizeMB}MB exceeds 25MB limit)`, `건너뜀: \`${file.name}\` (${sizeMB}MB, 25MB 제한 초과)`) };
  }

  const uploadDir = path.join(projectPath, ".claude-uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const fileName = `${Date.now()}-${file.name}`;
  const filePath = path.join(uploadDir, fileName);

  try {
    // Client4.getFileRoute already returns the full absolute URL
    // (e.g. "https://host/api/v4/files/<id>"), so do NOT prefix getUrl()
    // again — that builds a doubled-up URL and fetch() fails with a generic
    // "fetch failed" (DNS lookup on hostname+https://host).
    const client = ctx.client as unknown as {
      getFileRoute: (id: string) => string;
      getToken: () => string;
    };
    const url = client.getFileRoute(file.id);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${client.getToken()}` },
    });
    if (!response.ok || !response.body) {
      return { skipped: L(`Failed to download: \`${file.name}\``, `다운로드 실패: \`${file.name}\``) };
    }
    const stream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(response.body as any), stream);
  } catch (e) {
    console.warn(`[download] Failed to download file ${file.name}:`, e instanceof Error ? e.message : e);
    return { skipped: L(`Failed to download: \`${file.name}\``, `다운로드 실패: \`${file.name}\``) };
  }

  return { filePath, isImage: IMAGE_EXTENSIONS.has(ext) };
}

export async function handlePosted(event: PostedEvent, ctx: HandlerContext): Promise<void> {
  const post = event.post;

  // Ignore system posts, bot's own posts, and DMs to channels we're not managing
  if (!post || post.user_id === ctx.botUserId) return;
  if (post.type && post.type !== "" && post.type !== "slack_attachment") {
    // Non-empty type indicates system event (channel_join, etc.) — skip
    return;
  }

  const project = getProject(post.channel_id);
  if (!project) return; // unregistered channel

  if (!isAllowedUser(post.user_id)) {
    await ctx.adapter.send(
      post.channel_id,
      L("You are not authorized to use this bot.", "이 봇을 사용할 권한이 없습니다."),
    ).catch(() => {});
    return;
  }

  if (!checkRateLimit(post.user_id)) {
    await ctx.adapter.send(
      post.channel_id,
      L("Rate limit exceeded. Please wait a moment.", "요청 한도를 초과했습니다. 잠시 후 다시 시도하세요."),
    ).catch(() => {});
    return;
  }

  // Pending AskUserQuestion "custom input" — bare text reply resolves the prompt
  if (ctx.sessionManager.hasPendingCustomInput(post.channel_id)) {
    const text = post.message.trim();
    if (text) {
      ctx.sessionManager.resolveCustomInput(post.channel_id, text);
      await ctx.adapter.react(
        { channelId: post.channel_id, messageId: post.id },
        "white_check_mark",
      ).catch(() => {});
    }
    return;
  }

  let prompt = post.message.trim();

  // Attachments: Mattermost puts file IDs on post.file_ids and metadata at post.metadata.files
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const skipped: string[] = [];
  const files = post.metadata?.files ?? [];

  for (const f of files) {
    const result = await downloadFile(
      { id: f.id, name: f.name, size: f.size, extension: f.extension },
      project.project_path,
      ctx,
    );
    if (!result) continue;
    if ("skipped" in result) {
      skipped.push(result.skipped);
      continue;
    }
    if (result.isImage) imagePaths.push(result.filePath);
    else filePaths.push(result.filePath);
  }

  if (skipped.length > 0) {
    await ctx.adapter.send(post.channel_id, skipped.join("\n")).catch(() => {});
  }

  if (imagePaths.length > 0) {
    prompt += `\n\n[Attached images - use Read tool to view these files]\n${imagePaths.join("\n")}`;
  }
  if (filePaths.length > 0) {
    prompt += `\n\n[Attached files - use Read tool to read these files]\n${filePaths.join("\n")}`;
  }

  if (!prompt) return;

  // Session active? Offer queue-or-cancel confirmation instead of stepping on the in-flight work.
  if (ctx.sessionManager.isActive(post.channel_id)) {
    if (ctx.sessionManager.hasQueue(post.channel_id)) {
      await ctx.adapter.send(
        post.channel_id,
        L(
          "⏳ A message is already waiting to be queued. Please press the button first.",
          "⏳ 이미 큐 추가 대기 중인 메시지가 있습니다. 버튼을 먼저 눌러주세요.",
        ),
      ).catch(() => {});
      return;
    }
    if (ctx.sessionManager.isQueueFull(post.channel_id)) {
      await ctx.adapter.send(
        post.channel_id,
        L(
          "⏳ Queue is full (max 5). Please wait for the current task to finish.",
          "⏳ 큐가 가득 찼습니다 (최대 5개). 현재 작업 완료를 기다려주세요.",
        ),
      ).catch(() => {});
      return;
    }

    ctx.sessionManager.setPendingQueue(post.channel_id, prompt, post.user_id);

    await ctx.adapter.send(post.channel_id, {
      text: L(
        "⏳ A previous task is in progress. Process this automatically when done?",
        "⏳ 이전 작업이 진행 중입니다. 완료 후 자동으로 처리할까요?",
      ),
      attachments: [{
        actions: [
          {
            id: ACTION_IDS.queueYes,
            name: `✅  ${L("Add to Queue", "큐에 추가")}`,
            type: "button",
            style: "success",
            context: { channelId: post.channel_id },
          },
          {
            id: ACTION_IDS.queueNo,
            name: `❌  ${L("Cancel", "취소")}`,
            type: "button",
            style: "default",
            context: { channelId: post.channel_id },
          },
        ],
      }],
    }).catch(() => {});
    return;
  }

  // Dispatch to Claude.
  await ctx.sessionManager.sendMessage(post.channel_id, prompt, post.user_id);
}
