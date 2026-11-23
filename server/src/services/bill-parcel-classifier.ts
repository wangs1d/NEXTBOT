// 账单/快递识别器 —— 零 LLM 确定性规则（2026-11-13 用户定稿）。
//
// **为什么单独一个模块**：邮件侧有 `classifyMailImportance`（邮件专属字段与噪声源），
// 但短信侧一直没有分类器——短信进消息中心后一律按 salience=low 的 message 流丢进
// 总线，既不区分账单/快递，也不提取金额与单号，于是「自动识别并汇总」在短信这条
// 链路上从未成立。本模块把两条链路统一到**同一套类别语义**上：
//
//   快递 | 物流 | 取件码 | 话费 | 账单 | 快递单号  →  进入汇总（用户明确要求）
//   验证码 / 校验码 / 动态码                    →  不进汇总（用户明确「只是验证码不需要」）
//
// 关键取舍：**验证码不是"丢弃"，而是"不占汇报通道"**。原因有二：
//   1. 短信验证码常与真实业务混在一条里（「账单验证码 123456，扣款 12.34 元」）——
//      按整条丢弃会把账单一起丢；
//   2. 用户偶尔会问「刚才那个验证码是多少」，落库可检索比彻底丢弃有用。
// 因此判定顺序是：**先看有没有业务上下文（账单/快递），有就按业务走；没有才判验证码**。
//
// 另有三处容易踩的坑，这里都显式处理：
//   - 「取件验证码 123456」：字面含"验证码"但语义是取件码 → 判 parcel 并抽 pickupCode；
//   - 「取件码 8-2-3010」：含数字连字符，极像日期 → 用上下文锚定抽取，不做裸正则；
//   - 「消费 12.34 元」与「订单号 20260301」：金额与单号必须锚定关键词，否则会抓错。

/** 账单/快递类别（一条内容可同时命中两类，如「话费账单 + 包裹到驿站」） */
export type BillParcelCategory = "bill" | "parcel";

/** 识别结果 */
export type BillParcelMatch = {
  /** 命中的类别（可多个）；空数组 = 不进汇总 */
  categories: BillParcelCategory[];
  /** 命中的规则标签（人类可读，如「话费/通信费」「快递/取件码」） */
  labels: string[];
  /** 是否为纯验证码内容（无账单/快递上下文）——用户明确这类不进汇总 */
  isOtpOnly: boolean;
  /** 账单金额（元）；未提取到为 null */
  amount: number | null;
  /** 账单细分类型（话费/还款/信用卡/水电费…） */
  billType: string | null;
  /** 快递单号 / 运单号 */
  trackingNo: string | null;
  /** 取件码 */
  pickupCode: string | null;
  /** 承运商 / 驿站 */
  carrier: string | null;
};

/** 输入（邮件与短信统一形状：标题 + 正文 + 可选发件人） */
export type BillParcelInput = {
  /** 标题（邮件 subject；短信一般为空） */
  title?: string;
  /** 正文（邮件 textSnippet / 短信 body） */
  text: string;
};

// ---------------------------------------------------------------------- //
// 规则表
// ---------------------------------------------------------------------- //

type Rule = { label: string; pattern: RegExp; /** 命中后归入的类别 */
  category: BillParcelCategory; /** 账单子类（仅账单类用），用于汇总分组 */
  billType?: string };

/**
 * 账单类规则。
 *
 * 「账单/还款」与「话费/通信费」是两条独立规则（而非一条正则），因为汇总时
 * 话费要单独分组——用户每月关心的话费总额与「所有账单总额」不是一回事。
 */
