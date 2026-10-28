// Agent Body Center — BodyGateway（大脑→身体下行网关）
//
// 职责：
//  1. 反射弧拦截：execute 入口先过 ReflexArc.check(action)，命中 DENY_PATTERN 直接拒绝
//  2. 工具路由：按 action.tool 前缀路由到对应 BodyModule.act()
//  3. 兜底：未匹配的工具走 fallbackToolRegistry.execute（保留对未下沉工具的兼容）
//  4. 感官查询：sense(query) 按 query.module 路由到对应 BodyModule.sense()
//  5. 全量快照：snapshot() 返回各 BodyModule 快照 + 身体状态聚合
//
// 与 brain/action-executor.ts 的关系：
//  ActionExecutor.execute 改为委托 BodyGateway.execute(action)，不再直接 toolRegistry.execute。
//  BodyGateway 内部对 BrainDecisionAction 做反射弧 + 模块路由，未下沉工具 fallback 到 toolRegistry。
//
// 工具前缀路由表（routeTable）：
//  Task 1 仅提供空的 routeTable + registerToolRoute(prefix, module) 方法。
//  当前 routeTable 为空（Hand/Mouth 器官移除后，下行工具统一由
//  capability-modules / tools/*.ts 直接注册到 ToolRegistry 承接），
//  execute 全部走 fallbackToolRegistry 兜底，ReflexArc 硬安全门在入口先生效。

import type {
  BodyAction,
  BodyActionResult,
  BodyModuleKind,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyState,
  ReflexVerdict,
} from "./types.js";

// 透传 types.ts 中的 BodyGatewayLike，便于 index.ts 统一从 body-gateway.js 导出
export type { BodyGatewayLike } from "./types.js";

// ---- 外观接口 ------------------------------------------------------------

/**
 * 反射弧外观接口（身体侧硬安全门）。
 *
 * 与 brain/action-executor.ts 的 LimbicCortexLike 对称：
 *  - LimbicCortex 是脑侧软安全检查（含黑名单/高风险/SSRF 检查，可能调 LLM）
 *  - ReflexArc 是身体侧硬安全门（rm -rf / format / shutdown 等直接 DENY，不经 LLM）
 *
 * Task 1 仅定义接口，具体 ReflexArc 实现由后续 Task 提供。
 */
export interface ReflexArcLike {
  /**
   * 检查动作是否被反射弧拒绝。
   * - allow：放行，交 BodyModule.act 执行
   * - deny：硬拒绝，BodyGateway 直接返回 refused=true
   */
  check(action: BodyAction): ReflexVerdict;
  /**
   * 审计日志：拒绝事件写入日志（含 actorId / tool / args / reason / timestamp）。
   * BodyGateway 在反射弧拒绝路径上必须调用此方法。
   * 未实现时（旧版 ReflexArc）静默跳过。
   */
  audit?(
    action: BodyAction,
    verdict: ReflexVerdict,
    actorId?: string,
  ): void;
}

/**
 * 工具注册表外观接口（fallback 兜底用）。
 *
 * 与 brain/action-executor.ts 的 ToolRegistryLike 保持一致，
 * 让 BodyGateway 在工具未下沉到任何 BodyModule 时降级走 toolRegistry.execute。
 */
export interface ToolRegistryLike {
  execute(
    name: string,
    args: Record<string, unknown>,
    opts?: { actorId?: string },
  ): Promise<{ ok: boolean; result: Record<string, unknown> }>;
}

// ---- BodyGateway 主类 ---------------------------------------------------

/**
 * BodyGateway 构造参数。
 */
export interface BodyGatewayOptions {
  /** 反射弧（可选；未注入时跳过反射检查） */
  reflexArc?: ReflexArcLike;
  /** 兜底工具注册表（可选；未注入时未下沉工具返回 not_found） */
  fallbackToolRegistry?: ToolRegistryLike;
}

