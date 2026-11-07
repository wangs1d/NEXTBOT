/**
 * 工具名 + 入参 → 用户可见的进行时短句（服务端确定性模板）。
 *
 * 为什么不交给模型写：`userStatusLine` 只是工具入参里的**可选**字段，模型给不给
 * 不由我们控制；而「现在在干什么」是**事实**，应当由拿到事实的一侧用模板渲染，
 * 而不是再赌一次模型配合。所以这里只做确定性拼装：命中即返回，没命中返回
 * `null`（让客户端退回自己的工具族映射表，避免两端各写一套通用话术）。
 *
 * 三条硬约束：
 *  - 只读白名单字段，绝不遍历任意字段猜语义；
 *  - 参数值一律去换行、去引号、截断（[MAX_PARAM_CHARS]），不把长文本搬进状态位；
 *  - 参数值里出现内部标识（dotted / snake_case）或 URL 就丢弃该值——
 *    状态位是给人看的一句话，不是工程日志。
 */

/** 参数值最大展示长度（含省略号前的部分）。 */
const MAX_PARAM_CHARS = 14;

/** 参数字段白名单（按优先级从具体到泛化）。 */
const PARAM_KEYS = {
  query: ["query", "keyword", "keywords", "q", "searchQuery", "search_query"],
  city: ["city", "location", "area", "destinationCity"],
  product: ["productName", "product_name", "product", "item", "goods", "title"],
  title: ["title", "summary", "subject", "name"],
  person: ["contactName", "contact_name", "contact", "recipient", "to", "name"],
  song: ["song", "track", "music", "keyword"],
  app: ["appName", "app_name", "application", "app"],
  device: ["deviceName", "device_name", "device"],
  file: ["fileName", "file_name", "filename", "file", "path"],
  prompt: ["prompt", "description", "scene"],
  from: ["from", "origin", "departure", "fromCity"],
  to: ["to", "destination", "target", "toCity"],
} as const;

/** 内部标识：`shopping.order.place` / `desktop_uia_query`。 */
const INTERNAL_IDENTIFIER = /[a-z][a-z0-9]*(?:[._][a-z0-9]+)+/i;

function sanitizeParam(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // 换行/多空格压成单空格：状态位只有一行。
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  // 引号会把模板的「」包坏，直接剥掉外层引号。
  text = text.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").trim();
  if (!text) return null;
  // URL / 内部标识不是人话，宁可不说。
  if (/^https?:\/\//i.test(text)) return null;
  if (INTERNAL_IDENTIFIER.test(text)) return null;
  if (text.length > MAX_PARAM_CHARS) {
    text = `${text.slice(0, MAX_PARAM_CHARS)}…`;
  }
  return text;
}

function pick(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = sanitizeParam(input[key]);
    if (value) return value;
  }
  return null;
}

function hasPrefix(tool: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => tool.startsWith(prefix));
}

/**
 * 渲染工具进行时短句；**没有可用的参数就返回 `null`**。
 *
 * 返回值只用于「补充信息」：客户端仍以工具族映射表兜底，所以这里不必覆盖
 * 所有工具，覆盖「参数里带着用户关心的那个名词」的高价值场景即可。
 */
