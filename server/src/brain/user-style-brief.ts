/**
 * 用户风格浅层摘要（UserStyleBrief，2026-10-23 画像架构优化）。
 *
 * 定位：**画像的浅层影响面**。主对话走 prompt-assembler 全量注入；但 agent
 * "开口"的旁路（主动话术润色、通话开场、推送文案）此前用的是通用人设——
 * 私人管家了解用户之后，说的每句话在细节上都该有区分度。
 *
 * 本模块从画像栈（UserProfileAggregator.readProfile）**确定性投影**一份
 * ≤N 行的风格摘要（称呼/所在地/职业/沟通偏好…画像文本靠前的 basic 段），
 * 供旁路生成点以极低 token 成本携带。不做 LLM、不建第二套画像——
 * 投影是画像权威源的只读视图，画像更新后 TTL 内自然刷新。
 *
 * 设计约束：
 *   - 浅层：maxLines/maxChars 双上限，旁路 prompt 只增几十 token；
 *   - 宁缺勿错：画像为空返回 null，调用方回退无画像行为（不编造）；
 *   - TTL 缓存：画像更新有延迟容忍（风格区分不需要秒级新鲜）。
 */
export type UserStyleBriefDeps = {
  /** 画像全文读取（注入 UserProfileAggregator.readProfile；测试可注入 fake） */
  readProfile: (actorId: string) => Promise<string>;
  /** 缓存 TTL（毫秒），缺省 5 分钟 */
  ttlMs?: number;
  /** 最多携带的画像行数，缺省 6 */
  maxLines?: number;
  /** 总字符上限，缺省 320 */
  maxChars?: number;
  now?: () => number;
};

export type UserStyleBriefReader = (sessionId: string) => Promise<string | null>;

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_LINES = 6;
const DEFAULT_MAX_CHARS = 320;
/** 单行截断（画像行过长时压行，风格摘要不需要整段） */
const LINE_MAX_CHARS = 60;

/** 画像段头/装饰行（不入摘要） */
const SECTION_HEADER_RE = /^【.*】$|^[=—-]{3,}$/;

export function createUserStyleBrief(deps: UserStyleBriefDeps): UserStyleBriefReader {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxLines = deps.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { brief: string | null; at: number }>();

  function project(profileText: string): string | null {
    const lines: string[] = [];
    let total = 0;
    for (const raw of profileText.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || SECTION_HEADER_RE.test(line)) continue;
      const clipped = line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
      if (total + clipped.length > maxChars) break;
      lines.push(clipped);
      total += clipped.length;
      if (lines.length >= maxLines) break;
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  return async function getUserStyleBrief(sessionId: string): Promise<string | null> {
    const key = sessionId;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.brief;
    let brief: string | null = null;
    try {
      const profile = (await deps.readProfile(key)) ?? "";
      brief = project(profile);
    } catch {
      brief = null; // 画像读取失败不阻塞旁路生成，回退无画像
    }
    cache.set(key, { brief, at: now() });
    return brief;
  };
}