const BILL_RULES: readonly Rule[] = [
  // 顺序有意为之：话费放在最前。话费短信往往同时含「账单」「扣款」，
  // 若「账单/还款」在前，话费会被归进"还款扣款"分组——而用户每月真正关心的是
  // 话费单独一档（"这个月话费扣了多少"），不能被混进总账单里。
  { label: "话费/通信费", category: "bill", billType: "话费通信", pattern: /(话费|通信费|流量费|套餐费|流量包|月租|欠费|网费)/ },
  { label: "账单/还款", category: "bill", billType: "还款扣款", pattern: /(账单|对账单|扣款|代扣|还款|付款提醒|应还|待缴|缴费通知|本月账单)/ },
  { label: "银行卡扣款", category: "bill", billType: "银行卡", pattern: /(信用卡|储蓄卡|借记卡|尾号\s*\d{4}|交易成功|消费成功|支付成功|代扣成功)/ },
  { label: "生活缴费", category: "bill", billType: "生活缴费", pattern: /(水费|电费|燃气费|天然气|物业费|取暖费|供暖费)/ },
  { label: "发票/税务", category: "bill", billType: "发票税务", pattern: /(发票|完税|扣税|退税|开票)/ },
  { label: "订阅续费", category: "bill", billType: "订阅续费", pattern: /(自动续费|续费成功|续费提醒|会员到期|订阅到期|会员续费)/ },
  { label: "逾期/滞纳", category: "bill", billType: "逾期费用", pattern: /(逾期|滞纳金|违约金)/ },
];

/**
 * 快递类规则。
 *
 * 「取件码」单独成条（用户点名要求）：它不携带金额与单号，但**是**用户最需要的
 * 那条信息——「快递到了，取件码多少」是高频真实需求，缺了它快递通知等于没识别。
 */
const PARCEL_RULES: readonly Rule[] = [
  { label: "快递/包裹", category: "parcel", pattern: /(快递|包裹|快件|物流|运单|配送|发货|收货|签收|自提)/ },
  { label: "取件码/驿站", category: "parcel", pattern: /(取件码|取件密码|取件|提货码|驿站|丰巢|菜鸟|妈妈驿站|兔喜|快递柜|智能柜)/ },
  { label: "快递单号", category: "parcel", pattern: /(快递单号|运单号|物流单号|快递编号|快递号|tracking\s*(?:no|number))/ },
];

/**
 * 验证码语义（用户明确「只是验证码不需要」）。
 *
 * 独立于 BILL/PARCEL 规则表，因为它不是"另一类"，而是**降级条件**：
 * 命中且无账单/快递上下文 → 不进汇总。
 */
const OTP_PATTERN =
  /(验证码|校验码|动态码|确认码|安全码|verification\s*code|security\s*code|one[-\s]?time\s*(?:code|password)|\botp\b)/i;

// ---------------------------------------------------------------------- //
// 字段抽取
// ---------------------------------------------------------------------- //

/**
 * 金额抽取：只认**带货币锚点**的写法。
 *
 * 裸数字（"12.34"）不抽——短信里裸数字绝大多数是单号尾数/日期/数量，抽出来必错。
 * 支持：¥12.34 / ￥12.34 / 12.34元 / 12.34 元 / RMB 12.34 / 人民币12.34。
 */
