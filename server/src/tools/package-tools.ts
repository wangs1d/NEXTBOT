/**
 * 快递查询工具（查询的一半；数据进入在 services/package-track/package-intake.ts）。
 *
 * 沿用 order.status 的分工纪律：**先看本地登记表，采集到什么就报什么**，
 * 库里没有就如实说没有，绝不编造物流状态。官方轨迹只在丰桥密钥就绪时补，
 * 补失败就把失败原因原样带出（与"查到了但没有节点"区分开）。
 *
 * 工具名以 `package.` 为族；list/track 是只读（security/sensitive-action.ts 已登记），
 * add/bind_phone 只写本地库，不外呼、不触外部。
 */
import type { ToolHandler, ToolRegistry } from "./tool-registry.js";
import { resolveActorId } from "../agent/actor-id.js";
import { PACKAGE_STATUS_LABELS, normalizeTrackingNo, type PackageClue } from "../services/package-track/express-extract.js";
import type { PackageStore, StoredPackage } from "../services/package-track/package-store.js";
import { selectProvider, type ExpressTrackProvider } from "../services/package-track/express-provider.js";

export type PackageToolsDeps = {
  store: PackageStore;
  providers: ExpressTrackProvider[];
  now?: () => number;
};

/** 轨迹缓存窗口：同一件在 20 分钟内重复问不再打接口 */
const TRACK_CACHE_TTL_MS = 20 * 60_000;
/** 运单号形态底线：8~20 位字母数字（手动补录时的输入校验） */
const TRACKING_NO_SHAPE = /^[A-Z0-9]{8,20}$/i;

type RefreshOutcome =
  | { state: "cached" | "ok"; points: StoredPackage["trajectory"] }
  | { state: "no_tracking_no" }
  | { state: "no_backend"; message: string }
  | { state: "failed"; message: string };

function describeBackendGap(providers: ExpressTrackProvider[], courierCode: string | null): string {
  if (providers.length === 0 || providers.every((p) => !p.configured())) {
    return "未配置轨迹查询后端（顺丰丰桥 SF_QIAO_PARTNER_ID / SF_QIAO_CHECK_WORD），当前只有通知侧状态";
  }
  return `承运商${courierCode ? ` ${courierCode}` : "未识别"}暂不在可查白名单内，当前只有通知侧状态`;
}

async function refreshTrajectory(
  deps: PackageToolsDeps,
  pkg: StoredPackage,
  force: boolean,
): Promise<RefreshOutcome> {
  if (!pkg.trackingNo) return { state: "no_tracking_no" };

  const now = deps.now?.() ?? Date.now();
  const cachedAt = pkg.trajectoryAt ? new Date(pkg.trajectoryAt).getTime() : 0;
  if (!force && pkg.trajectory && now - cachedAt < TRACK_CACHE_TTL_MS) {
    return { state: "cached", points: pkg.trajectory };
  }

  const provider = selectProvider(deps.providers, pkg.courierCode, pkg.trackingNo);
  if (!provider) {
    return { state: "no_backend", message: describeBackendGap(deps.providers, pkg.courierCode) };
  }
  const outcome = await provider.queryRoutes({
    trackingNo: pkg.trackingNo,
    courierCode: pkg.courierCode,
    phoneTail: pkg.phoneTail,
  });
  if (!outcome.ok) {
    await deps.store.noteTrajectoryError(pkg.packageId, outcome.error);
    return { state: "failed", message: outcome.error };
  }
  await deps.store.applyTrajectory(pkg.packageId, outcome.points, now);
  return { state: "ok", points: outcome.points };
}

function carrierLabel(pkg: StoredPackage): string {
  return pkg.courierName ?? pkg.courierCode ?? "未知承运商";
}

function headLabel(pkg: StoredPackage): string {
  return pkg.trackingNo ? `${carrierLabel(pkg)} ${pkg.trackingNo}` : `${carrierLabel(pkg)}（未抓到运单号）`;
}

