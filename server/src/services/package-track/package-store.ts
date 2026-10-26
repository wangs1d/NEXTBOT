/**
 * 包裹实体登记表（JSON 文件，风格对齐 booking-order-store）。
 * SourceStore 只追加、无可变状态，答不了"我的快递到哪了"；本表把多条来源
 * （菜鸟推送/派件短信/发货邮件）收敛成一个有状态实体：消息流 → 本表 → provider 补轨迹。
 *
 * 两条撑住数据的不变量：
 *  - 合并键是运单号本身，承运码后补——先收到没带承运商的短信、后收到推送时实体不分裂。
 *  - 状态 rank 只增不减（营销短信里一句"已发货"不能把派送中的件倒退到待揽收）；
 *    唯一例外 exception，"退回/拒收"发生在签收之后是真事件，允许覆盖终态。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import {
  PACKAGE_STATUS_RANK,
  PACKAGE_TERMINAL_STATUSES,
  type PackageStatus,
  type PackageClue,
  courierName,
} from "./express-extract.js";

export type PackageEvent = {
  at: string;
  source: string;
  status: PackageStatus;
  /** 摘录原文（判定依据，审计用） */
  text: string;
};

/** provider 回传的官方轨迹点 */
export type PackageTrackPoint = {
  time: string;
  description: string;
};

