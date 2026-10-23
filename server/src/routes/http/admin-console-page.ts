/**
 * 管理控制台页面（管理员）：自包含 HTML，无外部依赖。
 *
 * 左侧导航 + 六个标签：概览 / 用户 / 内测 / 站内信（发送+记录+聚合统计）/ 支付 / 反馈管理 / 下载分发。
 * 数据接口：反馈提交与「我的反馈」走开放接口；全量反馈、状态流转与所有
 * /api/admin/* 鉴权：账号密码会话（HttpOnly Cookie，主通道）+ x-admin-token 遗留口令（脚本通道）。
 * 页内脚本用字符串拼接渲染，内容全部经 esc() 转义；事件用委托，不用内联 onclick。
 */

const STATUS_LABELS: Record<string, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
};

const TYPE_LABELS: Record<string, string> = {
  bug: "问题报障",
  suggestion: "功能建议",
  other: "其他",
};

export function renderAdminConsolePage(): string {
  const statusLabelsJson = JSON.stringify(STATUS_LABELS);
  const typeLabelsJson = JSON.stringify(TYPE_LABELS);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理控制台 · NextBot</title>
<style>
  :root {
    --bg: #f5f6f8; --card: #ffffff; --line: #e6e9ef; --line-soft: #eef1f5;
    --text: #171e2e; --muted: #697182; --faint: #9aa3b4;
    --accent: #2f6bff; --accent-deep: #2456d9; --accent-weak: #eef3ff;
    --side: #10141f; --side-text: #8b94a7;
    --ok: #16a34a; --bad: #dc2626; --warn: #d97706;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.03);
  }
  * { box-sizing: border-box; }
  html { -webkit-font-smoothing: antialiased; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  ::selection { background: var(--accent-weak); }
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: #d4dae4; border-radius: 8px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-track { background: transparent; }
  aside {
    position: fixed; left: 0; top: 0; bottom: 0; width: 212px;
    background: var(--side); color: var(--side-text);
    display: flex; flex-direction: column; padding: 20px 12px 14px;
  }
  aside .brand { color: #fff; font-size: 15px; font-weight: 600; padding: 0 10px; letter-spacing: .01em; }
  aside .brand-sub { font-size: 11px; padding: 2px 10px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
  nav { margin-top: 14px; flex: 1; overflow-y: auto; }
  nav a {
    display: block; padding: 8px 11px; margin: 2px 0; border-radius: 8px;
    color: var(--side-text); text-decoration: none; font-size: 13px;
    transition: background .12s, color .12s;
  }
  nav a:hover { background: rgba(255,255,255,.06); color: #d5dbe7; }
  nav a.on { background: rgba(47,107,255,.18); color: #fff; box-shadow: inset 2px 0 0 var(--accent); }
  .nav-badge {
    display: none; min-width: 17px; text-align: center; margin-left: 7px;
    background: #dc2626; color: #fff; font-size: 10.5px; font-weight: 600;
    border-radius: 999px; padding: 0 5px; line-height: 16px; vertical-align: 1px;
  }
  .tokenbox { border-top: 1px solid rgba(255,255,255,.08); padding: 12px 10px 4px; }
  .tokenbox label { font-size: 11px; display: block; margin-bottom: 6px; }
  .tokenbox input {
    width: 100%; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #dbe3f0;
    border-radius: 7px; padding: 5px 8px; font-size: 12px;
  }
  .tokenbox input:focus { outline: none; border-color: rgba(47,107,255,.55); }
  .tokenbox .hint { font-size: 10px; color: #5d6880; margin-top: 5px; }
  main { margin-left: 212px; padding: 28px 32px 80px; max-width: 1320px; }
  h1 { font-size: 20px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12.5px; margin-bottom: 20px; }
  section.tab { display: none; }
  section.tab.on { display: block; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 13px 18px; min-width: 118px; flex: 1;
  }
  .stat b { display: block; font-size: 23px; font-weight: 650; letter-spacing: -.02em; }
  .stat span { color: var(--muted); font-size: 12px; }
  .stat .stat-sub { font-size: 11px; color: var(--accent); margin-top: 3px; }
  .bars { display: flex; gap: 4px; align-items: flex-end; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .bar-v { width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; }
  .bar-label { font-size: 9px; color: var(--faint); white-space: nowrap; }
  .toolbar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 10px 14px; margin-bottom: 16px;
  }
  .seg { display: inline-flex; background: var(--line-soft); border-radius: 9px; padding: 2px; }
  .seg button {
    border: 0; background: transparent; padding: 5px 14px; cursor: pointer;
    font-size: 13px; color: var(--muted); border-radius: 7px; transition: all .12s;
  }
  .seg button:hover { color: var(--text); }
  .seg button.on { background: #fff; color: var(--text); font-weight: 500; box-shadow: 0 1px 3px rgba(16,24,40,.12); }
  select, input[type=search], input[type=text], input:not([type]) {
    border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; font-size: 13px;
    background: #fff; color: var(--text); transition: border-color .12s, box-shadow .12s;
  }
  select:hover, input[type=search]:hover, input[type=text]:hover, input:not([type]):hover { border-color: #cfd6e2; }
  select:focus, textarea:focus,
  input[type=search]:focus, input[type=text]:focus, input:not([type]):focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak);
  }
  input[type=search] { flex: 1; min-width: 140px; }
  textarea {
    width: 100%; border: 1px solid var(--line); border-radius: 8px;
    padding: 9px 11px; font-size: 13px; font-family: inherit; resize: vertical;
    transition: border-color .12s, box-shadow .12s;
  }
  .btn {
    border: 1px solid var(--line); background: #fff; border-radius: 8px;
    padding: 7px 15px; cursor: pointer; font-size: 13px; color: var(--text);
    font-weight: 500; transition: all .12s;
  }
  .btn:hover { border-color: #c9d2e0; background: #f8fafc; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { background: var(--accent-deep); border-color: var(--accent-deep); color: #fff; }
  .btn.danger { color: inherit; }
  .btn.danger:hover { border-color: var(--bad); color: var(--bad); background: #fef2f2; }
  .btn.small { padding: 3px 11px; font-size: 12px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow);
    padding: 16px 20px; margin-bottom: 12px;
  }
  .card h3 { font-size: 15px; margin: 0; flex: 1; min-width: 200px; }
  .card .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .card-title { font-size: 13.5px; font-weight: 600; margin-bottom: 10px; }
  .card .head .card-title { margin-bottom: 0; flex: 1; }
  .chip { font-size: 12px; border-radius: 999px; padding: 1px 10px; font-weight: 500; }
  .chip.bug { background: #fee2e2; color: #dc2626; }
  .chip.suggestion { background: #ede9fe; color: #7c3aed; }
  .chip.other { background: #e9ecf1; color: #4b5563; }
  .chip.open { background: #fef3c7; color: #d97706; }
  .chip.processing { background: #dbeafe; color: #2563eb; }
  .chip.resolved { background: #dcfce7; color: #16a34a; }
  .chip.ok { background: #dcfce7; color: #16a34a; }
  .chip.bad { background: #fee2e2; color: #dc2626; }
  .chip.warn { background: #fef3c7; color: #d97706; }
  .chip.info { background: #e0f2fe; color: #0369a1; }
  .chip.online { background: #dcfce7; color: #16a34a; }
  .chip.offline { background: #e9ecf1; color: #6b7280; }
  /* ---- 反馈工作台：左列表右详情 ---- */
  .fb-split { display: grid; grid-template-columns: 400px 1fr; gap: 14px; align-items: start; }
  .fb-pane {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow); overflow: hidden;
  }
  .fb-rows, .fb-detail { max-height: calc(100vh - 320px); overflow-y: auto; }
  .fb-detail { padding: 18px 22px 20px; }
  .fb-row {
    display: flex; gap: 10px; padding: 12px 14px; cursor: pointer;
    border-bottom: 1px solid var(--line-soft); border-left: 2px solid transparent;
    transition: background .1s;
  }
  .fb-row:hover { background: #f8fafc; }
  .fb-row.sel { background: var(--accent-weak); border-left-color: var(--accent); }
  .fb-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; flex: none; }
  .fb-dot.open { background: var(--warn); }
  .fb-dot.processing { background: var(--accent); }
  .fb-dot.resolved { background: var(--ok); }
  .fb-rowmain { flex: 1; min-width: 0; }
  .fb-rowtxt { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fb-rowmeta { font-size: 11.5px; color: var(--faint); margin-top: 1px; display: flex; gap: 6px; align-items: center; }
  .fb-uid { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fb-nbadge {
    flex: none; font-size: 10.5px; color: var(--accent); background: var(--accent-weak);
    border-radius: 999px; padding: 0 6px; line-height: 16px;
  }
  .fb-time { flex: none; font-size: 11px; color: var(--faint); margin-top: 2px; }
  .fb-empty { padding: 46px 0; text-align: center; color: var(--faint); }
  .fb-dhead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .fb-type { font-size: 12px; color: var(--muted); background: var(--line-soft); border-radius: 999px; padding: 1px 10px; }
  .fb-statusseg { margin-left: auto; display: inline-flex; background: var(--line-soft); border-radius: 9px; padding: 2px; }
  .fb-statusseg button {
    border: 0; background: transparent; padding: 4px 13px; cursor: pointer;
    font-size: 12.5px; color: var(--muted); border-radius: 7px; transition: all .12s;
  }
  .fb-statusseg button:hover { color: var(--text); }
  .fb-statusseg button.cur { background: #fff; font-weight: 550; box-shadow: 0 1px 3px rgba(16,24,40,.12); cursor: default; }
  .fb-statusseg button.cur.open { color: var(--warn); }
  .fb-statusseg button.cur.processing { color: var(--accent); }
  .fb-statusseg button.cur.resolved { color: var(--ok); }
  .fb-body { font-size: 14px; white-space: pre-wrap; padding: 2px 0 12px; }
  .fb-titleline { color: var(--muted); font-size: 12.5px; margin-top: 6px; }
  .fb-userbox { border: 1px solid var(--line-soft); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
  .fb-userline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .fb-uid-full { font-family: Consolas, monospace; font-size: 12.5px; }
  .mini {
    border: 1px solid var(--line); background: #fff; border-radius: 7px; cursor: pointer;
    padding: 2px 9px; font-size: 11.5px; color: var(--muted);
  }
  .mini:hover { border-color: #c9d2e0; color: var(--text); }
  .fb-hisrows { display: none; margin-top: 8px; border-top: 1px dashed var(--line); padding-top: 6px; }
  .fb-userbox.exp .fb-hisrows { display: block; }
  .fb-hisrow {
    display: flex; gap: 8px; align-items: center; font-size: 12.5px; padding: 5px 6px;
    border-radius: 7px; cursor: pointer; color: var(--muted);
  }
  .fb-hisrow:hover { background: var(--line-soft); color: var(--text); }
  .fb-hisrow.cur { color: var(--text); font-weight: 500; }
  .fb-histxt { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fb-replylab { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
  .fb-hinthint { font-weight: 400; color: var(--faint); font-size: 11.5px; margin-left: 6px; }
  .fb-replied {
    font-size: 12.5px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;
    padding: 7px 11px; margin-bottom: 8px; color: #15803d;
  }
  .fb-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .fb-savehint { font-size: 11.5px; color: var(--faint); }
  .fb-metafoot { font-size: 11.5px; color: var(--faint); margin-top: 14px; display: flex; gap: 6px; flex-wrap: wrap; }
  .fb-cnt {
    font-size: 11px; color: var(--faint); background: var(--line-soft);
    border-radius: 999px; padding: 0 7px; line-height: 17px;
  }
  .seg button.on .fb-cnt { color: var(--accent); background: var(--accent-weak); }
  .iconbtn {
    border: 1px solid var(--line); background: #fff; border-radius: 8px;
    width: 34px; height: 34px; cursor: pointer; color: var(--muted); font-size: 15px;
  }
  .iconbtn:hover { border-color: #c9d2e0; background: #f8fafc; }
  .fb-kbdhint { margin-left: auto; font-size: 11.5px; color: var(--faint); display: inline-flex; gap: 4px; align-items: center; }
  .kbd {
    font-size: 10.5px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px;
    padding: 0 5px; color: var(--faint); background: #fff;
  }
  /* 反馈页轮询发现有新条目但当前草稿未保存时的提示条 */
  .fb-newpill {
    display: none; margin-bottom: 10px; padding: 7px 14px; cursor: pointer;
    background: var(--accent-weak); border: 1px solid #c7d7fe; border-radius: 10px;
    color: var(--accent-deep); font-size: 12.5px; width: fit-content;
  }
  .fb-newpill:hover { background: #e0eaff; }
  .fb-resolvelab { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--muted); cursor: pointer; }
  .fb-ver { font-size: 11px; color: var(--muted); background: #f4f6fa; border: 1px solid var(--line-soft); border-radius: 999px; padding: 0 8px; line-height: 18px; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .desc { white-space: pre-wrap; margin: 10px 0 4px; }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    text-align: left; border-bottom: 1px solid var(--line-soft);
    padding: 9px 12px; font-size: 13px; vertical-align: top;
  }
  th { color: var(--faint); font-weight: 500; font-size: 12px; }
  tr:hover td { background: #fafbfd; }
  td.wrap, .kv-val { max-width: 420px; overflow-wrap: anywhere; }
  .kv td:first-child { color: var(--muted); width: 190px; background: #f8fafc; }
  tr:hover .kv td:first-child { background: #f3f6fa; }
  details.diag { margin: 8px 0; }
  details.diag summary { cursor: pointer; color: var(--muted); font-size: 12.5px; padding: 6px 2px; }
  details.diag summary:hover { color: var(--accent); }
  pre.json {
    background: #f8fafc; border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 12px; font-size: 12px; overflow: auto; max-height: 420px;
  }
  .replybox { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 10px; }
  .replybox .existing {
    background: var(--accent-weak); border-radius: 8px; padding: 8px 12px;
    font-size: 13px; margin-bottom: 8px;
  }
  .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
  .saved { color: var(--ok); font-size: 12px; }
  .empty { text-align: center; color: var(--faint); padding: 46px 0; }
  .err { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 10px; padding: 10px 14px; margin-bottom: 12px; }
  .ok-note { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; border-radius: 10px; padding: 8px 14px; margin-bottom: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
  .form-row { display: flex; gap: 14px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
  .field > span { font-size: 12px; color: var(--muted); font-weight: 500; }
  .field input[type=text] { width: 100%; }
  .field select { min-width: 132px; }
</style>
</head>
<body>
<aside>
  <div class="brand">管理控制台</div>
  <div class="brand-sub">NextBot · 部署后台</div>
  <nav id="nav">
    <a href="#overview" data-tab="overview">概览</a>
    <a href="#users" data-tab="users">用户</a>
    <a href="#whitelist" data-tab="whitelist">内测<span class="nav-badge" id="navBadgeWaitlist"></span></a>
    <a href="#messages" data-tab="messages">站内信</a>
    <a href="#payments" data-tab="payments">支付</a>
    <a href="#feedback" data-tab="feedback">反馈管理<span class="nav-badge" id="navBadgeFeedback"></span></a>
    <a href="#downloads" data-tab="downloads">下载分发</a>
  </nav>
  <div class="tokenbox" id="accountBox" style="display:none">
    <label>管理员</label>
    <div class="hint" id="accountName" style="margin:2px 0 8px"></div>
    <button class="btn" id="logoutBtn" style="width:100%">退出登录</button>
  </div>
</aside>
<main>
  <div id="err"></div>

  <!-- 登录门：未认证时盖住整页（登录 / 首次设置两种形态）。配色取页面浅色主题实值 -->
  <div id="authGate" style="display:none;position:fixed;inset:0;z-index:60;background:rgba(16,24,40,.38);align-items:center;justify-content:center">
    <div style="width:320px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:0 12px 32px rgba(16,24,40,.18)">
      <h2 id="authTitle" style="margin:0 0 4px;font-size:17px;color:var(--text)">管理员登录</h2>
      <div class="hint" id="authSub" style="margin-bottom:14px">输入管理员账号密码</div>
      <input id="authUser" placeholder="账号" autocomplete="username"
             style="width:100%;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--text)">
      <input id="authPass" type="password" placeholder="密码" autocomplete="current-password"
             style="width:100%;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--text)">
      <input id="authPass2" type="password" placeholder="再输一遍密码" autocomplete="new-password" style="display:none;width:100%;margin-bottom:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--text)">
      <div id="authErr" style="color:var(--bad);font-size:12px;min-height:18px;margin-bottom:6px"></div>
      <button class="btn primary" id="authSubmit" style="width:100%">登录</button>
    </div>
  </div>


  <section class="tab" id="tab-overview">
    <h1>概览</h1>
    <div class="sub">用户增长 · 站内信 · 支付收入 · 反馈 · 服务器</div>
    <div id="overviewBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-users">
    <h1>用户</h1>
    <div class="sub">注册数据 · 搜索 · 禁用/恢复（禁用后该用户无法继续对话）</div>
    <div class="toolbar">
      <input type="search" id="userKw" placeholder="搜索显示名 / 身份 ID / 邮箱">
      <select id="userStatusSel">
        <option value="">全部状态</option>
        <option value="ok">正常</option>
        <option value="disabled">已禁用</option>
        <option value="incomplete">未完成初始化</option>
      </select>
      <select id="userSortSel">
        <option value="newreg">最新注册优先</option>
        <option value="oldreg">最早注册优先</option>
        <option value="active">最近活跃优先</option>
        <option value="feedback">反馈最多优先</option>
      </select>
      <button class="btn primary" id="userRefresh">刷新</button>
    </div>
    <div id="usersBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-whitelist">
    <h1>内测管理</h1>
    <div class="sub">注册闸门 · 白名单 / 候补审批（用户登录页自助排队，这里批量通过，通过即邮件通知）· 踢人请到「用户」页禁用</div>
    <div id="wlBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-messages">
    <h1>站内信</h1>
    <div class="sub">给用户发送站内信（全体 / 指定用户 / 分组）· 发送记录 · 外部消息聚合统计</div>
    <div id="composeBody"><div class="empty">加载中…</div></div>
    <div id="messagesBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-payments">
    <h1>支付</h1>
    <div class="sub">真实支付订单（微信 / 支付宝 live 通道）· 台账只记真实交易，模拟订单不落库</div>
    <div class="toolbar" id="payToolbar" style="display:none">
      <select id="payRange">
        <option value="0">全部时间</option>
        <option value="1">今天</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
      </select>
      <button class="btn" id="payExportBtn">导出 CSV</button>
      <span class="meta" id="payRangeHint"></span>
    </div>
    <div id="paymentsBody"><div class="empty">加载中…</div></div>
  </section>

  <section class="tab" id="tab-feedback">
    <h1>反馈管理</h1>
    <div class="sub">左列选条、右栏处理：状态流转即时生效 · 保存回复自动以站内信送达用户</div>
    <div class="toolbar">
      <div class="seg" id="fbStatusSeg"></div>
      <select id="fbTypeSel">
        <option value="">全部类型</option>
        <option value="bug">问题报障</option>
        <option value="suggestion">功能建议</option>
        <option value="other">其他</option>
      </select>
      <input type="search" id="fbKw" placeholder="搜索正文 / 用户 / 联系方式">
      <button class="iconbtn" id="fbRefresh" title="刷新">⟳</button>
      <span class="fb-kbdhint"><span class="kbd">J</span> <span class="kbd">K</span> 切换条目</span>
    </div>
    <div class="fb-newpill" id="fbNewPill"></div>
    <div class="fb-split">
      <div class="fb-pane"><div class="fb-rows" id="fbList"><div class="fb-empty">加载中…</div></div></div>
      <div class="fb-pane"><div class="fb-detail" id="fbDetail"><div class="fb-empty">加载中…</div></div></div>
    </div>
  </section>

  <section class="tab" id="tab-downloads">
    <h1>下载分发</h1>
    <div class="sub">桌面应用安装包管理：上传 / 列表 / 下架（客户端从 /downloads/ 下载）</div>
    <div class="card" style="margin-bottom:12px">
      <div class="sub" style="margin:0 0 8px">发版设置（客户端启动检查的版本清单，保存即生效，无需重启）</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <label>latest <input id="mfLatest" size="9" placeholder="0.2.0"></label>
        <label>url <input id="mfUrl" size="58" placeholder="https://nextbot.top/downloads/Nextbot-Setup-x.y.z.exe"></label>
        <button class="btn primary" id="mfSaveBtn">保存清单</button>
        <span class="meta" id="mfHint"></span>
      </div>
      <div class="meta" id="mfMeta" style="margin-top:6px"></div>
      <div class="meta" id="mfHistory" style="margin-top:4px"></div>
    </div>
    <div class="toolbar">
      <input type="file" id="dlFile" style="display:none">
      <button class="btn primary" id="dlUploadBtn">上传安装包</button>
      <span class="meta" id="dlUploadHint">支持 .exe .zip .dmg .msi .apk .tar.gz .deb .rpm，同名覆盖</span>
      <button class="btn" id="dlRefresh">刷新</button>
    </div>
    <div id="dlList"><div class="empty">加载中…</div></div>
  </section>

</main>
<script>
var STATUS_LABELS = ${statusLabelsJson};
var TYPE_LABELS = ${typeLabelsJson};
var allFeedback = [];
var fbStatusFilter = "";
var allUsers = [];
var allDownloads = [];
var currentTab = "overview";

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 会话走 HttpOnly Cookie（same-origin fetch 默认携带），浏览器不再保存任何主凭证。
// X-Requested-With 是 cookie 通道写请求的服务端 CSRF 校验要求，所有请求统一带上。
function api(path, opts) {
  opts = Object.assign({}, opts || {});
  opts.headers = Object.assign({ "X-Requested-With": "admin-console" }, opts.headers || {});
  // 服务端 watch 重启后，浏览器连接池里的旧 keep-alive 连接可能半死：
  // fetch 永远 pending 而不是 reject。每次尝试 6 秒无响应就 abort 换新连接，
  // 最多试 3 次；HTTP 4xx/5xx 照常透传给调用方处理。
  var attempt = function (delayMs) {
    var prepare = delayMs
      ? new Promise(function (res) { setTimeout(res, delayMs); })
      : Promise.resolve();
    return prepare.then(function () {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 6000);
      opts.signal = ctrl.signal;
      return fetch(path, opts).finally(function () { clearTimeout(timer); });
    });
  };
  return attempt(0).catch(function () {
    return attempt(600);
  }).catch(function () {
    return attempt(1500);
  }).then(function (res) {
    // 会话过期/被吊销：任何接口 401 都直接亮出登录门（showAuthGate 声明在后，提升可用）
    if (res.status === 401 && authed) showAuthGate(false);
    return res;
  });
}

function fmtTime(isoOrMs) {
  if (!isoOrMs) return "-";
  var d = new Date(isoOrMs);
  if (isNaN(d.getTime())) return "-";
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function fmtBytes(n) {
  if (!n && n !== 0) return "-";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

function fmtUptime(ms) {
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400); s %= 86400;
  var h = Math.floor(s / 3600); s %= 3600;
  var m = Math.floor(s / 60);
  if (d > 0) return d + " 天 " + h + " 时 " + m + " 分";
  if (h > 0) return h + " 时 " + m + " 分";
  return m + " 分 " + (s % 60) + " 秒";
}

function showErr(msg) { $("err").innerHTML = '<div class="err">' + esc(msg) + "</div>"; }
function clearErr() { $("err").innerHTML = ""; }
function okNote(msg) { return '<div class="ok-note">' + esc(msg) + "</div>"; }

function chip(cls, text) { return '<span class="chip ' + cls + '">' + esc(text) + "</span>"; }

// ---------- 标签路由 ----------
function showTab(name) {
  if (name === "compose") name = "messages"; // 旧「消息发送」链接兼容：并入站内信
  currentTab = name;
  var tabs = document.querySelectorAll("section.tab");
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("on");
  var target = $("tab-" + name);
  if (target) target.classList.add("on");
  window.scrollTo(0, 0); // 切标签回到页首，避免停在上一标签的滚动位置看不到顶部内容
  var links = document.querySelectorAll("#nav a");
  for (var j = 0; j < links.length; j++) {
    links[j].classList.toggle("on", links[j].getAttribute("data-tab") === name);
  }
  if (name === "overview") loadOverview();
  else if (name === "users") loadUsers();
  else if (name === "whitelist") loadWhitelist();
  else if (name === "payments") loadPayments();
  else if (name === "messages") { loadCompose(); loadMessages(); }
  else if (name === "feedback") loadFeedback();
  else if (name === "downloads") { loadDownloads(); loadManifest(); }
}

/** 带 hash 的跳转（跨标签按钮统一走这里，保持地址栏可分享/可回退）。 */
function gotoTab(name) {
  if (location.hash !== "#" + name) location.hash = "#" + name;
  else showTab(name);
}

// ---------- 导航待办徽标 ----------
function setNavBadge(id, n) {
  var el = $(id);
  if (!el) return;
  if (n > 0) {
    el.textContent = n > 99 ? "99+" : String(n);
    el.style.display = "inline-block";
  } else {
    el.style.display = "none";
  }
}

function refreshPendingBadge() {
  api("/api/admin/pending-counts").then(function (r) { return r.json(); }).then(function (j) {
    if (!j || j.ok !== true) return;
    setNavBadge("navBadgeFeedback", j.feedbackOpen || 0);
    setNavBadge("navBadgeWaitlist", j.waitlistPending || 0);
  }).catch(function () {});
}
// 60s 常驻轮询（页面隐藏时跳过）；反馈/内测页操作完成后也会即时刷新
setInterval(function () { if (authed && !document.hidden) refreshPendingBadge(); }, 60000);

// ---------- 通用小组件 ----------
function statCard(n, label) {
  return '<div class="stat"><b>' + n + "</b><span>" + label + "</span></div>";
}

function kpiCard(n, label, sub) {
  return '<div class="stat"><b>' + n + "</b><span>" + label +
    '</span><div class="stat-sub">' + esc(sub) + "</div></div>";
}

function barChart(series, color) {
  var max = 1;
  series.forEach(function (s) { if (s.count > max) max = s.count; });
  var bars = series.map(function (s) {
    var h = Math.max(2, Math.round((s.count / max) * 110));
    return '<div class="bar-col" title="' + esc(s.day) + '：' + s.count + '">' +
      '<div class="bar-v" style="height:' + h + 'px;background:' + color + '"></div>' +
      '<div class="bar-label">' + esc(s.day.slice(5)) + "</div></div>";
  }).join("");
  return '<div class="bars">' + bars + "</div>";
}

// ---------- 概览 ----------
function loadOverview() {
  var body = $("overviewBody");
  api("/api/admin/overview").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.code === 503) throw new Error("管理后台尚未初始化（无任何凭证），请刷新页面完成管理员账号设置");
      if (res.j.ok !== true) throw new Error("概览接口异常");
      var d = res.j;
      var html = '<div class="stats">' +
        kpiCard(d.users.total, "注册用户", "今日 +" + d.users.newToday + " · 7 日 +" + d.users.new7d +
          (d.users.disabled ? " · 禁用 " + d.users.disabled : "")) +
        kpiCard(d.users.active7d != null ? d.users.active7d : "-", "7 日活跃",
          "今日活跃 " + (d.users.activeToday != null ? d.users.activeToday : "-")) +
        (d.messages
          ? kpiCard(d.messages.messages, "站内信", "今日 " + d.messages.today + " · 发出 " + d.messages.outbound)
          : kpiCard("-", "站内信", "未启用")) +
        (d.orders
          ? kpiCard(d.orders.total, "真实订单", "已付 " + d.orders.paid + " · 待付 " + d.orders.pending +
            (d.orders.closed ? " · 关闭 " + d.orders.closed : "") + (d.orders.refunded ? " · 退款 " + d.orders.refunded : ""))
          : kpiCard("-", "真实订单", "未启用")) +
        (d.orders
          ? kpiCard("¥" + d.orders.paidAmount, "收入", d.orders.paid + " 笔已支付")
          : "") +
        "</div>";
      html += '<div class="grid2" style="margin-bottom:12px">' +
        '<div class="card"><div class="card-title">注册趋势（近 14 天）</div>' + barChart(d.users.series, "#3b82f6") + "</div>" +
        (d.orders && d.orders.series
          ? '<div class="card"><div class="card-title">收入趋势（近 14 天 · ¥）</div>' + barChart(d.orders.series, "#16a34a") + "</div>"
          : '<div class="card"><div class="card-title">收入趋势</div><div class="meta">支付未启用</div></div>') +
        "</div>";
      var oldestDays = null;
      if (d.feedback.oldestOpenAt) {
        var ms = Date.now() - Date.parse(d.feedback.oldestOpenAt);
        if (Number.isFinite(ms)) oldestDays = Math.floor(ms / 86400000);
      }
      html += '<div class="grid2" style="margin-bottom:12px">' +
        '<div class="card"><div class="card-title">站内信趋势（近 14 天）</div>' +
        (d.messages ? barChart(d.messages.series, "#16a34a") : '<div class="meta">未启用</div>') +
        "</div>" +
        '<div class="card"><div class="card-title">反馈处理</div><div class="stats" style="margin-bottom:0">' +
        statCard(d.feedback.open, "反馈 · 待处理") +
        statCard(d.feedback.processing, "反馈 · 处理中") +
        statCard(d.feedback.resolved, "反馈 · 已解决") +
        "</div>" +
        (d.feedback.open > 0 && oldestDays != null
          ? '<div class="meta" style="margin-top:8px">最老的待处理提交于 ' +
            (oldestDays >= 1 ? '<b style="color:var(--warn)">' + oldestDays + ' 天前</b>' : '今天') +
            '，<a href="#feedback">去处理 →</a></div>'
          : "") +
        "</div></div>";
      html += '<div class="meta">服务器：运行 ' + fmtUptime(d.server.uptimeMs) + " · 内存 " +
        fmtBytes(d.server.rssBytes) + " · " + esc(d.server.nodeVersion) + " · " + esc(d.server.platform) +
        "</div>";
      body.innerHTML = html;
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
      showErr(e.message);
    });
}

// ---------- 反馈管理（左列表右详情工作台） ----------
var fbSelId = null;
// 跨页跳转：用户页点「反馈」时先记下要搜的身份，反馈列表加载完自动填入
var pendingFeedbackSearch = null;
// 自动刷新：45s 轮询，有未保存草稿时不重绘、只亮提示条
var fbNewCount = 0;

function fbSignature(items) {
  var newest = "";
  for (var i = 0; i < items.length; i++) {
    var t = items[i].updatedAt || items[i].createdAt || "";
    if (t > newest) newest = t;
  }
  return items.length + "@" + newest;
}

function fbHasDraft() {
  var ta = document.querySelector("#fbDetail textarea");
  if (!ta || !fbSelId) return false;
  var r = fbFind(fbSelId);
  return ta.value.trim() !== ((r && r.replyNote) || "").trim();
}

function renderFbNewPill() {
  var el = $("fbNewPill");
  if (!el) return;
  if (fbNewCount > 0) {
    el.textContent = "有 " + fbNewCount + " 条新反馈 / 状态更新 —— 你的回复草稿未保存，点击后刷新";
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

function fbPollTick() {
  if (currentTab !== "feedback" || !authed || document.hidden) return;
  api("/api/feedback?limit=500").then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok !== true) return;
    var items = data.items || [];
    if (fbSignature(items) === fbSignature(allFeedback)) return;
    if (fbHasDraft()) {
      // 正在写回复：不重绘（重绘会丢草稿），只提示
      var known = {};
      allFeedback.forEach(function (r) { known[r.id] = r.updatedAt || r.createdAt || ""; });
      fbNewCount = 0;
      items.forEach(function (r) { if (known[r.id] !== (r.updatedAt || r.createdAt || "")) fbNewCount++; });
      renderFbNewPill();
      return;
    }
    applyFeedbackItems(items);
  }).catch(function () {});
}
setInterval(fbPollTick, 45000);

/** 用一份全量列表刷新工作台（尽量保住当前选中项）。 */
function applyFeedbackItems(items) {
  allFeedback = items;
  fbNewCount = 0;
  renderFbNewPill();
  // 选中项被删/被筛掉时回落到列表第一条
  if (fbSelId && !filteredFeedback().some(function (r) { return r.id === fbSelId; })) fbSelId = null;
  if (!fbSelId) {
    var first = filteredFeedback()[0];
    if (first) fbSelId = first.id;
  }
  renderFbSeg();
  renderFbList();
  renderFbDetail();
  refreshPendingBadge();
}

function loadFeedback() {
  clearErr();
  api("/api/feedback?limit=500").then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok !== true) throw new Error("接口返回异常");
    if (pendingFeedbackSearch != null) {
      $("fbKw").value = pendingFeedbackSearch;
      pendingFeedbackSearch = null;
    }
    applyFeedbackItems(data.items || []);
  }).catch(function (e) {
    $("fbList").innerHTML = '<div class="fb-empty">加载失败</div>';
    showErr("反馈加载失败：" + e.message);
  });
}

// 客户端标题=正文首行自动派生，title 是 description 前缀时不重复展示
function fbTitleDuplicated(r) {
  var t = (r.title || "").trim(), d = (r.description || "").trim();
  return !t || d.indexOf(t) === 0;
}

function filteredFeedback() {
  var kw = $("fbKw").value.trim().toLowerCase();
  var type = $("fbTypeSel").value;
  return allFeedback.filter(function (r) {
    if (fbStatusFilter && r.status !== fbStatusFilter) return false;
    if (type && r.type !== type) return false;
    if (kw) {
      var hay = (r.title + " " + r.description + " " + r.actorId + " " + (r.contact || "")).toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}

function fbByUser(actorId) {
  return allFeedback.filter(function (r) { return r.actorId === actorId; });
}

function renderFbSeg() {
  var counts = { "": allFeedback.length, open: 0, processing: 0, resolved: 0 };
  allFeedback.forEach(function (r) { if (counts[r.status] != null) counts[r.status]++; });
  $("fbStatusSeg").innerHTML = segOpts.map(function (o) {
    return '<button data-v="' + o.v + '"' + (o.v === fbStatusFilter ? ' class="on"' : "") + ">" +
      o.l + ' <span class="fb-cnt">' + counts[o.v] + "</span></button>";
  }).join("");
}

function shortFbUid(a) { return a && a.length > 16 ? a.slice(0, 9) + "…" + a.slice(-4) : (a || "-"); }

function renderFbList() {
  var items = filteredFeedback();
  if (!items.length) {
    $("fbList").innerHTML = '<div class="fb-empty">没有符合条件的反馈</div>';
    return;
  }
  $("fbList").innerHTML = items.map(function (r) {
    var n = fbByUser(r.actorId).length;
    return '<div class="fb-row' + (r.id === fbSelId ? " sel" : "") + '" data-fbid="' + esc(r.id) + '">' +
      '<span class="fb-dot ' + esc(r.status) + '"></span>' +
      '<div class="fb-rowmain"><div class="fb-rowtxt">' + esc((r.description || r.title).split("\\n")[0]) + "</div>" +
      '<div class="fb-rowmeta"><span class="fb-uid">' + esc(shortFbUid(r.actorId)) + "</span>" +
      (n > 1 ? '<span class="fb-nbadge">×' + n + "</span>" : "") + "</div></div>" +
      '<span class="fb-time">' + fmtTime(r.createdAt).slice(5, 10) + "</span></div>";
  }).join("");
  var rows = $("fbList").querySelectorAll(".fb-row");
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener("click", function () {
      fbSelId = this.getAttribute("data-fbid");
      renderFbList();
      renderFbDetail();
    });
  }
}

function renderFbDetail() {
  var box = $("fbDetail");
  var r = null;
  for (var i = 0; i < allFeedback.length; i++) if (allFeedback[i].id === fbSelId) r = allFeedback[i];
  if (!r) { box.innerHTML = '<div class="fb-empty">左侧选择一条反馈</div>'; return; }
  var his = fbByUser(r.actorId);
  var diagKeys = Object.keys(r.diagnostics || {});
  var h = '<div class="fb-dhead"><span class="fb-type">' + esc(TYPE_LABELS[r.type] || r.type) + "</span>" +
    // 客户端版本 / 平台：判断「是不是新版才有的 bug」的第一眼信息
    (r.clientVersion ? '<span class="fb-ver">v' + esc(r.clientVersion) + "</span>" : "") +
    (r.platform ? '<span class="fb-ver">' + esc(r.platform) + "</span>" : "") +
    '<div class="fb-statusseg">';
  ["open", "processing", "resolved"].forEach(function (st) {
    h += '<button data-act="fb-status" data-id="' + esc(r.id) + '" data-status="' + st + '"' +
      (st === r.status ? ' class="cur ' + st + '"' : "") + ">" + (STATUS_LABELS[st] || st) + "</button>";
  });
  h += "</div></div>";
  h += '<div class="fb-body">' + esc(r.description || r.title);
  if (!fbTitleDuplicated(r)) h += '<div class="fb-titleline">标题：' + esc(r.title) + "</div>";
  h += "</div>";
  if (diagKeys.length) {
    h += '<details class="diag"><summary>诊断信息 · ' + diagKeys.length + " 项</summary><table>" +
      diagKeys.map(function (k) {
        return "<tr><td>" + esc(k) + '</td><td class="kv-val">' + esc(r.diagnostics[k]) + "</td></tr>";
      }).join("") + "</table></details>";
  }
  h += '<div class="fb-userbox"><div class="fb-userline">' +
    '<span class="fb-uid-full">' + esc(r.actorId || "-") + "</span>" +
    '<button class="mini" data-act="fb-copyid" data-user="' + esc(r.actorId || "") + '">复制 ID</button>' +
    (r.actorId ? '<button class="mini" data-act="fb-goto-user" data-user="' + esc(r.actorId) + '">查看账号</button>' : "") +
    (his.length > 1 ? '<button class="mini" data-act="fb-togglehis">他的反馈 · ' + his.length + " 条 ▾</button>" : "") +
    "</div>" +
    (his.length > 1 ? '<div class="fb-hisrows">' + his.map(function (x) {
      return '<div class="fb-hisrow' + (x.id === r.id ? " cur" : "") + '" data-fbid="' + esc(x.id) + '">' +
        '<span class="fb-dot ' + esc(x.status) + '"></span>' +
        '<span class="fb-histxt">' + esc((x.description || x.title).slice(0, 30)) + "</span>" +
        "<span>" + (STATUS_LABELS[x.status] || x.status) + "</span>" +
        '<span class="fb-time">' + fmtTime(x.createdAt).slice(5, 10) + "</span></div>";
    }).join("") + "</div>" : "") +
    "</div>";
  h += '<div class="fb-replylab">回复用户 <span class="fb-hinthint">保存后自动以站内信送达该用户</span></div>';
  if (r.replyNote) h += '<div class="fb-replied">已回复：' + esc(r.replyNote) + "</div>";
  h += '<textarea id="fb-note-' + esc(r.id) + '" rows="3" placeholder="' +
    (r.replyNote ? "补充新回复…" : "回复说明…（留空仅流转状态）") + '"></textarea>';
  h += '<div class="fb-actions"><button class="btn primary" data-act="fb-save" data-id="' + esc(r.id) + '"' +
    (r.replyNote ? " disabled" : "") + '>保存回复并通知</button>' +
    (r.status !== "resolved"
      ? '<label class="fb-resolvelab"><input type="checkbox" id="fb-resolve-' + esc(r.id) + '">保存后标记为已解决</label>'
      : "") +
    '<span class="fb-savehint">状态流转即时生效，无需另存</span></div>';
  h += '<div class="fb-metafoot"><span>#' + esc(r.id) + "</span><span>·</span><span>" + fmtTime(r.createdAt) + "</span>" +
    (r.contact ? "<span>·</span><span>联系方式：" + esc(r.contact) + "</span>" : "") + "</div>";
  box.innerHTML = h;
  var hisRows = box.querySelectorAll(".fb-hisrow");
  for (var j = 0; j < hisRows.length; j++) {
    hisRows[j].addEventListener("click", function () {
      fbSelId = this.getAttribute("data-fbid");
      renderFbList();
      renderFbDetail();
    });
  }
  var ta = box.querySelector("textarea");
  var sb = box.querySelector('[data-act="fb-save"]');
  if (ta && sb) {
    ta.addEventListener("input", function () { sb.disabled = ta.value.trim() === (r.replyNote || "").trim(); });
  }
}

function fbFind(id) {
  for (var i = 0; i < allFeedback.length; i++) if (allFeedback[i].id === id) return allFeedback[i];
  return null;
}

function updateFeedbackStatus(id, status) {
  var noteEl = $("fb-note-" + id);
  var note = noteEl ? noteEl.value.trim() : "";
  var current = fbFind(id);
  var body = { status: status };
  if (note) body.replyNote = note; // 输入中的新回复随状态一并保存
  else if (current && current.replyNote) body.replyNote = current.replyNote; // 保持已存回复
  api("/api/feedback/" + encodeURIComponent(id) + "/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.ok !== true) throw new Error(data.message || "更新失败");
    loadFeedback();
  }).catch(function (e) { showErr("反馈更新失败：" + e.message); });
}

function saveFeedbackReply(id) {
  var noteEl = $("fb-note-" + id);
  var note = noteEl ? noteEl.value.trim() : "";
  var current = fbFind(id);
  if (!note || note === ((current && current.replyNote) || "").trim()) return;
  // 勾选「保存后标记为已解决」则随回复一并流转
  var resolveEl = $("fb-resolve-" + id);
  var target = resolveEl && resolveEl.checked ? "resolved" : (current ? current.status : "open");
  updateFeedbackStatus(id, target);
}

// ---------- 用户 ----------
var userFbCounts = {};        // actorId -> 反馈条数（与反馈列表同源）
var pendingUserSearch = null; // 跨页跳转：反馈页「查看账号」带过来的搜索词
var pendingUserInbox = null;  // 跨页跳转：用户页「收件箱」要打开的目标

function userStatusKey(u) {
  if (u.disabled) return "disabled";
  if (!u.setupComplete) return "incomplete";
  return "ok";
}

function loadUsers() {
  clearErr();
  var body = $("usersBody");
  // 用户列表与反馈列表并行拉：反馈数列与「反馈最多」排序都要用
  Promise.all([
    api("/api/admin/users").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); }),
    api("/api/feedback?limit=500").then(function (r) { return r.json(); }).catch(function () { return null; })
  ])
    .then(function (results) {
      var res = results[0];
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.code === 503) throw new Error("管理后台尚未初始化（无任何凭证）");
      allUsers = res.j.users || [];
      userFbCounts = {};
      if (results[1] && results[1].ok === true) {
        (results[1].items || []).forEach(function (r) {
          if (!r.actorId) return;
          userFbCounts[r.actorId] = (userFbCounts[r.actorId] || 0) + 1;
        });
      }
      var s = res.j.stats || {};
      var html = '<div class="stats">' +
        statCard(s.total, "注册用户") +
        statCard("+" + (s.newToday || 0), "今日新增") +
        statCard("+" + (s.new7d || 0), "近 7 日新增") +
        kpiCard(s.active7d != null ? s.active7d : "-", "7 日活跃", "今日活跃 " + (s.activeToday != null ? s.activeToday : "-")) +
        (s.disabled ? statCard(s.disabled, "已禁用") : "") +
        "</div>";
      html += '<div class="card" style="margin-bottom:12px"><div class="card-title">注册趋势（近 30 天）</div>' +
        barChart(s.series || [], "#3b82f6") + "</div>";
      html += '<div id="userTableWrap"></div>';
      body.innerHTML = html;
      if (pendingUserSearch != null) {
        $("userKw").value = pendingUserSearch;
        pendingUserSearch = null;
        var selEl = $("userStatusSel"); if (selEl) selEl.value = "";
      }
      renderUserTable();
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

function filteredUsers() {
  var kw = ($("userKw") ? $("userKw").value.trim() : "").toLowerCase();
  var status = $("userStatusSel") ? $("userStatusSel").value : "";
  return allUsers.filter(function (u) {
    if (status && userStatusKey(u) !== status) return false;
    if (!kw) return true;
    var hay = ((u.displayName || "") + " " + u.userId + " " + (u.email || "")).toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
}

function sortedUsers(users) {
  var mode = $("userSortSel") ? $("userSortSel").value : "newreg";
  var byLastActive = function (a, b) {
    var ta = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
    var tb = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
    return tb - ta;
  };
  var rows = users.slice();
  if (mode === "oldreg") rows.sort(function (a, b) { return Date.parse(a.createdAt) - Date.parse(b.createdAt); });
  else if (mode === "active") rows.sort(byLastActive);
  else if (mode === "feedback") rows.sort(function (a, b) { return (userFbCounts[b.userId] || 0) - (userFbCounts[a.userId] || 0); });
  else rows.sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
  return rows;
}

function renderUserTable() {
  var wrap = $("userTableWrap");
  if (!wrap) return;
  var users = sortedUsers(filteredUsers());
  if (!allUsers.length) {
    wrap.innerHTML = '<div class="card"><div class="empty">还没有注册用户。客户端注册账号后会出现在这里。</div></div>';
    return;
  }
  if (!users.length) {
    wrap.innerHTML = '<div class="card"><div class="empty">没有匹配的用户</div></div>';
    return;
  }
  var rows = users.map(function (u) {
    var statusChip = u.disabled ? chip("bad", "已禁用") : (u.setupComplete ? chip("ok", "正常") : chip("other", "未完成初始化"));
    var toggleBtn = u.disabled
      ? '<button class="btn small" data-act="user-toggle" data-user="' + esc(u.userId) + '" data-disabled="0">恢复启用</button>'
      : '<button class="btn small danger" data-act="user-toggle" data-user="' + esc(u.userId) + '" data-disabled="1">禁用</button>';
    var fbN = userFbCounts[u.userId] || 0;
    var fbCell = fbN > 0
      ? '<button class="mini" data-act="user-goto-feedback" data-user="' + esc(u.userId) + '" title="查看该用户的反馈">反馈 ' + fbN + " 条</button>"
      : '<span class="meta">0</span>';
    var lastActive = u.lastActiveAt ? fmtTime(u.lastActiveAt) : '<span class="meta">从未上线</span>';
    return "<tr" + (u.disabled ? ' style="opacity:.55"' : "") + ">" +
      "<td>" + esc(u.displayName || "-") + "</td>" +
      '<td class="wrap">' + esc(u.userId) + "</td>" +
      "<td>" + esc(u.email || "-") + "</td>" +
      "<td>" + statusChip + "</td>" +
      "<td>" + lastActive + "</td>" +
      "<td>" + fmtTime(u.createdAt) + "</td>" +
      "<td>" + fbCell + "</td>" +
      "<td>" + toggleBtn +
      ' <button class="btn small" data-act="user-goto-inbox" data-user="' + esc(u.userId) + '" title="查看该用户的站内信收件箱">收件箱</button></td>' +
      "</tr>";
  }).join("");
  wrap.innerHTML = '<div class="card"><table><tr>' +
    "<th>显示名</th><th>身份 ID</th><th>邮箱</th><th>状态</th><th>最近活跃</th><th>注册时间</th><th>反馈</th><th>操作</th>" +
    "</tr>" + rows + "</table></div>";
}

/** 反馈页「查看账号」：切到用户页并按身份 ID 过滤。 */
function gotoUserPage(userId) {
  pendingUserSearch = userId;
  gotoTab("users");
}

/** 用户页「反馈 N 条」/反馈按钮：切到反馈页并按身份搜索。 */
function gotoFeedbackSearch(userId) {
  pendingFeedbackSearch = userId;
  gotoTab("feedback");
}

/** 用户页「收件箱」：切到站内信页，等发送区渲染完打开该用户的收件箱。 */
function gotoUserInbox(userId) {
  pendingUserInbox = userId;
  gotoTab("messages");
}

function toggleUser(userId, disable) {
  var verb = disable ? "禁用" : "恢复启用";
  if (!confirm("确定要" + verb + "用户 " + userId + " 吗？" +
    (disable ? "禁用后该用户将无法继续与 Agent 对话。" : ""))) return;
  api("/api/admin/users/" + encodeURIComponent(userId) + "/disabled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled: !!disable })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || "操作失败");
      loadUsers();
    })
    .catch(function (e) { showErr(verb + "失败：" + e.message); });
}

// ---------- 内测管理（白名单 / 候补审批） ----------
var wlEmails = [];
var wlEnabled = false;
var wlCorrupt = false;
var wlUpdatedAt = null;
var wlRequests = [];

function wlStatusChip(r) {
  if (r.status === "approved") return chip("ok", "已通过");
  if (r.status === "rejected") return chip("bad", "已拒绝");
  return chip("other", "待审批");
}

function renderBeta() {
  var body = $("wlBody");
  var pendingCount = 0;
  var i;
  for (i = 0; i < wlRequests.length; i++) if (wlRequests[i].status === "pending") pendingCount++;
  var html = '<div class="stats">' +
    statCard(wlEmails.length, "白名单邮箱") +
    statCard(pendingCount, "待审批") +
    "</div>";
  var stateChip;
  if (wlCorrupt) stateChip = chip("bad", "名单文件损坏：暂拒一切新注册（fail-closed）· 重新添加邮箱保存即修复");
  else if (wlEnabled) stateChip = chip("ok", "已设闸：仅名单内邮箱可注册");
  else stateChip = chip("other", "未设闸：任何人可注册 · 添加第一个邮箱即自动设闸");
  html += '<div class="card" style="margin-bottom:12px"><div class="card-title">注册闸门</div>' + stateChip +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">' +
    '<input type="email" id="wlEmail" placeholder="tester@example.com" style="padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--text)">' +
    '<button class="btn primary" id="wlAddBtn">加入白名单</button>' +
    '<span class="meta">名单更新：' + fmtTime(wlUpdatedAt) + ' · 落盘 data/beta-whitelist.json 改完即生效无需重启 · 只挡新注册，已注册用户登录不受影响</span>' +
    "</div>";
  if (wlEmails.length) {
    var rows = wlEmails.map(function (e) {
      return "<tr><td>" + esc(e) +
        '</td><td style="width:90px"><button class="btn small danger" data-act="wl-remove" data-email="' +
        esc(e) + '">移除</button></td></tr>';
    }).join("");
    html += '<table style="margin-top:10px"><tr><th>名单邮箱</th><th>操作</th></tr>' + rows + "</table>";
  }
  html += "</div>";
  html += '<div class="card" style="margin-bottom:12px"><div class="card-title">候补申请（用户在登录页自助排队）</div>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
    '<button class="btn primary small" data-act="wl-approve-checked">通过选中</button>' +
    '<button class="btn small danger" data-act="wl-reject-checked">拒绝选中</button>' +
    '<button class="btn small" data-act="wl-refresh">刷新</button>' +
    '<span class="meta">通过 = 加入白名单并自动邮件通知对方（需已配置 SMTP）</span></div>';
  if (!wlRequests.length) {
    html += '<div class="empty">还没有申请。用户在登录页被闸拦截后可自助提交。</div>';
  } else {
    var qrows = wlRequests.map(function (r) {
      var check = r.status === "pending"
        ? '<input type="checkbox" class="wl-apply-check" data-email="' + esc(r.email) + '">'
        : "";
      var ops = r.status === "pending"
        ? '<button class="btn small primary" data-act="wl-approve" data-email="' + esc(r.email) + '">通过</button> ' +
          '<button class="btn small danger" data-act="wl-reject" data-email="' + esc(r.email) + '">拒绝</button>'
        : "-";
      return "<tr><td>" + check + "</td><td>" + esc(r.email) + "</td><td>" + esc(r.note || "-") + "</td><td>" +
        wlStatusChip(r) + "</td><td>" + fmtTime(r.requestedAt) + "</td><td>" + ops + "</td></tr>";
    }).join("");
    html += '<table><tr><th style="width:30px"></th><th>邮箱</th><th>备注</th><th>状态</th><th>申请时间</th><th>操作</th></tr>' + qrows + "</table>";
  }
  html += "</div>";
  body.innerHTML = html;
  $("wlAddBtn").addEventListener("click", addWhitelist);
  $("wlEmail").addEventListener("keydown", function (ev) { if (ev.key === "Enter") addWhitelist(); });
}

function loadWhitelist() {
  clearErr();
  var body = $("wlBody");
  Promise.all([
    api("/api/admin/beta-whitelist").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); }),
    api("/api/admin/beta-waitlist").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
  ]).then(function (res) {
    for (var i = 0; i < res.length; i++) {
      if (res[i].code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res[i].j.ok !== true) throw new Error(res[i].j.message || "加载失败");
    }
    wlEmails = res[0].j.emails || [];
    wlEnabled = !!res[0].j.enabled;
    wlCorrupt = !!res[0].j.corrupt;
    wlUpdatedAt = res[0].j.updatedAt;
    wlRequests = res[1].j.requests || [];
    renderBeta();
    refreshPendingBadge();
  })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

// 候补队列自动刷新：60s 拉一次，有变化才重绘（保住正在输入的白名单邮箱）
function wlPollTick() {
  if (currentTab !== "whitelist" || !authed || document.hidden) return;
  api("/api/admin/beta-waitlist").then(function (r) { return r.json(); }).then(function (j) {
    if (!j || j.ok !== true) return;
    var reqs = j.requests || [];
    var pendingOf = function (list) {
      var n = 0;
      for (var i = 0; i < list.length; i++) if (list[i].status === "pending") n++;
      return n;
    };
    if (reqs.length === wlRequests.length && pendingOf(reqs) === pendingOf(wlRequests)) return;
    wlRequests = reqs;
    var emailVal = $("wlEmail") ? $("wlEmail").value : "";
    renderBeta();
    if (emailVal && $("wlEmail")) $("wlEmail").value = emailVal;
    refreshPendingBadge();
  }).catch(function () {});
}
setInterval(wlPollTick, 60000);

function addWhitelist() {
  var input = $("wlEmail");
  var email = (input ? input.value : "").trim();
  if (!email) return;
  var first = wlEmails.length === 0;
  if (!confirm((first ? "名单当前为空：添加后注册闸立即生效，名单外邮箱将无法注册。" : "") +
    "添加 " + email + " 到内测白名单？")) return;
  api("/api/admin/beta-whitelist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.j.ok !== true) throw new Error(res.j.message || "添加失败");
      loadWhitelist();
    })
    .catch(function (e) { showErr("白名单添加失败：" + e.message); });
}

function removeWhitelist(email) {
  if (!confirm("移除 " + email + "？移除后该邮箱无法再新注册；已注册账号不受影响，需要踢出请到「用户」页禁用。")) return;
  api("/api/admin/beta-whitelist/" + encodeURIComponent(email), { method: "DELETE" })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.j.ok !== true) throw new Error(res.j.message || "移除失败");
      loadWhitelist();
    })
    .catch(function (e) { showErr("白名单移除失败：" + e.message); });
}

function checkedApplyEmails() {
  var boxes = document.querySelectorAll(".wl-apply-check:checked");
  var emails = [];
  for (var i = 0; i < boxes.length; i++) emails.push(boxes[i].getAttribute("data-email"));
  return emails;
}

function approveWaitlist(emails) {
  if (!emails.length) { showErr("先勾选要通过的申请"); return; }
  if (!confirm("通过 " + emails.length + " 个申请？通过后邮箱加入白名单，并自动向对方邮箱发送通过通知（需已配置 SMTP）。")) return;
  api("/api/admin/beta-waitlist/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emails: emails })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.j.ok !== true) throw new Error(res.j.message || "操作失败");
      loadWhitelist();
    })
    .catch(function (e) { showErr("候补通过失败：" + e.message); });
}

function rejectWaitlist(emails) {
  if (!emails.length) { showErr("先勾选要拒绝的申请"); return; }
  if (!confirm("拒绝 " + emails.length + " 个申请？拒绝后对方可重新申请。")) return;
  api("/api/admin/beta-waitlist/reject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emails: emails })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.j.ok !== true) throw new Error(res.j.message || "操作失败");
      loadWhitelist();
    })
    .catch(function (e) { showErr("候补拒绝失败：" + e.message); });
}

// ---------- 消息发送（站内信群发） ----------
var composeUsers = [];
var composeGroups = [];
var bcTarget = "all";
var bcSelected = {};
var bcSending = false;
var sentEntries = [];
var BC_GROUP_LABELS = { active: "正常用户", disabled: "已禁用用户", new7d: "近 7 日注册" };

function loadCompose() {
  clearErr();
  var body = $("composeBody");
  Promise.all([
    api("/api/admin/inbox/recipients").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); }),
    api("/api/admin/inbox/sent?limit=100").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
  ]).then(function (results) {
    var rec = results[0], sent = results[1];
    if (rec.code === 401) throw new Error("管理员会话已失效，请重新登录");
    if (rec.j.ok !== true) throw new Error("收件人接口异常");
    composeUsers = rec.j.users || [];
    composeGroups = rec.j.groups || [];
    bcSelected = {}; // 每次进入标签重置选择，避免跨刷新误发
    body.innerHTML =
      '<div class="card"><div class="card-title">新建站内信</div>' +
      '<div class="form-row">' +
      '<div class="field" style="flex:1;min-width:260px"><span>标题</span><input id="bcTitle" type="text" maxlength="120" placeholder="如：系统升级公告"></div>' +
      "</div>" +
      '<details class="diag" style="margin:0 0 10px"><summary>更多设置（类型 / 重要度，默认：产品公告 · 普通）</summary>' +
      '<div class="form-row" style="margin-top:8px">' +
      '<div class="field"><span>类型</span><select id="bcKind"><option value="announcement">产品公告</option><option value="system">系统通知</option></select></div>' +
      '<div class="field"><span>重要度</span><select id="bcImportance"><option value="normal">普通</option><option value="high">重要</option><option value="critical">紧急</option><option value="low">低</option></select></div>' +
      "</div></details>" +
      '<div class="field"><span>正文</span><textarea id="bcBody" rows="5" maxlength="4000" placeholder="发送后写入每位接收人的站内信收件箱，在线设备会立即收到提醒。"></textarea></div>' +
      '<div style="margin:4px 0 8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">接收人：' +
      '<span class="seg" id="bcTargetSeg">' +
      '<button data-v="all"' + (bcTarget === "all" ? ' class="on"' : "") + ">全体用户</button>" +
      '<button data-v="users"' + (bcTarget === "users" ? ' class="on"' : "") + ">指定用户</button>" +
      '<button data-v="group"' + (bcTarget === "group" ? ' class="on"' : "") + ">分组</button>" +
      '</span> <span class="meta" id="bcTargetHint" style="margin:0"></span></div>' +
      '<div id="bcTargetPane"></div>' +
      '<div class="actions" style="border-top:1px dashed var(--line);padding-top:12px"><button class="btn primary" id="bcSendBtn">发送</button>' +
      '<span class="meta" id="bcHint" style="margin:0"></span></div></div>' +
      '<div class="card"><div class="head"><div class="card-title">发送记录</div>' +
      '<button class="btn small" data-act="bc-reload">刷新</button></div>' +
      '<div id="bcSentWrap"><div class="meta">加载中…</div></div>' +
      '<div id="bcSentDetail"></div></div>';
  renderBcTargetPane();
  renderSentTable(sent.j.entries || []);
  // 用户页「收件箱」跳转：等发送区/记录区渲染完再展开目标用户收件箱
  if (pendingUserInbox) {
    var inboxTarget = pendingUserInbox;
    pendingUserInbox = null;
    showUserInbox(inboxTarget);
  }
}).catch(function (e) {
    body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    showErr(e.message);
  });
}

function bcTargetCount() {
  if (bcTarget === "all") return composeUsers.length;
  if (bcTarget === "users") return Object.keys(bcSelected).length;
  var sel = document.getElementById("bcGroup");
  var g = sel ? sel.value : "";
  var def = null;
  for (var i = 0; i < composeGroups.length; i++) if (composeGroups[i].key === g) def = composeGroups[i];
  return def ? def.count : 0;
}

function updateBcHint() {
  var hint = $("bcTargetHint");
  if (hint) hint.textContent = "本次将发送给 " + bcTargetCount() + " 位用户";
}

function renderBcTargetPane() {
  var pane = $("bcTargetPane");
  if (!pane) return;
  if (bcTarget === "all") {
    pane.innerHTML = "";
  } else if (bcTarget === "group") {
    var opts = composeGroups.filter(function (g) { return g.key !== "all"; });
    pane.innerHTML = '<label>分组 <select id="bcGroup">' +
      opts.map(function (g) {
        return '<option value="' + esc(g.key) + '">' + esc(g.label) + "（" + g.count + " 人）</option>";
      }).join("") + "</select></label>";
  } else {
    pane.innerHTML =
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' +
      '<input type="search" id="bcUserKw" placeholder="搜索显示名 / 身份 ID / 邮箱" style="flex:1;min-width:180px">' +
      '<button class="btn small" data-act="bc-clear-sel">清空选择</button>' +
      '<span class="meta" id="bcSelCount"></span></div>' +
      '<div id="bcUserList" style="max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:4px 10px"></div>';
    renderBcUserList();
  }
  updateBcHint();
}

function filteredBcUsers() {
  var kwEl = document.getElementById("bcUserKw");
  var kw = (kwEl ? kwEl.value.trim() : "").toLowerCase();
  if (!kw) return composeUsers;
  return composeUsers.filter(function (u) {
    var hay = ((u.displayName || "") + " " + u.userId + " " + (u.email || "")).toLowerCase();
    return hay.indexOf(kw) >= 0;
  });
}

function renderBcUserList() {
  var wrap = document.getElementById("bcUserList");
  if (!wrap) return;
  var users = filteredBcUsers();
  if (!users.length) {
    wrap.innerHTML = '<div class="meta" style="padding:8px 0">没有匹配的用户</div>';
    return;
  }
  wrap.innerHTML = users.map(function (u) {
    var checked = bcSelected[u.userId] ? " checked" : "";
    return '<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">' +
      '<input type="checkbox" data-act="bc-user" data-user="' + esc(u.userId) + '"' + checked + ">" +
      "<span>" + esc(u.displayName || "-") + "</span>" +
      '<span class="meta">' + esc(u.userId) + (u.email ? " · " + esc(u.email) : "") +
      " · 注册 " + esc(String(u.createdAt || "").slice(0, 10)) + "</span>" +
      (u.disabled ? chip("bad", "已禁用") : "") +
      "</label>";
  }).join("");
  updateBcSelCount();
}

function updateBcSelCount() {
  var el = document.getElementById("bcSelCount");
  if (el) el.textContent = "已选 " + Object.keys(bcSelected).length + " 人";
}

function bcToggleUser(userId, checked) {
  if (checked) bcSelected[userId] = true;
  else delete bcSelected[userId];
  updateBcSelCount();
  updateBcHint();
}

function bcTargetLabel(entry) {
  if (entry.targetType === "all") return "全体用户";
  if (entry.targetType === "group") return "分组 · " + (BC_GROUP_LABELS[entry.group] || entry.group || "-");
  return "指定用户";
}

function renderSentTable(entries) {
  sentEntries = entries || [];
  var wrap = $("bcSentWrap");
  if (!wrap) return;
  if (!sentEntries.length) {
    wrap.innerHTML = '<div class="meta" style="padding:10px 0">还没有发送记录</div>';
    return;
  }
  var rows = sentEntries.map(function (e2) {
    var preview = e2.body && e2.body.length > 50 ? e2.body.slice(0, 50) + "…" : (e2.body || "");
    return "<tr>" +
      "<td>" + fmtTime(e2.time) + "</td>" +
      '<td class="wrap">' + esc(e2.title) + "</td>" +
      '<td class="wrap">' + esc(preview) + "</td>" +
      "<td>" + esc(bcTargetLabel(e2)) + " · " + e2.recipients + " 人</td>" +
      "<td>共 " + e2.recipients + " 条 · 实时送达 " + e2.deliveredLive + "</td>" +
      '<td><button class="btn small" data-act="bc-detail" data-batch="' + esc(e2.batchId || "") + '">详情</button></td>' +
      "</tr>";
  }).join("");
  wrap.innerHTML = '<table style="margin-top:6px"><tr>' +
    "<th>时间</th><th>标题</th><th>内容</th><th>接收对象</th><th>送达</th><th>操作</th>" +
    "</tr>" + rows + "</table>";
}

// —— 逐人送达/阅读明细 + 单用户收件箱查看 ——
var bcLastBatch = "";

function showSentDetail(batchId) {
  var wrap = $("bcSentDetail");
  if (!wrap || !batchId) return;
  bcLastBatch = batchId;
  wrap.innerHTML = '<div class="meta" style="padding:8px 0">加载送达明细…</div>';
  api("/api/admin/inbox/sent/" + encodeURIComponent(batchId))
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || "详情加载失败");
      var rows = res.j.rows || [];
      var html = '<div class="head" style="margin:14px 0 4px;border-top:1px dashed var(--line);padding-top:12px">' +
        '<div class="card-title">送达明细（已读 ' + res.j.readCount + " / " + res.j.total + "）</div>" +
        '<button class="btn small" data-act="bc-detail-close">收起</button></div>';
      if (!rows.length) {
        html += '<div class="meta">没有收件人明细</div>';
      } else {
        html += '<table><tr><th>用户</th><th>昵称</th><th>送达方式</th><th>阅读状态</th><th>操作</th></tr>' +
          rows.map(function (r2) {
            var status = r2.found
              ? (r2.read ? chip("ok", "已读") : chip("open", "未读")) + (r2.readAt ? ' <span class="meta">' + fmtTime(r2.readAt) + "</span>" : "")
              : chip("offline", "无记录");
            return "<tr>" +
              '<td class="wrap">' + esc(r2.userId) + (r2.accountGone ? " " + chip("warn", "账号已注销") : "") + "</td>" +
              "<td>" + esc(r2.displayName || "-") + "</td>" +
              "<td>" + (r2.deliveredLive ? "实时推送" : "离线落盘") + "</td>" +
              "<td>" + status + "</td>" +
              '<td><button class="btn small" data-act="bc-inbox" data-user="' + esc(r2.userId) + '">收件箱</button></td>' +
              "</tr>";
          }).join("") + "</table>";
      }
      wrap.innerHTML = html;
    })
    .catch(function (e) {
      wrap.innerHTML = "";
      showErr("送达明细加载失败：" + e.message);
    });
}

function showUserInbox(userId) {
  var wrap = $("bcSentDetail");
  if (!wrap || !userId) return;
  wrap.innerHTML = '<div class="meta" style="padding:8px 0">加载收件箱…</div>';
  api("/api/admin/inbox/user/" + encodeURIComponent(userId))
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || "加载失败");
      var msgs = res.j.messages || [];
      var html = '<div class="head" style="margin:14px 0 4px;border-top:1px dashed var(--line);padding-top:12px">' +
        '<div class="card-title">收件箱 · ' + esc(userId) + "（未读 " + res.j.unreadCount + " 条）</div>" +
        '<button class="btn small" data-act="bc-inbox-close">返回明细</button></div>';
      if (!msgs.length) {
        html += '<div class="meta">该用户还没有收到过站内信</div>';
      } else {
        html += '<table><tr><th>时间</th><th>标题</th><th>内容</th><th>状态</th></tr>' +
          msgs.map(function (m) {
            var preview = m.body && m.body.length > 60 ? m.body.slice(0, 60) + "…" : m.body;
            return "<tr>" +
              "<td>" + fmtTime(m.createdAt) + "</td>" +
              '<td class="wrap">' + esc(m.title) + "</td>" +
              '<td class="wrap">' + esc(preview) + "</td>" +
              "<td>" + (m.readAt ? chip("ok", "已读") : chip("open", "未读")) + "</td>" +
              "</tr>";
          }).join("") + "</table>";
      }
      wrap.innerHTML = html;
    })
    .catch(function (e) {
      wrap.innerHTML = "";
      showErr("收件箱加载失败：" + e.message);
    });
}

function sendBroadcast() {
  if (bcSending) return;
  var titleEl = document.getElementById("bcTitle");
  var bodyEl = document.getElementById("bcBody");
  var kindEl = document.getElementById("bcKind");
  var impEl = document.getElementById("bcImportance");
  var hint = $("bcHint");
  var title = titleEl ? titleEl.value.trim() : "";
  var body = bodyEl ? bodyEl.value.trim() : "";
  if (!title) { hint.textContent = "请填写标题"; return; }
  if (!body) { hint.textContent = "请填写正文"; return; }
  var count = bcTargetCount();
  if (count <= 0) { hint.textContent = "没有可发送的收件人"; return; }
  var payload = {
    title: title, body: body,
    kind: kindEl ? kindEl.value : "announcement",
    importance: impEl ? impEl.value : "normal",
    targetType: bcTarget
  };
  if (bcTarget === "users") payload.userIds = Object.keys(bcSelected);
  if (bcTarget === "group") payload.group = ($("bcGroup") ? $("bcGroup").value : "");
  var targetDesc = bcTarget === "all" ? "全体用户"
    : bcTarget === "group" ? (BC_GROUP_LABELS[payload.group] || payload.group) + "分组"
    : "指定的 " + count + " 位用户";
  if (!confirm("确认向" + targetDesc + "（" + count + " 人）发送站内信「" + title + "」吗？发送后不可撤回。")) return;
  bcSending = true;
  hint.textContent = "正在发送…";
  api("/api/admin/inbox/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      bcSending = false;
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || "发送失败");
      hint.textContent = "已发送 " + res.j.sent + " 条，在线设备实时送达 " + res.j.deliveredLive + " 条 ✓";
      if (bodyEl) bodyEl.value = "";
      var dw = $("bcSentDetail");
      if (dw) dw.innerHTML = "";
      api("/api/admin/inbox/sent?limit=100").then(function (r2) { return r2.json(); }).then(function (j2) {
        renderSentTable((j2 && j2.entries) || []);
      });
    })
    .catch(function (e) {
      bcSending = false;
      hint.textContent = "";
      showErr("发送失败：" + e.message);
    });
}

// ---------- 支付（只记真实订单：台账不含模拟数据） ----------
var payOrders = [];

function orderStatusChip(st) {
  if (st === "paid") return chip("ok", "已支付");
  if (st === "pending") return chip("open", "待支付");
  if (st === "closed") return chip("offline", "已关闭");
  if (st === "refunded") return chip("info", "已退款");
  return chip("offline", st || "-");
}

function orderStatusLabel(st) {
  if (st === "paid") return "已支付";
  if (st === "pending") return "待支付";
  if (st === "closed") return "已关闭";
  if (st === "refunded") return "已退款";
  return st || "-";
}

function filteredPayOrders() {
  var v = $("payRange") ? $("payRange").value : "0";
  if (v === "0") return payOrders;
  var from;
  if (v === "1") {
    from = new Date();
    from.setHours(0, 0, 0, 0);
  } else {
    from = Date.now() - Number(v) * 86400000;
  }
  return payOrders.filter(function (o) { return Date.parse(o.createdAt) >= from; });
}

function renderPaymentsTable() {
  var wrap = $("payTableWrap");
  if (!wrap) return;
  var orders = filteredPayOrders();
  var hint = $("payRangeHint");
  if (hint) {
    var paidSum = 0;
    orders.forEach(function (o) { if (o.status === "paid") paidSum += Number(o.amount) || 0; });
    hint.textContent = "筛选出 " + orders.length + " / " + payOrders.length + " 笔 · 其中已付 ¥" + paidSum;
  }
  if (!payOrders.length) {
    wrap.innerHTML = '<div class="card"><div class="empty">还没有真实支付订单。</div>' +
      '<div class="meta" style="text-align:center;padding:0 0 18px">真实通道需在服务端配置微信/支付宝商户凭证（live 模式）；模拟测试订单不再展示、不再落库。</div></div>';
    return;
  }
  var rows = orders.map(function (o) {
    return "<tr>" +
      '<td class="wrap">' + esc(o.outTradeNo) + "</td>" +
      "<td>" + esc(o.provider) + " / " + esc(o.method) + "</td>" +
      "<td>¥" + o.amount + "</td>" +
      '<td class="wrap">' + esc(o.description || "-") + "</td>" +
      "<td>" + orderStatusChip(o.status) + "</td>" +
      "<td>" + fmtTime(o.createdAt) + "</td>" +
      "<td>" + fmtTime(o.paidAt) + "</td>" +
      "</tr>";
  }).join("");
  wrap.innerHTML = orders.length
    ? '<div class="card"><table><tr>' +
      "<th>商户单号</th><th>渠道 / 方式</th><th>金额</th><th>描述</th><th>状态</th><th>创建时间</th><th>支付时间</th>" +
      "</tr>" + rows + "</table></div>"
    : '<div class="card"><div class="empty">该时间范围内没有订单</div></div>';
}

function csvCell(v) {
  v = String(v == null ? "" : v);
  // 注意：本页脚本是外层 TS 模板串，正则里的反斜杠必须双写才不会被模板层吃掉一层
  return /[",\\r\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function exportPaymentsCsv() {
  var orders = filteredPayOrders();
  if (!orders.length) { showErr("当前筛选范围内没有可导出的订单"); return; }
  var lines = [["商户单号", "渠道", "方式", "金额", "描述", "状态", "创建时间", "支付时间"].join(",")].concat(
    orders.map(function (o) {
      return [o.outTradeNo, o.provider, o.method, o.amount, o.description || "", orderStatusLabel(o.status),
        fmtTime(o.createdAt), fmtTime(o.paidAt)].map(csvCell).join(",");
    })
  );
  // BOM：让 Excel 正确识别 UTF-8 中文
  var blob = new Blob(["\\uFEFF" + lines.join("\\r\\n")], { type: "text/csv;charset=utf-8" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "orders-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
}

function loadPayments() {
  clearErr();
  var body = $("paymentsBody");
  api("/api/admin/orders").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.j.enabled !== true) {
        body.innerHTML = '<div class="card"><div class="empty">支付服务未启用</div></div>';
        return;
      }
      var s = res.j.stats || {};
      var html = '<div class="stats">' +
        statCard(s.total, "真实订单") +
        statCard(s.paid, "已支付") +
        statCard("¥" + s.paidAmount, "收入") +
        "</div>";
      if (s.pending || s.refunded) {
        html += '<div class="stats">' +
          statCard(s.pending || 0, "待支付") +
          (s.refunded ? statCard(s.refunded, "已退款") : "") +
          "</div>";
      }
      payOrders = res.j.orders || [];
      html += '<div id="payTableWrap"></div>';
      body.innerHTML = html;
      var toolbar = $("payToolbar");
      if (toolbar) toolbar.style.display = "flex";
      renderPaymentsTable();
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

// ---------- 站内信 ----------
function loadMessages() {
  clearErr();
  var body = $("messagesBody");
  api("/api/admin/messages").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      if (res.j.enabled !== true) {
        body.innerHTML = '<div class="card"><div class="empty">消息聚合中心未启用</div></div>';
        return;
      }
      var s = res.j.stats;
      // 外部消息聚合（微信/QQ/邮件等平台消息）与上面的站内信发送是两套系统，
      // 统计默认折叠，供排查平台消息链路时展开看。
      var html = '<details class="diag" style="margin-top:2px"><summary>外部消息聚合统计（微信 / QQ / 邮件等平台消息，非站内信发送记录）</summary>';
      if (s) {
        html += '<div class="stats">' +
          statCard(s.messages, "消息总量") +
          statCard(s.today, "今日消息") +
          statCard(s.outbound, "发出") +
          statCard(s.inbound, "收到") +
          "</div>";
        html += '<div class="card" style="margin-bottom:12px"><div class="card-title">消息趋势（近 14 天）</div>' +
          barChart(s.series || [], "#16a34a") + "</div>";
      }
      var platforms = res.j.byPlatform || [];
      html += '<div class="card" style="margin-bottom:12px"><div class="card-title">平台分布</div>';
      html += platforms.length
        ? "<table><tr><th>平台</th><th>会话数</th><th>消息数</th></tr>" + platforms.map(function (p) {
            return "<tr><td>" + esc(p.platform) + "</td><td>" + p.conversations + "</td><td>" + p.messages + "</td></tr>";
          }).join("") + "</table>"
        : '<div class="meta">暂无会话数据</div>';
      html += "</div>";
      var recent = res.j.recent || [];
      html += '<div class="card"><div class="card-title">最近消息</div>';
      html += recent.length
        ? '<table style="margin-top:6px"><tr><th>时间</th><th>平台</th><th>方向</th><th>身份</th><th>内容</th></tr>' +
          recent.map(function (m) {
            var preview = m.text.length > 40 ? m.text.slice(0, 40) + "…" : m.text;
            return "<tr>" +
              "<td>" + fmtTime(m.createdAt) + "</td>" +
              "<td>" + esc(m.platform) + "</td>" +
              "<td>" + (m.direction === "outbound" ? "发出" : "收到") + "</td>" +
              "<td>" + esc(m.actorId) + "</td>" +
              '<td class="wrap">' + esc(preview) + "</td>" +
              "</tr>";
          }).join("") + "</table>"
        : '<div class="empty">暂无消息</div>';
      html += "</div>";
      html += "</details>";
      body.innerHTML = html;
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

// ---------- 下载分发 ----------
function loadManifest() {
  api("/api/admin/client-manifest").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error("需要管理员 Token");
      var m = res.j.manifest || {};
      $("mfLatest").value = m.latest || "";
      $("mfUrl").value = m.url || "";
      $("mfMeta").textContent = "当前：minVersion=" + (m.minVersion || "(默认)") +
        " · channel=" + (m.channel || "byok") +
        " · notes=" + (m.notes || "（空）") +
        " · 改 latest+url 即完成一次发版，用户客户端下次启动收到更新";
    })
    .catch(function (e) {
      $("mfMeta").textContent = "清单读取失败：" + e.message;
    });
  // 发版变更历史（来自管理操作审计，只读展示最近 4 条）
  api("/api/admin/audit?limit=200").then(function (r) { return r.json(); }).then(function (j) {
    var box = $("mfHistory");
    if (!box || !j || j.ok !== true) return;
    var updates = (j.entries || []).filter(function (e2) { return e2.action === "client_manifest.update"; }).slice(0, 4);
    if (!updates.length) {
      box.textContent = "发版变更记录：暂无（保存清单后会在这里留痕）";
      return;
    }
    box.innerHTML = "发版变更记录（最近 " + updates.length + " 次）：<br>" +
      updates.map(function (e2) {
        var d = e2.detail || {};
        var file = (d.url || "").split("/").pop() || "-";
        return esc(fmtTime(e2.time)) + " · latest <b>" + esc(d.latest || "-") + "</b> · " + esc(file);
      }).join("<br>");
  }).catch(function () {});
}

function saveManifest() {
  var hint = $("mfHint");
  api("/api/admin/client-manifest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ latest: $("mfLatest").value, url: $("mfUrl").value })
  })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || "保存失败");
      hint.textContent = "已保存，对全体客户端即时生效 ✓";
      loadManifest();
    })
    .catch(function (e) {
      hint.textContent = "";
      showErr("保存失败：" + e.message);
    });
}

function loadDownloads() {
  clearErr();
  var body = $("dlList");
  api("/api/admin/downloads/list").then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code === 401) throw new Error("管理员会话已失效，请重新登录");
      allDownloads = Array.isArray(res.j) ? res.j : [];
      renderDownloadTable();
    })
    .catch(function (e) {
      body.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    });
}

function renderDownloadTable() {
  var body = $("dlList");
  if (!allDownloads.length) {
    body.innerHTML = '<div class="card"><div class="empty">还没有安装包。点击上方「上传安装包」发布新版本。</div></div>';
    return;
  }
  var rows = allDownloads.map(function (f) {
    return "<tr>" +
      '<td class="wrap">' + esc(f.name) + "</td>" +
      "<td>" + fmtBytes(f.size) + "</td>" +
      "<td>" + esc(f.modified || "-") + "</td>" +
      '<td><a href="/downloads/' + encodeURIComponent(f.name) + '" target="_blank">下载链接</a></td>' +
      '<td><button class="btn small danger" data-act="dl-delete" data-file="' + esc(f.name) + '">删除</button></td>' +
      "</tr>";
  }).join("");
  body.innerHTML = '<div class="card"><table><tr>' +
    "<th>文件名</th><th>大小</th><th>修改日期</th><th>链接</th><th>操作</th>" +
    "</tr>" + rows + "</table></div>";
}

function uploadDownload(file) {
  var hint = $("dlUploadHint");
  var fd = new FormData();
  fd.append("file", file, file.name);
  hint.textContent = "正在上传 " + file.name + "（" + fmtBytes(file.size) + "）…";
  api("/api/admin/downloads/upload", { method: "POST", body: fd })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error(res.j.message || res.j.error || "上传失败");
      hint.textContent = "已发布：" + res.j.file;
      loadDownloads();
    })
    .catch(function (e) {
      hint.textContent = "支持 .exe .zip .dmg .msi .apk .tar.gz .deb .rpm，同名覆盖";
      showErr("上传失败：" + e.message);
    });
}

