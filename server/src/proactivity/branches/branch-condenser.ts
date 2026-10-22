// 树枝精简器（BranchCondenser）—— 闸的三段式里的 L3（2026-10-22 Phase 2）。
//
// 架构语义（用户定调）：闸不只是放行——「对内容做大致了解，然后总结上报到管道」。
// 过了 L1（确定性闸）+ L2（游标增量）的内容，由本器压缩成 BranchSignal（delta +
// salience + entities）再上报主动性板块；原文留在树枝权威库不进管道（不丢失原文，
// agent 要原文走工具回查——token 可控的根基）。
//
// 用量纪律（对齐 SpeechPolisher，LLM 只花在刀刃上）：
//  - 按树枝配置开关（branches.json condense 字段，缺省关——LLM 成本是 O(源数×消息量)）
//  - 每日调用熔断（BRANCH_MAX_CONDENSE_PER_DAY，默认 20）
//  - 8s 超时 / 任何失败 / 输出异常 → 确定性模板兜底（上报永不因 LLM 失败而中断）
//  - BRANCH_CONDENSE_LLM=0 一键关闭（全模板模式）
//  - 模型钉位：BRANCH_CONDENSE_MODEL > PROACTIVITY_MODEL > provider 默认
//
// 设计红线：本器是入站信号处理器，只加工"要上报的内容"；绝不碰对话正文与已流式
// 输出（出口闸铁律）。
import { createHash } from "node:crypto";

import type { ExternalChatProvider } from "../../external-model/types.js";
import type { BranchSignal } from "./branch-types.js";

const SYSTEM_PROMPT = `你是信息流的精简器。输入一段刚到达的原始内容，输出 JSON（不要 markdown 代码块、不要解释）：
{"delta":"一句话摘要，≤60字，保留人名/时间/金额/事件等硬信息","salience":"low|medium|high","entities":["出现的实体词"]}
salience 判定：需要用户马上知道=high；有用但不急=medium；背景噪声=low。拿不准就往低调。`;

const SIGNAL_MAX = 300;

export type BranchCondenserDeps = {
  /** 外部模型（晚绑定；null/未启用 = 全模板模式） */
  chat: () => ExternalChatProvider | null;
  /** 测试注入 */
  nowFn?: () => number;
  timeoutMs?: number;
};

export type CondenseStats = { llmEnabled: boolean; callsToday: number; cap: number; lastUsedLlm: boolean; lastFallback?: string };

export class BranchCondenser {
  private readonly nowFn: () => number;
  private readonly timeoutMs: number;
  private readonly cap: number;
  private callsDate = "";
  private callsToday = 0;
  private lastFallback?: string;
  /** 最近一次 condense 是否真用了 LLM（registry 标记 condensed 用，防跨调用误读 lastFallback） */
  private lastUsedLlm = false;

  constructor(private readonly deps: BranchCondenserDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 8_000;
    const raw = process.env.BRANCH_MAX_CONDENSE_PER_DAY;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    this.cap = Number.isFinite(n) && n > 0 ? n : 20;
  }

  /** LLM 精简是否可用（kill switch / provider / 熔断） */
  isEnabled(): boolean {
    if (process.env.BRANCH_CONDENSE_LLM === "0") return false;
    if (this.callsToday >= this.cap) return false;
    return this.deps.chat()?.isEnabled() === true;
  }

  stats(): CondenseStats {
    return {
      llmEnabled: this.isEnabled(),
      callsToday: this.callsToday,
      cap: this.cap,
      lastUsedLlm: this.lastUsedLlm,
      ...(this.lastFallback ? { lastFallback: this.lastFallback } : {}),
    };
  }

  /**
   * 确定性模板信号（零 LLM 兜底，也是熔断/关闭时的唯一路径）。
   * delta 取正文截断；salience 由调用方按树枝语义给（缺省 medium 不丢信息）。
   */
  templateSignal(input: { stream: string; at: number; fingerprint: string; text: string; salience?: BranchSignal["salience"]; payload?: Record<string, unknown> }): BranchSignal {
    return {
      stream: input.stream,
      at: input.at,
      fingerprint: input.fingerprint,
      salience: input.salience ?? "medium",
      delta: input.text.replace(/\s+/g, " ").trim().slice(0, 80),
      payload: input.payload ?? {},
    };
  }

