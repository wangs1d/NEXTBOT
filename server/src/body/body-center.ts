// Agent Body Center — 外观类（BodyCenter）
//
// 与 brain/brain-center.ts 对称：身体中心的统一外观与编排器。
//
// 持有：
//  - BodyModule 引用（eye / ear / skin / vestibular / homeostasis / reflex /
//    rhythm），均可选，缺失时方法优雅降级
//  - BodyBus 引用（身体内部消息总线）
//  - BodyGateway 引用（大脑→身体下行网关）
//
// 对外暴露：
//  - registerModule(module)：委托到 BodyGateway.registerModule
//  - act(action)：委托到 BodyGateway.execute
//  - sense(query)：委托到 BodyGateway.sense
//  - state(actorId?)：聚合各 BodyModule 的 state 字段
//  - snapshot()：委托到 BodyGateway.snapshot
//  - start()/stop()：调用各 module 的 start/stop，失败不阻断其他
//  - getBus()/getGateway()：暴露内部引用
//  - 模块 setter（setEye/setEar/...）：供装配阶段注入具体实现
//
// 设计原则（与 BrainCenter 一致）：
//  - 任一模块缺失时方法优雅降级，不抛异常
//  - start/stop 失败不阻断其他模块
//  - 不持有 LLM，所有智能决策在 BrainCenter 侧

import type { BodyBus } from "./body-bus.js";
import type { BodyGateway } from "./body-gateway.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyState,
} from "./types.js";

/**
 * BodyCenter —— 身体中心外观类。
 *
 * 持有 BodyModule 引用 + BodyBus + BodyGateway，对外提供统一入口。
 *
 * 与 BrainCenter 的对称关系：
 *  - BrainCenter 持有 11 个皮层 + 2 个皮下分区 + ActionExecutor
 *  - BodyCenter 持有 BodyModule + BodyBus + BodyGateway
 *  - BrainCenter.cognize 阶段 1 调 bodyGateway.sense 补全身体状态
 *  - BrainCenter.ActionExecutor.execute 委托到 bodyGateway.execute
 */
export class BodyCenter {
  // ---- BodyModule 引用（均可选，缺失时降级） ----
  /** 眼（视觉）：截屏 / 摄像头 / VLM 描述 */
  private eye: BodyModuleLike | null = null;
  /** 耳（听觉）：phone-bridge / voice-message 入站音频到达 */
  private ear: BodyModuleLike | null = null;
  /** 皮肤（体感）：智能家居 / 设备传感器 */
  private skin: BodyModuleLike | null = null;
  /** 前庭器（平衡）：3D 具身位置 / 多设备渲染状态 */
  private vestibular: BodyModuleLike | null = null;
  /** 稳态核心（内脏）：电量 / 位置 / 算力配额 / 负载 / 疲劳度 */
  private homeostasis: BodyModuleLike | null = null;
  /** 反射弧（脊髓反射）：硬安全门，rm -rf / format 等直接 DENY */
  private reflex: BodyModuleLike | null = null;
  /** 节律感知核心（生物钟）：连续工作 / 深夜活跃检测，供主动性模块消费 */
  private rhythm: BodyModuleLike | null = null;

  // ---- 总线与网关 ----
  private bodyBus: BodyBus;
  private bodyGateway: BodyGateway;

  private started = false;

  constructor(bodyGateway: BodyGateway, bodyBus: BodyBus) {
    this.bodyGateway = bodyGateway;
    this.bodyBus = bodyBus;
  }

  // ---- 模块注册（委托到 BodyGateway.registerModule） ----

  /**
   * 注册一个 BodyModule。
   * 同时挂到 BodyGateway（用于路由）和本地对应字段（用于 start/stop/snapshot）。
   */
  registerModule(module: BodyModuleLike): void {
    this.bodyGateway.registerModule(module);
    // 按模块种类挂到本地字段
    switch (module.name) {
      case "eye":
        this.eye = module;
        break;
      case "ear":
        this.ear = module;
        break;
      case "skin":
        this.skin = module;
        break;
      case "vestibular":
        this.vestibular = module;
        break;
      case "homeostasis":
        this.homeostasis = module;
        break;
      case "reflex":
        this.reflex = module;
        break;
      case "rhythm":
        this.rhythm = module;
        break;
      default:
        console.log(`[BodyCenter] 未知 BodyModule kind: ${module.name}，仅挂到 BodyGateway`);
    }
  }

  // ---- 模块 setter（供装配阶段注入具体实现） ----

  /** 注入眼（视觉） */
  setEye(m: BodyModuleLike): void {
    this.eye = m;
    this.bodyGateway.registerModule(m);
    console.log("[BodyCenter] 已注入 Eye（眼/视觉）");
  }

  /** 注入耳（听觉） */
  setEar(m: BodyModuleLike): void {
    this.ear = m;
    this.bodyGateway.registerModule(m);
    console.log("[BodyCenter] 已注入 Ear（耳/听觉）");
  }

  /** 注入皮肤（体感） */
  setSkin(m: BodyModuleLike): void {
    this.skin = m;
    this.bodyGateway.registerModule(m);
    console.log("[BodyCenter] 已注入 Skin（皮肤/体感）");
  }

  /** 注入前庭器（平衡） */
  setVestibularApparatus(m: BodyModuleLike): void {
    this.vestibular = m;
    this.bodyGateway.registerModule(m);
    console.log("[BodyCenter] 已注入 VestibularApparatus（前庭器/平衡）");
  }

