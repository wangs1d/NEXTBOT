import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 网页端注册/登录页（桌面端「立即登录」跳转目标）+ 公开内测申请页。
 *
 * - GET /accounts/web?cb=<回连地址>&state=<随机串>   登录页（黑白极简，零外部资源）
 * - GET /beta                                       公开内测申请页（无需安装包，手机可开）
 *
 * 背景：服务端账号体系本就按邮箱幂等建档（无密码），「注册」「登录」在
 * /accounts/register 上是同一动作（重复注册返回「已存在」，客户端视为成功）。
 * 本页收集邮箱 → 调注册接口 → 302/跳转回桌面端的本机回环地址（cb），
 * 桌面端从回调 query 里取邮箱落盘会话，完成「网页登录 → 客户端进主界面」闭环。
 * cb 只允许本机回环地址，防止页面被当成任意跳板。
 *
 * /beta 面向还没装 App 的申请人：填邮箱排队 → 后台审批 → 回来查询进度，
 * 通过后本页直接亮出安装包下载地址（发版 manifest 现读）。
 */
export function registerAccountWebRoutes(
  app: FastifyInstance,
  opts: { otpEnabled?: boolean } = {},
): void {
  // 官网落地页（域名 DNS 指到本服务后即为主页）：热读 public/landing.html，
  // 改页 scp 即生效无需重启；文件缺失时回退 /beta 申请页，行为不断。
  app.get("/", async (_request, reply) => {
    try {
      const html = await readFile(join(process.cwd(), "public", "landing.html"), "utf8");
      reply.type("text/html; charset=utf-8").send(html);
    } catch {
      return reply.redirect("/beta");
    }
  });

  app.get("/accounts/web", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(renderAccountWebPage(Boolean(opts.otpEnabled)));
  });

  app.get("/beta", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(renderBetaApplyPage());
  });
}

