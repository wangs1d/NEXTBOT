/**
 * 共用浏览器注入运行时（framework-free，纯同步 JS）。
 *
 * 面板身份标记（2026-10-28 根因修复）：本控制器的每个文档都带
 * window.__NB_SHARED_PANEL__ —— 进程内多个 WebView2 控制器（光球
 * NavigateToString 页也报 about:blank）共用同一个 CDP 端点，URL
 * 无法唯一定位面板页；服务端 cdp-gateway 据此标记唯一锁定
 * 用户可见的面板页，再也不会把页面开到看不见的目标上。
 *
 * 设计约束：
 *   - 本文件只提供「单次同步探测/操作」原语；所有等待/重试/超时循环由
 *     宿主执行器（BrowserActionExecutor，Dart/其他语言）驱动，这里绝不内置轮询。
 *   - 宿主通过两种方式安装本文件（幂等，二选一或并用）：
 *       1) 文档级常驻：引擎支持 document-created 脚本时，把整个文件作为
 *          bootstrap 注入，每个新文档自动可用；
 *       2) 动作前内联：执行器拼接 `(function(){<本文件>; __installSharedBrowser();
 *          return ...})()` 调用，任何页面状态下都可用。
 *   - 全局挂载 window.__sharedBrowser；重复安装保留已有 ref 表
 *     （同一文档内跨调用稳定，整页导航后随文档自然重置——这是期望行为）。
 *   - ref 是给 LLM 的稳定元素引用：read_page 返回 ref，click 按 ref 定位，
 *     页面局部刷新不会导致 ref 错位（相比按 DOM 序号 index）。
 */
window.__NB_SHARED_PANEL__ = true;

