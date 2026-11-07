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

/**
 * 各平台「已登录」的正向 Cookie 信号（2026-11-06 真机取证补）。
 *
 * 只看「URL 还在不在登录页」会漏判成功：京东扫码确认后页面常停在
 * passport.jd.com 的过渡/成功页，URL 启发式一直判「还是登录页」，
 * waitForLogin 白等到 120s 超时——用户明明已确认登录却收到「没等到你扫」。
 * 这些 Cookie 名在登录前不存在、登录后必落，命中即视为已登录。
 */
const LOGIN_COOKIE_MARKERS: Record<string, string[]> = {
  jd: ["pin", "pt_pin", "thor"],
  taobao: ["unb", "lgc", "_tb_token_"],
  tmall: ["unb", "lgc", "_tb_token_"],
  pdd: ["PDDUserID", "pdd_user_id"],
};

/**
 * 正向判定「这个页面上下文是否已带该平台的登录态」。
 * Cookie 读取失败（CDP 断开/页面跳转中）按「无正向信号」处理，不抛错。
 */
export async function isPlatformLoggedIn(
  siteId: string,
  page: Page,
): Promise<boolean> {
  const markers = LOGIN_COOKIE_MARKERS[siteId];
  if (!markers || markers.length === 0) return false;
  try {
    const cookies = await page.context().cookies();
    return cookies.some((c) => markers.includes(c.name));
  } catch {
    return false;
  }
}

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
 * 等待用户扫码登录：轮询检测登录态，成功后重新落回 targetUrl。
 * 调用方需在此之前完成二维码截图/推送。
 *
 * 判定顺序（2026-11-06 修「扫码确认了却一直等到超时」）：
 * 1. 正向 Cookie 信号优先——扫码确认后页面常停在登录域的过渡页，URL 启发式
 *    会一直误判「还在登录页」；Cookie 已带登录态就该立即放行。
 * 2. URL/正文启发式兜底——页面确实离开了登录页也放行。
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
    // 正向信号优先：Cookie 已带登录态（URL 可能还挂在 passport 过渡页）
    if (await isPlatformLoggedIn(siteId, page).catch(() => false)) {
      await settleBackToTarget(page, targetUrl);
      return { ok: true };
    }
    const det = await detectLoginPage(siteId, page).catch(() => ({ isLogin: false }));
    if (!det.isLogin) {
      // 登录成功后站点通常跳到首页/个人页，重新落回目标页再交给调用方解析
      await settleBackToTarget(page, targetUrl);
      return { ok: true };
    }
  }
  return { ok: false, error: `等待扫码登录超时（${Math.round(timeoutMs / 1000)}s）` };
}

/** 登录成功后把页面送回目标地址，失败不阻塞（调用方自己会再导航）。 */
async function settleBackToTarget(page: Page, targetUrl: string): Promise<void> {
  if (page.url() === targetUrl) return;
  await page
    .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(2_000).catch(() => {});
}
