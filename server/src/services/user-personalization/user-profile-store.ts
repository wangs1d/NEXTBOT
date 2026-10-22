import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PROFILE_FILENAME = "USER_PROFILE.md";

function sanitizeActorId(actorId: string): string {
  const s = actorId.trim().slice(0, 128);
  return s.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

/** 默认模板自带的样板行（这些行不算「真实事实」） */
const TEMPLATE_BOILERPLATE_LINES = new Set([
  "（待了解：称呼、所在地、职业等）",
  "（待了解）",
  "（重要但不宜归类到以上的信息）",
  "回复偏好：精简直接，口语化，像身边熟人回话；少客服腔、少标题、少表格、少长解释",
]);

/* ──────────────────────────────────────────────────────────────
 * 确定性净噪器（2026-10-20）：画像「什么内容都往里写」的代码侧防线。
 * 纯规则、零 LLM，写入前统一生效；启动时另跑一次清存量坏行。
 * ────────────────────────────────────────────────────────────── */

const PROFILE_PLACEHOLDER_RE = /^（.*）$/;
/** 系统同步样板行（语气风格/回复偏好）：永不判噪声。
 *  注意「(会)?」：writer（profile-heuristics.syncPreferredToneInProfile）写的是
 *  「系统会根据对话自动调整」，默认模板是「系统根据对话自动调整」——2026-10-22
 *  修复三处文案漂移，判定统一容忍「会」。 */
const SYSTEM_SAMPLE_LINE_RE = /^(语气风格：.*（系统(?:会)?根据对话自动调整）|回复偏好：.*)$/;
/** section 标题 → 内部键（净噪时需要按 section 判定，如「基本信息」只收档案字段行） */
const SECTION_TITLE_TO_KEY: Record<string, string> = {
  "基本信息": "basic",
  "兴趣与习惯": "interest",
  "沟通偏好": "communication",
  "备注": "note",
};
const TEMPORAL_WINDOW_RE = /(近期|最近|目前|这几天|这周|本周|本月|这个月|下周|下个月|这周末)/;
const TEMPORAL_PLAN_RE = /(安排|行程|计划|出差|旅行|出行|去.{1,6}玩)/;
const FREQUENCY_OBSERVE_RE = /(频繁|反复|多次|时不时|来回切换|来回变|不断切换|不断变化|经常切换|经常更换)/;
const AGENT_META_PREFIX_RE = /^(会|经常|习惯|倾向|喜欢|乐于|擅长)/;
const AGENT_META_TARGET_RE = /(助手|agent|AI|记忆|你)/i;
/** 「会主动…/经常主动…」这类反复行为观察（如「会主动询问宠物相关信息」） */
const RECURRING_BEHAVIOR_RE = /^(会|经常|习惯|倾向|乐于|擅长|喜欢)(主动|不时|频繁|反复|多次|总会|都会|总是)/;
const UNCERTAIN_RE = /(可能|大概|也许|似乎|推测|没准|不确定|应该是)/;
const FIELD_LINE_RE = /^([^：:\s]{1,12})\s*[：:]\s*(.+)$/;

/**
 * 行内容是否属于「不该进画像」的噪声（确定性判定，不调 LLM）。
 * 判据（任一条命中即噪声）：
 *  - R1 疑问句（问号结尾 / 疑问词开头 / 吗|呢 结尾）
 *  - R2 「常用语言」等无权威字段行（不在结构化事实库字段表里、无消费方）
 *  - R3 临时行程/安排（时间窗词 × 安排类词）
 *  - R4 行为频率与变化的观察（如「旅游目的频繁切换」）
 *  - R5 对 Agent/助手/记忆的 meta 观察（如「会主动询问宠物相关信息」）
 *  - R6 不确定推断（可能/大概/也许/似乎…）
 *  - R7 档案字段行的值可疑（空、问句、待了解/未知、含频率或不确定词、超 40 字）
 *  - R8 基本信息 section 里非「字段：值」形态的长句（职业/所在地之外的细节不该塞进基本信息）
 * 白名单：系统样板行、占位行（占位行由 section 级规则裁决）永不判噪声。
 */
export function isNoisyProfileLine(content: string, section?: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (SYSTEM_SAMPLE_LINE_RE.test(t)) return false;
  if (PROFILE_PLACEHOLDER_RE.test(t)) return false;
  if (t.length > 60) return true;
  // R1 疑问句
  if (/[？?]\s*$/.test(t)) return true;
  if (/^(是否|多少|什么|怎么|为什么|哪一?个?|哪些|能不能|可不可以|有没有|要不要)/.test(t)) return true;
  if (/(吗|呢)[。！!]?$/.test(t)) return true;
  // R2 无权威字段行
  if (/^常用语言\s*[：:]/.test(t)) return true;
  // R3 临时行程/安排
  if (TEMPORAL_WINDOW_RE.test(t) && TEMPORAL_PLAN_RE.test(t)) return true;
  // R4 行为频率/变化观察
  if (FREQUENCY_OBSERVE_RE.test(t)) return true;
  // R5 Agent/meta 观察（对助手/记忆的观察，或「会主动…」式反复行为描述）
  if ((AGENT_META_PREFIX_RE.test(t) && AGENT_META_TARGET_RE.test(t)) || RECURRING_BEHAVIOR_RE.test(t)) return true;
  // R6 不确定推断
  if (UNCERTAIN_RE.test(t)) return true;
  // R7 档案字段值可疑
  const fieldMatch = FIELD_LINE_RE.exec(t);
  if (fieldMatch) {
    const value = fieldMatch[2]!.trim();
    if (!value || value.length > 40) return true;
    if (/^[?？]/.test(value)) return true;
    if (/待了解|未知|经常|频繁|大概|也许|似乎/.test(value)) return true;
  } else if (section === "basic" && !/^(用户|我)/.test(t)) {
    // R8 基本信息里非档案字段形态的细节句（猫粮口味、未定义名词的观察等）
    return true;
  }
  return false;
}

/**
 * 整文净噪（确定性、幂等）：删噪声行；某 section 已有真实行时删该 section 的占位行；
 * 标题、引用块、样板行保持不变。无变化时返回原字符串（调用方据 !== 决定是否写盘）。
 */
export function sanitizeProfileMarkdown(md: string): string {
  const source = md.replace(/\r\n/g, "\n");
  const lines = source.split("\n");

  // 第一遍：标记 section 归属 + 统计每个 section 是否已有真实行
  const sectionOf: Array<string | undefined> = new Array(lines.length);
  let current: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[i]!.trim());
    if (heading) {
      current = SECTION_TITLE_TO_KEY[heading[1]!];
      sectionOf[i] = undefined;
      continue;
    }
    if (/^#\s*/.test(lines[i]!.trim())) {
      current = undefined;
      sectionOf[i] = undefined;
      continue;
    }
    sectionOf[i] = current;
  }
  const sectionHasReal = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw.startsWith("- ")) continue;
    const content = raw.slice(2).trim();
    const key = sectionOf[i];
    if (!key) continue;
    if (PROFILE_PLACEHOLDER_RE.test(content)) continue;
    if (isNoisyProfileLine(content, key)) continue;
    sectionHasReal.add(key);
  }

  // 第二遍：按规则产出
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const raw = line.trim();
    const key = sectionOf[i];
    if (!raw.startsWith("- ")) {
      out.push(line);
      continue;
    }
    const content = raw.slice(2).trim();
    if (key) {
      if (PROFILE_PLACEHOLDER_RE.test(content) && sectionHasReal.has(key)) {
        changed = true; // 已有真实事实 → 占位行是残留，删掉
        continue;
      }
      if (isNoisyProfileLine(content, key)) {
        changed = true;
        continue;
      }
    }
    out.push(line);
  }
  if (!changed) return md;
  // 连续空行收敛成一行（删行后避免留大段空白）
  const compact: string[] = [];
  for (const line of out) {
    if (line.trim() === "" && compact.length > 0 && compact[compact.length - 1]!.trim() === "") continue;
    compact.push(line);
  }
  return compact.join("\n");
}