  /** 注入稳态核心（内脏） */
  setHomeostasis(m: BodyModuleLike): void {
    this.homeostasis = m;
    this.bodyGateway.registerModule(m);
    console.log("[BodyCenter] 已注入 HomeostasisCore（稳态核心/内脏）");
  }

  /** 注入反射弧（脊髓反射） */
  setReflex(m: BodyModuleLike): void {
    this.reflex = m;
    this.bodyGateway.registerModule(m);
    console.log("[BodyCenter] 已注入 ReflexArc（反射弧/脊髓反射）");
  }

  // ---- 模块 getter（供外部装配层访问具体模块扩展能力） ----

  getEye(): BodyModuleLike | null {
    return this.eye;
  }

  getEar(): BodyModuleLike | null {
    return this.ear;
  }

  getSkin(): BodyModuleLike | null {
    return this.skin;
  }

  getVestibularApparatus(): BodyModuleLike | null {
    return this.vestibular;
  }

  getHomeostasis(): BodyModuleLike | null {
    return this.homeostasis;
  }

  getReflex(): BodyModuleLike | null {
    return this.reflex;
  }

  // ---- 核心方法（委托到 BodyGateway） ----

  /**
   * 执行一个身体动作。
   * 委托到 BodyGateway.execute（先过反射弧，再路由到 BodyModule.act）。
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    return this.bodyGateway.execute(action);
  }

  /**
   * 感官查询。
   * 委托到 BodyGateway.sense（按 query.module 路由到对应 BodyModule.sense）。
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    return this.bodyGateway.sense(query);
  }

  /**
   * 聚合身体当前状态。
   *
   * Task 1 实现：直接调 snapshot().state（BodyGateway 内部聚合）。
   * Task 12 会改为 HomeostasisCore 主导维护，BodyCenter 直接读取其 state 字段。
   *
   * @param _actorId 当前 actor（Task 1 暂未使用，预留参数）
   */
  state(_actorId?: string): BodyState {
    return this.bodyGateway.snapshot().state;
  }

  /**
   * 全量快照：各 BodyModule 快照 + 身体状态聚合。
   * 委托到 BodyGateway.snapshot。
   */
  snapshot(): { modules: BodyModuleSnapshot[]; state: BodyState } {
    return this.bodyGateway.snapshot();
  }

  // ---- 生命周期 ----

  /**
   * 启动身体中心：依次启动 BodyBus + 8 个 BodyModule。
   * 任一模块启动失败不阻断其他模块（降级而非崩溃）。
   */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[BodyCenter] 已启动，跳过重复 start");
      return;
    }
    console.log("[BodyCenter] 正在启动...");
    await this.startModule("BodyBus", this.bodyBus);
    await this.startModule("Eye", this.eye);
    await this.startModule("Ear", this.ear);
    await this.startModule("Skin", this.skin);
    await this.startModule("VestibularApparatus", this.vestibular);
    await this.startModule("HomeostasisCore", this.homeostasis);
    await this.startModule("ReflexArc", this.reflex);
    await this.startModule("RhythmCore", this.rhythm);
    this.started = true;
    console.log("[BodyCenter] 启动完成");
  }

  /**
   * 停止身体中心：依次停止 8 个 BodyModule + BodyBus。
   * 任一模块停止失败不阻断其他模块。
   */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[BodyCenter] 未启动，跳过 stop");
      return;
    }
    console.log("[BodyCenter] 正在停止...");
    // 停止顺序与启动顺序相反（先停感知/运动器官，最后停总线）
    await this.stopModule("RhythmCore", this.rhythm);
    await this.stopModule("ReflexArc", this.reflex);
    await this.stopModule("HomeostasisCore", this.homeostasis);
    await this.stopModule("VestibularApparatus", this.vestibular);
    await this.stopModule("Skin", this.skin);
    await this.stopModule("Ear", this.ear);
    await this.stopModule("Eye", this.eye);
    await this.stopModule("BodyBus", this.bodyBus);
    this.started = false;
    console.log("[BodyCenter] 已停止");
  }

  // ---- 引用暴露 ----

  /** 暴露 BodyBus 引用（供装配阶段桥接到 SynapseBus） */
  getBus(): BodyBus {
    return this.bodyBus;
  }

  /** 暴露 BodyGateway 引用（供 BrainCenter.registerBodyGateway 使用） */
  getGateway(): BodyGateway {
    return this.bodyGateway;
  }

  /** 暴露 RhythmCore 引用（供装配层喂入 presence/awareness 活动数据） */
  getRhythm(): BodyModuleLike | null {
    return this.rhythm;
  }

  // ---- 内部工具 ----

  /** 启动单个模块；缺失或无 start 方法则跳过，失败不阻断其他 */
  private async startModule(
    name: string,
    m: { start?(): Promise<void> } | null,
  ): Promise<void> {
    if (!m || typeof m.start !== "function") {
      return;
    }
    try {
      await m.start();
      console.log(`[BodyCenter] ${name} 已启动`);
    } catch (err) {
      console.log(`[BodyCenter] ${name} 启动失败（不阻断其他模块）: ${err}`);
    }
  }

  /** 停止单个模块；缺失或无 stop 方法则跳过，失败不阻断其他 */
  private async stopModule(
    name: string,
    m: { stop?(): Promise<void> } | null,
  ): Promise<void> {
    if (!m || typeof m.stop !== "function") {
      return;
    }
    try {
      await m.stop();
      console.log(`[BodyCenter] ${name} 已停止`);
    } catch (err) {
      console.log(`[BodyCenter] ${name} 停止失败（不阻断其他模块）: ${err}`);
    }
  }
}
