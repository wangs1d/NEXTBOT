import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getRuntimeConfig } from "../config/env.js";

/**
 * 同一「配对码」下的 session 视为同一协作组；与 `AGENT_RELAY_REQUIRE_PAIR` 联用时限制中继仅组内互通。
 * 配对关系可持久化到 JSON（默认 `data/agent-pairing.json`，可用 `AGENT_PAIRING_FILE` 覆盖）。
 */
export class AgentPairingService {
  private readonly sessionToCode = new Map<string, string>();

  private get persistPath(): string {
    return process.env.AGENT_PAIRING_FILE ?? join(getDataDir(), "agent-pairing.json");
  }

  /** 启动时加载；文件不存在则保持空映射。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as { sessionToCode?: Record<string, string> };
      const o = data.sessionToCode ?? {};
      this.sessionToCode.clear();
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && v.length > 0) {
          this.sessionToCode.set(k, v);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  /** 在 join / leave 后调用以落盘。 */
  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const sessionToCode = Object.fromEntries(this.sessionToCode);
    const payload = JSON.stringify({ sessionToCode }, null, 2);
    await writeFile(this.persistPath, payload, "utf8");
  }

  /** 规范化：去空白、转大写，便于口头约定。 */
  normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  join(sessionId: string, rawCode: string): string {
    const code = this.normalizeCode(rawCode);
    if (!code) throw new Error("配对码不能为空");
    this.sessionToCode.set(sessionId, code);
    return code;
  }

  leave(sessionId: string): void {
    this.sessionToCode.delete(sessionId);
  }

  getCode(sessionId: string): string | undefined {
    return this.sessionToCode.get(sessionId);
  }

  /** 双方均已加入且为同一配对码。 */
  arePaired(a: string, b: string): boolean {
    const ca = this.sessionToCode.get(a);
    const cb = this.sessionToCode.get(b);
    return ca !== undefined && ca === cb;
  }
}

export function relayRequiresPairEnv(): boolean {
  return getRuntimeConfig().agentRelayRequirePair;
}
