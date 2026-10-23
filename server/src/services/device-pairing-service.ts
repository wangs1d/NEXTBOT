/**
 * 设备配对服务 —— 终端互连平台的「身份绑定」层
 *
 * 与 AgentPairingService 的关系：
 *  - AgentPairingService：解决「Agent 间协作组」（sessionId ↔ code，对称关系）
 *  - DevicePairingService：解决「设备归属」（deviceId ↔ ownerUserId，从属关系）
 *
 * 配对流程：
 *  1. 用户在 Flutter「我的设备」页点「添加设备」→ POST /device/pairing/code
 *     服务端生成 6 位配对码（10 分钟有效），返回给用户展示
 *  2. 用户在新设备端输入配对码 → 设备端 POST /device/pair { code, deviceId, kind, name }
 *     服务端校验配对码 → 绑定 deviceId 到 ownerUserId → 持久化
 *  3. 设备走 WS device.register 时带上 ownerUserId（已绑定关系）
 *     ws-device-handler 可软校验：deviceId 绑定的 owner 与 register 的 ownerUserId 是否一致
 *
 * 配对码特征：
 *  - 6 位大写字母+数字（剔除易混淆字符 0/O/I/1/L）
 *  - TTL 10 分钟，一次性使用（consume 后删除）
 *  - 内存存储（不落盘；进程重启清空，用户重新生成即可）
 *
 * 绑定关系持久化：
 *  - 默认 data/device-pairing.json
 *  - 结构：{ deviceId -> { ownerUserId, kind, name, boundAt } }
 *  - 同一 deviceId 重复配对会覆盖（解绑后再绑）
 */
import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

/** 已配对设备的持久化记录。 */
export interface PairedDeviceRecord {
  deviceId: string;
  ownerUserId: string;
  kind: string;
  name: string;
  boundAt: number;
  /** 配对时声明的元数据（型号 / 系统等），可选。 */
  metadata?: Record<string, unknown>;
}

interface PendingCode {
  ownerUserId: string;
  code: string;
  expiresAt: number;
  /** 可选：限定只能配对某种 kind（如用户选「添加摄像头」时锁定 kind=camera）。 */
  deviceKind?: string;
}

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 剔除 0/O/I/1/L
const CODE_LENGTH = 6;

export class DevicePairingService {
  private readonly pendingCodes = new Map<string, PendingCode>();
  private readonly bindings = new Map<string, PairedDeviceRecord>();
  private readonly ownerIndex = new Map<string, Set<string>>();