function __installSharedBrowser() {
  if (window.__sharedBrowser && window.__sharedBrowser.__ready) return;
  const SB = window.__sharedBrowser = (window.__sharedBrowser || {});

  SB.__ready = true;
  SB.INTERACTIVE = [
    "a[href]", "button", "input", "select", "textarea",
    "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
    "[onclick]", "summary", "label"
  ].join(",");

  // ── ref 表（WeakMap 正查 + WeakRef 反查，不阻止 GC）──────────────────
  SB._refMap = SB._refMap || new WeakMap();
  SB._byRef = SB._byRef || new Map();
  SB._refSeq = SB._refSeq || 0;
  SB.refOf = function (el) {
    let r = SB._refMap.get(el);
    if (!r) {
      r = "e" + (++SB._refSeq);
      SB._refMap.set(el, r);
      SB._byRef.set(r, new WeakRef(el));
    }
    return r;
  };
  SB.refEl = function (ref) {
    const wr = ref && SB._byRef.get(ref);
    if (!wr) return null;
    const el = wr.deref();
    return el && el.isConnected ? el : null;
  };

  // ── 基础谓词 ────────────────────────────────────────────────────────
  SB.visible = function (el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  SB.enabled = function (el) {
    if (el.disabled) return false;
    const st = getComputedStyle(el);
    if (st.pointerEvents === "none") return false;
    const aria = el.getAttribute && el.getAttribute("aria-disabled");
    return aria !== "true";
  };
  SB.textOf = function (el) {
    return (el.innerText || el.value || el.getAttribute("aria-label") ||
      el.title || "").trim().replace(/\s+/g, " ").slice(0, 80);
  };

  // 可交互元素（按 DOM 顺序；visible + enabled 过滤）
  SB.els = function (limit) {
    const out = [];
    document.querySelectorAll(SB.INTERACTIVE).forEach((el) => {
      if (out.length >= limit) return;
      if (!SB.visible(el) || !SB.enabled(el)) return;
      out.push(el);
    });
    return out;
  };

  // ── 元素定位（ref > selector > text > index）────────────────────────
  SB.resolve = function (opts) {
    if (opts.ref) {
      const byRef = SB.refEl(opts.ref);
      if (byRef) return byRef;
      // ref 失效（元素被移除）→ 落到其他线索，避免整次调用报废
    }
    if (opts.selector) {
      try { return document.querySelector(opts.selector); } catch (e) { return null; }
    }
    if (opts.text) {
      const want = opts.text.trim().toLowerCase();
      let exact = null, partial = null;
      SB.els(500).forEach((e) => {
        const t = SB.textOf(e).toLowerCase();
        if (!exact && t === want) exact = e;
        else if (!partial && t && t.includes(want)) partial = e;
      });
      return exact || partial;
    }
    if (opts.index != null) return SB.els(200)[opts.index] || null;
    return null;
  };

  // 元素描述（probe/elements 共用的字段形状）
  SB.describe = function (el) {
    return {
      ref: SB.refOf(el),
      tag: el.tagName.toLowerCase(),
      text: SB.textOf(el),
      href: el.tagName === "A" ? (el.getAttribute("href") || "") : "",
      placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "",
      aria: (el.getAttribute && el.getAttribute("aria-label")) || "",
      role: (el.getAttribute && el.getAttribute("role")) || "",
      inputType: (el.tagName === "INPUT" && el.type) ? el.type : ""
    };
  };

  /**
   * 探测元素可操作性（执行器等待循环的单步）。
   * 返回 {found, ...describe, disabled, covered, coverer, rect} 或 {found:false, staleRef}。
   * opts.center=true 时先滚动到元素中心再测遮挡。
   */
  SB.probe = function (opts) {
    const staleRefOnly = opts.ref && !SB.refEl(opts.ref) &&
      !opts.selector && !opts.text && opts.index == null;
    const el = SB.resolve(opts);
    if (!el) return { found: false, staleRef: !!staleRefOnly };
    if (!SB.enabled(el)) {
      return { found: true, ...SB.describe(el), disabled: true, covered: false, coverer: "" };
    }
    if (opts.center) {
      try { el.scrollIntoView({ block: "center" }); } catch (e) { /* iframe 等 */ }
    }
    const r = el.getBoundingClientRect();
    let covered = false, coverer = "";
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        covered = true;
        coverer = SB.textOf(top).slice(0, 40) || top.tagName.toLowerCase();
      }
    }
    return {
      found: true,
      ...SB.describe(el),
      disabled: false,
      covered,
      coverer,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    };
  };

  /** 点击（执行器已通过 probe 确认可点；这里只做滚动 + click）。 */
  SB.clickAt = function (opts) {
    const el = SB.resolve(opts);
    if (!el) return { clicked: false };
    try { el.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
    el.click();
    return { clicked: true, ref: SB.refOf(el) };
  };

  /**
   * 输入（走原型 setter，兼容 React/Vue 受控组件）；submit=true 时回车提交。
   * 返回回读值供执行器校验（受控组件吞值时可检测）。
   */
  SB.typeInto = function (opts) {
    let el = SB.resolve(opts);
    if (!el && !opts.selector && !opts.ref) {
      // 未指定目标 → 自动定位第一个可用输入框
      document.querySelectorAll("input, textarea").forEach((e) => {
        if (el || !SB.visible(e) || !SB.enabled(e) || e.readOnly) return;
        const t = (e.type || "text").toLowerCase();
        if (e.tagName === "TEXTAREA" ||
            ["text", "search", "email", "password", "tel", "url", "number", ""].includes(t)) el = e;
      });
    }
    if (!el) return { typed: false, error: "未找到输入框" };
    try { el.focus(); el.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    const next = (opts.clear === false ? (el.value || "") : "") + opts.text;
    setter.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (opts.submit) {
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      }
    }
    return { typed: true, ref: SB.refOf(el), value: String(el.value || "").slice(0, 120) };
  };

  // ── 正文读取 ────────────────────────────────────────────────────────
  // 主内容启发式：main/article/[role=main]/#content/.content 中取文本最长者；
  // 达不到正文 30% 视为未命中（如列表页），退回 body。
  SB.mainRoot = function () {
    const cands = [];
    ["main", "article", "[role=main]", "#content", ".content"].forEach((s) => {
      const el = document.querySelector(s);
      if (el) cands.push(el);
    });
    let best = null, bestLen = 0;
    cands.forEach((c) => {
      const t = (c.innerText || "").trim();
      if (t.length > bestLen) { best = c; bestLen = t.length; }
    });
    const bodyLen = document.body ? (document.body.innerText || "").trim().length : 0;
    return (best && bodyLen > 0 && bestLen >= bodyLen * 0.3)
      ? best : (document.body || document.documentElement);
  };

  /**
   * 读取页面：正文（支持 offset 分页续读）+ 可交互元素（带稳定 ref）。
   */
  SB.read = function (opts) {
    const root = opts.selector
      ? (SB.resolve({ selector: opts.selector }))
      : SB.mainRoot();
    if (opts.selector && !root) return { error: "选择器未命中: " + opts.selector };
    const full = (root.innerText || "").trim();
    const maxChars = opts.maxChars || 4000;
    const offset = opts.offset || 0;
    const res = {
      url: location.href,
      title: document.title,
      text: full.slice(offset, offset + maxChars),
      offset: offset,
      total: full.length,
      hasMore: offset + maxChars < full.length,
      readyState: document.readyState
    };
    if (opts.includeInteractive !== false) {
      const limit = opts.elementLimit || 30;
      const all = SB.els(300);
      res.elements = all.slice(0, limit).map((el) => SB.describe(el));
      res.elementTotal = all.length;
    }
    return res;
  };

  // ── 页面状态 / 滚动 / 导出 ──────────────────────────────────────────
  SB.pageState = function () {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: Math.round(window.scrollY || 0),
      scrollHeight: Math.round((document.body && document.body.scrollHeight) || 0)
    };
  };

  SB.scrollPage = function (opts) {
    if (opts.to === "top") window.scrollTo({ top: 0 });
    else if (opts.to === "bottom") window.scrollTo({ top: document.body.scrollHeight });
    else window.scrollBy({ top: opts.deltaY || 600 });
    return SB.pageState();
  };

  /**
   * 导出登录态（best-effort）：HttpOnly Cookie 拿不到（limited=true 标记），
   * 服务端 Playwright 池用它拼 storageState 时须知此限制。
   */
  SB.exportState = function () {
    const ls = {}, ss = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        ls[k] = String(localStorage.getItem(k)).slice(0, 4096);
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        ss[k] = String(sessionStorage.getItem(k)).slice(0, 4096);
      }
    } catch (e) { /* 存储被禁用时忽略 */ }
    return {
      origin: location.origin,
      url: location.href,
      cookie: document.cookie || "",
      localStorage: ls,
      sessionStorage: ss,
      limited: true
    };
  };

  /**
   * target=_blank / window.open 拦截 → 本窗导航。
   * WebView2 弹窗策略为 deny 时新窗口会被静默吞掉；本钩子把这类导航
   * 改写到当前窗口。文档级常驻安装时每个新文档自动生效。
   */
  SB.interceptBlank = function () {
    if (SB.__blankHooked) return { hooked: true };
    SB.__blankHooked = true;
    const origOpen = window.open;
    window.open = function (u) {
      if (typeof u === "string" && u) { location.href = u; return null; }
      try { return origOpen.apply(window, arguments); } catch (e) { return null; }
    };
    document.addEventListener("click", function (ev) {
      const t = ev.target;
      const a = t && t.closest ? t.closest('a[target="_blank"], a[target=_blank]') : null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#") return;
      ev.preventDefault();
      location.href = href;
    }, true);
    return { hooked: true };
  };
}