  /**
   * L3 精简：过闸内容 → 压缩视图 BranchSignal。任何失败都回退模板（调用方无需处理失败）。
   * fingerprint 由调用方给（与 L2 游标共用同一指纹），LLM 结果不参与指纹。
   */
  async condense(input: {
    stream: string;
    branchId: string;
    sessionId: string;
    fingerprint: string;
    text: string;
    at: number;
    payload?: Record<string, unknown>;
  }): Promise<BranchSignal> {
    const fallback = () =>
      this.templateSignal({
        stream: input.stream,
        at: input.at,
        fingerprint: input.fingerprint,
        text: input.text,
        payload: input.payload,
      });
    if (!this.isEnabled()) {
      this.lastUsedLlm = false;
      this.lastFallback = process.env.BRANCH_CONDENSE_LLM === "0" ? "kill_switch" : "cap_or_no_provider";
      return fallback();
    }
    const text = String(input.text ?? "").trim();
    if (text.length === 0 || text.length > 4000) {
      this.lastUsedLlm = false;
      return fallback();
    }

    const chat = this.deps.chat();
    if (!chat) {
      this.lastUsedLlm = false;
      return fallback();
    }
    const userPrompt = `来源树枝：${input.branchId}\n原始内容：\n${text}`;
    try {
      let full = "";
      await this.withTimeout(
        chat.streamCompletion(
          `branch_condense:${input.branchId}:${input.fingerprint}`,
          { text: userPrompt },
          (delta: string) => {
            full += delta;
          },
          undefined,
          {
            systemPromptOverride: SYSTEM_PROMPT,
            ephemeralTurn: true,
            disableThinking: true,
            maxThreadMessages: 0,
            auditStage: "branch_condense",
            ...(process.env.BRANCH_CONDENSE_MODEL
              ? { modelOverride: process.env.BRANCH_CONDENSE_MODEL }
              : process.env.PROACTIVITY_MODEL
                ? { modelOverride: process.env.PROACTIVITY_MODEL }
                : {}),
          },
        ),
      );
      this.bumpCounter();
      const parsed = parseSignalJson(full);
      if (!parsed || parsed.delta.length === 0 || parsed.delta.length > SIGNAL_MAX) {
        this.lastUsedLlm = false;
        this.lastFallback = "bad_output";
        return fallback();
      }
      this.lastUsedLlm = true;
      return {
        stream: input.stream,
        at: input.at,
        fingerprint: input.fingerprint,
        salience: parsed.salience,
        delta: parsed.delta,
        payload: input.payload ?? {},
        ...(parsed.entities.length > 0 ? { entities: parsed.entities } : {}),
      };
    } catch (err) {
      this.lastUsedLlm = false;
      this.lastFallback = `error:${String(err).slice(0, 60)}`;
      return fallback();
    }
  }

  /** 内容指纹（L2 游标去重键；调用方也可自带语义指纹如 msg:actor:channel:摘要） */
  fingerprintOf(seed: string): string {
    return createHash("sha1").update(seed).digest("hex").slice(0, 16);
  }

  private bumpCounter(): void {
    const day = new Date(this.nowFn()).toISOString().slice(0, 10);
    if (day !== this.callsDate) {
      this.callsDate = day;
      this.callsToday = 0;
    }
    this.callsToday += 1;
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error("condense_timeout")), this.timeoutMs)),
    ]);
  }
}

/** 宽容 JSON 解析：剥 markdown 代码围栏 / 截第一个 {...} 块 */
function parseSignalJson(raw: string): { delta: string; salience: BranchSignal["salience"]; entities: string[] } | null {
  try {
    let s = String(raw ?? "").trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const delta = String(obj.delta ?? "").trim();
    const salienceRaw = String(obj.salience ?? "medium").toLowerCase();
    const salience: BranchSignal["salience"] =
      salienceRaw === "high" || salienceRaw === "low" ? salienceRaw : "medium";
    const entities = Array.isArray(obj.entities) ? obj.entities.map((e) => String(e).trim()).filter(Boolean).slice(0, 8) : [];
    return { delta, salience, entities };
  } catch {
    return null;
  }
}
