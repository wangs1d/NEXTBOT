// 从入站消息（推送/短信/邮件正文）提取包裹线索：主键是运单号，取件码可独立成件。
// 宁漏不误报——线索会生成常驻包裹实体并被主动播报，误报等于把一条营销短信变成一个"包裹"。

/** 包裹状态（rank 单调前进：状态跃迁只允许从低 rank 到高 rank） */
export type PackageStatus =
  | "unknown"
  | "created"
  | "picked_up"
  | "in_transit"
  | "arrived"
  | "delivering"
  | "awaiting_pickup"
  | "signed"
  | "exception";

/** 状态序（"exception" 不参与单调比较，命中即整件置为异常） */
export const PACKAGE_STATUS_RANK: Record<PackageStatus, number> = {
  unknown: 0,
  created: 1,
  picked_up: 2,
  in_transit: 3,
  arrived: 4,
  delivering: 5,
  awaiting_pickup: 6,
  signed: 7,
  exception: 6,
};

/** 终态：列表默认不展示（includeFinished 才给） */
export const PACKAGE_TERMINAL_STATUSES: ReadonlySet<PackageStatus> = new Set(["signed"]);

export const PACKAGE_STATUS_LABELS: Record<PackageStatus, string> = {
  unknown: "状态未知",
  created: "已下单待揽收",
  picked_up: "已揽收",
  in_transit: "运输中",
  arrived: "已到达本地",
  delivering: "派送中",
  awaiting_pickup: "待取件",
  signed: "已签收",
  exception: "异常/退回",
};

/**
 * 承运商表。code 是**本项目内部规范码**（大写），各家查询接口的代码映射由
 * provider 负责，避免上游文档里的 `yunda`/`YD`/`韵达` 三套写法渗进业务层。
 */
export type CourierDef = { code: string; name: string; aliases: string[] };

export const COURIERS: CourierDef[] = [
  { code: "SF", name: "顺丰速运", aliases: ["顺丰", "sf express", "sf-express"] },
  { code: "JD", name: "京东物流", aliases: ["京东物流", "京东快递", "jd logistics", "jd.com"] },
  { code: "ZTO", name: "中通快递", aliases: ["中通", "zto"] },
  { code: "YTO", name: "圆通速递", aliases: ["圆通", "yto"] },
  { code: "STO", name: "申通快递", aliases: ["申通", "sto"] },
  { code: "YD", name: "韵达速递", aliases: ["韵达", "yunda"] },
  { code: "JT", name: "极兔速递", aliases: ["极兔", "j&t", "jt express"] },
  { code: "EMS", name: "邮政EMS", aliases: ["ems", "邮政", "中国邮政", "包裹号"] },
  { code: "DBL", name: "德邦快递", aliases: ["德邦", "deppon"] },
  { code: "BEST", name: "百世快递", aliases: ["百世", "best"] },
  { code: "ANE", name: "安能物流", aliases: ["安能", "ane"] },
  { code: "SS", name: "天天快递", aliases: ["天天快递", "ttky"] },
];

const COURIER_BY_CODE = new Map(COURIERS.map((c) => [c.code, c]));

export function courierName(code: string | null | undefined): string | null {
  if (!code) return null;
  return COURIER_BY_CODE.get(code.toUpperCase())?.name ?? null;
}

/**
 * 强形态运单号：前缀/后缀锚定，与手机号、订单号不可能撞车，见到即认。
 * 弱形态（纯数字）在下面单独走语境门。
 */
const STRONG_TRACKING: Array<{ re: RegExp; courier: string }> = [
  { re: /\bSF\d{11,13}\b/i, courier: "SF" },
  { re: /\bJT\d{11,15}\b/i, courier: "JT" },
  // 圆通纯数字形态位数不定，官方推送走 YT 前缀式更稳
  { re: /\bYT\d{9,13}\b/i, courier: "YTO" },
  { re: /\bJD[A-Z]{0,2}\d{10,13}\b/i, courier: "JD" },
  { re: /\b[A-Z]{2}\d{9}CN\b/i, courier: "EMS" },
];

