// DiscoveryLayer —— 共享发现层（2026-10-19，架构收口）。
//
// 病根：四套存储（SourceStore 传感原料 / WorldBoard 整理后的"现在" / GoalBoard 长期目标 /
// 会话拆步）+ 三个出口（arbiterV2.admit / proactivityHub.submitIntent /
// proactivePipeline.submitProposal），彼此没有共同键。源数一旦从 3 涨到 N，
// "谁读到谁"的连线数就按 N² 涨——于是邮件说"提到搬家"、GoalRunner 说"搬家卡在第 3 步
// 等确认"，两句话谁也读不到对方，同一个目标被两层各说一遍。
//
// 修法（不是补丁，是架构）：
//  1. **一条总线 = SourceStore，不新建存储**。发现作为 `finding` 条目进同一条流，
//     白拿指纹去重、按天分区、实体倒排 findByEntity、保留期与 LRU。
//  2. **共同键 = subject**（目标用 goalId；其余用主体词），三源天然汇聚。
//  3. **"联系"由 findByEntity 自然产生**：findByEntity("搬家") 同时命中邮件里提到搬家和
//     GoalRunner 说卡在第 3 步——不需要任何两两耦合。
//  4. **单开口闸 = composeBeforeOpen**：任何出口在开口前读同 subject 的未消费 finding +
//     实体命中上下文，零 LLM 模板拼接进正文，并把读过的发现标记为已消费。于是同一发现
//     不会被两个出口各说一遍，"重复降档"从"另加一条规则"变成"发现已被读走"的副作用。
//
// 边界：零 LLM；不新建存储；不动执行边界（launchTask / TaskHub 终态回调），执行仍由
// 既有链路负责，本层只管"发现怎么汇总、开口前读什么"。
import type { ProactiveImportance } from "./pipeline-types.js";
import { downgradeImportanceForRepeat, isCrossSourceRepeat } from "./goal-signal-bridge.js";
import type { DiscoveryFinding, SourceStore } from "./source-store.js";

/** 开口前读合成时的来源标签（把流名说成人话，正文里可读） */
const STREAM_LABEL: Record<string, string> = {
  mail: "邮件",
  schedule: "日历",
  message: "消息",
  finance: "账单",
  weather: "天气",
  shopping: "购物",
  location: "位置",
  screen: "屏幕",
  conversation: "对话",
  rhythm: "节律",
  file: "文件",
  goal: "目标",
  interest: "兴趣",
};

/** 主体词候选：连续汉字 2-6 字 / 拉丁-数字 ≥3 字符 */
const SUBJECT_RE = /[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z0-9]{2,}/g;
/** 主体词停用（这些词当共同键毫无区分度，会把不相干的事绑到一起） */
const SUBJECT_STOP = new Set([
  "用户", "今天", "明天", "本周", "这周", "我的", "帮你", "帮忙", "一下", "现在", "已经",
  "消息", "提醒", "通知", "建议", "要不要", "可以", "需要", "正在", "目前",
]);
/** 主体词前缀噪声（"邮件提到三亚" 的主体词是「三亚」，不是「邮件提到三亚」） */
const SUBJECT_NOISE_PREFIX_RE =
  /^(?:邮件|消息|收到|来自|提到|关于|提醒|需要|发现|正在|已经|今天|明天|本周|这周|我的|帮你|帮忙|用户|计划|目标|要不要|有个|一个)+/;

/** 一次发现写入（缺 subject 时由 content 推主体词；推不出则不落账） */
export type DiscoveryWrite = {
  subject?: string;
  actorId?: string;
  /** 产出者标识（也是 composeBeforeOpen 里判定"是不是自己那句"的键） */
  source: string;
  content: string;
  at?: number;
  ttlMs?: number;
  entities?: string[];
};

