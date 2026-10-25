/**
 * 每个 sessionId 保留全部活跃连接（电脑端 + 手机端互通：多设备同时在线 fan-out，
 * 任一设备可收；全部掉线才算离线。旧语义"后连覆盖"会导致另一端永远收不到）。
 *
 * 设备类别（2026-09-18）：客户端在 session.init 自报 platform，归一为 desktop | mobile
 * 后随连接登记。critical 升级链据此做设备分级触达：
 *   - 两端都在线 → 全端 fan-out（现状不变）
 *   - 仅一端在线 → WS 事件仍 fan-out（另一端不在线收不到是自然语义）
 *   - 全部离线   → 升级链跳过"假装弹窗"，直达 手机推送 → 短信 → 微信 的离线必达通道
 */
export type DeviceClass = "desktop" | "mobile";

export type WsLike = {
  send(data: string): void;
  readyState?: number;
};

/** session.init 自报的 platform/deviceClass 归一：手机系 → mobile，其余（含缺省）→ desktop。
 * 缺省归 desktop 是向后兼容：旧客户端（未带 platform）语义不变。 */
export function normalizeDeviceClass(raw: unknown): DeviceClass {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (["mobile", "android", "ios", "phone"].includes(s)) return "mobile";
  return "desktop";
}

interface SocketEntry {
  socket: WsLike;
  deviceClass: DeviceClass;
  /** 终端最近一次"真人活动"时间（非 keepalive 的业务消息刷新；设备智能路由用） */
  lastActiveAt: number;
}

export class WsConnectionRegistry {
  private readonly connections = new Map<string, Set<SocketEntry>>();

  /** 连接变化回调（PresenceService 在场感知接线；首连接 true / 末断开 false，fire-and-forget） */
  onConnectionChange?: (actorId: string, connected: boolean) => void;

  register(sessionId: string, socket: WsLike, meta?: { deviceClass?: DeviceClass }): void {
    let set = this.connections.get(sessionId);
    if (!set) {
      set = new Set();
      this.connections.set(sessionId, set);
    }
    set.add({ socket, deviceClass: meta?.deviceClass ?? "desktop", lastActiveAt: Date.now() });
    if (set.size === 1) {
      try {
        this.onConnectionChange?.(sessionId, true);
      } catch {
        /* 回调失败不影响连接登记 */
      }
    }
  }

  /**
   * 移除指定 socket（多设备下各 socket 独立登记，旧连接 close 只摘除自己，
   * 不会误删另一端的新连接）。末个连接移除后标记离线。
   */
  unregister(sessionId: string, socket: WsLike): void {
    const set = this.connections.get(sessionId);
    if (!set) return;
    const entry = [...set].find((e) => e.socket === socket);
    if (!entry || !set.delete(entry)) return;
    if (set.size === 0) {
      this.connections.delete(sessionId);
      try {
        this.onConnectionChange?.(sessionId, false);
      } catch {
        /* 回调失败不影响连接清理 */
      }
    }
  }

  /** 当前有活连接的 session 键（调试/手动触发用：不传 sessionId 时取它） */
  connectedSessionIds(): string[] {
    return [...this.connections.keys()];
  }