function deleteDownload(name) {
  if (!confirm("确定要下架并删除 " + name + " 吗？客户端将无法再下载该文件。")) return;
  api("/api/admin/downloads/" + encodeURIComponent(name), { method: "DELETE" })
    .then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      if (res.code !== 200 || res.j.ok !== true) throw new Error("删除失败");
      loadDownloads();
    })
    .catch(function (e) { showErr("删除失败：" + e.message); });
}

// ---------- 事件委托与初始化 ----------
document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-act]") : null;
  if (!el) return;
  var act = el.getAttribute("data-act");
  var id = el.getAttribute("data-id") || "";
  if (act === "fb-status") updateFeedbackStatus(id, el.getAttribute("data-status"));
  else if (act === "fb-save") saveFeedbackReply(id);
  else if (act === "fb-copyid") {
    var cu = el.getAttribute("data-user") || "";
    if (cu && navigator.clipboard) {
      navigator.clipboard.writeText(cu).then(function () {
        el.textContent = "已复制";
        setTimeout(function () { el.textContent = "复制 ID"; }, 1200);
      });
    }
  }
  else if (act === "fb-togglehis") {
    var ub = el.closest(".fb-userbox");
    if (ub) ub.classList.toggle("exp");
  }
  else if (act === "user-toggle") toggleUser(el.getAttribute("data-user"), el.getAttribute("data-disabled") === "1");
  else if (act === "fb-goto-user") gotoUserPage(el.getAttribute("data-user") || "");
  else if (act === "user-goto-feedback") gotoFeedbackSearch(el.getAttribute("data-user") || "");
  else if (act === "user-goto-inbox") gotoUserInbox(el.getAttribute("data-user") || "");
  else if (act === "dl-delete") deleteDownload(el.getAttribute("data-file"));
  else if (act === "bc-user") bcToggleUser(el.getAttribute("data-user"), el.checked);
  else if (act === "bc-clear-sel") { bcSelected = {}; renderBcUserList(); updateBcHint(); }
  else if (act === "bc-reload") loadCompose();
  else if (act === "bc-detail") showSentDetail(el.getAttribute("data-batch"));
  else if (act === "bc-detail-close") { var dw = $("bcSentDetail"); if (dw) dw.innerHTML = ""; }
  else if (act === "bc-inbox") showUserInbox(el.getAttribute("data-user"));
  else if (act === "bc-inbox-close") { if (bcLastBatch) showSentDetail(bcLastBatch); else { var iw = $("bcSentDetail"); if (iw) iw.innerHTML = ""; } }
});