/** 开口前读合成的入参 */
export type ComposeOpenInput<T extends ProactiveImportance> = {
  /** 共同键（缺省由 body 推主体词；推不出则跳过 finding 合并，只做实体联系） */
  subject?: string;
  /** 本次开口的产出者标识：同源的 finding 不再重复拼进正文（它就是要说的那句话本身） */
  ownSource?: string;
  actorId?: string;
  body: string;
  importance: T;
  /** 是否在请用户拍板（是则不参与重复降档——用户是阻塞点，价值不由"刚不刚说过"决定） */
  needsUser?: boolean;
  /** 显式实体词（缺省由 body 分词） */
  entities?: string[];
  /** 实体联系条数上限（缺省 2） */
  linkLimit?: number;
};

/** 开口前读合成的结果 */
export type ComposeOpenResult<T extends ProactiveImportance> = {
  /** 合成后的正文（零 LLM 模板拼接） */
  body: string;
  /** 合成后的等级（重复开口 + 非 needsUser → 降一档；否则原样） */
  importance: T;
  /** 实际使用的共同键（空串 = 没有共同键，本次只做了实体联系） */
  subject: string;
  /** 本次是不是"同一 subject 窗口内重复开口" */
  repeat: boolean;
  /** 被合并进来的他人发现（诊断/对比用） */
  merged: Array<{ source: string; content: string }>;
  /** 被合并进来的跨源实体联系（诊断/对比用） */
  linked: string[];
  /**
   * 本次读到的 finding 指纹。**没有立即消费**——消费发生在"真的说出口"之后
   * （noteSpoken）。语义差异很重要：被频控/静默挡下的开口等于没说，
   * 它登记过的发现应当留在总线上，让下一个出口顺带说出来，而不是人间蒸发。
   */
  pendingFingerprints: string[];
};

/** 已真正说出去的仲裁结论（这些 verdict 之后才消费发现；被抑制的不消费） */
const SPOKEN_VERDICTS = new Set(["delivered", "deferred", "merged"]);

/** 开口时刻记账（目标侧接 GoalBoard.lastOpenedAt 以保跨重启语义；其余留在内存） */
export type OpenMarkStore = {
  lastOpenedAt(subject: string): number | undefined;
  markOpened(subject: string, at: number): void;
};

export type DiscoveryLayerDeps = {
  store: SourceStore;
  /** 目标侧开口记账（可选）：接上后 goalId 的"上次开口"跨重启仍有效 */
  goalOpens?: OpenMarkStore;
  nowFn?: () => number;
};

export class DiscoveryLayer {
  private readonly nowFn: () => number;
  /** 非目标 subject 的开口时刻（内存记账：跨源重复判定只在同进程内才有意义） */
  private readonly openedAt = new Map<string, number>();

  constructor(private readonly deps: DiscoveryLayerDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
  }

