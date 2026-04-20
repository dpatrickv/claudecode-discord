import { z } from "zod";

const envSchema = z.object({
  /** Mattermost server base URL, e.g. https://mattermost.vanderhop.com (no trailing slash). */
  MATTERMOST_URL: z.string().url("MATTERMOST_URL must be a valid URL"),
  /** Personal access token for the bot user. System-admin role required for slash-command management. */
  MATTERMOST_TOKEN: z.string().min(1, "MATTERMOST_TOKEN is required"),
  /** Team ID the bot operates in. */
  MATTERMOST_TEAM_ID: z.string().min(1, "MATTERMOST_TEAM_ID is required"),
  /** Shared secret the bot validates on inbound webhook calls (slash commands, button callbacks). */
  MATTERMOST_WEBHOOK_TOKEN: z.string().min(1, "MATTERMOST_WEBHOOK_TOKEN is required"),
  /** Public URL Mattermost calls to reach the bot — e.g. http://10.0.2.244:9887. Used when registering slash commands. */
  BOT_PUBLIC_URL: z.string().url("BOT_PUBLIC_URL must be a valid URL"),
  /** Port the inbound HTTP server listens on. */
  HTTP_BIND_PORT: z.coerce.number().int().positive().default(9887),
  /** Comma-separated list of Mattermost user IDs allowed to talk to the bot. */
  ALLOWED_USER_IDS: z
    .string()
    .min(1, "ALLOWED_USER_IDS is required")
    .transform((v) => v.split(",").map((id) => id.trim())),
  BASE_PROJECT_DIR: z.string().min(1, "BASE_PROJECT_DIR is required"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  SHOW_COST: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Configuration error:\n${errors}`);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) return loadConfig();
  return _config;
}