  private get persistPath(): string {
    return process.env.DEVICE_PAIRING_FILE ?? join(getDataDir(), "device-pairing.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as { bindings?: PairedDeviceRecord[] };
      const list = data.bindings ?? [];
      this.bindings.clear();
      this.ownerIndex.clear();
      for (const rec of list) {
        if (!rec.deviceId || !rec.ownerUserId) continue;
        this.bindings.set(rec.deviceId, rec);
        this.indexOwner(rec.ownerUserId, rec.deviceId);
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    const bindings = Array.from(this.bindings.values());
    const payload = JSON.stringify({ bindings }, null, 2);
    await writeFile(this.persistPath, payload, "utf8");
  }

  /** 生成 6 位配对码，10 分钟有效。返回码本身。 */
  generateCode(ownerUserId: string, deviceKind?: string): string {
    if (!ownerUserId) throw new Error("ownerUserId 不能为空");
    // 同一用户同时只能有一个有效码（避免混乱）；先清理旧的
    this.clearPendingByOwner(ownerUserId);
    const code = generateRandomCode();
    this.pendingCodes.set(code, {
      ownerUserId,
      code,
      expiresAt: Date.now() + CODE_TTL_MS,
      deviceKind,
    });
    return code;
  }

  /** 查询某用户当前未消费的配对码（用于前端展示）。 */
  getPendingCode(ownerUserId: string): { code: string; expiresAt: number; deviceKind?: string } | null {
    this.cleanupExpired();
    for (const pending of this.pendingCodes.values()) {
      if (pending.ownerUserId === ownerUserId) {
        return { code: pending.code, expiresAt: pending.expiresAt, deviceKind: pending.deviceKind };
      }
    }
    return null;
  }

  /**
   * 消费配对码：把设备绑定到配对码对应的 ownerUserId。
   *  - 码不存在 / 过期 / kind 不匹配 → 抛错
   *  - 同一 deviceId 已绑定到其他用户 → 抛错（需先解绑）
   *  - 同一 deviceId 已绑定到同一用户 → 覆盖更新（刷新 kind/name）
   *  成功后删除配对码（一次性）。
   */
  async consumeCode(
    code: string,
    deviceId: string,
    info: { kind: string; name: string; metadata?: Record<string, unknown> },
  ): Promise<PairedDeviceRecord> {
    const normalized = code.trim().toUpperCase();
    this.cleanupExpired();
    const pending = this.pendingCodes.get(normalized);
    if (!pending) {
      throw new Error("配对码不存在或已过期");
    }
    if (pending.deviceKind && pending.deviceKind !== info.kind) {
      throw new Error(`配对码限定 kind=${pending.deviceKind}，但设备声明 kind=${info.kind}`);
    }
    const existing = this.bindings.get(deviceId);
    if (existing && existing.ownerUserId !== pending.ownerUserId) {
      throw new Error(`设备 ${deviceId} 已绑定到其他用户，请先解绑`);
    }
    const record: PairedDeviceRecord = {
      deviceId,
      ownerUserId: pending.ownerUserId,
      kind: info.kind,
      name: info.name,
      boundAt: Date.now(),
      metadata: info.metadata,
    };
    this.bindings.set(deviceId, record);
    this.indexOwner(pending.ownerUserId, deviceId);
    this.pendingCodes.delete(normalized);
    await this.persist();
    return record;
  }

  /** 解绑设备。返回是否成功（设备不存在返回 false）。 */
  async unbind(deviceId: string): Promise<boolean> {
    const rec = this.bindings.get(deviceId);
    if (!rec) return false;
    this.bindings.delete(deviceId);
    this.unindexOwner(rec.ownerUserId, deviceId);
    await this.persist();
    return true;
  }

  /** 列出某用户已绑定的所有设备。 */
  listDevices(ownerUserId: string): PairedDeviceRecord[] {
    const ids = this.ownerIndex.get(ownerUserId);
    if (!ids || ids.size === 0) return [];
    const out: PairedDeviceRecord[] = [];
    for (const id of ids) {
      const rec = this.bindings.get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  /** 查询某设备的归属用户。 */
  getOwner(deviceId: string): string | undefined {
    return this.bindings.get(deviceId)?.ownerUserId;
  }

  /** 查询某设备的完整绑定记录。 */
  getBinding(deviceId: string): PairedDeviceRecord | undefined {
    return this.bindings.get(deviceId);
  }

  /** 校验 deviceId 是否绑定到指定 ownerUserId。 */
  isBoundTo(deviceId: string, ownerUserId: string): boolean {
    return this.bindings.get(deviceId)?.ownerUserId === ownerUserId;
  }

  // ---------- 内部工具 ----------

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [code, pending] of this.pendingCodes) {
      if (pending.expiresAt <= now) {
        this.pendingCodes.delete(code);
      }
    }
  }

  private clearPendingByOwner(ownerUserId: string): void {
    for (const [code, pending] of this.pendingCodes) {
      if (pending.ownerUserId === ownerUserId) {
        this.pendingCodes.delete(code);
      }
    }
  }

  private indexOwner(ownerUserId: string, deviceId: string): void {
    let set = this.ownerIndex.get(ownerUserId);
    if (!set) {
      set = new Set();
      this.ownerIndex.set(ownerUserId, set);
    }
    set.add(deviceId);
  }

  private unindexOwner(ownerUserId: string, deviceId: string): void {
    const set = this.ownerIndex.get(ownerUserId);
    if (!set) return;
    set.delete(deviceId);
    if (set.size === 0) this.ownerIndex.delete(ownerUserId);
  }
}

function generateRandomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  // 用 crypto.getRandomValues 保证均匀分布；Node 18+ 全局可用
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}