  /** 登记一条发现（同 subject 未消费的同内容幂等）。返回是否落账 */
  write(input: DiscoveryWrite): boolean {
    const subject = (input.subject ?? primarySubjectOf(input.content) ?? "").trim();
    if (!subject) return false;
    return (
      this.deps.store.noteFinding({
        subject,
        source: input.source,
        content: input.content,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.at !== undefined ? { at: input.at } : {}),
        ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        ...(input.entities?.length ? { entities: input.entities } : {}),
      }) !== null
    );
  }

  /** 读某 subject 未消费的发现（三源互读的唯一入口） */
  findingsFor(subject: string, opts: { actorId?: string } = {}): DiscoveryFinding[] {
    return this.deps.store.unconsumedFindings(subject, opts);
  }

  /** 跨源实体联系：给定实体词，一次拿到**所有来源**里提到它的条目 */
  linksFor(entity: string, limit = 3): Array<{ stream: string; text: string }> {
    return this.deps.store
      .findByEntity(entity, { limit })
      .filter((h) => h.stream !== "finding")
      .map((h) => ({ stream: h.stream, text: (h.delta ?? h.entity).slice(0, 60) }));
  }

  /**
   * 单开口闸：开口前读合成。
   *
   * 顺序很关键：调用方**先 write 自己的发现，再 compose**——这样别的源刚登记的发现
   * 会被这一次开口一并带走（读走即标记，下一个出口不会再说一遍）。
   *
   * 合成是纯模板：正文 + "（另：邮件提到 X；日历提到 Y）"，不经过任何模型。
   */
  composeBeforeOpen<T extends ProactiveImportance>(input: ComposeOpenInput<T>): ComposeOpenResult<T> {
    const now = this.nowFn();
    const base = String(input.body ?? "");
    const subject = (input.subject ?? primarySubjectOf(base) ?? "").trim();
    const entities = input.entities?.length ? input.entities : entitiesOf(base);

    // 汇总口径（共享发现层的核心）：**共同键 + 实体词**两条路一起走。
    //  - 同 subject：目标三源天然汇聚（goalId 一致）；
    //  - 实体命中：跨键联系（邮件的 subject 是「房东」、目标是 goalId，靠「搬家」相遇）。
    const gathered = new Map<string, DiscoveryFinding>();
    if (subject) {
      for (const f of this.deps.store.unconsumedFindings(subject, input.actorId ? { actorId: input.actorId } : {})) {
        gathered.set(f.fingerprint, f);
      }
    }
    for (const entity of entities.slice(0, 4)) {
      for (const f of this.deps.store.findingsByEntity(entity, { limit: 3 })) {
        if (this.deps.store.isFindingConsumed(f.fingerprint)) continue;
        if (f.at + f.ttlMs <= now) continue;
        if (!gathered.has(f.fingerprint)) gathered.set(f.fingerprint, f);
      }
    }
    const findings = [...gathered.values()];

    // 他人发现：同源的（自己那句本身）不重复拼；正文里已有的也不重复拼；并入条数设上限
    const merged: Array<{ source: string; content: string }> = [];
    const mergeLimit = input.linkLimit ?? 2;
    for (const f of findings) {
      if (merged.length >= mergeLimit) break;
      if (input.ownSource && f.source === input.ownSource) continue;
      if (base.includes(f.content)) continue;
      merged.push({ source: f.source, content: f.content });
    }

    // 实体联系：正文里出现的实体词，去别的流查"还有谁提过它"
    const linked: string[] = [];
    const limit = input.linkLimit ?? 2;
    for (const entity of (input.entities?.length ? input.entities : entitiesOf(base)).slice(0, 4)) {
      if (linked.length >= limit) break;
      for (const hit of this.linksFor(entity, 2)) {
        const line = `${STREAM_LABEL[hit.stream] ?? hit.stream}提到「${hit.text}」`;
        if (base.includes(line) || linked.includes(line) || merged.some((m) => m.content.includes(hit.text))) continue;
        linked.push(line);
        if (linked.length >= limit) break;
      }
    }

    const extras = [
      ...merged.map((m) => `${STREAM_LABEL[labelOfSource(m.source)] ?? m.source}：${m.content}`),
      ...linked,
    ];
    const body = extras.length ? `${base}\n（另：${extras.join("；")}）` : base;

    // 重复开口判定：该 subject 刚被说过 + 这次不是请用户拍板 → 降一档
    const lastOpenedAt = this.lastOpenedAt(subject);
    const repeat = subject ? isCrossSourceRepeat(lastOpenedAt, now) : false;
    if (subject) this.markOpened(subject, now);
    // 收窄断言安全：降档只沿阶梯向下走一格（critical→high→medium→low），绝不升档
    const importance = (repeat && !input.needsUser
      ? downgradeImportanceForRepeat(input.importance, { needsUser: false })
      : input.importance) as T;

    // 消费推迟到"真的说出口"（noteSpoken）：被抑制的开口不该把发现一起吞掉
    return { body, importance, subject, repeat, merged, linked, pendingFingerprints: findings.map((f) => f.fingerprint) };
  }

  /**
   * 开口真的说出口之后调用：把这次读到的发现标记为已消费（下一个出口不再重复说）。
   * 仲裁结论是被抑制/静默/过期/丢弃时不调用——那些开口等于没说，发现留在总线上。
   */
  noteSpoken(fingerprints: string[], verdict: string, at = this.nowFn()): number {
    if (!SPOKEN_VERDICTS.has(verdict)) return 0;
    return this.deps.store.consumeFindings(fingerprints, at);
  }

  /** 某 subject 上次开口时刻（外部记账优先，保证 goalId 跨重启语义） */
  lastOpenedAt(subject: string): number | undefined {
    const key = String(subject ?? "").trim();
    if (!key) return undefined;
    const ext = this.deps.goalOpens?.lastOpenedAt(key);
    const own = this.openedAt.get(key);
    if (ext === undefined) return own;
    if (own === undefined) return ext;
    return Math.max(ext, own);
  }

  private markOpened(subject: string, at: number): void {
    this.openedAt.set(subject, at);
    this.deps.goalOpens?.markOpened(subject, at);
  }

  /** 台账快照（诊断面板：与 SourceStore.stats().findings 同源，另附 subject 数） */
  stats(): { subjects: number; pending: number; consumed: number; openedSubjects: number } {
    return { ...this.deps.store.findingStats(), openedSubjects: this.openedAt.size };
  }
}

