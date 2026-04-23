/**
 * /bf-status — Brewfather active batch status + live iSpindel readings.
 *
 * Shows all currently Fermenting / Conditioning batches from Brewfather,
 * paired with live iSpindel gravity/temp if the relay is reachable.
 */

import { getConfig } from "../../utils/config.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";
import { COLORS } from "../../claude/output-formatter.js";

async function jsonFetch(url: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Parse Prometheus text-format iSpindel metrics into a device → readings map. */
function parsePrometheus(text: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const m = line.match(/ispindel_(\w+)\{device="([^"]+)"\}\s+([\d.eE+\-]+)/);
    if (!m) continue;
    const [, metric, device, valueStr] = m;
    if (!out[device]) out[device] = {};
    out[device][metric] = parseFloat(valueStr);
  }
  return out;
}

interface BFBatch {
  _id?: string;
  id?: string;
  name?: string;
  batchNo?: number;
  status?: string;
  brewDate?: number;
  fermentationStartDate?: number;
  measuredAbv?: number;
  estimatedAbv?: number;
  measuredGravity?: number;
  estimatedOg?: number;
  recipe?: { name?: string; style?: { name?: string } | string };
}

export const command: CommandModule = {
  name: "bf-status",
  description: "Show active Brewfather fermentation batches with live iSpindel readings",
  autoCompleteHint: "",
  autoCompleteDesc: "",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const cfg = getConfig();

    if (!cfg.BF_USER_ID || !cfg.BF_API_KEY) {
      return {
        response_type: "ephemeral",
        text: "Brewfather credentials (BF_USER_ID / BF_API_KEY) not configured.",
      };
    }

    const creds = Buffer.from(`${cfg.BF_USER_ID}:${cfg.BF_API_KEY}`).toString("base64");
    const authHeader = { Authorization: `Basic ${creds}` };

    // Fetch active batches and iSpindel readings concurrently
    const [batchResult, ispindelResult] = await Promise.allSettled([
      jsonFetch(
        "https://api.brewfather.app/v2/batches?status=Fermenting,Conditioning&limit=20",
        { headers: authHeader }
      ) as Promise<BFBatch[]>,
      cfg.ISPINDEL_URL
        ? fetch(`${cfg.ISPINDEL_URL}/metrics`, { signal: AbortSignal.timeout(3000) })
            .then(r => r.ok ? r.text() : "")
        : Promise.resolve(""),
    ]);

    if (batchResult.status === "rejected") {
      return {
        response_type: "ephemeral",
        text: `Brewfather error: ${batchResult.reason}`,
      };
    }

    const batches = batchResult.value ?? [];
    const rawMetrics = ispindelResult.status === "fulfilled" ? ispindelResult.value as string : "";
    const ispindel  = rawMetrics ? parsePrometheus(rawMetrics) : {};
    const ispindelDevices = Object.keys(ispindel);

    if (!batches.length && !ispindelDevices.length) {
      return {
        response_type: "ephemeral",
        text: "No active batches in Brewfather and no iSpindel devices reporting.",
      };
    }

    const fields = [];

    // ── Brewfather batches ──────────────────────────────────────────────────
    for (const b of batches) {
      const name     = b.name ?? b.recipe?.name ?? "Unknown";
      const status   = b.status ?? "";
      const batchNum = b.batchNo ? `#${b.batchNo}` : "";
      const style    = typeof b.recipe?.style === "object"
        ? b.recipe.style?.name ?? ""
        : b.recipe?.style ?? "";

      // Days since brew
      const startTs = b.fermentationStartDate ?? b.brewDate;
      const days    = startTs ? Math.floor((Date.now() - startTs) / 86400000) : null;
      const dayStr  = days !== null ? `Day ${days}` : "";

      const abv = b.measuredAbv ?? b.estimatedAbv;
      const grav = b.measuredGravity ?? b.estimatedOg;

      const lines = [
        `${batchNum ? `**${batchNum}** · ` : ""}**${name}**` + (style ? ` · _${style}_` : ""),
        `Status: **${status}**${dayStr ? ` · ${dayStr}` : ""}`,
      ];
      if (abv != null) lines.push(`ABV: ${abv.toFixed(1)}%`);
      if (grav != null) lines.push(`Gravity: ${grav.toFixed(4)}`);

      // Try to match an iSpindel device by name similarity
      const batchNameLower = name.toLowerCase();
      const matchedDevice = ispindelDevices.find(d =>
        batchNameLower.includes(d.toLowerCase()) ||
        d.toLowerCase().includes(batchNameLower.substring(0, 6))
      );
      if (matchedDevice) {
        const d = ispindel[matchedDevice];
        if (d.gravity != null)
          lines.push(`📡 **Live SG**: ${d.gravity.toFixed(4)} (${matchedDevice})`);
        if (d.temperature_fahrenheit != null)
          lines.push(`🌡️ **Temp**: ${d.temperature_fahrenheit.toFixed(1)}°F`);
      }

      const statusEmoji =
        status === "Fermenting"   ? "🫧" :
        status === "Conditioning" ? "⏳" :
        "🍺";

      fields.push({
        title: `${statusEmoji} ${name}`,
        value: lines.join("\n"),
        short: false,
      });
    }

    // ── iSpindel devices not matched to any batch ───────────────────────────
    const matchedDevices = new Set<string>();
    for (const b of batches) {
      const bname = (b.name ?? "").toLowerCase();
      for (const d of ispindelDevices) {
        if (bname.includes(d.toLowerCase()) || d.toLowerCase().includes(bname.substring(0, 6))) {
          matchedDevices.add(d);
        }
      }
    }
    const unmatchedDevices = ispindelDevices.filter(d => !matchedDevices.has(d));
    for (const device of unmatchedDevices) {
      const d   = ispindel[device];
      const now = Date.now() / 1000;
      const age = d.last_seen_timestamp
        ? Math.round((now - d.last_seen_timestamp) / 60)
        : null;
      if (age !== null && age > 120) continue; // skip stale (>2h) devices

      const lines: string[] = [];
      if (d.gravity != null)              lines.push(`SG: **${d.gravity.toFixed(4)}**`);
      if (d.temperature_fahrenheit != null) lines.push(`Temp: **${d.temperature_fahrenheit.toFixed(1)}°F**`);
      if (d.battery_volts != null)        lines.push(`Battery: ${d.battery_volts.toFixed(2)}V`);
      if (age !== null)                   lines.push(`Updated: ${age}m ago`);

      fields.push({
        title: `📡 ${device}`,
        value: lines.join(" · ") || "No readings",
        short: false,
      });
    }

    return {
      response_type: "ephemeral",
      attachments: [
        {
          title: `🍺 Brewery Status — ${batches.length} active batch${batches.length !== 1 ? "es" : ""}`,
          color: COLORS.info ?? "#4ecdc4",
          fields,
        },
      ],
    };
  },
};