function oneLine(pkg: StoredPackage): string {
  return `${headLabel(pkg)} ${PACKAGE_STATUS_LABELS[pkg.status]}${pkg.pickupCode ? `，取件码 ${pkg.pickupCode}` : ""}`;
}

function toListItem(pkg: StoredPackage) {
  const last = pkg.trajectory?.[0] ?? null;
  return {
    packageId: pkg.packageId,
    trackingNo: pkg.trackingNo,
    courier: carrierLabel(pkg),
    status: pkg.status,
    statusLabel: PACKAGE_STATUS_LABELS[pkg.status],
    statusAt: pkg.statusAt,
    pickupCode: pkg.pickupCode,
    sourcePlatforms: pkg.sourcePlatforms,
    latestNotify: pkg.events[pkg.events.length - 1]?.text ?? "",
    latestTrackPoint: last ? `${last.time} ${last.description}` : null,
  };
}

export function createPackageListHandler(deps: PackageToolsDeps): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const includeFinished = String(input.status ?? "").trim() === "all";
    const packages = await deps.store.listPackages(actorId, {
      includeFinished,
      limit: 20,
    });

    if (packages.length === 0) {
      return {
        ok: true,
        hasPackages: false,
        summary: includeFinished
          ? "包裹登记表中没有任何记录"
          : "包裹登记表中暂无在途包裹（手机通知/短信/邮件里未捕捉到含运单号的快递消息）",
        hint:
          "如实告知用户当前没有采集到快递记录。可建议：①确认手机通知授权与菜鸟/顺丰/京东 App 是否开启推送；" +
          "②用 package.add 手动补录运单号。绝不编造物流状态或件数。",
      };
    }

    return {
      ok: true,
      hasPackages: true,
      count: packages.length,
      packages: packages.map(toListItem),
      summary: `${includeFinished ? "全部" : "在途"} ${packages.length} 件：${packages.map(oneLine).join("；")}`,
      hint: "状态来自通知文本的规则判定；trajectory 缺失时说明未配置丰桥或该承运商不在白名单，不要臆测节点。",
    };
  };
}

export function createPackageTrackHandler(deps: PackageToolsDeps): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const raw = String(input.trackingNo ?? input.packageId ?? "").trim();
    if (!raw) return { ok: false, error: "缺少运单号 (trackingNo) 或 packageId" };

    const pkg = await deps.store.findPackage(actorId, raw);
    if (!pkg) {
      return {
        ok: true,
        found: false,
        summary: `登记表里没有运单号 ${raw.toUpperCase()} 的包裹`,
        hint: "先用 package.add 补录（把用户告知的单号登记进来）或 package.list 看现有件；不要凭单号形态猜测承运商与状态。",
      };
    }

    const force = input.refresh === true;
    const refresh = await refreshTrajectory(deps, pkg, force);
    const after = (await deps.store.findPackage(actorId, pkg.packageId)) ?? pkg;
    const points = after.trajectory ?? (refresh.state === "cached" || refresh.state === "ok" ? refresh.points : null);

    const view = {
      packageId: after.packageId,
      trackingNo: after.trackingNo,
      courier: carrierLabel(after),
      status: after.status,
      statusLabel: PACKAGE_STATUS_LABELS[after.status],
      statusAt: after.statusAt,
      pickupCode: after.pickupCode,
      phoneTail: after.phoneTail,
      sourcePlatforms: after.sourcePlatforms,
      notifications: after.events.slice(-4),
      trajectory: points ?? [],
      trajectoryFrom: points && points.length > 0 ? "丰桥官方路由查询" : null,
    };

    const notes: string[] = [];
    if (refresh.state === "no_tracking_no") notes.push("该件只捕捉到取件码、没抓到运单号，无法向承运商查轨迹");
    if (refresh.state === "no_backend" || refresh.state === "failed") notes.push(refresh.message);

    return {
      ok: true,
      found: true,
      ...view,
      summary:
        `${headLabel(after)} ${PACKAGE_STATUS_LABELS[after.status]}` +
        (after.pickupCode ? `，取件码 ${after.pickupCode}` : "") +
        (points && points.length > 0 ? `；最新节点：${points[0]!.time} ${points[0]!.description}` : "") +
        (notes.length > 0 ? `（${notes.join("；")}）` : ""),
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
      hint: "trajectory 为空且无 note 时，如实说没有节点；有 note 时把原因转达给用户，不要改成'暂无物流信息'这种含糊话术。",
    };
  };
}