// 消息发送：动态渲染的控件用文档级委托（表单每次进入标签都会重建）
document.addEventListener("click", function (ev) {
  var segBtn = ev.target.closest ? ev.target.closest("#bcTargetSeg button") : null;
  if (segBtn) {
    bcTarget = segBtn.getAttribute("data-v") || "all";
    var all = document.querySelectorAll("#bcTargetSeg button");
    for (var i = 0; i < all.length; i++) all[i].classList.toggle("on", all[i] === segBtn);
    renderBcTargetPane();
    return;
  }
  if (ev.target.closest && ev.target.closest("#bcSendBtn")) sendBroadcast();
});
document.addEventListener("input", function (ev) {
  if (ev.target && ev.target.id === "bcUserKw") renderBcUserList();
});
document.addEventListener("change", function (ev) {
  if (ev.target && ev.target.id === "bcGroup") updateBcHint();
});

$("nav").addEventListener("click", function (ev) {
  var a = ev.target.closest ? ev.target.closest("a[data-tab]") : null;
  if (!a) return;
  ev.preventDefault();
  var tab = a.getAttribute("data-tab");
  if (location.hash !== "#" + tab) location.hash = "#" + tab;
  else showTab(tab);
});

// —— 账号密码会话（HttpOnly Cookie）——
// 浏览器不再保存任何主凭证；登录态由服务端会话决定，401 即亮出登录门。
var authed = false;