/**
 * 画像是否含有真实事实（非纯默认模板/系统样板）。
 * 判据：存在一条内容行不属于默认模板样板集——占位括号行与
 * 「语气风格：…（系统根据对话自动调整）」这类系统同步行也算样板。
 * 用于 prompt 注入闸：模板画像不注入，省 token 且不给 LLM 喂「待了解」噪声。
 */
export function hasRealProfileContent(profile: string): boolean {
  for (const raw of profile.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const content = line.slice(2).trim();
    if (!content) continue;
    if (TEMPLATE_BOILERPLATE_LINES.has(content)) continue;
    if (content.startsWith("（") && content.endsWith("）")) continue;
    if (/^语气风格：.*（系统(?:会)?根据对话自动调整）$/.test(content)) continue;
    return true;
  }
  return false;
}

export function defaultUserProfileMarkdown(actorId: string): string {
  const now = new Date().toISOString();
  return `# 用户画像

> 本文件由 Agent 在与你的对话中持续更新。最后更新：${now}
> 用户标识：\`${actorId}\`

## 基本信息

- （待了解：称呼、所在地、职业等）

## 兴趣与习惯

- （待了解）

## 沟通偏好

- 语气风格：自然均衡（系统根据对话自动调整）
- 回复偏好：精简直接，口语化，像身边熟人回话；少客服腔、少标题、少表格、少长解释

## 备注

- （重要但不宜归类到以上的信息）
`;
}

export class UserProfileStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir?.trim() ||
      process.env.AGENT_USER_PROFILE_DIR?.trim() ||
      join(process.cwd(), "data", "user_profiles");
  }

  profilePath(actorId: string): string {
    return join(this.baseDir, sanitizeActorId(actorId), PROFILE_FILENAME);
  }

  async read(actorId: string): Promise<string> {
    const path = this.profilePath(actorId);
    try {
      const raw = await readFile(path, "utf8");
      return raw.trim() || defaultUserProfileMarkdown(actorId);
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
      if (code === "ENOENT") return defaultUserProfileMarkdown(actorId);
      throw e;
    }
  }

  async write(actorId: string, content: string): Promise<void> {
    const path = this.profilePath(actorId);
    // 所有写入方共用同一不变式：落盘前过确定性净噪器（噪声行清掉、
    // 已有真实行时清占位行），避免"什么内容都往画像里写"。
    const clean = sanitizeProfileMarkdown(content.trim()).trim();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${clean}\n`, "utf8");
  }

  /** 列出已有画像文件的 actor（启动存量净噪用；目录名即 actor 目录名） */
  async listActorIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * 级联删除该 actor 的画像文件与待消费轮次队列（隐私闭环：
   * clearAllMemoryForActor 的其余记忆库都清了，画像目录此前会残留）。
   */
  async deleteAll(actorId: string): Promise<boolean> {
    const dir = dirname(this.profilePath(actorId));
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}
