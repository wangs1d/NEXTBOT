import type { Page } from "playwright";

/**
 * 浏览器层的 human-required 判定（通用层）。
 *
 * 对齐主流 Browser Agent（Browser Use / Operator / 豆包）的 human checkpoint：
 * 只有「只有用户本人能做」的环节（登录墙、验证码/风控、支付/审批）才暂停交人；
 * 普通空结果、网络超时不是接管理由。
 *
 * 这里只做**确定性信号**（URL / 正文 / DOM），任何浏览器能力（购物、通用网页
 * 操作、预订报价）都复用同一套判定，避免各业务各写一份。
 */

/** 各站点登录页 URL 启发式（hostname / URL 命中即认为需要登录）。 */
const LOGIN_URL_PATTERNS: Record<string, RegExp[]> = {
  jd: [/passport\.jd\.com/i],
  taobao: [/login\.taobao\.com/i, /login\.tmall\.com/i],
  tmall: [/login\.taobao\.com/i, /login\.tmall\.com/i],
  pdd: [/passport\.(pinduoduo|yangkeduo)\.com/i, /login\.(pinduoduo|yangkeduo)/i],
  meituan: [/passport\.meituan\.com/i, /account\.meituan\.com/i],
  douyin: [/sso\.douyin\.com/i, /passport\.douyin\.com/i],
  damai: [/passport\.damai\.cn/i],
  maoyan: [/passport\.maoyan\.com/i],
  ctrip: [/passport\.ctrip\.com/i, /login\.ctrip/i],
  qunar: [/user\.qunar\.com\/login/i],
  fliggy: [/login\.fliggy\.com/i],
  dianping: [/passport\.dianping\.com/i, /account\.dianping\.com/i],
  alipay: [/authstore\.alipay\.com/i, /login\.alipay/i],
  netease: [/login\.163\.com/i, /id\.163\.com/i],
};

/** 兜底正文关键词（URL 未命中时，正文出现即认为登录页）。 */
const LOGIN_BODY_KEYWORDS = ["扫码登录", "二维码登录", "欢迎登录", "登录后查看"];

/** 扫码登录最长等待（毫秒）。可用 SHOPPING_LOGIN_WAIT_MS 覆盖。 */
export function getLoginWaitMs(): number {
  const v = Number.parseInt(process.env.SHOPPING_LOGIN_WAIT_MS ?? "120000", 10);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

export type LoginPageDetection = {
  isLogin: boolean;
  /** 判中依据（审计/提示用） */
  reason?: string;
};

export type HumanRequirementReason = "login" | "captcha";

export type HumanRequiredDetection = {
  required: boolean;
  reason?: HumanRequirementReason;
  /** 判中依据（审计/提示用） */
  evidence?: string;
};

/** 验证码/风控页 URL 启发式 */
const CAPTCHA_URL_RE = /(captcha|verify|verification|punish|risk[_-]?control|anti[_-]?bot|security[_-]?check)/i;

/** 验证码/风控页正文关键词（只收强信号，避免把普通搜索结果误判成验证页） */
const CAPTCHA_BODY_KEYWORDS = [
  "安全验证",
  "人机验证",
  "滑块验证",
  "拖动滑块",
  "完成验证",
  "请完成验证",
  "异常流量",
  "异常访问",
  "环境异常",
  "访问受限",
];

/** 登录/验证码浮层 DOM 标记（保守白名单，避免命中普通「已验证」徽标） */
const HUMAN_DOM_SELECTOR = [
  '#captcha',
  '[id*="captcha"]',
  '[class*="captcha"]',
  'iframe[src*="captcha"]',
  'iframe[src*="verify"]',
  '[class*="slider-verify"]',
  '[class*="verify-slider"]',
].join(",");

/** 判断当前页面是否为站点登录页（URL 启发式 + 正文关键词兜底）。 */
export async function detectLoginPage(
  siteId: string,
  page: Page,
): Promise<LoginPageDetection> {
  const url = page.url();
  const patterns = LOGIN_URL_PATTERNS[siteId] ?? [];
  if (patterns.some((re) => re.test(url))) {
    return { isLogin: true, reason: `URL 命中登录页（${url}）` };
  }
  // 通用兜底：host 带 passport./login./signin. 或路径以 /login 开头（只看 host+path，避免误判 query）
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* 非 http(s) URL 不做通用判定 */
  }
  if (host && (/^passport\.|^login\.|^signin\.|\.login\./i.test(host) || /^\/login/i.test(path))) {
    return { isLogin: true, reason: `host/path 含登录段（${url}）` };
  }
  try {
    const bodyHead = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 600));
    const hit = LOGIN_BODY_KEYWORDS.find((kw) => bodyHead.includes(kw));
    if (hit) return { isLogin: true, reason: `正文命中「${hit}」` };
  } catch {
    /* evaluate 失败（页面跳转中/CDP 断开）不影响判定 */
  }
  return { isLogin: false };
}

/**
 * 统一判定「这里是不是必须用户本人上」。
 *
 * 调用时机：导航落页后、每次交互动作（点击/输入/提交）之后。命中才交人，
 * 未命中就当普通失败/空结果处理。
 */
export async function detectHumanRequired(
  siteId: string,
  page: Page,
): Promise<HumanRequiredDetection> {
  const login: LoginPageDetection = await detectLoginPage(siteId, page).catch(() => ({ isLogin: false }));
  if (login.isLogin) {
    return { required: true, reason: "login", evidence: login.reason };
  }

  const url = page.url();
  if (CAPTCHA_URL_RE.test(url)) {
    return { required: true, reason: "captcha", evidence: `URL 命中验证页（${url}）` };
  }

  try {
    const bodyHead = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 800));
    const hit = CAPTCHA_BODY_KEYWORDS.find((kw) => bodyHead.includes(kw));
    if (hit) return { required: true, reason: "captcha", evidence: `正文命中「${hit}」` };
  } catch {
    /* evaluate 失败（页面跳转中/CDP 断开）不影响判定 */
  }

  try {
    const marker = await page.evaluate((selector) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return null;
      return el.id || (typeof el.className === "string" ? el.className : "") || el.getAttribute("src") || "human-dom";
    }, HUMAN_DOM_SELECTOR);
    if (marker) return { required: true, reason: "captcha", evidence: `DOM 命中（${marker.slice(0, 40)}）` };
  } catch {
    /* 同上 */
  }

  return { required: false };
}

/**
 * 等待用户扫码登录：轮询检测登录页，成功后重新落回 targetUrl。
 * 调用方需在此之前完成二维码截图/推送（登录页不会自己消失，轮询只看 URL）。
 */
export async function waitForLogin(
  siteId: string,
  page: Page,
  targetUrl: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? getLoginWaitMs();
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs).catch(() => {});
    const det = await detectLoginPage(siteId, page).catch(() => ({ isLogin: false }));
    if (!det.isLogin) {
      // 登录成功后站点通常跳到首页/个人页，重新落回目标页再交给调用方解析
      if (page.url() !== targetUrl) {
        await page
          .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => {});
        await page.waitForTimeout(2_000).catch(() => {});
      }
      return { ok: true };
    }
  }
  return { ok: false, error: `等待扫码登录超时（${Math.round(timeoutMs / 1000)}s）` };
}