/** 下限 12 位把 11 位手机号天然挡在外面 */
const DIGIT_RUN_RE = /(?<!\d)\d{12,15}(?!\d)/g;

/** 物流语境词：纯数字运单号必须命中其一才采纳 */
const LOGISTICS_CONTEXT_RE =
  /(运单号|运单|快递单号|快递|包裹|物流|快件|面单|单号|寄件|收件|取件|揽收|派送|签收|驿站|快递柜|丰巢|转运中心|分拨)/;

/** 命中即否决：电商订单号（京东 15~16 位、拼多多 15 位）与本窗口重叠，只能靠语境区分 */
const ORDER_NO_CONTEXT_RE = /(订单号|订单编号|订单id|交易单号|交易号|流水号|商品编号|商家编码|发票号)/;

/** 外卖/跑腿由 shopping 流负责，别在这里生成包裹实体 */
const TAKEOUT_RE = /(骑手|外卖|饿了么|闪购|跑腿|到店自取|取餐)/;

/** 状态规则：按 rank 取命中的最高档（一条通知描述的即当前状态） */
const STATUS_RULES: Array<{ status: PackageStatus; re: RegExp }> = [
  { status: "signed", re: /(已签收|签收成功|本人签收|已取出|已取件|取件成功|投递完成|投递成功)/ },
  {
    status: "awaiting_pickup",
    re: /(待取件|请取件|请前往取|取件码|提货码|开柜码|驿站|快递柜|柜机|丰巢|代收点|快件已存放|暂存)/,
  },
  { status: "delivering", re: /(派送中|配送中|派件中|正在派送|快递员(?:正在|已出发|为您)|安排派送|发出派送)/ },
  { status: "arrived", re: /(已到达.{0,12}(市|公司|网点|营业部|分拨|转运)|到达.{0,10}(收|派)件|到件)/ },
  { status: "in_transit", re: /(运输中|在途|已发出|下一站|物流|已揽收并|发往)/ },
  { status: "picked_up", re: /(已揽收|已揽件|揽收成功|快递员已取件|已收件)/ },
  { status: "created", re: /(已下单|待揽收|等待揽收|已发货|商家已发货|已出库)/ },
];

/** 异常覆盖词：命中即整件置 exception（不参与 rank 单调比较） */
const EXCEPTION_RE = /(退回|退件|拒收|异常件|问题件|滞留|无法联系|地址不详|超区|破损|拦截件|召回)/;

const PICKUP_CODE_RE =
  /(?:取件码|提货码|取货码|开柜码|取件序号)\s*[:：]?\s*(\d{1,2}-\d{1,2}-\d{3,6}|\d{4,8})/;

/** 手机后四位：显式尾号词 + 脱敏号码（138****1234）两式 */
const PHONE_TAIL_RULES: RegExp[] = [
  /(?:手机尾号|尾号|后四位)\s*[:：]?\s*(\d{4})/,
  /\d{2,3}\*{3,4}(\d{4})/,
];

/** 参与扫描的正文字符上限（超长邮件正文只扫前段，防正则回溯放大） */
const MAX_SCAN_LENGTH = 4000;
/** 摘录保留长度 */
const EXCERPT_MAX = 200;

export type PackageClue = {
  /** 运单号（已大写归一）；取件码型线索可能为 null */
  trackingNo: string | null;
  /** 内部规范承运码；认不出为 null */
  courierCode: string | null;
  courierName: string | null;
  status: PackageStatus;
  /** 命中的原始状态词（审计用：状态是规则判出来的，不是官方回传） */
  statusWord: string | null;
  pickupCode: string | null;
  phoneTail: string | null;
  /** 来源平台（wechat/sms/generic/email…，原样透传便于回溯） */
  sourcePlatform: string;
  /** 归一化单行摘录 */
  excerpt: string;
};