function showAuthGate(needsSetup) {
  authed = false;
  $("accountBox").style.display = "none";
  $("authGate").style.display = "flex";
  $("authTitle").textContent = needsSetup ? "初始化管理员账号" : "管理员登录";
  $("authSub").textContent = needsSetup
    ? "首次使用：设置管理员账号与密码"
    : "输入管理员账号密码";
  $("authPass2").style.display = needsSetup ? "block" : "none";
  $("authSubmit").textContent = needsSetup ? "创建并登录" : "登录";
  $("authErr").textContent = "";
  $("authUser").value = "";
  $("authPass").value = "";
  $("authPass2").value = "";
  setTimeout(function () { try { $("authUser").focus(); } catch (e) {} }, 30);
}

function hideAuthGate(username) {
  authed = true;
  $("authGate").style.display = "none";
  $("accountBox").style.display = "block";
  $("accountName").textContent = username || "admin";
  refreshPendingBadge();
  showTab(hashTab());
}

function submitAuth() {
  var username = $("authUser").value.trim();
  var password = $("authPass").value;
  var isSetup = $("authPass2").style.display !== "none";
  if (!username || !password) {
    $("authErr").textContent = "请输入账号和密码";
    return;
  }
  if (isSetup && password !== $("authPass2").value) {
    $("authErr").textContent = "两次输入的密码不一致";
    return;
  }
  $("authSubmit").disabled = true;
  $("authErr").textContent = "";
  fetch("/api/admin/auth/" + (isSetup ? "setup" : "login"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "admin-console" },
    body: JSON.stringify({ username: username, password: password })
  }).then(function (r) { return r.json().then(function (j) { return { code: r.status, j: j }; }); })
    .then(function (res) {
      $("authSubmit").disabled = false;
      if (res.code === 200 && res.j && res.j.ok) {
        hideAuthGate(res.j.username);
        return;
      }
      $("authErr").textContent = (res.j && res.j.message) || "操作失败";
    })
    .catch(function () {
      $("authSubmit").disabled = false;
      $("authErr").textContent = "网络错误，请重试";
    });
}