export function createPackageAddHandler(deps: PackageToolsDeps): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const trackingNo = normalizeTrackingNo(String(input.trackingNo ?? ""));
    if (!TRACKING_NO_SHAPE.test(trackingNo)) {
      return { ok: false, error: `运单号形态不合法（${trackingNo || "空"}），应为 8~20 位字母数字` };
    }
    const phoneTail = String(input.phoneTail ?? "").trim().slice(-4);
    if (phoneTail && !/^\d{4}$/.test(phoneTail)) {
      return { ok: false, error: "手机后四位 (phoneTail) 需为 4 位数字" };
    }

    const contact = await deps.store.getContactPhone(actorId);
    const clue: PackageClue = {
      trackingNo,
      courierCode: String(input.courierCode ?? "").trim().toUpperCase() || null,
      courierName: null,
      status: "unknown",
      statusWord: null,
      pickupCode: null,
      phoneTail: phoneTail || contact?.phoneTail || null,
      sourcePlatform: "manual",
      excerpt: "用户手动补录运单号",
    };

    const result = await deps.store.ingestPackageClue(actorId, clue);
    const pkg = result.package;
    const refresh = await refreshTrajectory(deps, pkg, true);
    const after = (await deps.store.findPackage(actorId, pkg.packageId)) ?? pkg;

    const notes: string[] = [];
    if (refresh.state === "no_backend" || refresh.state === "failed") notes.push(refresh.message);

    return {
      ok: true,
      packageId: after.packageId,
      trackingNo,
      courier: carrierLabel(after),
      status: after.status,
      statusLabel: PACKAGE_STATUS_LABELS[after.status],
      trajectory: after.trajectory ?? [],
      summary:
        `已登记 ${headLabel(after)}` +
        (after.trajectory && after.trajectory.length > 0
          ? `，补到 ${after.trajectory.length} 个官方节点，最新：${after.trajectory[0]!.time} ${after.trajectory[0]!.description}`
          : notes.length > 0
            ? `，${notes.join("；")}`
            : "，暂无官方节点"),
      ...(notes.length > 0 ? { note: notes.join("；") } : {}),
    };
  };
}

export function createPackageBindPhoneHandler(deps: PackageToolsDeps): ToolHandler {
  return async (input, context) => {
    const actorId = resolveActorId(context);
    const phone = String(input.phone ?? "").trim().replace(/\s+/g, "");
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return { ok: false, error: "手机号格式不正确 (phone)，需 11 位大陆号码" };
    }
    const { phoneTail } = await deps.store.setContactPhone(actorId, phone);
    return {
      ok: true,
      phoneTail,
      summary: `已记录收件手机号（后四位 ${phoneTail}）`,
      note: "手机号只用于承运商查件的所有权校验（顺丰/中通等要求后四位）。隐私面单会把运单上的号码换成虚拟号，" +
        "所以它不能用来反查全网包裹；包裹仍靠通知流识别。完整号码不落盘，只留后四位。",
    };
  };
}

export function registerPackageTools(registry: ToolRegistry, deps: PackageToolsDeps): void {
  registry.register("package.list", createPackageListHandler(deps));
  registry.register("package.track", createPackageTrackHandler(deps));
  registry.register("package.add", createPackageAddHandler(deps));
  registry.register("package.bind_phone", createPackageBindPhoneHandler(deps));
}
