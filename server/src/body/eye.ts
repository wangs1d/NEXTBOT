// Agent Body Center — Eye 眼/视觉传感器
//
// 与人体器官对照：眼睛。统一封装「看」的感知通道：
//  - 桌面截屏（desktop.visual.screenshot）→ 委托 DesktopVisualPort
//  - 桌面 VLM 描述（desktop.visual.describe）→ 委托 DesktopVisualPort.describe
//  - 摄像头拍照（camera.take_photo）→ 委托 DeviceRegistry.invoke
//  - 摄像头视频流（camera.start_stream）→ 委托 DeviceRegistry.openStream 异步迭代
//
// 设计原则（与 SensoryCortex 一致）：
//   1. 子系统缺失时方法优雅降级（返回带 error 的结果），不抛异常阻断调用方
//   2. 截图/拍照/流帧到达时通过 BodyBus 发布 body.eye.frame / body.eye.camera_frame 信号
//   3. 三个 *Like 接口仅声明本模块实际用到的方法，结构兼容即可

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
  BodyToolRegistry,
} from "./types.js";

// ---- 子系统最小化外观接口（结构兼容真实服务即可）----------------------

/**
 * 桌面视觉子系统（DesktopVisualPort）的最小化结构接口。
 * 截屏方法 region 用 [left, top, width, height] 元组（与 pyautogui 一致）。
 * describe 为可选的 VLM 描述方法，存在时用于生成截图的文字描述。
 */
export interface DesktopVisualLike {
  screenshot?(input?: {
    region?: [number, number, number, number];
  }): Promise<{
    base64?: string;
    url?: string;
    width?: number;
    height?: number;
  }>;
  describe?(image: {
    base64?: string;
    url?: string;
  }): Promise<{ text: string; tags?: string[] }>;
}

/**
 * 设备注册表子系统（DeviceRegistry）的最小化结构接口。
 * 仅暴露视觉皮层用到的 camera 设备检索 / 调用 / 流式订阅能力。
 */
export interface DeviceRegistryLike {
  listByCapability?(cap: string): Array<{ deviceId: string; kind: string }>;
  invoke(
    deviceId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown }>;
  openStream?(
    deviceId: string,
    streamId: string,
    params: Record<string, unknown>,
  ): AsyncIterable<{ type: string; payload: Record<string, unknown> }>;
}

/**
 * Eye 依赖注入参数。
 * bodyBus 必填；其余子系统均可选，缺失时对应工具返回 ok=false 优雅降级。
 */
export interface EyeDeps {
  bodyBus: BodyBus;
  desktopVisualPort?: DesktopVisualLike;
  deviceRegistry?: DeviceRegistryLike;
}

// ---- 辅助类型 ----

/** 视觉帧统一返回结构（截屏 / 摄像头帧通用） */
interface VisualFrame {
  base64?: string;
  url?: string;
  width?: number;
  height?: number;
  capturedAt: string;
  source: "desktop" | "camera";
  deviceId?: string;
  streamId?: string;
}

/** 视觉设备状态项 */
interface CameraInfo {
  deviceId: string;
  kind: string;
}

// ---- Eye 主类 ----

/**
 * 眼/视觉传感器：统一封装「看」的感知通道。
 *
 * 三条接入路径：
 *   1. desktop.visual.screenshot → DesktopVisualPort.screenshot 优先，
 *      缺失时返回 ok=false
 *   2. desktop.visual.describe   → DesktopVisualPort.describe（如存在）
 *   3. camera.take_photo         → DeviceRegistry.invoke(deviceId, "camera.take_photo", params)
 *   4. camera.start_stream       → DeviceRegistry.openStream 异步迭代
 *
 * 每次截图/拍照/流帧到达时，通过 BodyBus 发布：
 *   - body.eye.frame        桌面截屏帧
 *   - body.eye.camera_frame 摄像头帧
 *
 * 任一子系统缺失时方法优雅降级（返回带 error 的结果），不抛异常阻断调用方。
 */
export class Eye implements BodyModuleLike {
  readonly name = "eye" as const;
  readonly label = "眼/视觉传感器";
  readonly tools = [
    "desktop.visual.screenshot",
    "desktop.visual.describe",
    "camera.take_photo",
    "camera.start_stream",
  ];

  private readonly bodyBus: BodyBus;
  private readonly desktopVisualPort: DesktopVisualLike | null;
  private readonly deviceRegistry: DeviceRegistryLike | null;

  private started = false;
  private lastActivityAt: string | null = null;