/**
 * BodyGateway —— 大脑→身体的下行网关。
 *
 * 持有：
 *  - 8 个 BodyModule 的引用（按 module.name 索引）
 *  - 反射弧引用（ReflexArc，可选）
 *  - 兜底工具注册表（ToolRegistry，可选）
 *  - 工具前缀路由表（prefix → BodyModuleKind）
 *
 * 一次 execute 调用的路由开销 < 5ms（不含实际工具执行耗时）。
 */
export class BodyGateway {
  private reflexArc: ReflexArcLike | null;
  private fallbackToolRegistry: ToolRegistryLike | null;

  // 已注册的 BodyModule，按 module.name 索引
  private modules: Map<BodyModuleKind, BodyModuleLike> = new Map();

  // 工具前缀路由表：prefix（如 "desktop.visual."）→ module kind
  // Task 12 会填充实际映射，Task 1 仅提供机制
  private routeTable: Map<string, BodyModuleKind> = new Map();

  constructor(opts: BodyGatewayOptions = {}) {
    this.reflexArc = opts.reflexArc ?? null;
    this.fallbackToolRegistry = opts.fallbackToolRegistry ?? null;
  }

  // ─── 模块与路由注册 ──────────────────────────────────────────

  /**
   * 注册一个 BodyModule。
   * 按 module.name 索引；重复注册同名模块会覆盖旧引用。
   */
  registerModule(module: BodyModuleLike): void {
    this.modules.set(module.name, module);
    console.log(`[BodyGateway] 已注册 BodyModule: ${module.name} (${module.label})`);
  }

  /**
   * 注册工具前缀到 BodyModule 的路由。
   *
   * @param prefix 工具名前缀，如 "desktop.visual." / "tts." / "embodiment."
   * @param module 对应的 BodyModule kind
   *
   * Task 12 会按归属批量调用此方法填充 routeTable。
   */
  registerToolRoute(prefix: string, module: BodyModuleKind): void {
    this.routeTable.set(prefix, module);
    console.log(`[BodyGateway] 已注册工具路由: ${prefix}* → ${module}`);
  }

  /**
   * 判断某工具是否已下沉到 BodyGateway（即 routeTable 中有匹配前缀）。
   *
   * 调用方（如 agent-core.ts 的主路径 / ActionExecutor）可据此决定：
   *  - hasRoute(tool) === true：走 BodyGateway.execute 路由
   *  - hasRoute(tool) === false：直接走 toolRegistry.execute 兜底
   *
   * 注意：仅判断 routeTable 是否命中，不保证对应 BodyModule 在线。
   */
  hasRoute(tool: string): boolean {
    return this.resolveModule(tool) !== null;
  }

  /** 内部：按 tool name 查找对应的 BodyModule（前缀最长匹配） */
  private resolveModule(tool: string): BodyModuleLike | null {
    // 前缀最长匹配：优先匹配更具体的前缀
    // 例如 "desktop.visual.run_task" 同时匹配 "desktop." 和 "desktop.visual."，
    // 应选 "desktop.visual."（更具体）
    let bestPrefix = "";
    for (const prefix of this.routeTable.keys()) {
      if (tool.startsWith(prefix) && prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
      }
    }
    if (!bestPrefix) {
      return null;
    }
    const kind = this.routeTable.get(bestPrefix)!;
    return this.modules.get(kind) ?? null;
  }

  // ─── 核心：execute / sense / snapshot ────────────────────────