  get(sessionId: string): WsLike | undefined {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0) return undefined;
    return [...set][set.size - 1].socket;
  }

  isOnline(sessionId: string): boolean {
    const set = this.connections.get(sessionId);
    return !!set && set.size > 0;
  }

  /**
   * 全量广播（客户端版本更新推送等运营事件）：遍历全部 session 的全部连接，
   * open 状态才发；单连接发送失败吞掉（不影响其余连接，也不影响遍历）。
   */
  broadcastAll(data: string): void {
    for (const set of this.connections.values()) {
      for (const entry of set) {
        const open =
          entry.socket.readyState === undefined || entry.socket.readyState === 1;
        if (!open) continue;
        try {
          entry.socket.send(data);
        } catch {
          /* 半开连接 send 可能抛错：吞掉，其余连接照常 */
        }
      }
    }
  }

  /** 该 actor 是否有指定类别的在线设备（升级链设备分级路由用） */
  hasDeviceClass(sessionId: string, deviceClass: DeviceClass): boolean {
    const set = this.connections.get(sessionId);
    if (!set) return false;
    for (const entry of set) {
      const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
      if (open && entry.deviceClass === deviceClass) return true;
    }
    return false;
  }

  /**
   * 查指定连接自报的设备类别（2026-10-07）：chat 轮注入【运行环境】块用——
   * agent 需要知道「用户此刻在手机上还是电脑上」（手机端回复要短、别引导桌面操作）。
   * 找不到（连接未登记/已断开）返回 undefined，调用方按缺省桌面处理或不注入。
   */
  deviceClassOf(sessionId: string, socket: WsLike): DeviceClass | undefined {
    const set = this.connections.get(sessionId);
    if (!set) return undefined;
    return [...set].find((e) => e.socket === socket)?.deviceClass;
  }

  /** 在线设备类别清单（诊断/状态接口用） */
  getOnlineDeviceClasses(sessionId: string): DeviceClass[] {
    const set = this.connections.get(sessionId);
    if (!set) return [];
    const classes = new Set<DeviceClass>();
    for (const entry of set) {
      const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
      if (open) classes.add(entry.deviceClass);
    }
    return [...classes];
  }

  /**
   * 终端活动刷新（2026-10-08 提醒智能路由）：终端每条业务 WS 消息（chat / ack / sync 回执等，
   * 不含 ws.keepalive——后台挂着的连接不代表"人在看"）调用一次，维护该连接的 lastActiveAt。
   * 连接未登记（未 session.init）时静默忽略。
   */
  touchActivity(sessionId: string, socket: WsLike): void {
    const set = this.connections.get(sessionId);
    if (!set) return;
    const entry = [...set].find((e) => e.socket === socket);
    if (entry) entry.lastActiveAt = Date.now();
  }

  /**
   * 最近活跃设备的类别（withinMs 窗口内有真人活动的连接里取最新一条）。
   * 找不到 → undefined（调用方按"位置未知"处理）。提醒单端投递的判定核心。
   */
  mostRecentActiveDeviceClass(sessionId: string, withinMs: number): DeviceClass | undefined {
    const set = this.connections.get(sessionId);
    if (!set) return undefined;
    const cutoff = Date.now() - withinMs;
    let best: SocketEntry | undefined;
    for (const entry of set) {
      const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
      if (!open || entry.lastActiveAt < cutoff) continue;
      if (!best || entry.lastActiveAt > best.lastActiveAt) best = entry;
    }
    return best?.deviceClass;
  }

  /**
   * 仅向"最近活跃"的那一个连接投递（同窗口多端活跃时取最新），任一端有真人活动即不算全端打扰。
   * 返回是否成功送达（无活跃端 / 发送失败 → false，调用方自行降级 fan-out）。
   */
  trySendToActiveDevice(sessionId: string, data: string, withinMs: number): boolean {
    const set = this.connections.get(sessionId);
    if (!set) return false;
    const cutoff = Date.now() - withinMs;
    let best: SocketEntry | undefined;
    for (const entry of [...set]) {
      const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
      if (!open || entry.lastActiveAt < cutoff) continue;
      if (!best || entry.lastActiveAt > best.lastActiveAt) best = entry;
    }
    if (!best) return false;
    return this.trySendEntry(sessionId, best, data);
  }

  /**
   * 按设备类别优先级投递：第一个有在线设备的类别独占接收（手机优先的闹钟触达用，
   * 闹铃只在"跟人睡"的那台设备上响，不两端齐响）。
   */
  trySendToDeviceClassOrder(sessionId: string, data: string, orderedClasses: DeviceClass[]): boolean {
    for (const dc of orderedClasses) {
      if (this.trySendToDeviceClasses(sessionId, data, [dc])) return true;
    }
    return false;
  }

  /** 向该 actor 的全部在线设备投递（电脑端 + 手机端都收到），任一成功即算送达 */
  trySend(sessionId: string, data: string): boolean {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0) return false;
    let delivered = false;
    for (const entry of [...set]) {
      delivered = this.trySendEntry(sessionId, entry, data) || delivered;
    }
    return delivered;
  }

  /** 仅向指定类别的在线设备投递（升级链按设备分级触达用），任一成功即算送达 */
  trySendToDeviceClasses(sessionId: string, data: string, deviceClasses: DeviceClass[]): boolean {
    const set = this.connections.get(sessionId);
    if (!set || set.size === 0 || deviceClasses.length === 0) return false;
    let delivered = false;
    for (const entry of [...set]) {
      if (!deviceClasses.includes(entry.deviceClass)) continue;
      delivered = this.trySendEntry(sessionId, entry, data) || delivered;
    }
    return delivered;
  }

  private trySendEntry(sessionId: string, entry: SocketEntry, data: string): boolean {
    const open = entry.socket.readyState === undefined || entry.socket.readyState === 1;
    if (!open) {
      this.dropSocket(sessionId, entry.socket);
      return false;
    }
    try {
      entry.socket.send(data);
      return true;
    } catch {
      this.dropSocket(sessionId, entry.socket);
      return false;
    }
  }

  /** 静默清理死连接（无 close 事件时 trySend 兜底），末个移除同样标记离线 */
  private dropSocket(sessionId: string, socket: WsLike): void {
    const set = this.connections.get(sessionId);
    if (!set) return;
    const entry = [...set].find((e) => e.socket === socket);
    if (!entry || !set.delete(entry)) return;
    if (set.size === 0) {
      this.connections.delete(sessionId);
      try {
        this.onConnectionChange?.(sessionId, false);
      } catch {
        /* 回调失败不影响连接清理 */
      }
    }
  }
}