  constructor(deps: EyeDeps) {
    this.bodyBus = deps.bodyBus;
    this.desktopVisualPort = deps.desktopVisualPort ?? null;
    this.deviceRegistry = deps.deviceRegistry ?? null;
  }

  // ---- 生命周期 ----

  /**
   * 启动视觉皮层。
   *
   * 当前无后台任务，仅置位并记日志。
   * deviceRegistry 的设备变更订阅（subscribe）未在 DeviceRegistryLike 接口暴露，
   * 若需把 camera 上下线事件转 BodyBus，由装配层把真实 DeviceRegistry 的
   * subscribe 事件转 body.eye.device_change（Task 12 装配时接通）。
   */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[Eye] 已启动，跳过重复 start");
      return;
    }
    console.log("[Eye] 正在启动...");
    this.started = true;
    console.log("[Eye] 启动完成");
  }

  /** 停止视觉皮层：置位，不主动中断底层服务。 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[Eye] 未启动，跳过 stop");
      return;
    }
    console.log("[Eye] 正在停止...");
    this.started = false;
    console.log("[Eye] 已停止");
  }

  // ---- 核心方法：act ----

  /**
   * 执行视觉动作。
   *
   * 按 action.tool 路由到对应子系统能力：
   *   - desktop.visual.screenshot → 截屏
   *   - desktop.visual.describe   → VLM 描述
   *   - camera.take_photo         → 摄像头拍照
   *   - camera.start_stream       → 摄像头视频流（异步迭代 + 逐帧发布到 BodyBus）
   */
  async act(action: BodyAction): Promise<BodyActionResult> {
    const startedAt = Date.now();
    const { tool, args } = action;

    try {
      let result: Record<string, unknown>;
      switch (tool) {
        case "desktop.visual.screenshot":
          result = await this.actScreenshot(args);
          break;
        case "desktop.visual.describe":
          result = await this.actDescribe(args);
          break;
        case "camera.take_photo":
          result = await this.actTakePhoto(args);
          break;
        case "camera.start_stream":
          result = await this.actStartStream(args);
          break;
        default:
          return {
            ok: false,
            result: {},
            errorMessage: `Eye: 不支持的工具 ${tool}`,
            durationMs: Date.now() - startedAt,
          };
      }
      this.touchActivity();
      const ok = result["ok"] !== false;
      return {
        ok,
        result,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(`[Eye] act(${tool}) 异常: ${errorMessage}`);
      return {
        ok: false,
        result: {},
        errorMessage,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  /**
   * desktop.visual.screenshot：截屏一次。
   *
   * 委托 desktopVisualPort.screenshot；缺失或返回失败时返回 ok=false。
   * 成功时发布 body.eye.frame 信号（含 base64/url + width/height + capturedAt）。
   */
  private async actScreenshot(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const region = this.parseRegion(args["region"]);

    // 优先走 desktopVisualPort
    if (this.desktopVisualPort?.screenshot) {
      try {
        const shot = await this.desktopVisualPort.screenshot(
          region ? { region } : undefined,
        );
        const frame = this.normalizeFrame(shot, "desktop");
        this.publishDesktopFrame(frame);
        return {
          ok: true,
          base64: frame.base64,
          url: frame.url,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
          source: "desktop-visual-port",
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          source: "desktop-visual-port",
        };
      }
    }

    return {
      ok: false,
      error:
        "Eye: 桌面截屏不可用（desktopVisualPort 未注入或无 screenshot 方法）",
    };
  }

  /**
   * desktop.visual.describe：对图像做 VLM 描述。
   *
   * 委托 desktopVisualPort.describe（如存在）。输入图像来自 args.image（含 base64 或 url）
   * 或 args.base64 / args.url 顶层字段。describe 不存在时返回 ok=false。
   */
  private async actDescribe(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.desktopVisualPort?.describe) {
      return {
        ok: false,
        error:
          "Eye: VLM 描述不可用（desktopVisualPort 未注入或无 describe 方法）",
      };
    }

    const imageInput = this.parseImageInput(args);
    if (!imageInput) {
      return {
        ok: false,
        error:
          "Eye: describe 缺少图像输入（需提供 image.base64 或 image.url）",
      };
    }

    try {
      const result = await this.desktopVisualPort.describe(imageInput);
      return {
        ok: true,
        text: result.text,
        tags: result.tags ?? [],
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * camera.take_photo：从指定 camera 设备拍一张照片。
   *
   * 委托 deviceRegistry.invoke(deviceId, "camera.take_photo", params)。
   * 缺少 deviceId 或 deviceRegistry 时返回 ok=false。
   * 成功时发布 body.eye.camera_frame 信号。
   */
  private async actTakePhoto(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deviceRegistry) {
      return {
        ok: false,
        error: "Eye: 摄像头不可用（deviceRegistry 未注入）",
      };
    }

    const deviceId = typeof args["deviceId"] === "string" ? args["deviceId"] : "";
    if (!deviceId) {
      return {
        ok: false,
        error: "Eye: camera.take_photo 缺少 deviceId 参数",
      };
    }

    const params = this.extractParams(args, ["deviceId"]);
    try {
      const r = await this.deviceRegistry.invoke(
        deviceId,
        "camera.take_photo",
        params,
      );
      if (!r.ok) {
        return {
          ok: false,
          error: "camera.take_photo 调用失败",
          deviceId,
          result: r.result ?? {},
        };
      }
      const result = (r.result ?? {}) as Record<string, unknown>;
      const frame = this.normalizeCameraFrame(result, deviceId);
      this.publishCameraFrame(frame);
      return {
        ok: true,
        deviceId,
        result,
        capturedAt: frame.capturedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        deviceId,
      };
    }
  }

  /**
   * camera.start_stream：开启摄像头视频流，逐帧发布到 BodyBus。
   *
   * 委托 deviceRegistry.openStream(deviceId, "video", params) 异步迭代。
   * 当前方法阻塞直到流自然结束或出错；调用方如需提前停止，可通过 BodyBus
   * 监听 body.eye.camera_frame 信号消费帧。
   *
   * 注意：openStream 在 *Like 接口中为可选；缺失时返回 ok=false。
   */
  private async actStartStream(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.deviceRegistry?.openStream) {
      return {
        ok: false,
        error:
          "Eye: 视频流不可用（deviceRegistry 未注入或无 openStream 方法）",
      };
    }

    const deviceId = typeof args["deviceId"] === "string" ? args["deviceId"] : "";
    if (!deviceId) {
      return {
        ok: false,
        error: "Eye: camera.start_stream 缺少 deviceId 参数",
      };
    }

    const streamId =
      typeof args["streamId"] === "string" ? args["streamId"] : "video";
    const params = this.extractParams(args, ["deviceId", "streamId"]);
    let frameCount = 0;
    let lastFrameAt: string | null = null;
    let streamError: string | null = null;

    try {
      const stream = this.deviceRegistry.openStream(
        deviceId,
        streamId,
        params,
      );
      for await (const chunk of stream) {
        frameCount += 1;
        const payload =
          (chunk["payload"] as Record<string, unknown> | undefined) ?? {};
        const frame = this.normalizeCameraFrame(payload, deviceId);
        frame.streamId = streamId;
        lastFrameAt = frame.capturedAt;
        this.publishCameraFrame(frame);
        // chunk.type === "end" / "error" 时也走完 for-await，让流自然结束
        if (chunk["type"] === "error") {
          const errMsg =
            typeof payload["error"] === "string"
              ? payload["error"]
              : "camera stream reported error chunk";
          streamError = errMsg;
          break;
        }
      }
    } catch (err) {
      streamError = err instanceof Error ? err.message : String(err);
      console.log(
        `[Eye] camera.start_stream(${deviceId}) 流异常: ${streamError}`,
      );
    }

    return {
      ok: streamError === null,
      deviceId,
      streamId,
      frameCount,
      lastFrameAt,
      ...(streamError ? { error: streamError } : {}),
    };
  }

  // ---- 核心方法：sense ----

  /**
   * 感官查询。
   *
   * 支持 query.kind：
   *   - eye.desktop_frame：截一次桌面屏，返回 { base64/url, width, height, capturedAt }
   *   - eye.camera_frame ：从 camera 设备取一帧
   *   - eye.status       ：返回 { desktopOnline, cameras: [...] }
   *
   * query.params 可携带 deviceId / region 等参数。
   */
  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const kind = query.kind ?? "";
    const params = query.params ?? {};

    try {
      switch (kind) {
        case "eye.desktop_frame":
          return await this.senseDesktopFrame(params);
        case "eye.camera_frame":
          return await this.senseCameraFrame(params);
        case "eye.status":
          return await this.senseStatus();
        default:
          return {
            ok: false,
            data: {},
            module: "eye",
            errorMessage: `Eye: 不支持的 sense kind ${kind}`,
          };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(`[Eye] sense(${kind}) 异常: ${errorMessage}`);
      return {
        ok: false,
        data: {},
        module: "eye",
        errorMessage,
      };
    }
  }

  /** sense: eye.desktop_frame → 截一次桌面屏 */
  private async senseDesktopFrame(
    params: Record<string, unknown>,
  ): Promise<BodySenseResult> {
    const region = this.parseRegion(params["region"]);

    const dv = this.desktopVisualPort;
    if (dv?.screenshot) {
      try {
        const shot = await dv.screenshot(region ? { region } : undefined);
        const frame = this.normalizeFrame(shot, "desktop");
        return {
          ok: true,
          data: {
            base64: frame.base64,
            url: frame.url,
            width: frame.width,
            height: frame.height,
            capturedAt: frame.capturedAt,
            source: "desktop-visual-port",
          },
          module: "eye",
        };
      } catch (err) {
        return {
          ok: false,
          data: {},
          module: "eye",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return {
      ok: false,
      data: {},
      module: "eye",
      errorMessage:
        "Eye: 桌面截屏不可用（desktopVisualPort 未注入或无 screenshot 方法）",
    };
  }

  /** sense: eye.camera_frame → 从 camera 设备取一帧 */
  private async senseCameraFrame(
    params: Record<string, unknown>,
  ): Promise<BodySenseResult> {
    if (!this.deviceRegistry) {
      return {
        ok: false,
        data: {},
        module: "eye",
        errorMessage: "Eye: 摄像头不可用（deviceRegistry 未注入）",
      };
    }

    const deviceId =
      typeof params["deviceId"] === "string" ? params["deviceId"] : "";
    if (!deviceId) {
      return {
        ok: false,
        data: {},
        module: "eye",
        errorMessage: "Eye: eye.camera_frame 缺少 deviceId 参数",
      };
    }

    const invokeParams = this.extractParams(params, ["deviceId"]);
    try {
      const r = await this.deviceRegistry.invoke(
        deviceId,
        "camera.take_photo",
        invokeParams,
      );
      if (!r.ok) {
        return {
          ok: false,
          data: {},
          module: "eye",
          errorMessage: "camera.take_photo 调用失败",
        };
      }
      const result = (r.result ?? {}) as Record<string, unknown>;
      const frame = this.normalizeCameraFrame(result, deviceId);
      // sense 路径同样发布帧信号，便于其他 BodyModule 感知最新视觉输入
      this.publishCameraFrame(frame);
      return {
        ok: true,
        data: {
          base64: frame.base64,
          url: frame.url,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
          deviceId,
          result,
        },
        module: "eye",
      };
    } catch (err) {
      return {
        ok: false,
        data: {},
        module: "eye",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** sense: eye.status → 返回桌面 + cameras 状态 */
  private async senseStatus(): Promise<BodySenseResult> {
    const desktopOnline = Boolean(this.desktopVisualPort?.screenshot);

    const cameras: CameraInfo[] = [];
    if (this.deviceRegistry?.listByCapability) {
      try {
        const list = this.deviceRegistry.listByCapability("camera");
        for (const d of list) {
          cameras.push({ deviceId: d.deviceId, kind: d.kind });
        }
      } catch {
        // 列举失败不阻断，返回空 cameras
      }
    }

    return {
      ok: true,
      data: {
        desktopOnline,
        cameras,
        desktopVisualPortAvailable: this.desktopVisualPort !== null,
        deviceRegistryAvailable: this.deviceRegistry !== null,
      },
      module: "eye",
    };
  }

  // ---- snapshot ----

  /** 模块快照（标准实现，无额外元数据） */
  snapshot(): BodyModuleSnapshot {
    const subsystems: string[] = [];
    if (this.desktopVisualPort) subsystems.push("desktop-visual-port");
    if (this.deviceRegistry) subsystems.push("device-registry");

    return {
      name: "eye",
      label: this.label,
      tools: [...this.tools],
      online: this.started,
      subsystems,
      lastActivityAt: this.lastActivityAt,
    };
  }

  // ---- registerTools ----

  /**
   * 把 desktop.visual.screenshot / desktop.visual.describe /
   * camera.take_photo / camera.start_stream 工具挂到外部 ToolRegistry，
   * handler 内部委托 this.act()。
   *
   * actorId 暂时无法获取（BodyToolRegistry 接口未传 context），保持 undefined。
   * 返回值：成功 { ok: true, ...result.result }；失败 { ok: false, error, ...result.result }。
   */
  registerTools(registry: BodyToolRegistry): void {
    for (const toolName of this.tools) {
      registry.register(toolName, async (input) => {
        const result = await this.act({
          tool: toolName,
          args: input,
          source: "body_module",
        });
        if (!result.ok) {
          return {
            ok: false,
            error:
              result.errorMessage ??
              result.reason ??
              "body module action failed",
            ...result.result,
          };
        }
        return { ok: true, ...result.result };
      });
    }
  }

  // ---- 内部工具 ----

  /** 解析 region 参数为 [left, top, width, height] 元组；非法时返回 undefined */
  private parseRegion(
    value: unknown,
  ): [number, number, number, number] | undefined {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !value.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      return undefined;
    }
    return [value[0], value[1], value[2], value[3]];
  }

  /** 从 args 中提取图像输入（base64 或 url） */
  private parseImageInput(
    args: Record<string, unknown>,
  ): { base64?: string; url?: string } | null {
    const imageField = args["image"];
    if (imageField && typeof imageField === "object") {
      const obj = imageField as Record<string, unknown>;
      const base64 =
        typeof obj["base64"] === "string" ? obj["base64"] : undefined;
      const url = typeof obj["url"] === "string" ? obj["url"] : undefined;
      if (base64 || url) return { base64, url };
    }
    const topBase64 =
      typeof args["base64"] === "string" ? args["base64"] : undefined;
    const topUrl = typeof args["url"] === "string" ? args["url"] : undefined;
    if (topBase64 || topUrl) return { base64: topBase64, url: topUrl };
    return null;
  }

  /**
   * 把截屏子系统的返回值归一成 VisualFrame。
   * 同时接受 base64/imageBase64 与 url 字段（兼容 DesktopVisualPort）。
   */
  private normalizeFrame(
    shot: {
      base64?: string;
      url?: string;
      width?: number;
      height?: number;
    } | undefined,
    source: "desktop" | "camera",
    deviceId?: string,
  ): VisualFrame {
    const raw = (shot ?? {}) as Record<string, unknown>;
    const base64 =
      typeof raw["base64"] === "string"
        ? raw["base64"]
        : typeof raw["imageBase64"] === "string"
          ? (raw["imageBase64"] as string)
          : undefined;
    const url = typeof raw["url"] === "string" ? raw["url"] : undefined;
    const width = typeof raw["width"] === "number" ? raw["width"] : undefined;
    const height =
      typeof raw["height"] === "number" ? raw["height"] : undefined;
    return {
      base64,
      url,
      width,
      height,
      capturedAt: new Date().toISOString(),
      source,
      deviceId,
    };
  }

  /** 归一摄像头帧（接受 result.data / result.payload / result.base64 三种形态） */
  private normalizeCameraFrame(
    result: Record<string, unknown>,
    deviceId: string,
  ): VisualFrame {
    // 优先识别嵌套 data / payload
    const nested =
      (result["data"] as Record<string, unknown> | undefined) ??
      (result["payload"] as Record<string, unknown> | undefined);
    const src = nested ?? result;
    return this.normalizeFrame(
      {
        base64:
          typeof src["base64"] === "string" ? (src["base64"] as string) : undefined,
        url: typeof src["url"] === "string" ? (src["url"] as string) : undefined,
        width: typeof src["width"] === "number" ? (src["width"] as number) : undefined,
        height:
          typeof src["height"] === "number" ? (src["height"] as number) : undefined,
      },
      "camera",
      deviceId,
    );
  }

  /** 发布 body.eye.frame 桌面帧信号 */
  private publishDesktopFrame(frame: VisualFrame): void {
    try {
      this.bodyBus.publish({
        kind: "body.eye.frame",
        module: "eye",
        payload: {
          base64: frame.base64,
          url: frame.url,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
          source: frame.source,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.log(`[Eye] publishDesktopFrame 异常: ${err}`);
    }
  }

  /** 发布 body.eye.camera_frame 摄像头帧信号 */
  private publishCameraFrame(frame: VisualFrame): void {
    try {
      this.bodyBus.publish({
        kind: "body.eye.camera_frame",
        module: "eye",
        payload: {
          base64: frame.base64,
          url: frame.url,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
          source: frame.source,
          deviceId: frame.deviceId,
          streamId: frame.streamId,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.log(`[Eye] publishCameraFrame 异常: ${err}`);
    }
  }

  /** 从 args 中剔除指定 keys 后剩余字段作为 params */
  private extractParams(
    args: Record<string, unknown>,
    exclude: string[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!exclude.includes(k)) {
        out[k] = v;
      }
    }
    return out;
  }

  /** 记录最近一次活动时间 */
  private touchActivity(): void {
    this.lastActivityAt = new Date().toISOString();
  }
}
