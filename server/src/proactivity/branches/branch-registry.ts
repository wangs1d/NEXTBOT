// 树枝注册表（BranchRegistry）—— 可插拔的声明与用户配置面（Phase 1→3）。
//
// 「加一个信息源」从改代码变成注册一份 manifest + 用户配置启停。
// 用户配置落 data/proactivity/branches.json（缺省全启用、精简缺省关）；
// 缺配置/坏配置一律回落内置默认（零配置启动门禁铁律：缺配置不许 throw）。
//
// ingest() 是树枝上报管道的统一入口（Phase 2 三段式编排）：
//   树枝启用？→ L1 确定性闸 → L2 游标去重 → L3 精简（配置开才花 LLM，模板兜底）
//   → BranchSignal 交主动性板块。原文不进管道（留在树枝权威库）。
import { getDataDir } from "../../config/data-dir.js";
import { readJson, writeJson } from "../persist-file.js";
import { join } from "node:path";
import type { BranchManifest, BranchSignal } from "./branch-types.js";
import type { BranchCondenser } from "./branch-condenser.js";
import { BranchGate } from "./branch-gate.js";
import { BranchCursor } from "./branch-cursor.js";

/** 内置树枝清单：Phase 1 先注册四根（message 的闸走现役 delegate，其余为声明占位） */
export const BUILTIN_BRANCHES: BranchManifest[] = [
  {
    id: "message",
    stream: "message",
    mode: "streaming",
    label: "消息（微信/短信/站内）",
    gate: { delegate: () => ({ gated: false }) }, // 装配层注入 gateInboundMessage
  },
  {
    id: "mail",
    stream: "mail",
    mode: "streaming",
    label: "邮件（IMAP 轮询）",
    gate: { strongNoise: "(验证码|校验码|取件码|回复TD|退订回[T]|中奖|贷款|催收|额度(申请|提升|已满))", commercialDensity: 2 },
  },
  {
    id: "schedule_upload",
    stream: "schedule",
    mode: "upload",
    label: "上传课表/行程表",
    gate: { passthrough: true },
  },
  {
    id: "file",
    stream: "file",
    mode: "streaming",
    label: "文件目录监听",
    gate: { passthrough: true },
  },
];

type PersistedBranchEntry = { enabled?: boolean; condense?: boolean; dailyBudget?: number };
type PersistedBranchConfig = Record<string, PersistedBranchEntry>;

export type BranchUserConfig = { enabled: boolean; condense: boolean; dailyBudget: number };

export type BranchRegistryDeps = {
  configPath?: string;
  /** L2 游标持久化路径（缺省：configPath 同目录的 branch-cursors.json） */
  cursorPath?: string;
};

export type BranchIngestInput = {
  text: string;
  /** L2 游标指纹（与内容语义对齐：消息=actor|channel|摘要；上传=actor|源名|条目集） */
  fingerprint: string;
  meta?: Record<string, unknown>;
  /** LLM 精简的会话隔离键 */
  sessionId?: string;
  payload?: Record<string, unknown>;
};

export type BranchIngestResult =
  | { allowed: false; stage: "L1" | "L2"; reason: string }
  | { allowed: true; signal: BranchSignal; condensed: boolean };

export class BranchRegistry {
  private readonly manifests = new Map<string, BranchManifest>();
  private readonly config: PersistedBranchConfig;
  private condenser: BranchCondenser | null = null;

  constructor(private readonly deps: BranchRegistryDeps = {}) {
    for (const m of BUILTIN_BRANCHES) this.manifests.set(m.id, { ...m, gate: { ...m.gate } });
    this.config = readJson<PersistedBranchConfig>(deps.configPath ?? "", {});
  }

  /** 装配层注入闸策略（如 message 树枝接 gateInboundMessage），不改变声明身份 */
  attachGatePolicy(id: string, gate: Partial<BranchManifest["gate"]>): void {
    const m = this.manifests.get(id);
    if (!m) return;
    this.manifests.set(id, { ...m, gate: { ...m.gate, ...gate } });
  }

  /** 装配层注入 L3 精简器（晚绑定：bootstrap 运行期构造后挂入） */
  attachCondenser(condenser: BranchCondenser | null): void {
    this.condenser = condenser;
  }