function renderAccountWebPage(otpEnabled: boolean): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NEXTBOT — 登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Noto Sans SC", "Microsoft YaHei UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 24px;
  }
  .card {
    width: 400px;
    max-width: 100%;
    background: #141414;
    border: 1px solid #232323;
    border-radius: 24px;
    padding: 44px 44px 36px;
  }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: 3.2px; color: #F2F2F2; }
  h1 { margin-top: 26px; font-size: 28px; font-weight: 700; line-height: 1.3; color: #F2F2F2; }
  .sub { margin-top: 10px; font-size: 14px; line-height: 1.6; color: #9B9B9B; }
  label { display: block; margin-top: 32px; font-size: 13px; font-weight: 600; color: #F2F2F2; }
  input {
    margin-top: 8px; width: 100%; height: 48px;
    background: #101010; border: 1px solid #3D3D3D; border-radius: 10px;
    padding: 0 16px; font-size: 14px; color: #F2F2F2; outline: none;
    font-family: inherit;
  }
  input:focus { border-color: #E8E8E8; }
  input::placeholder { color: #6B6B6B; }
  button {
    margin-top: 28px; width: 100%; height: 48px;
    background: #FFFFFF; color: #0A0A0A; border: none; border-radius: 24px;
    font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  button:disabled { background: #2E2E2E; color: #9B9B9B; cursor: default; }
  button.secondary {
    background: transparent; color: #F2F2F2; border: 1px solid #3D3D3D;
    margin-top: 12px;
  }
  button.secondary:disabled { border-color: #2E2E2E; color: #6B6B6B; }
  #applyBox { margin-top: 18px; padding-top: 18px; border-top: 1px solid #232323; }
  #applyBox input {
    margin-top: 0;
  }
  #otpRow { display: flex; gap: 10px; margin-top: 8px; }
  #otpRow input { margin-top: 0; flex: 1; letter-spacing: 4px; }
  #sendBtn {
    margin-top: 0; width: 118px; height: 48px; flex-shrink: 0;
    background: transparent; color: #F2F2F2; border: 1px solid #3D3D3D;
    border-radius: 10px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit;
  }
  #sendBtn:disabled { border-color: #2E2E2E; color: #6B6B6B; cursor: default; }
  #msg { margin-top: 14px; font-size: 12px; line-height: 1.5; color: #9B9B9B; min-height: 18px; }
  #msg.err { color: #F2604E; }
  #msg.ok { color: #F2F2F2; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">NEXTBOT</div>
    <h1>登录 NEXTBOT 桌面端</h1>
    <p class="sub">${otpEnabled
      ? "输入邮箱获取验证码，验证通过后登录；新邮箱将自动创建账号。"
      : "输入邮箱继续，新邮箱将自动创建账号。"}</p>
    <form id="f" autocomplete="on">
      <label for="email">邮箱</label>
      <input id="email" name="email" type="email" placeholder="you@example.com" autofocus>
      <div id="otpBlock" class="${otpEnabled ? "" : "hidden"}">
        <label for="code" style="margin-top:20px">验证码</label>
        <div id="otpRow">
          <input id="code" name="code" type="text" inputmode="numeric" maxlength="6"
                 placeholder="6 位数字" autocomplete="one-time-code">
          <button id="sendBtn" type="button">发送验证码</button>
        </div>
      </div>
      <button id="btn" type="submit">注册 / 登录</button>
      <p id="msg"></p>
    </form>
    <div id="applyBox" class="hidden">
      <p class="sub" style="margin-top:0">没在名单？申请加入内测候补，管理员通过后用<b>同一邮箱</b>登录即可。</p>
      <input id="applyNote" type="text" maxlength="200" placeholder="备注：您是谁 / 从哪来的（选填）">
      <button id="applyBtn" class="secondary" type="button">申请加入候补</button>
    </div>
    <p id="notice" class="sub hidden">本页面需要从桌面应用的登录窗口发起，请回到应用点击「立即登录」。</p>
  </div>
  <script>
    var qs = new URLSearchParams(location.search);
    var cb = qs.get("cb") || "";
    var state = qs.get("state") || "";
    var msg = document.getElementById("msg");
    var form = document.getElementById("f");
    var btn = document.getElementById("btn");
    var emailInput = document.getElementById("email");

    // 只允许回连本机回环地址：页面不充当任意域的跳板
    function cbAllowed(u) {
      return u.indexOf("http://127.0.0.1:") === 0
        || u.indexOf("http://localhost:") === 0
        || u.indexOf("http://[::1]:") === 0;
    }

    if (!cb || !state || !cbAllowed(cb)) {
      form.classList.add("hidden");
      document.getElementById("notice").classList.remove("hidden");
    }

    function setMsg(text, kind) {
      msg.textContent = text;
      msg.className = kind || "";
    }

    // ── 邮箱所有权验证码（OTP）：服务端开启 SMTP 通道后渲染 ──
    var otpEnabled = ${otpEnabled ? "true" : "false"};
    var sendBtn = document.getElementById("sendBtn");
    var codeInput = document.getElementById("code");
    var countdown = 0;
    var countdownTimer = null;

    function startCountdown(seconds) {
      countdown = seconds;
      sendBtn.disabled = true;
      sendBtn.textContent = "重新发送(" + countdown + "s)";
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(function () {
        countdown -= 1;
        if (countdown <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          sendBtn.disabled = false;
          sendBtn.textContent = "发送验证码";
        } else {
          sendBtn.textContent = "重新发送(" + countdown + "s)";
        }
      }, 1000);
    }

    if (otpEnabled) {
      sendBtn.addEventListener("click", function () {
        var email = emailInput.value.trim().toLowerCase();
        if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
          setMsg("请先输入有效的邮箱地址", "err");
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = "发送中…";
        setMsg("", "");
        fetch("/accounts/email/otp/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email })
        }).then(function (res) {
          return res.json().then(function (data) {
            if (res.status === 200 && data && data.ok === true) {
              startCountdown(data.resendAfterSeconds || 60);
              codeInput.focus();
              setMsg("验证码已发送到 " + email + "，请查收（可能在垃圾箱）", "ok");
              return;
            }
            if (res.status === 429) {
              startCountdown((data && data.retryAfterSeconds) || 60);
              setMsg((data && data.message) || "发送过于频繁，请稍后再试", "err");
              return;
            }
            sendBtn.disabled = false;
            sendBtn.textContent = "发送验证码";
            setMsg((data && data.message) || "发送失败，请稍后重试", "err");
          });
        }).catch(function () {
          sendBtn.disabled = false;
          sendBtn.textContent = "发送验证码";
          setMsg("发送失败，请稍后重试", "err");
        });
      });
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      // 邮箱统一小写：邮箱就是账号主键，大小写不同写法不得裂成两个账号
      var email = emailInput.value.trim().toLowerCase();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        setMsg("请输入有效的邮箱地址", "err");
        return;
      }
      var code = otpEnabled ? codeInput.value.trim() : "";
      if (otpEnabled && !/^\\d{6}$/.test(code)) {
        setMsg("请先点「发送验证码」，再输入收到的 6 位验证码", "err");
        return;
      }
      btn.disabled = true;
      setMsg("提交中…", "");
      fetch("/accounts/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: email,
          displayName: email.split("@")[0],
          email: email,
          otpCode: code || undefined
        })
      }).then(function (res) {
        return res.json().then(function (data) {
          var ok = res.status === 200 && data && data.ok === true;
          // 幂等：已存在账号视为登录成功
          var dup = data && typeof data.message === "string" && data.message.indexOf("已存在") >= 0;
          if (!ok && !dup) {
            var err = new Error((data && data.message) || "登录失败，请稍后重试");
            err.statusCode = res.status;
            throw err;
          }
          // ok=true 仅当本次调用真正新建了账号（已存在走 400「已存在」）；
          // 回连据此带 fresh=1，桌面端仅对新建账号跑首启向导，已注册邮箱
          // 在任意机器登录直达主界面（2026-10-16）。
          return ok;
        });
      }).then(function (fresh) {
        setMsg("成功，正在回连桌面端…", "ok");
        var sep = cb.indexOf("?") >= 0 ? "&" : "?";
        window.location.href = cb + sep + "state=" + encodeURIComponent(state)
          + "&email=" + encodeURIComponent(email)
          + (fresh ? "&fresh=1" : "");
      }).catch(function (e) {
        setMsg(e && e.message ? e.message : "登录失败，请稍后重试", "err");
        btn.disabled = false;
        // 内测闸拦截（403）：露出候补申请区，用户可自助排队
        if (e && e.statusCode === 403) {
          document.getElementById("applyBox").classList.remove("hidden");
        }
      });
    });

    document.getElementById("applyBtn").addEventListener("click", function () {
      var applyBtn = document.getElementById("applyBtn");
      var email = emailInput.value.trim().toLowerCase();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        setMsg("请先在上方填写有效邮箱，再申请候补", "err");
        return;
      }
      applyBtn.disabled = true;
      setMsg("提交申请中…", "");
      fetch("/accounts/beta/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          note: document.getElementById("applyNote").value.trim() || undefined
        })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (res.status !== 200 || !data || data.ok !== true) {
            throw new Error((data && data.message) || "申请失败，请稍后重试");
          }
          if (data.whitelisted) {
            setMsg("这个邮箱已在白名单内，直接点「注册 / 登录」即可进入", "ok");
          } else {
            setMsg("已加入候补名单，届时用同一邮箱登录", "ok");
          }
        });
      }).catch(function (e) {
        setMsg(e && e.message ? e.message : "申请失败，请稍后重试", "err");
        applyBtn.disabled = false;
      });
    });
  </script>