export type ExtractInput = {
  platform?: string;
  title?: string;
  text: string;
};

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 归一运单号：大写、去空格，让同一条单号在短信/推送/邮件里得到同一个实体 */
export function normalizeTrackingNo(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

function detectCourier(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  let best: { code: string; at: number } | null = null;
  for (const courier of COURIERS) {
    for (const alias of courier.aliases) {
      const at = lower.indexOf(alias);
      if (at < 0) continue;
      if (!best || at < best.at) best = { code: courier.code, at };
    }
  }
  return best?.code ?? null;
}

function detectStatus(haystack: string): { status: PackageStatus; word: string | null } {
  if (EXCEPTION_RE.test(haystack)) {
    return { status: "exception", word: haystack.match(EXCEPTION_RE)?.[0] ?? null };
  }
  let best: { status: PackageStatus; word: string } | null = null;
  for (const rule of STATUS_RULES) {
    const m = rule.re.exec(haystack);
    if (!m) continue;
    if (!best || PACKAGE_STATUS_RANK[rule.status] > PACKAGE_STATUS_RANK[best.status]) {
      best = { status: rule.status, word: m[0] };
    }
  }
  return best ?? { status: "unknown", word: null };
}

/**
 * 挑运单号：强形态优先；纯数字要过三道门——长度窗口（挡手机号）、
 * 物流语境（必须）、订单号语境（一票否决）。
 */
function pickTrackingNo(
  haystack: string,
): { no: string; courier: string | null } | null {
  for (const { re, courier } of STRONG_TRACKING) {
    const m = re.exec(haystack);
    if (m) return { no: normalizeTrackingNo(m[0]), courier };
  }
  if (!LOGISTICS_CONTEXT_RE.test(haystack)) return null;

  let fallback: string | null = null;
  for (const m of haystack.matchAll(DIGIT_RUN_RE)) {
    const start = m.index ?? 0;
    const before = haystack.slice(Math.max(0, start - 12), start);
    if (ORDER_NO_CONTEXT_RE.test(before)) continue;
    // 脱敏手机号（138****1234）后面紧跟的数字不是运单号
    if (/\*{3,4}\s*$/.test(before)) continue;
    fallback = m[0];
    break;
  }
  return fallback ? { no: normalizeTrackingNo(fallback), courier: null } : null;
}

/**
 * 从一条入站消息（通知/短信/邮件正文）提取包裹线索。
 * 返回 null = 这不是快递事件；调用方直接把消息留给其他链路。
 */
export function extractPackageClue(input: ExtractInput): PackageClue | null {
  const title = normalize(String(input.title ?? ""));
  const body = normalize(String(input.text ?? "")).slice(0, MAX_SCAN_LENGTH);
  if (!body) return null;
  const haystack = `${title} ${body}`;

  const picked = pickTrackingNo(haystack);
  const pickupCode = haystack.match(PICKUP_CODE_RE)?.[1] ?? null;
  // 只有取件码、没有运单号：仍是一条真实的"到件待取"事件（驿站/柜机短信常见），
  // 存为无轨迹的包裹实体，工具侧如实说明没抓到单号，不猜。
  if (!picked && !pickupCode) return null;

  const courierFromText = detectCourier(haystack);
  if (!picked && !courierFromText && !LOGISTICS_CONTEXT_RE.test(haystack)) return null;

  // 外卖/跑腿不在此域（无运单号、由 shopping 流承接）；文本点名了承运商才放行
  if (TAKEOUT_RE.test(haystack) && !picked?.courier && !courierFromText) return null;

  const code = picked?.courier ?? courierFromText;
  const detected = detectStatus(haystack);
  // 有取件码即"到件待取"，但已经明说签收了的不能倒回去降级
  const status =
    pickupCode && detected.status !== "signed"
      ? { status: "awaiting_pickup" as PackageStatus, word: "取件码" }
      : detected;
  const phoneTail =
    PHONE_TAIL_RULES.map((re) => re.exec(haystack)?.[1] ?? null).find((v) => v != null) ?? null;

  return {
    trackingNo: picked?.no ?? null,
    courierCode: code ?? null,
    courierName: courierName(code),
    status: status.status,
    statusWord: status.word,
    pickupCode,
    phoneTail,
    sourcePlatform: String(input.platform ?? "").trim() || "unknown",
    excerpt: `${title ? `${title}：` : ""}${body}`.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX),
  };
}