  register(manifest: BranchManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  get(id: string): BranchManifest | null {
    return this.manifests.get(id) ?? null;
  }

  list(): Array<BranchManifest & { enabled: boolean }> {
    return [...this.manifests.values()].map((m) => ({ ...m, enabled: this.isEnabled(m.id) }));
  }

  isEnabled(id: string): boolean {
    return this.config[id]?.enabled !== false;
  }

  /** 用户的树枝配置（enabled/condense/dailyBudget，缺省：开/关/20） */
  getConfig(id: string): BranchUserConfig {
    const e = this.config[id] ?? {};
    return {
      enabled: e.enabled !== false,
      condense: e.condense === true,
      dailyBudget: Number.isFinite(e.dailyBudget) && (e.dailyBudget as number) > 0 ? (e.dailyBudget as number) : 20,
    };
  }

  /** 用户动态配置（配置面调用；写穿落盘） */
  setConfig(id: string, patch: { enabled?: boolean; condense?: boolean; dailyBudget?: number }): void {
    if (!this.manifests.has(id)) return;
    const prev = this.config[id] ?? {};
    this.config[id] = { ...prev };
    if (patch.enabled !== undefined) this.config[id]!.enabled = patch.enabled;
    if (patch.condense !== undefined) this.config[id]!.condense = patch.condense;
    if (patch.dailyBudget !== undefined && Number.isFinite(patch.dailyBudget) && patch.dailyBudget > 0) {
      this.config[id]!.dailyBudget = Math.round(patch.dailyBudget);
    }
    if (this.deps.configPath) writeJson(this.deps.configPath, this.config);
  }

  /** 兼容旧调用点：仅启停 */
  setEnabled(id: string, enabled: boolean): void {
    this.setConfig(id, { enabled });
  }

  /**
   * 树枝上报统一入口（三段式）：L1 确定性闸 → L2 游标去重 → L3 精简。
   * 树枝停用直接拒（stage=L1, reason=branch_disabled）；闸/Gate 异常按"挡下"处理
   * （宁漏不误：上报是增益路径，坏状态不许污染管道）。L3 任何失败由精简器内部
   * 回退模板，本层不再兜底。
   */
  async ingest(branchId: string, input: BranchIngestInput): Promise<BranchIngestResult | null> {
    const manifest = this.manifests.get(branchId);
    if (!manifest) return null;
    if (!this.isEnabled(branchId)) {
      return { allowed: false, stage: "L1", reason: "branch_disabled" };
    }
    const blocked = this.runGate(branchId, input);
    if (blocked) return blocked;

    const at = Date.now();
    const condenseOn = this.getConfig(branchId).condense;
    if (condenseOn && this.condenser) {
      const signal = await this.condenser.condense({
        stream: manifest.stream,
        branchId,
        sessionId: input.sessionId ?? branchId,
        fingerprint: input.fingerprint,
        text: input.text,
        at,
        payload: input.payload,
      });
      return { allowed: true, signal, condensed: this.condenser.stats().lastUsedLlm };
    }
    const signal = this.condenser?.templateSignal({
      stream: manifest.stream,
      at,
      fingerprint: input.fingerprint,
      text: input.text,
      payload: input.payload,
    }) ?? {
      stream: manifest.stream,
      at,
      fingerprint: input.fingerprint,
      salience: "medium" as const,
      delta: String(input.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      payload: input.payload ?? {},
    };
    return { allowed: true, signal, condensed: false };
  }

  /** L1+L2（BranchGate 持有游标，按树枝惰性缓存）。返回非 null = 被挡下（直接作为 ingest 结果） */
  private readonly gates = new Map<string, BranchGate>();
  private runGate(branchId: string, input: { text: string; fingerprint: string; meta?: Record<string, unknown> }): { allowed: false; stage: "L1" | "L2"; reason: string } | null {
    try {
      let gate = this.gates.get(branchId);
      if (!gate) {
        const cursorPath =
          this.deps.cursorPath ??
          (this.deps.configPath
            ? this.deps.configPath.replace(/[^\\/]+$/, "branch-cursors.json")
            : join(getDataDir(), "proactivity", "branch-cursors.json"));
        gate = new BranchGate({
          manifest: this.manifests.get(branchId)!,
          cursor: new BranchCursor({ persistPath: cursorPath }),
        });
        this.gates.set(branchId, gate);
      }
      const v = gate.admit(input);
      return v.allowed ? null : { allowed: false, stage: v.stage, reason: v.reason ?? "gated" };
    } catch {
      return { allowed: false, stage: "L1", reason: "gate_error" };
    }
  }
}