export function renderToolStatusLine(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const tool = (toolName ?? "").trim();
  if (!tool || !input) return null;

  const query = pick(input, PARAM_KEYS.query);
  const city = pick(input, PARAM_KEYS.city);
  const product = pick(input, PARAM_KEYS.product);
  const title = pick(input, PARAM_KEYS.title);
  const person = pick(input, PARAM_KEYS.person);
  const song = pick(input, PARAM_KEYS.song);
  const app = pick(input, PARAM_KEYS.app);
  const device = pick(input, PARAM_KEYS.device);
  const file = pick(input, PARAM_KEYS.file);
  const prompt = pick(input, PARAM_KEYS.prompt);
  const from = pick(input, PARAM_KEYS.from);
  const to = pick(input, PARAM_KEYS.to);

  // ── 天气 / 检索 / 网页 ──
  if (hasPrefix(tool, ["weather"])) {
    return city ? `我看下${city}的天气` : null;
  }
  if (hasPrefix(tool, ["search_images"])) {
    return query ? `我找找「${query}」的图` : null;
  }
  if (hasPrefix(tool, ["search_videos"])) {
    return query ? `我找个「${query}」的视频` : null;
  }
  if (
    hasPrefix(tool, [
      "search_web",
      "deep_search",
      "info.search",
      "internet.",
      "desktop.web_search",
    ])
  ) {
    return query ? `我在查「${query}」` : null;
  }
  if (
    hasPrefix(tool, [
      "fetch_web",
      "fetch_page",
      "browser.fetch_page",
      "desktop.web_fetch",
      "info.inspect_webpage",
      "shared_browser.read_page",
    ])
  ) {
    // 这族工具的入参只有 URL，能抽出来的唯一「名词」就是域名。
    // 「我在读example.com」既生硬也没信息量——域名不该亮给用户，
    // 直接放弃参数化，让客户端的工具族文案兜底（「我上网读读这篇」）。
    return null;
  }
  if (hasPrefix(tool, ["memory.", "obs_recall"])) {
    return query ? `我翻翻「${query}」相关的` : null;
  }
  if (hasPrefix(tool, ["panel."])) {
    return query ? `我在面板里翻「${query}」` : null;
  }

  // ── 购物 / 消费 ──
  if (hasPrefix(tool, ["shopping.compare"])) {
    return product ? `我在比「${product}」的价` : null;
  }
  if (hasPrefix(tool, ["shopping.order.place", "shopping.order.track"])) {
    return product ? `我在处理「${product}」这一单` : null;
  }
  if (hasPrefix(tool, ["shopping.order"])) {
    return product ? `我在翻「${product}」的订单` : null;
  }
  if (hasPrefix(tool, ["restaurant.book"])) {
    const where = title ?? city;
    return where ? `我在订${where}的位子` : null;
  }
  if (hasPrefix(tool, ["restaurant.search"])) {
    return city ? `我在找${city}的餐厅` : null;
  }

  // ── 出行 ──
  if (hasPrefix(tool, ["ride_hailing.book"])) {
    return to ? `我叫车去${to}` : null;
  }
  if (hasPrefix(tool, ["travel_booking", "travel."])) {
    if (from && to) return `我在看${from}到${to}的票`;
    if (to) return `我在看去${to}的票`;
    return null;
  }

  // ── 日程 / 提醒 ──
  if (hasPrefix(tool, ["calendar.create", "calendar.update"])) {
    return title ? `我在排「${title}」` : null;
  }
  if (hasPrefix(tool, ["reminder."])) {
    return title ? `我设个「${title}」的提醒` : null;
  }

  // ── 沟通 ──
  if (hasPrefix(tool, ["phone.dial", "phone.call_user", "phone_call.start"])) {
    return person ? `我打给${person}` : null;
  }
  if (hasPrefix(tool, ["messages.reply", "messages.suggest_reply"])) {
    return person ? `我回${person}一句` : null;
  }
  if (hasPrefix(tool, ["email.send"])) {
    return person ? `我在给${person}写邮件` : null;
  }

  // ── 媒体 / 生成 ──
  if (hasPrefix(tool, ["media.play", "media.resume"])) {
    return song ? `我放「${song}」` : null;
  }
  if (hasPrefix(tool, ["image.generate"])) {
    return prompt ? `我在画「${prompt}」` : null;
  }

  // ── 桌面 / 设备 / 文件 / 代码 ──
  if (hasPrefix(tool, ["desktop.open", "desktop_open"])) {
    return app ? `我打开${app}` : null;
  }
  if (hasPrefix(tool, ["smart_home.control_device"])) {
    return device ? `我调一下${device}` : null;
  }
  if (hasPrefix(tool, ["file.parse", "file.read"])) {
    return file ? `我在读「${file}」` : null;
  }
  if (hasPrefix(tool, ["code.write_file", "code.read_file"])) {
    return file ? `我在改 ${file}` : null;
  }

  return null;
}