export function extractAmount(text: string): number | null {
  const patterns = [
    /[¥￥]\s*(\d{1,8}(?:\.\d{1,2})?)/,
    /(?:RMB|CNY)\s*(\d{1,8}(?:\.\d{1,2})?)/i,
    /人民币\s*(\d{1,8}(?:\.\d{1,2})?)/,
    /(\d{1,8}(?:\.\d{1,2})?)\s*元/,
    /(\d{1,8}(?:\.\d{1,2})?)\s*块钱/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const n = Number.parseFloat(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  return null;
}

/**
 * 锚定词与取值之间的分隔：短信里五花八门——空格、冒号、全角括号
 * （「【取件验证码】123456」）、中文逗号。分隔符写成**字符类**而不是
 * `\s*[:：]?\s*`，否则遇到全角括号就断链，码明明在眼前却抽不出来。
 */
const SEP = "[\\s:：】\\]\\)）】]*";

/**
 * 快递单号抽取：必须**锚定关键词**。
 *
 * 锚定后取紧邻的 token（字母数字与连字符，允许 SF1234567890 / 1234567890123 两种形态）。
 * 不做"全串找长数字"的裸扫——那会把订单号、卡号、日期一起抓进来。
 */
export function extractTrackingNo(text: string): string | null {
  const anchored = new RegExp(
    `(?:快递单号|运单号|物流单号|快递编号|快递号|tracking\\s*(?:no|number))${SEP}([A-Za-z0-9][A-Za-z0-9-]{7,29})`,
    "i",
  ).exec(text);
  if (anchored?.[1]) return anchored[1].trim();
  // 兜底：明确的「运单/快递」语境附近出现的 12 位以上纯数字串（快递单号典型长度）
  if (/(快递|物流|运单|包裹)/.test(text)) {
    const longNum = /\b(\d{12,22})\b/.exec(text);
    if (longNum?.[1]) return longNum[1];
  }
  return null;
}

/**
 * 取件码抽取：同样必须锚定。
 *
 * 典型形态有三类：
 *   - 「取件码 1234」/「取件码：8-2-3010」
 *   - 「8-2-3010」独立出现（多段数字连字符，需排除日期形态 2026-03-01）
 *   - 「提货码 A12」
 */
export function extractPickupCode(text: string): string | null {
  // 锚定词含「取件验证码」：快递短信常这么写（"取件验证码 123456"），
  // 语义是取件码而非短信验证码——它必须能被抽出来，否则用户问"取件码多少"
  // 只能得到一句"识别到快递但没有码"。
  const anchored = new RegExp(
    `(?:取件码|取件密码|取件验证码|取件校验码|提货码|pickup\\s*code)${SEP}([0-9A-Za-z]{1,8}(?:-[0-9A-Za-z]{1,8}){0,3})`,
    "i",
  ).exec(text);
  if (anchored?.[1]) return anchored[1].trim();
  // 「取件码」等关键词存在但格式特殊（如空格分隔）时的宽松匹配
  if (/(取件|提货)/.test(text)) {
    const loose = /\b(\d{1,2}-\d{1,2}-\d{2,6})\b/.exec(text);
    if (loose?.[1]) {
      // 排除纯日期（年-月-日 / 月-日）：第一段 4 位且落在 1900-2100 → 视为日期
      const head = Number.parseInt(loose[1].split("-")[0] ?? "", 10);
      if (!(Number.isFinite(head) && head >= 1900 && head <= 2100)) return loose[1];
    }
  }
  return null;
}

/** 承运商 / 驿站识别（用于汇总「哪个快递」与「去哪个驿站取」） */
export function extractCarrier(text: string): string | null {
  const carriers = [
    "顺丰",
    "中通",
    "圆通",
    "申通",
    "韵达",
    "极兔",
    "京东",
    "邮政",
    "EMS",
    "德邦",
    "丰巢",
    "菜鸟",
    "妈妈驿站",
    "兔喜",
  ];
  const upper = text.toUpperCase();
  for (const c of carriers) {
    if (upper.includes(c.toUpperCase())) return c;
  }
  return null;
}

// ---------------------------------------------------------------------- //
// 主判定
// ---------------------------------------------------------------------- //

// ---------------------------------------------------------------------- //
// 人工纠正样本（分类器反馈闭环，§9 月报卡「类目可改」2026-11-24）
// ---------------------------------------------------------------------- //

/**
 * 一条训练样本：用户改过类目的原文 + 人给的类目。
 * 由 `BillParcelLedger.corrections()` 从台账条目里派生（纠正本身就地写在条目上，
 * 不需要另开的训练文件）。
 */
export type ClassifierCorrectionSample = { text: string; billType: string };

/**
 * 学习短语里要剔除的通用词：这些词在任何账单里都出现，学进去等于把
 * 「所有含『账单』的文本」都归到某一类——那是过拟合，不是学习。
 */
const CORRECTION_STOPWORDS = [
  "账单", "扣款", "消费", "支付", "付款", "金额", "元", "通知", "提醒",
  "成功", "您的", "你", "本次", "合计", "共计", "人民币", "账户", "余额",
  "交易", "明细", "日期", "时间", "流水", "订单", "尾号", "银行",
  "支付宝", "微信", "云闪付", "截至", "当前", "可用", "入账", "扣费",
];

/** 归一化：小写 + 去掉空白与标点，只留文字/数字（CJK 按整段处理） */
function normalizeForCorrection(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

/**
 * 这个词是否已被内置规则覆盖。
 *
 * 学习层只教规则**不认识的新词**。把「话费」这种规则词学成"→水电费"，等于让一条
 * 误纠正去改写整条确定性规则——所有话费短信从此都错。所以凡命中内置规则的短语
 * 一律不进学习索引；用户改对了的那次，纠正照样记在台账条目上（本条呈现正确），
 * 只是不外溢成规则。
 */
function coveredByBuiltInRules(phrase: string): boolean {
  return (
    BILL_RULES.some((r) => r.pattern.test(phrase)) ||
    PARCEL_RULES.some((r) => r.pattern.test(phrase))
  );
}

/**
 * 从一段原文里挑可学习的判别短语：切出 2~12 字的词块，去掉通用词与纯数字，
 * 按长度降序（越长的短语越具体，误伤面越小）。
 */
export function correctionKeywords(text: string, limit = 6): string[] {
  const norm = normalizeForCorrection(text ?? "");
  if (!norm) return [];
  const raw = norm
    // 以数字/空白为界切块：金额、单号、日期都不该成为类目特征
    .split(/[0-9]+/)
    .flatMap((seg) => seg.split(" "))
    // 再用通用词切一刀：「支付宝美团」→「美团」，商户名才是要学的那个词
    .flatMap((t) => CORRECTION_STOPWORDS.reduce((acc, w) => acc.flatMap((s) => s.split(w)), [t]))
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 12)
    .filter((t) => !/^[a-z]{1,3}$/.test(t))
    .filter((t) => !coveredByBuiltInRules(t));
  const unique = [...new Set(raw)].sort((a, b) => b.length - a.length || a.localeCompare(b));
  return unique.slice(0, Math.max(1, limit));
}

/** 编译样本 → 短语表（长短语优先，命中即止） */
function buildCorrectionIndex(
  samples: ClassifierCorrectionSample[],
): Array<{ phrase: string; billType: string }> {
  const index: Array<{ phrase: string; billType: string }> = [];
  const seen = new Set<string>();
  for (const s of samples) {
    const billType = (s.billType ?? "").trim();
    if (!billType || coveredByBuiltInRules(billType)) continue;
    for (const phrase of correctionKeywords(s.text)) {
      const key = `${phrase}→${billType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      index.push({ phrase, billType });
    }
  }
  return index.sort((a, b) => b.phrase.length - a.phrase.length || a.phrase.localeCompare(b.phrase));
}

/**
 * 判定一条内容是否为「账单」/「快递」，并抽取结构化字段。
 *
 * 判定顺序（有意为之，不可调换）：
 *   1. 先扫业务规则（账单/快递）——命中即带业务上下文；
 *   2. 再看验证码——**仅当没有业务上下文时**才判为 otpOnly；
 *   3. 都没有 → 空 categories（不进汇总）。
 *
 * 这样「账单验证码」「取件验证码」这类复合内容不会被误判成验证码而丢弃。
 *
 * `opts.corrections` 是人工纠正样本（可选）：在规则表之后追加一层"学到的新词"。
 * 纪律是**只教规则不认识的东西，绝不翻案**——命中快递或验证码的内容学习层不碰，
 * 规则已给出子类时学习层也不改（见 `coveredByBuiltInRules`）。学习层唯一能做的事：
 * 把规则完全不认识、且非验证码的文本认成账单并给出人给的子类。这样一条误纠正
 * 最多影响它自己那几个词，不会污染既有确定性规则。
 */
export function classifyBillParcel(
  input: BillParcelInput,
  opts: { corrections?: ClassifierCorrectionSample[] } = {},
): BillParcelMatch {
  const title = (input.title ?? "").trim();
  const text = (input.text ?? "").trim();
  const haystack = `${title}\n${text}`;

  const categories: BillParcelCategory[] = [];
  const labels: string[] = [];
  let billType: string | null = null;

  for (const rule of BILL_RULES) {
    if (!rule.pattern.test(haystack)) continue;
    labels.push(rule.label);
    if (!categories.includes(rule.category)) categories.push(rule.category);
    if (!billType && rule.billType) billType = rule.billType;
  }
  for (const rule of PARCEL_RULES) {
    if (!rule.pattern.test(haystack)) continue;
    labels.push(rule.label);
    if (!categories.includes(rule.category)) categories.push(rule.category);
  }

  const otpHit = OTP_PATTERN.test(haystack);
  const hasBusiness = categories.length > 0;

  // —— 学习层：人工纠正样本（纪律见上方 doc：只补规则不认识的新词，不翻案） ——
  if (opts.corrections && opts.corrections.length > 0 && !categories.includes("parcel") && !otpHit) {
    const haystackNorm = normalizeForCorrection(haystack);
    for (const { phrase, billType: learned } of buildCorrectionIndex(opts.corrections)) {
      if (!haystackNorm.includes(phrase)) continue;
      if (categories.includes("bill") && billType) break; // 规则已给出子类：不覆盖确定性规则
      if (!categories.includes("bill")) {
        categories.push("bill");
        labels.push("人工纠正样本");
      }
      billType = learned;
      break;
    }
  }

  // 复合内容（账单/快递 + 验证码）不算 otpOnly —— 业务信息优先。
  const isOtpOnly = !hasBusiness && otpHit;

  const match: BillParcelMatch = {
    categories,
    labels,
    isOtpOnly,
    amount: null,
    billType: categories.includes("bill") ? billType : null,
    trackingNo: null,
    pickupCode: null,
    carrier: null,
  };

  // 字段抽取只对进汇总的内容做——验证码类不必付这个代价，也不该把它的数字
  // 当成金额/单号（验证码 6 位数很容易被误读成金额或单号）。
  if (!hasBusiness) return match;

  match.amount = extractAmount(haystack);
  match.trackingNo = extractTrackingNo(haystack);
  match.pickupCode = extractPickupCode(haystack);
  match.carrier = extractCarrier(haystack);
  return match;
}

/** 是否应进汇总（判定的对外唯一出口，避免各调用点各写一套条件） */
export function shouldReportBillParcel(match: BillParcelMatch): boolean {
  return match.categories.length > 0;
}

/**
 * 内置账单子类清单（规则表里出现过的 billType，按规则顺序去重）。
 * 月报卡「改类目」的候选项由这里出——候选项与规则同源，客户端不另抄一份，
 * 加一条规则不会漏一个下拉项。
 */
export function listBillTypes(): string[] {
  return [...new Set(BILL_RULES.map((r) => r.billType).filter((t): t is string => !!t))];
}

/** 一行摘要（台账标题 / 主动汇报用） */
export function summarizeBillParcel(match: BillParcelMatch, fallback: string): string {
  const bits: string[] = [];
  if (match.categories.includes("bill")) {
    bits.push(match.billType ? `账单·${match.billType}` : "账单");
    if (match.amount != null) bits.push(`¥${match.amount}`);
  }
  if (match.categories.includes("parcel")) {
    const carrier = match.carrier ? `${match.carrier}` : "快递";
    bits.push(match.trackingNo ? `${carrier} ${match.trackingNo}` : carrier);
    if (match.pickupCode) bits.push(`取件码 ${match.pickupCode}`);
  }
  if (bits.length === 0) return fallback.slice(0, 80);
  return bits.join(" · ");
}