$("authSubmit").addEventListener("click", submitAuth);
$("authGate").addEventListener("keydown", function (ev) {
  if (ev.key === "Enter") submitAuth();
});

$("logoutBtn").addEventListener("click", function () {
  fetch("/api/admin/auth/logout", {
    method: "POST",
    headers: { "X-Requested-With": "admin-console" }
  }).then(function () { showAuthGate(false); }).catch(function () { showAuthGate(false); });
});

$("fbStatusSeg").addEventListener("click", function (ev) {
  var btn = ev.target.closest ? ev.target.closest("button") : null;
  if (!btn) return;
  fbStatusFilter = btn.getAttribute("data-v");
  renderFbSeg();
  renderFbList();
});
$("fbTypeSel").addEventListener("change", function () {
  if (fbSelId && !filteredFeedback().some(function (r) { return r.id === fbSelId; })) fbSelId = null;
  renderFbList();
  renderFbDetail();
});
$("fbKw").addEventListener("input", function () {
  if (fbSelId && !filteredFeedback().some(function (r) { return r.id === fbSelId; })) fbSelId = null;
  renderFbList();
  renderFbDetail();
});
$("fbRefresh").addEventListener("click", loadFeedback);
// J/K 键盘切换条目（输入控件聚焦时忽略）
document.addEventListener("keydown", function (ev) {
  if (currentTab !== "feedback" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  var tag = ((ev.target && ev.target.tagName) || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (ev.key !== "j" && ev.key !== "k") return;
  var list = filteredFeedback();
  if (!list.length) return;
  var idx = -1;
  for (var i = 0; i < list.length; i++) if (list[i].id === fbSelId) idx = i;
  var next = ev.key === "j" ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
  if (next === idx) return;
  fbSelId = list[next].id;
  renderFbList();
  renderFbDetail();
  var selEl = document.querySelector(".fb-row.sel");
  if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
});

$("userKw").addEventListener("input", renderUserTable);
$("userStatusSel").addEventListener("change", renderUserTable);
$("userSortSel").addEventListener("change", renderUserTable);
$("userRefresh").addEventListener("click", loadUsers);
$("payRange").addEventListener("change", renderPaymentsTable);
$("payExportBtn").addEventListener("click", exportPaymentsCsv);
$("fbNewPill").addEventListener("click", loadFeedback);

// 内测管理各操作按钮走事件委托：三张表随增删整体重绘，逐行绑定会丢
$("wlBody").addEventListener("click", function (ev) {
  var el = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
  if (!el) return;
  var act = el.getAttribute("data-act");
  if (act === "wl-remove") removeWhitelist(el.getAttribute("data-email"));
  else if (act === "wl-approve") approveWaitlist([el.getAttribute("data-email")]);
  else if (act === "wl-reject") rejectWaitlist([el.getAttribute("data-email")]);
  else if (act === "wl-approve-checked") approveWaitlist(checkedApplyEmails());
  else if (act === "wl-reject-checked") rejectWaitlist(checkedApplyEmails());
  else if (act === "wl-refresh") loadWhitelist();
});

$("dlUploadBtn").addEventListener("click", function () { $("dlFile").click(); });
$("dlFile").addEventListener("change", function () {
  var f = this.files && this.files[0];
  if (f) uploadDownload(f);
  this.value = "";
});
$("dlRefresh").addEventListener("click", loadDownloads);
$("mfSaveBtn").addEventListener("click", saveManifest);

var segOpts = [
  { v: "", l: "全部" }, { v: "open", l: "待处理" },
  { v: "processing", l: "处理中" }, { v: "resolved", l: "已解决" }
];
renderFbSeg();

function hashTab() {
  var t = (location.hash || "#overview").slice(1);
  if (t === "compose") t = "messages"; // 旧「消息发送」链接兼容
  return t;
}

// 启动：先探测登录态再放行标签页；未认证盖登录门（未设凭证时为首次设置形态）
window.addEventListener("hashchange", function () {
  if (!authed) return;
  var tab = hashTab();
  if (document.getElementById("tab-" + tab) && tab !== currentTab) showTab(tab);
});
fetch("/api/admin/auth/status").then(function (r) { return r.json(); }).then(function (st) {
  if (st && st.ok && st.authenticated) hideAuthGate(st.username);
  else showAuthGate(!!(st && st.ok && st.needsSetup));
}).catch(function () {
  showAuthGate(false);
});
</script>
</body>
</html>`;
}