  /**
   * 执行一个身体动作。
   *
   * 流程：
   *  1. 反射弧检查：reflexArc?.check(action)，deny → 直接返回 { ok:false, refused:true, reason }
   *  2. 工具路由：按 action.tool 前缀路由到对应 BodyModule.act()
   *  3. 兜底：未匹配的工具走 fallbackToolRegistry.execute
   *  4. 全程记录耗时（durationMs）
   *
   * @param action 身体动作
   */
  async execute(action: BodyAction): Promise<BodyActionResult> {
    const startTime = Date.now();

    // 1. 反射弧检查（身体侧硬安全门，不经 LLM）
    if (this.reflexArc) {
      try {
        const verdict = this.reflexArc.check(action);
        if (verdict.verdict === "deny") {
          const reason = verdict.reason ?? "refused_by_reflex_arc";
          console.log(
            `[BodyGateway] execute: 反射弧拒绝 tool=${action.tool} ` +
              `reason=${reason} matchedPattern=${verdict.matchedPattern ?? ""} ` +
              `actorId=${action.actorId ?? ""}`,
          );
          // 写入审计日志（含 actorId / tool / args / reason / timestamp）
          try {
            this.reflexArc.audit?.(action, verdict, action.actorId);
          } catch (auditErr) {
            // 审计失败不应阻断拒绝响应；仅记录到 stderr
            process.stderr.write(
              `[BodyGateway] audit 调用异常: ${String(auditErr).slice(0, 120)}\n`,
            );
          }
          return {
            ok: false,
            result: { refused: true, reason, matchedPattern: verdict.matchedPattern },
            refused: true,
            reason,
            durationMs: Date.now() - startTime,
          };
        }
      } catch (err) {
        // 反射弧本身异常 → fail-closed（拒绝执行），避免危险动作漏过
        const errMsg = String(err).slice(0, 120);
        console.log(`[BodyGateway] execute: 反射弧检查异常，fail-closed 拒绝: ${errMsg}`);
        // fail-closed 也写审计（构造合成 verdict，记录 actorId/tool/args/reason/timestamp）
        try {
          this.reflexArc.audit?.(
            action,
            { verdict: "deny", reason: `reflex_check_error:${errMsg}`, matchedPattern: "", severity: "deny" },
            action.actorId,
          );
        } catch (auditErr) {
          process.stderr.write(
            `[BodyGateway] audit(fail-closed) 调用异常: ${String(auditErr).slice(0, 120)}\n`,
          );
        }
        return {
          ok: false,
          result: { error: `reflex_check_error:${errMsg}` },
          refused: true,
          reason: `reflex_check_error:${errMsg}`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 2. 工具路由
    const module = this.resolveModule(action.tool);
    if (module) {
      try {
        const result = await module.act(action);
        // BodyModule.act() 返回 "unknown tool" 类错误时，说明该工具前缀虽匹配
        // routeTable，但 BodyModule 内部 dispatch 未覆盖该具体工具；
        // 此时降级到 fallbackToolRegistry，让独立注册的 handler 兜底执行。
        const errMsg = result.errorMessage ?? "";
        const isUnknownTool =
          !result.ok &&
          (errMsg.includes("unknown tool") ||
            errMsg.includes("tool_not_found") ||
            errMsg.includes("unknown tool prefix"));
        if (!isUnknownTool) {
          return {
            ...result,
            durationMs: result.durationMs ?? Date.now() - startTime,
          };
        }
        // isUnknownTool === true → 落到第 3 步 fallback
        console.log(
          `[BodyGateway] execute: BodyModule 未覆盖该工具，降级 fallback ` +
            `module=${module.name} tool=${action.tool} err=${errMsg.slice(0, 80)}`,
        );
      } catch (err) {
        const errMsg = String(err).slice(0, 120);
        console.log(
          `[BodyGateway] execute: BodyModule.act 异常 module=${module.name} tool=${action.tool} err=${errMsg}`,
        );
        // 异常也降级到 fallback（fail-open），避免单 BodyModule bug 阻断所有前缀匹配工具
        // 仍保留异常信息到最终返回的 errorMessage 兜底（若 fallback 也失败）
      }
    }

    // 3. 兜底：未下沉工具走 fallbackToolRegistry
    if (this.fallbackToolRegistry) {
      try {
        const fallbackResult = await this.fallbackToolRegistry.execute(
          action.tool,
          action.args,
          { actorId: action.actorId },
        );
        return {
          ok: fallbackResult.ok,
          result: fallbackResult.result,
          errorMessage: fallbackResult.ok ? undefined : String(fallbackResult.result?.error ?? "").slice(0, 120) || undefined,
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        const errMsg = String(err).slice(0, 120);
        console.log(
          `[BodyGateway] execute: fallbackToolRegistry 异常 tool=${action.tool} err=${errMsg}`,
        );
        return {
          ok: false,
          result: { error: errMsg },
          errorMessage: errMsg,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 4. 既无 BodyModule 也无 fallback → not_found
    console.log(`[BodyGateway] execute: 工具未注册 tool=${action.tool}`);
    return {
      ok: false,
      result: { error: `tool_not_found:${action.tool}` },
      errorMessage: `tool_not_found:${action.tool}`,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 感官查询。
   *
   * 路由策略：
   *  - query.module 显式指定：直接路由到对应 BodyModule.sense()
   *  - 否则：按 query.kind 前缀路由（如 "visual.*" → visual 模块）
   *  - 都未命中：返回 ok=false + "no_module_for_query"
   *
   * @param query 感官查询
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    // 1. 显式指定 module
    let module: BodyModuleLike | null = null;
    if (query.module) {
      module = this.modules.get(query.module) ?? null;
    } else {
      // 2. 按 kind 前缀路由（kind 形如 "eye.desktop_frame" / "ear.transcript"）
      const kind = query.kind;
      for (const [prefix, modKind] of this.routeTable.entries()) {
        // 把路由前缀（如 "desktop.visual."）转为 sense 域前缀（如 "eye."）
      // 简化策略：取 prefix 的第一段作为 sense 域
      // 例：routeTable["desktop.visual."] → sense 域 "eye"
        const senseDomain = this.extractSenseDomain(prefix);
        if (senseDomain && kind.startsWith(`${senseDomain}.`)) {
          module = this.modules.get(modKind) ?? null;
          if (module) {
            break;
          }
        }
      }
      // 兜底：where_am_i 等跨模块查询路由到 vestibular（前庭主导位置感知）
      if (!module && (kind === "where_am_i" || kind.startsWith("where_am_i"))) {
        module = this.modules.get("vestibular") ?? null;
      }
    }

    if (!module) {
      console.log(`[BodyGateway] sense: 无对应模块 kind=${query.kind} module=${query.module ?? ""}`);
      return {
        ok: false,
        data: { error: "no_module_for_query" },
        errorMessage: `no_module_for_query:${query.kind}`,
      };
    }

    try {
      const result = await module.sense(query);
      return {
        ...result,
        module: result.module ?? module.name,
      };
    } catch (err) {
      const errMsg = String(err).slice(0, 120);
      console.log(
        `[BodyGateway] sense: BodyModule.sense 异常 module=${module.name} kind=${query.kind} err=${errMsg}`,
      );
      return {
        ok: false,
        data: { error: errMsg },
        module: module.name,
        errorMessage: errMsg,
      };
    }
  }

  /**
   * 全量快照：返回各 BodyModule 快照 + 身体状态聚合。
   *
   * 身体状态聚合策略（Task 1 仅占位）：
   *  - 遍历各 BodyModule.snapshot()，从 metadata 中提取 battery/location/quota/load/fatigue/currentDevice/mood/rendering
   *  - Task 12 会由 HomeostasisCore 主导维护，BodyGateway 直接读取其 state 字段
   */
  snapshot(): { modules: BodyModuleSnapshot[]; state: BodyState } {
    const modules: BodyModuleSnapshot[] = [];
    const state: BodyState = {};

    for (const module of this.modules.values()) {
      let snap: BodyModuleSnapshot;
      try {
        snap = module.snapshot();
      } catch (err) {
        // 单个模块快照失败不阻断其他模块
        console.log(
          `[BodyGateway] snapshot: 模块快照失败 module=${module.name} err=${err}`,
        );
        snap = {
          name: module.name,
          label: module.label,
          tools: module.tools,
          online: false,
          subsystems: [],
          lastActivityAt: null,
          metadata: { error: String(err).slice(0, 120) },
        };
      }
      modules.push(snap);

      // 聚合身体状态：从模块快照 metadata 提取已知字段
      this.mergeStateFromSnapshot(state, snap, module.name);
    }

    return { modules, state };
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  /**
   * 从路由前缀提取 sense 域。
   * 例："desktop.visual." → "eye"；"tts." → "mouth"（特殊映射）；"embodiment." → "vestibular"
   *
   * Task 1 实现简化版本：取前缀最后一段。Task 12 会改为基于 BodyModule 自描述的 tools 列表路由。
   */
  private extractSenseDomain(prefix: string): string | null {
    // 去掉末尾 "."，取最后一段
    const trimmed = prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
    const parts = trimmed.split(".");
    if (parts.length === 0) {
      return null;
    }
    const last = parts[parts.length - 1];

    // 特殊映射：工具前缀最后一段 → sense 域
    // Task 12 会扩展为基于 BodyModule.sense 能力的更精确路由
    const senseMap: Record<string, string> = {
      // 视觉类工具前缀 → eye 域
      eye: "eye",
      visual: "eye",
      screenshot: "eye",
      camera: "eye",
      // 听觉类工具前缀 → ear 域
      ear: "ear",
      auditory: "ear",
      // 体感类工具前缀 → skin 域
      skin: "skin",
      somato: "skin",
      smart_home: "skin",
      // 前庭类工具前缀 → vestibular 域
      vestibular: "vestibular",
      embodiment: "vestibular",
      // 稳态类工具前缀 → homeostasis 域
      homeostasis: "homeostasis",
      battery: "homeostasis",
      // 反射类工具前缀 → reflex 域
      reflex: "reflex",
    };
    return senseMap[last] ?? last;
  }

  /**
   * 从单个 BodyModule 快照聚合身体状态字段。
   *
   * P0-3 调整：mood 的权威来源从 VestibularApparatus 改为 HomeostasisCore。
   *  - homeostasis 分支：mood/hunger/valence 总是覆盖（权威源）
   *  - vestibular 分支：mood 仅在 homeostasis 未设置时作为 fallback（渲染态）
   *
   * 这样 body-gateway 优先取 homeostasis 的 mood，homeostasis 不可用（未注册或
   * mood 未计算）时 fallback 到 vestibular 的渲染态 mood，保持双向兼容。
   */
  private mergeStateFromSnapshot(
    state: BodyState,
    snap: BodyModuleSnapshot,
    moduleKind: BodyModuleKind,
  ): void {
    const meta = snap.metadata ?? {};

    // HomeostasisCore 是稳态字段 + mood 的权威来源
    if (moduleKind === "homeostasis") {
      if (typeof meta.battery === "number") state.battery = meta.battery;
      if (typeof meta.location === "string") state.location = meta.location;
      if (typeof meta.quota === "number") state.quota = meta.quota;
      if (typeof meta.load === "number") state.load = meta.load;
      if (typeof meta.fatigue === "number") state.fatigue = meta.fatigue;
      // P0-3：mood/hunger/valence 从 homeostasis 提取（权威源，总是覆盖）
      if (typeof meta.mood === "string") state.mood = meta.mood;
      if (typeof meta.hunger === "number") state.hunger = meta.hunger;
      if (typeof meta.valence === "number") state.valence = meta.valence;
    }

    // VestibularApparatus 是位置/渲染状态的权威来源
    if (moduleKind === "vestibular") {
      if (typeof meta.currentDevice === "string") state.currentDevice = meta.currentDevice;
      // P0-3：mood 仅在 homeostasis 未设置时作为 fallback（渲染态）
      if (typeof meta.mood === "string" && state.mood === undefined) {
        state.mood = meta.mood;
      }
      if (typeof meta.rendering === "boolean") state.rendering = meta.rendering;
    }
  }
}
