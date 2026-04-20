/**
 * /usage — show Claude Code session / weekly / sonnet usage progress bars.
 * Reads credentials from ~/.claude/.credentials.json (or macOS keychain),
 * auto-refreshes the OAuth token if expired, hits the Anthropic OAuth usage
 * endpoint, and falls back to the cached copy on failure.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { L } from "../../utils/i18n.js";
import { COLORS } from "../../claude/output-formatter.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";

interface UsageEntry {
  utilization: number;
  resets_at: string;
}
interface UsageResponse {
  five_hour?: UsageEntry;
  seven_day?: UsageEntry;
  seven_day_sonnet?: UsageEntry;
  _fetched_at?: string;
}
interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

function progressBar(pct: number, width = 12): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatResetTime(isoStr: string): string {
  const resetDate = new Date(isoStr);
  const now = new Date();
  const diffMs = resetDate.getTime() - now.getTime();
  if (diffMs <= 0) return L("resetting soon", "곧 초기화");
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
  if (diffH > 0) return L(`${diffH}h ${diffM}m left`, `${diffH}시간 ${diffM}분 후 초기화`);
  return L(`${diffM}m left`, `${diffM}분 후 초기화`);
}

function readCredentials(): { cred: Credentials; source: "file" | "keychain" } | null {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const cred = JSON.parse(readFileSync(credPath, "utf-8")) as Credentials;
    if (cred?.claudeAiOauth?.accessToken) return { cred, source: "file" };
  } catch { /* not found */ }

  if (platform() === "darwin") {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const cred = JSON.parse(raw) as Credentials;
      if (cred?.claudeAiOauth?.accessToken) return { cred, source: "keychain" };
    } catch { /* keychain miss */ }
  }
  return null;
}

function isTokenExpired(cred: Credentials): boolean {
  const expiresAt = cred?.claudeAiOauth?.expiresAt ?? 0;
  return Date.now() >= expiresAt - 300_000;
}

async function refreshOAuthToken(cred: Credentials, source: "file" | "keychain"): Promise<string | null> {
  const refreshToken = cred?.claudeAiOauth?.refreshToken;
  if (!refreshToken) return null;

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });

    const res = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, unknown>;
    const newAccess = data.access_token as string;
    if (!newAccess) return null;

    const newRefresh = (data.refresh_token as string) ?? refreshToken;
    const expiresIn = (data.expires_in as number) ?? 3600;
    const newExpiresAt = Date.now() + expiresIn * 1000;

    if (source === "file") {
      try {
        const credPath = join(homedir(), ".claude", ".credentials.json");
        cred.claudeAiOauth!.accessToken = newAccess;
        cred.claudeAiOauth!.refreshToken = newRefresh;
        cred.claudeAiOauth!.expiresAt = newExpiresAt;
        writeFileSync(credPath, JSON.stringify(cred));
      } catch { /* ignore */ }
    }
    return newAccess;
  } catch {
    return null;
  }
}

async function fetchUsageLive(): Promise<UsageResponse | null> {
  const result = readCredentials();
  if (!result) return null;

  let { cred } = result;
  let token = cred?.claudeAiOauth?.accessToken;
  if (!token) return null;

  if (isTokenExpired(cred)) {
    const newToken = await refreshOAuthToken(cred, result.source);
    if (newToken) token = newToken;
  }

  try {
    let res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      const newToken = await refreshOAuthToken(cred, result.source);
      if (newToken) {
        res = await fetch("https://api.anthropic.com/api/oauth/usage", {
          headers: {
            Authorization: `Bearer ${newToken}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal: AbortSignal.timeout(10_000),
        });
      }
    }

    if (!res.ok) return null;
    const data = (await res.json()) as UsageResponse;

    try {
      const cachePath = join(homedir(), ".claude", ".usage-cache.json");
      const cache = { ...data, _fetched_at: new Date().toISOString() };
      writeFileSync(cachePath, JSON.stringify(cache));
    } catch { /* ignore */ }

    return data;
  } catch {
    return null;
  }
}

function loadUsageCache(): UsageResponse | null {
  try {
    const cachePath = join(homedir(), ".claude", ".usage-cache.json");
    return JSON.parse(readFileSync(cachePath, "utf-8")) as UsageResponse;
  } catch {
    return null;
  }
}

export const command: CommandModule = {
  name: "usage",
  description: "Show Claude Code usage (Session 5hr / Weekly / Sonnet)",
  autoCompleteHint: "",
  autoCompleteDesc: "",

  async execute(_req: SlashRequest): Promise<SlashResponse> {
    const data = (await fetchUsageLive()) ?? loadUsageCache();

    if (!data || (!data.five_hour && !data.seven_day && !data.seven_day_sonnet)) {
      return {
        response_type: "ephemeral",
        text: L(
          "Could not fetch usage data. Make sure you're logged into Claude Code (`claude` CLI).",
          "사용량 정보를 가져올 수 없습니다. Claude Code(`claude` CLI)에 로그인되어 있는지 확인하세요.",
        ),
      };
    }

    const lines: string[] = [];
    if (data.five_hour) {
      const pct = Math.round(data.five_hour.utilization);
      lines.push(`**${L("Session (5hr)", "세션 (5시간)")}**  \`${progressBar(pct)}\`  **${pct}%**  ·  ${formatResetTime(data.five_hour.resets_at)}`);
    }
    if (data.seven_day) {
      const pct = Math.round(data.seven_day.utilization);
      lines.push(`**${L("Weekly (7day)", "주간 (7일)")}**  \`${progressBar(pct)}\`  **${pct}%**  ·  ${formatResetTime(data.seven_day.resets_at)}`);
    }
    if (data.seven_day_sonnet) {
      const pct = Math.round(data.seven_day_sonnet.utilization);
      lines.push(`**${L("Sonnet (7day)", "소네트 (7일)")}**  \`${progressBar(pct)}\`  **${pct}%**  ·  ${formatResetTime(data.seven_day_sonnet.resets_at)}`);
    }

    let footerText = "claude.ai/settings/usage";
    if (data._fetched_at) {
      const fetchedDate = new Date(data._fetched_at);
      const diffMin = Math.floor((Date.now() - fetchedDate.getTime()) / 60_000);
      if (diffMin < 1) footerText = L("Just now", "방금 갱신") + "  ·  " + footerText;
      else footerText = L(`${diffMin}m ago`, `${diffMin}분 전 갱신`) + "  ·  " + footerText;
    }

    return {
      response_type: "ephemeral",
      attachments: [{
        title: L("📊 Claude Code Usage", "📊 Claude Code 사용량"),
        text: lines.join("\n\n"),
        color: COLORS.question,
        footer: footerText,
      }],
    };
  },
};