export type StoredPackage = {
  packageId: string;
  actorId: string;
  trackingNo: string | null;
  courierCode: string | null;
  courierName: string | null;
  status: PackageStatus;
  /** 判定状态的原始词（规则产物，非官方回传） */
  statusWord: string | null;
  /** 最近一次状态跃迁时刻 */
  statusAt: string;
  pickupCode: string | null;
  phoneTail: string | null;
  sourcePlatforms: string[];
  events: PackageEvent[];
  /** 官方轨迹（null = 从未成功补全过；空数组 = 查到了但没有节点） */
  trajectory: PackageTrackPoint[] | null;
  trajectoryAt: string | null;
  /** 最近一次补轨迹失败原因（工具侧如实展示，不拿失败冒充无轨迹） */
  trajectoryError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PackageIngestResult =
  | { kind: "created"; package: StoredPackage }
  | { kind: "transition"; package: StoredPackage; from: PackageStatus }
  /** 状态没变但补到了新信息（首次拿到取件码/承运商/单号）——同样值得一播 */
  | { kind: "enriched"; package: StoredPackage }
  | { kind: "noop"; package: StoredPackage };

export type PackageListFilter = {
  statuses?: PackageStatus[];
  /** 缺省 false：已签收的不再出现在"我的快递"里 */
  includeFinished?: boolean;
  limit?: number;
};

/** 单实体保留的摘录条数（只留最近几条，够回溯即可） */
const EVENTS_MAX = 8;

const iso = (at: number) => new Date(at).toISOString();

function hashShort(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export class PackageStore {
  private readonly packages = new Map<string, StoredPackage>();
  /** actor → 收件手机尾号（只留后四位：查询校验够用，全号不落盘） */
  private readonly contacts = new Map<string, { phoneTail: string; updatedAt: string }>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly file: string | null = null) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      if (existsSync(this.file)) {
        const raw = await readFile(this.file, "utf8");
        const parsed = JSON.parse(raw) as {
          packages?: StoredPackage[];
          contacts?: Array<{ actorId: string; phoneTail: string; updatedAt: string }>;
        };
        for (const p of parsed.packages ?? []) {
          if (p?.packageId) this.packages.set(p.packageId, p);
        }
        for (const c of parsed.contacts ?? []) {
          if (c?.actorId && c.phoneTail) {
            this.contacts.set(c.actorId, { phoneTail: c.phoneTail, updatedAt: c.updatedAt ?? "" });
          }
        }
      }
    } catch {
      // 损坏文件从空开始（与 booking-order-store 容错策略一致）
    }
  }

  private persist(): void {
    if (!this.file) return;
    const file = this.file;
    const payload = JSON.stringify(
      {
        packages: [...this.packages.values()],
        contacts: [...this.contacts.entries()].map(([actorId, c]) => ({ actorId, ...c })),
      },
      null,
      2,
    );
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, file);
      })
      .catch((err) => {
        console.warn("[PackageStore] 包裹登记表写盘失败", err);
      });
  }

  /** 等落盘完成（测试与退出前用） */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private static keyOf(clue: PackageClue, at: number): string {
    if (clue.trackingNo) return `trk_${clue.trackingNo}`;
    // 只有取件码：按「码 + 平台 + 天」归一，同一条驿站短信的重复推送不会生成多实体
    const day = iso(at).slice(0, 10);
    return `puc_${hashShort(`${clue.pickupCode ?? ""}|${clue.sourcePlatform}|${day}`)}`;
  }

  /**
   * 汇入一条线索：创建实体 / 状态跃迁 / 无变化。
   * "无变化"必须原样返回，调用方据此决定要不要发信号——否则同一件快递
   * 被三条来源各报一次就会播报三次。
   */
  /**
   * 归并"只有取件码"的孪生实体：驿站短信常不带运单号，先生成了 puc_ 实体；
   * 之后菜鸟推送补上运单号会另起 trk_ 实体 —— 不归并就是同一个件的两张卡。
   */
  private absorbPickupTwin(target: StoredPackage, actorId: string, pickupCode: string | null): void {
    if (!pickupCode) return;
    for (const [id, twin] of this.packages) {
      if (id === target.packageId) continue;
      if (!id.startsWith("puc_") || twin.trackingNo) continue;
      if (twin.actorId !== actorId || twin.pickupCode !== pickupCode) continue;
      target.events = [...twin.events, ...target.events].slice(-EVENTS_MAX);
      for (const platform of twin.sourcePlatforms) {
        if (!target.sourcePlatforms.includes(platform)) target.sourcePlatforms.push(platform);
      }
      if (PACKAGE_STATUS_RANK[twin.status] > PACKAGE_STATUS_RANK[target.status]) {
        target.status = twin.status;
        target.statusAt = twin.statusAt;
      }
      this.packages.delete(id);
    }
  }

  async ingestPackageClue(actorId: string, clue: PackageClue, at = Date.now()): Promise<PackageIngestResult> {
    await this.ensureLoaded();
    const key = PackageStore.keyOf(clue, at);
    const existing = this.packages.get(key);

    if (!existing) {
      const created: StoredPackage = {
        packageId: key,
        actorId,
        trackingNo: clue.trackingNo,
        courierCode: clue.courierCode,
        courierName: clue.courierCode ? (courierName(clue.courierCode) ?? clue.courierName) : null,
        status: clue.status,
        statusWord: clue.statusWord,
        statusAt: iso(at),
        pickupCode: clue.pickupCode,
        phoneTail: clue.phoneTail,
        sourcePlatforms: [clue.sourcePlatform],
        events: [{ at: iso(at), source: clue.sourcePlatform, status: clue.status, text: clue.excerpt }],
        trajectory: null,
        trajectoryAt: null,
        trajectoryError: null,
        createdAt: iso(at),
        updatedAt: iso(at),
      };
      this.packages.set(key, created);
      if (created.trackingNo) this.absorbPickupTwin(created, actorId, created.pickupCode);
      this.persist();
      return { kind: "created", package: created };
    }

    const from = existing.status;
    let changed = false;

    // 后到的强信息补齐先前缺失的字段（承运商/单号/取件码/尾号）
    if (clue.courierCode && !existing.courierCode) {
      existing.courierCode = clue.courierCode;
      existing.courierName = courierName(clue.courierCode);
      changed = true;
    }
    if (clue.trackingNo && !existing.trackingNo) {
      existing.trackingNo = clue.trackingNo;
      changed = true;
    }
    if (clue.pickupCode && !existing.pickupCode) {
      existing.pickupCode = clue.pickupCode;
      changed = true;
    }
    if (clue.phoneTail && !existing.phoneTail) {
      existing.phoneTail = clue.phoneTail;
      changed = true;
    }

    const canTransition =
      clue.status !== "unknown" &&
      (clue.status === "exception" || PACKAGE_STATUS_RANK[clue.status] > PACKAGE_STATUS_RANK[from]);
    if (canTransition) {
      existing.status = clue.status;
      existing.statusWord = clue.statusWord;
      existing.statusAt = iso(at);
      existing.events = [...existing.events, { at: iso(at), source: clue.sourcePlatform, status: clue.status, text: clue.excerpt }].slice(-EVENTS_MAX);
      changed = true;
    }

    if (!existing.sourcePlatforms.includes(clue.sourcePlatform)) {
      existing.sourcePlatforms.push(clue.sourcePlatform);
      changed = true;
    }

    if (!changed) return { kind: "noop", package: existing };

    existing.updatedAt = iso(at);
    this.packages.set(existing.packageId, existing);
    this.persist();
    return canTransition
      ? { kind: "transition", package: existing, from }
      : { kind: "enriched", package: existing };
  }

  async listPackages(actorId: string, filter: PackageListFilter = {}): Promise<StoredPackage[]> {
    await this.ensureLoaded();
    const includeFinished = filter.includeFinished ?? false;
    const out: StoredPackage[] = [];
    const entries = [...this.packages.values()]
      .filter((p) => p.actorId === actorId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    for (const p of entries) {
      if (!includeFinished && PACKAGE_TERMINAL_STATUSES.has(p.status)) continue;
      if (filter.statuses && !filter.statuses.includes(p.status)) continue;
      out.push(p);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  /** 按运单号或 packageId 取单个实体（运单号查询忽略大小写与空格） */
  async findPackage(actorId: string, idOrTrackingNo: string): Promise<StoredPackage | null> {
    await this.ensureLoaded();
    const raw = idOrTrackingNo.trim().toUpperCase().replace(/\s+/g, "");
    for (const p of this.packages.values()) {
      if (p.actorId !== actorId) continue;
      if (p.packageId === idOrTrackingNo.trim()) return p;
      if (p.trackingNo && p.trackingNo.toUpperCase().replace(/\s+/g, "") === raw) return p;
    }
    return null;
  }

  async applyTrajectory(
    packageId: string,
    points: PackageTrackPoint[],
    at = Date.now(),
  ): Promise<StoredPackage | null> {
    await this.ensureLoaded();
    const p = this.packages.get(packageId);
    if (!p) return null;
    p.trajectory = points;
    p.trajectoryAt = iso(at);
    p.trajectoryError = null;
    p.updatedAt = iso(at);
    this.persist();
    return p;
  }

  /** 记录补轨迹失败原因（失败 ≠ 空轨迹，两者在工具侧话术上必须分开） */
  async noteTrajectoryError(packageId: string, reason: string): Promise<void> {
    await this.ensureLoaded();
    const p = this.packages.get(packageId);
    if (!p) return;
    p.trajectoryError = reason.slice(0, 200);
    this.persist();
  }

  async setContactPhone(actorId: string, phone: string, at = Date.now()): Promise<{ phoneTail: string }> {
    await this.ensureLoaded();
    const tail = phone.slice(-4);
    this.contacts.set(actorId, { phoneTail: tail, updatedAt: iso(at) });
    this.persist();
    return { phoneTail: tail };
  }

  async getContactPhone(actorId: string): Promise<{ phoneTail: string } | null> {
    await this.ensureLoaded();
    const c = this.contacts.get(actorId);
    return c ? { phoneTail: c.phoneTail } : null;
  }

  stats(): { total: number; active: number } {
    let active = 0;
    for (const p of this.packages.values()) {
      if (!PACKAGE_TERMINAL_STATUSES.has(p.status)) active += 1;
    }
    return { total: this.packages.size, active };
  }
}
