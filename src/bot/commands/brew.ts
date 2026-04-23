/**
 * /brew — homelab brewing inventory & fermentation queries.
 *
 * Sub-commands:
 *   /brew search <query>   — search inventory (all categories) for an ingredient
 *   /brew stock            — list items at or below low-stock threshold
 *   /brew taps             — show current tap list from the taplist service
 *   /brew pour <tap> <oz>  — log a pour (auth required via MATTERMOST_WEBHOOK_TOKEN match)
 *   /brew <query>          — shorthand for /brew search <query>
 */

import { getConfig } from "../../utils/config.js";
import type { CommandModule, SlashRequest, SlashResponse } from "../types.js";
import { COLORS } from "../../claude/output-formatter.js";

async function jsonFetch(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

interface InventoryItem {
  id: number;
  name: string;
  category?: string;
  quantity_lbs?: number;
  quantity_oz?: number;
  quantity?: number;
  unit?: string;
  low_stock?: boolean;
  low_stock_lbs?: number;
  low_stock_oz?: number;
  descriptors?: string;
  alpha_acid?: number;
  style?: string;
  notes?: string;
}

interface TapEntry {
  tap_num: number;
  name?: string | null;
  style?: string | null;
  abv?: number | null;
  ibu?: number | null;
  pct_remaining?: number | null;
  empty?: boolean;
}

function formatInventoryItem(item: InventoryItem, cat: string): string {
  const parts: string[] = [];

  if (cat === "fermentables") {
    const qty = item.quantity_lbs != null
      ? `${item.quantity_lbs.toFixed(2)} lbs`
      : "—";
    parts.push(`**${item.name}** — ${qty}`);
    if (item.notes) parts.push(`_${item.notes}_`);
  } else if (cat === "hops") {
    const qty = item.quantity_oz != null
      ? `${item.quantity_oz.toFixed(1)} oz`
      : "—";
    const aa = item.alpha_acid != null ? ` · AA ${item.alpha_acid}%` : "";
    parts.push(`**${item.name}** — ${qty}${aa}`);
    if (item.descriptors) parts.push(`_${item.descriptors}_`);
  } else if (cat === "yeasts") {
    const qty = item.quantity != null ? `${item.quantity} pkg` : "—";
    parts.push(`**${item.name}** — ${qty}`);
    if (item.style) parts.push(`_${item.style}_`);
  } else {
    const qty = item.quantity_oz != null
      ? `${item.quantity_oz.toFixed(1)} oz`
      : item.quantity != null
      ? `${item.quantity} ${item.unit ?? "units"}`
      : "—";
    parts.push(`**${item.name}** — ${qty}`);
    if (item.notes) parts.push(`_${item.notes}_`);
  }

  return parts.join(" · ");
}

export const command: CommandModule = {
  name: "brew",
  description: "Search brewing inventory, check stock levels, and view tap list",
  autoCompleteHint: "[search|stock|taps|pour] [args...]",
  autoCompleteDesc: "e.g. /brew citra  or  /brew stock  or  /brew taps",

  async execute(req: SlashRequest): Promise<SlashResponse> {
    const cfg = getConfig();
    const invUrl  = cfg.BREW_INVENTORY_URL;
    const tapUrl  = cfg.TAPLIST_URL;

    const raw   = req.text.trim();
    const parts = raw.split(/\s+/);
    const sub   = parts[0]?.toLowerCase() ?? "";

    // ── /brew taps ─────────────────────────────────────────────────────────
    if (sub === "taps") {
      if (!tapUrl) return { response_type: "ephemeral", text: "TAPLIST_URL not configured." };
      let taps: TapEntry[];
      try {
        taps = await jsonFetch(`${tapUrl}/api/taps`) as TapEntry[];
      } catch (e) {
        return { response_type: "ephemeral", text: `Taplist error: ${(e as Error).message}` };
      }
      const lines = taps.map(t => {
        if (t.empty || !t.name) return `🪣 **Tap ${t.tap_num}** — _Empty_`;
        const abv = t.abv != null ? `ABV ${t.abv.toFixed(1)}%` : "";
        const ibu = t.ibu != null ? `IBU ${Math.round(t.ibu)}` : "";
        const keg = t.pct_remaining != null
          ? `${Math.round(t.pct_remaining * 100)}% remaining`
          : "";
        const badges = [abv, ibu, keg].filter(Boolean).join(" · ");
        const style  = t.style ? ` — _${t.style}_` : "";
        return `🍺 **Tap ${t.tap_num}: ${t.name}**${style}${badges ? `\n  ${badges}` : ""}`;
      });
      return {
        response_type: "in_channel",
        attachments: [{
          title: "🍻 Current Tap List",
          color: COLORS.success,
          text: lines.join("\n"),
        }],
      };
    }

    // ── /brew pour <tap_num> <oz> ──────────────────────────────────────────
    if (sub === "pour") {
      if (!tapUrl) return { response_type: "ephemeral", text: "TAPLIST_URL not configured." };
      const tapNum = parseInt(parts[1] ?? "", 10);
      const oz     = parseFloat(parts[2] ?? "");
      if (isNaN(tapNum) || isNaN(oz) || oz <= 0) {
        return { response_type: "ephemeral", text: "Usage: `/brew pour <tap_num> <oz>`\nExample: `/brew pour 3 16`" };
      }
      try {
        const result = await fetch(`${tapUrl}/api/taps/${tapNum}/pour`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": cfg.MATTERMOST_WEBHOOK_TOKEN,
          },
          body: JSON.stringify({ oz }),
          signal: AbortSignal.timeout(5000),
        });
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
        const tap = await result.json() as TapEntry;
        const pct = tap.pct_remaining != null
          ? ` · ${Math.round(tap.pct_remaining * 100)}% remaining`
          : "";
        return {
          response_type: "in_channel",
          text: `🍺 Logged **${oz}oz** from Tap ${tapNum} (${tap.name ?? "Unknown"})${pct}`,
        };
      } catch (e) {
        return { response_type: "ephemeral", text: `Pour log error: ${(e as Error).message}` };
      }
    }

    // ── /brew stock ────────────────────────────────────────────────────────
    if (sub === "stock") {
      if (!invUrl) return { response_type: "ephemeral", text: "BREW_INVENTORY_URL not configured." };
      let items: InventoryItem[];
      try {
        items = await jsonFetch(`${invUrl}/api/low_stock`) as InventoryItem[];
      } catch (e) {
        return { response_type: "ephemeral", text: `Inventory error: ${(e as Error).message}` };
      }
      if (!items.length) {
        return { response_type: "ephemeral", text: "✅ All ingredients are above low-stock thresholds." };
      }
      const grouped: Record<string, InventoryItem[]> = {};
      for (const item of items) {
        const cat = (item.category ?? "other");
        (grouped[cat] ??= []).push(item);
      }
      const fields = Object.entries(grouped).map(([cat, catItems]) => ({
        title: cat.charAt(0).toUpperCase() + cat.slice(1),
        value: catItems.map(it => formatInventoryItem(it, cat)).join("\n"),
        short: false,
      }));
      return {
        response_type: "ephemeral",
        attachments: [{
          title: `⚠️ Low Stock (${items.length} item${items.length !== 1 ? "s" : ""})`,
          color: COLORS.warning ?? "#e8a020",
          fields,
        }],
      };
    }

    // ── /brew search <query>  or  /brew <query> (shorthand) ───────────────
    const query = sub === "search" ? parts.slice(1).join(" ") : raw;
    if (!query) {
      return {
        response_type: "ephemeral",
        text: [
          "**Usage:**",
          "`/brew <ingredient>` — search inventory",
          "`/brew stock` — items at/below low-stock threshold",
          "`/brew taps` — current tap list",
          "`/brew pour <tap> <oz>` — log a pour",
        ].join("\n"),
      };
    }
    if (!invUrl) return { response_type: "ephemeral", text: "BREW_INVENTORY_URL not configured." };
    let results: Array<{ category: string; items: InventoryItem[] }>;
    try {
      results = await jsonFetch(
        `${invUrl}/api/inventory?q=${encodeURIComponent(query)}`
      ) as Array<{ category: string; items: InventoryItem[] }>;
    } catch (e) {
      return { response_type: "ephemeral", text: `Inventory error: ${(e as Error).message}` };
    }
    const allItems = results.flatMap(r => r.items.map(it => ({ ...it, category: r.category })));
    if (!allItems.length) {
      return { response_type: "ephemeral", text: `No inventory results for **${query}**` };
    }
    const grouped: Record<string, InventoryItem[]> = {};
    for (const item of allItems) {
      const cat = item.category ?? "other";
      (grouped[cat] ??= []).push(item);
    }
    const fields = Object.entries(grouped).map(([cat, catItems]) => ({
      title: cat.charAt(0).toUpperCase() + cat.slice(1),
      value: catItems.slice(0, 8).map(it => formatInventoryItem(it, cat)).join("\n"),
      short: false,
    }));
    return {
      response_type: "ephemeral",
      attachments: [{
        title: `🔍 Inventory: "${query}" (${allItems.length} result${allItems.length !== 1 ? "s" : ""})`,
        color: COLORS.info ?? "#4ecdc4",
        fields,
      }],
    };
  },
};
