/**
 * 短期记忆增强：WAL + 当日 digest + 高信号 fast-path。
 * `enhanced`（默认）：当日内 RAM digest，普通轮次延迟入向量库；高信号即时入库。
 * `legacy`：保持原有每轮 turn_archive 行为。
 */

function envTruthy(raw: string | undefined, defaultOn = true): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return defaultOn;
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type ShortTermMemoryConfig = {
  mode: "enhanced" | "legacy";
  walEnabled: boolean;
  walDir: string;
  digestEnabled: boolean;
  digestFile: string;
  digestMaxChars: number;
  digestPromptMaxChars: number;
  digestTimezone: string;
  deferTurnArchive: boolean;
};

export function getShortTermMemoryConfig(): ShortTermMemoryConfig {
  const modeRaw = process.env.AGENT_SHORT_TERM_MEMORY?.trim().toLowerCase();
  const mode: "enhanced" | "legacy" = modeRaw === "legacy" ? "legacy" : "enhanced";

  return {
    mode,
    walEnabled: envTruthy(process.env.AGENT_TURN_WAL_ENABLED, mode === "enhanced"),
    walDir: process.env.AGENT_TURN_WAL_DIR?.trim() || "turn-wal",
    digestEnabled: envTruthy(process.env.AGENT_DAILY_DIGEST_ENABLED, mode === "enhanced"),
    digestFile: process.env.AGENT_DAILY_DIGEST_FILE?.trim() || "daily-digests.json",
    digestMaxChars: envPositiveInt(process.env.AGENT_DAILY_DIGEST_MAX_CHARS, 1000),
    digestPromptMaxChars: envPositiveInt(process.env.AGENT_DAILY_DIGEST_PROMPT_MAX_CHARS, 800),
    digestTimezone: process.env.AGENT_DAILY_DIGEST_TIMEZONE?.trim() || "Asia/Shanghai",
    deferTurnArchive: envTruthy(process.env.AGENT_DEFER_TURN_ARCHIVE, mode === "enhanced"),
  };
}

/** 按配置时区返回 YYYY-MM-DD */
export function getCalendarDay(date = new Date(), tz?: string): string {
  const zone = tz ?? getShortTermMemoryConfig().digestTimezone;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