</body>
</html>`;
}

function renderBetaApplyPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NEXTBOT — 内测申请</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: "Noto Sans SC", "Microsoft YaHei UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 24px 16px;
  }
  .card {
    width: 400px;
    max-width: 100%;
    background: #141414;
    border: 1px solid #232323;
    border-radius: 24px;
    padding: 44px 40px 36px;
  }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: 3.2px; color: #F2F2F2; }
  h1 { margin-top: 26px; font-size: 26px; font-weight: 700; line-height: 1.3; color: #F2F2F2; }
  .sub { margin-top: 10px; font-size: 14px; line-height: 1.6; color: #9B9B9B; }
  label { display: block; margin-top: 28px; font-size: 13px; font-weight: 600; color: #F2F2F2; }
  input {
    margin-top: 8px; width: 100%; height: 46px;
    background: #101010; border: 1px solid #3D3D3D; border-radius: 10px;
    padding: 0 16px; font-size: 14px; color: #F2F2F2; outline: none;
    font-family: inherit;
  }
  input:focus { border-color: #E8E8E8; }
  input::placeholder { color: #6B6B6B; }
  button {
    margin-top: 26px; width: 100%; height: 48px;
    background: #FFFFFF; color: #0A0A0A; border: none; border-radius: 24px;
    font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit;
  }
  button:disabled { background: #2E2E2E; color: #9B9B9B; cursor: default; }
  button.dl, a.dl {
    background: #FFFFFF; margin-top: 18px; text-decoration: none;
    color: #0A0A0A; font-size: 15px; font-weight: 600; height: 48px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 24px; cursor: pointer;
  }
  .panel { margin-top: 22px; border-top: 1px solid #232323; padding-top: 20px; display: none; }
  .panel .state { font-size: 15px; font-weight: 600; color: #F2F2F2; }
  .panel .desc { margin-top: 8px; font-size: 13px; line-height: 1.7; color: #9B9B9B; }
  .panel .steps { margin-top: 12px; font-size: 13px; line-height: 1.9; color: #9B9B9B; }
  .panel .steps b { color: #F2F2F2; font-weight: 600; }
  #msg { margin-top: 14px; font-size: 12px; line-height: 1.5; color: #9B9B9B; min-height: 18px; }
  #msg.err { color: #F2604E; }
  #msg.ok { color: #F2F2F2; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">NEXTBOT</div>
    <h1>申请 NEXTBOT 内测</h1>
    <p class="sub">填邮箱排队，管理员通过后回到本页查询即可下载安装包。已通过的用户用同一邮箱在桌面端登录即可。</p>
    <form id="f">
      <label for="email">邮箱</label>
      <input id="email" type="email" placeholder="you@example.com" autofocus>
      <label for="note">备注（选填）</label>
      <input id="note" type="text" maxlength="200" placeholder="您是谁 / 从哪来的">
      <button id="btn" type="submit">申请 / 查询进度</button>
    </form>
    <div class="panel" id="panel">
      <div class="state" id="state"></div>
      <div class="desc" id="desc"></div>
      <a id="dl" class="dl" style="display:none" download>下载安装包（Windows）</a>
      <div class="steps" id="steps" style="display:none">
        <b>1</b>. 下载并安装（无弹窗广告，装完桌面出现 NEXTBOT 图标）<br>
        <b>2</b>. 打开应用，点「立即登录」<br>
        <b>3</b>. 用<b>本页同一邮箱</b>完成登录即可开始使用
      </div>
      <button id="reapply" style="display:none">重新申请</button>
    </div>
    <p id="msg"></p>
  </div>
  <script>
    var msg = document.getElementById("msg");
    var btn = document.getElementById("btn");
    var panel = document.getElementById("panel");
    var stateEl = document.getElementById("state");
    var descEl = document.getElementById("desc");
    var dl = document.getElementById("dl");
    var steps = document.getElementById("steps");
    var reapplyBtn = document.getElementById("reapply");
    var emailInput = document.getElementById("email");
    var noteInput = document.getElementById("note");

    function setMsg(text, kind) {
      msg.textContent = text;
      msg.className = kind || "";
    }

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function hidePanel() {
      panel.style.display = "none";
      dl.style.display = "none";
      steps.style.display = "none";
      reapplyBtn.style.display = "none";
    }

    function render(data) {
      panel.style.display = "block";
      var status = data.status;
      if (status === "approved") {
        stateEl.textContent = "✓ 已通过";
        descEl.textContent = "您的邮箱已在内测名单内，按下面三步开始使用：";
        if (data.downloadUrl) {
          dl.href = data.downloadUrl;
          dl.style.display = "flex";
        }
        steps.style.display = "block";
      } else if (status === "pending") {
        stateEl.textContent = "已进入候选名单";
        descEl.textContent = "管理员通过后，回到本页再点一次「申请 / 查询进度」即可获取安装包。";
      } else if (status === "rejected") {
        stateEl.textContent = "本次未通过";
        descEl.textContent = "如有疑问可联系管理员；也可以修改备注后重新申请。";
        reapplyBtn.style.display = "block";
      } else {
        hidePanel();
      }
    }

    function query() {
      var email = emailInput.value.trim().toLowerCase();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        setMsg("请输入有效的邮箱地址", "err");
        return Promise.resolve(null);
      }
      return fetch("/accounts/beta/status?email=" + encodeURIComponent(email))
        .then(function (r) { return r.json(); });
    }

    function apply(email) {
      return fetch("/accounts/beta/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          note: noteInput.value.trim() || undefined
        })
      }).then(function (r) { return r.json(); });
    }

    reapplyBtn.addEventListener("click", function () {
      var email = emailInput.value.trim().toLowerCase();
      if (!email) return;
      reapplyBtn.disabled = true;
      apply(email).then(function (d) {
        if (!d || d.ok !== true) throw new Error(d && d.message || "申请失败");
        render(d);
        setMsg("已重新提交申请", "ok");
      }).catch(function (e) {
        setMsg(e && e.message ? e.message : "申请失败，请稍后重试", "err");
      }).finally(function () { reapplyBtn.disabled = false; });
    });

    document.getElementById("f").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = emailInput.value.trim().toLowerCase();
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        setMsg("请输入有效的邮箱地址", "err");
        return;
      }
      btn.disabled = true;
      setMsg("查询中…", "");
      hidePanel();
      query().then(function (st) {
        if (!st) return null;
        if (st.ok !== true) throw new Error(st.message || "查询失败");
        if (st.status !== "none") return st;
        return apply(email).then(function (ap) {
          if (!ap || ap.ok !== true) throw new Error(ap && ap.message || "申请失败");
          return ap;
        });
      }).then(function (data) {
        if (!data) { btn.disabled = false; return; }
        render(data);
        setMsg("", "");
      }).catch(function (e) {
        setMsg(e && e.message ? e.message : "请稍后重试", "err");
      }).finally(function () { btn.disabled = false; });
    });
  </script>
</body>
</html>`;
}