/** 产出者标识 → 流名（`hub:email` → `email`；`sensor_bridge` → `sensor_bridge`） */
function labelOfSource(source: string): string {
  const s = String(source ?? "");
  const idx = s.indexOf(":");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/**
 * 主体词推断（零 LLM）：正文里最"像实体"的词，就是这件事的共同键。
 *
 * 启发式口径：剥掉"邮件/提到/关于"这类前缀噪声后，**优先 2 字汉字**（中文实体
 * 普遍是双字：三亚 / 搬家 / 机票 / 房东），4 字以内才收，超长的一律判为句子碎片
 * 直接丢弃。丢弃是有意为之：没有共同键时只做实体联系（findByEntity 会把"谁还提过
 * 这件事"自然串起来），比给一个假键（让不相干的事被强行合并）安全得多。
 *
 * 所以调用方**能给 subject 就给**（邮件 subject 字段、目标 goalId 都是精确键），
 * 推断只兜底。
 */
export function primarySubjectOf(text: string): string | null {
  const runs = String(text ?? "").match(SUBJECT_RE) ?? [];
  const cands = runs
    .map(cleanSubjectRun)
    // 汉字只收 2-4 字：更长的一定是句子碎片（"搬家要提前"/"一周预约电梯"），
    // 拿它当共同键会把不相干的事绑到一起——宁可不给键（退回实体联系），
    // 也不给一个假键。拉丁/数字串（review / iphone15）按原样收。
    .filter((r) => (isCjk(r) ? r.length >= 2 && r.length <= 4 : r.length >= 3) && !SUBJECT_STOP.has(r));
  if (cands.length === 0) return null;
  // 汉字优先、短的优先（中文实体普遍 2 字："三亚"/"搬家"/"机票"）；拉丁串排后
  cands.sort((a, b) => Number(isCjk(b)) - Number(isCjk(a)) || a.length - b.length);
  return cands[0];
}

/** 剥前缀噪声（"邮件提到三亚" → "三亚"；剥不动则原样返回） */
function cleanSubjectRun(run: string): string {
  let r = run.trim();
  for (let i = 0; i < 3; i++) {
    const next = r.replace(SUBJECT_NOISE_PREFIX_RE, "");
    if (next === r || next.length === 1) break;
    r = next;
  }
  return r;
}

function isCjk(s: string): boolean {
  return /^[\u4e00-\u9fa5]/.test(s);
}

/** 正文实体词（与 SourceStore 倒排同源纪律：汉字 2 字滑窗 + 拉丁整词） */
export function entitiesOf(text: string): string[] {
  const out = new Set<string>();
  for (const run of String(text ?? "").match(/[\u4e00-\u9fa5]{2,}|[A-Za-z][A-Za-z0-9]{2,}/g) ?? []) {
    if (/^[A-Za-z]/.test(run)) {
      out.add(run.toLowerCase());
      continue;
    }
    if (run.length <= 2) {
      out.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].filter((t) => !SUBJECT_STOP.has(t));
}
