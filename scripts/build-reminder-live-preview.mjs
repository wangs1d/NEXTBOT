/**
 * 把「提醒确认卡」真实链路证据渲染成可看的手机端页面。
 *
 * 输入：docs/design/mobile-reminder/live-evidence.json（由
 *       server/probe-reminder-card-live.ts 真调工具 + 生产渲染链产出）
 * 输出：docs/design/mobile-reminder/live.html（自包含单文件，默认唯一产物）
 *       需要留图时设 REMINDER_SHOTS=1，额外产出 live-preview.png /
 *       live-phones.png / live-card-detail.png / live-card-flipped.png
 *
 * 运行：node scripts/build-reminder-live-preview.mjs
 *       REMINDER_SHOTS=1 node scripts/build-reminder-live-preview.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const ROOT = "D:/ws-project/Private-Agent";
const DIR = `${ROOT}/docs/design/mobile-reminder`;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const evidence = JSON.parse(readFileSync(`${DIR}/live-evidence.json`, "utf8"));
const inline = JSON.stringify(evidence).replace(/</g, "\\u003c");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>提醒确认卡 · 真实链路实测</title>
<style>
  :root{--page:#EDEEF1;--surface:#FFFFFF;--chat:#F7F7F8;--ink:#111112;--sub:#70707A;--muted:#A6A6AF;--divider:#EDEDEF;--bubble:#F1F1F4;--line:#DCDCE1;}
  *{box-sizing:border-box;-webkit-font-smoothing:antialiased;}
  body{margin:0;padding:40px 36px 70px;background:var(--page);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .wrap{max-width:1480px;margin:0 auto;}
  .head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:20px;}
  .head h1{margin:0 0 9px;font-size:25px;letter-spacing:-.4px;}
  .head p{margin:0;max-width:1000px;font-size:13px;color:var(--sub);line-height:1.8;}
  .head code{font-family:ui-monospace,Menlo,monospace;font-size:11px;background:#E4E6EB;border-radius:4px;padding:1px 5px;}
  .pass-pill{white-space:nowrap;background:#E4F3EB;color:#0E5B36;border-radius:999px;padding:9px 15px;font-size:13px;font-weight:700;}
  .bar{display:flex;gap:22px;flex-wrap:wrap;background:var(--surface);border:1px solid #E4E5E9;border-radius:14px;padding:14px 18px;margin-bottom:26px;font-size:11.5px;color:var(--sub);line-height:1.7;}
  .bar b{color:var(--ink);font-weight:650;}
  .screens{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px 34px;}
  .screen-label{margin-bottom:12px;}
  .screen-label .t{font-size:13.5px;font-weight:700;}
  .screen-label .t .n{display:inline-block;font-size:10px;font-weight:700;color:var(--muted);border:1px solid #DDDEE4;border-radius:5px;padding:1px 6px;margin-right:8px;vertical-align:1px;}
  .screen-label .s{font-size:11px;color:var(--sub);margin-top:5px;line-height:1.6;}
  .phone{width:368px;height:690px;background:var(--chat);border-radius:40px;border:9px solid #101013;box-shadow:0 22px 54px -22px rgba(16,16,20,.38);position:relative;overflow:hidden;display:flex;flex-direction:column;}
  .status{height:38px;flex:0 0 38px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;font-size:11.5px;font-weight:650;}
  .status .right{display:flex;align-items:center;gap:5px;}
  .status .bars{display:flex;align-items:flex-end;gap:2px;height:9px;}
  .status .bars i{width:2.5px;background:var(--ink);border-radius:1px;display:block;}
  .status .bat{width:15px;height:8px;border:1.3px solid var(--ink);border-radius:2px;position:relative;}
  .status .bat::after{content:"";position:absolute;inset:1.3px;background:var(--ink);}
  .notch{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:100px;height:24px;background:#101013;border-radius:13px;}
  .nav{flex:0 0 44px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--divider);}
  .nav .title{font-size:14px;font-weight:650;}
  .nav .side{font-size:11px;color:var(--sub);letter-spacing:.06em;}
  .chat{flex:1;overflow:hidden;padding:14px 14px 8px;display:flex;flex-direction:column;gap:8px;}
  .chat>*{flex:0 0 auto;}
  .time{align-self:center;font-size:10px;color:var(--muted);margin:1px 0 3px;}
  .bubble{align-self:flex-start;background:var(--bubble);color:#1A1A1C;font-size:13.5px;line-height:1.65;padding:9px 13px;border-radius:17px 17px 17px 5px;max-width:88%;}
  .bubble.user{align-self:flex-end;background:var(--ink);color:#fff;border-radius:17px 17px 5px 17px;max-width:86%;}
  .card-host{align-self:flex-start;display:flex;flex-direction:column;align-items:flex-start;max-width:88%;}
  .rc{width:300px;max-width:100%;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 16px 13px;box-shadow:0 1px 2px rgba(17,17,18,.035);}
  .rc .kicker{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:500;letter-spacing:.7px;color:#8A8A93;margin-bottom:10px;}
  .rc .kicker .dot{width:5px;height:5px;border-radius:50%;background:#C7C8CF;flex:0 0 5px;}
  .rc.updated .kicker{color:#8A641C;} .rc.updated .kicker .dot{background:#B8862F;}
  .rc.fired .kicker{color:#4C7A60;} .rc.fired .kicker .dot{background:#2E9E63;}
  .rc.cancelled{background:#FCFCFD;border-color:#EBECEF;}
  .rc.cancelled .kicker{color:#A6A6AF;}
  .rc .line{height:44px;display:flex;align-items:center;gap:9px;white-space:nowrap;}
  .rc .line .when-col{width:92px;flex:0 0 92px;display:flex;align-items:baseline;gap:5px;}
  .rc .line .lab{font-size:12px;color:#A6A6AF;}
  .rc .line .tm{font-size:16px;font-weight:500;letter-spacing:-.3px;color:#1A1A1C;font-variant-numeric:tabular-nums;}
  .rc .line .sep{font-size:12px;color:#A6A6AF;}
  .rc .line .ttl{font-size:15px;font-weight:400;letter-spacing:.1px;color:#3C3D45;overflow:hidden;text-overflow:ellipsis;min-width:0;}
  .rc .line.strike .tm,.rc .line.strike .ttl{color:#A6A6AF;text-decoration:line-through;text-decoration-color:#C9CAD1;}
  .rc .wheel{position:relative;height:132px;overflow:hidden;cursor:ns-resize;touch-action:none;
    -webkit-mask-image:linear-gradient(to bottom,transparent 0%,#000 30%,#000 70%,transparent 100%);
    mask-image:linear-gradient(to bottom,transparent 0%,#000 30%,#000 70%,transparent 100%);}
  .rc .wheel .slot{position:absolute;left:-4px;right:-4px;top:44px;height:44px;border-radius:10px;background:rgba(17,17,18,.035);}
  .rc .wheel .wrow{position:absolute;left:0;right:0;top:0;height:44px;pointer-events:none;
    transition:transform .28s cubic-bezier(.22,.61,.36,1),opacity .28s ease;}
  .rc .sub{font-size:10.5px;color:var(--muted);margin-top:9px;}
  .composer{flex:0 0 60px;background:var(--chat);padding:6px 4px 0;display:flex;align-items:flex-start;}
  .input-card{flex:1;height:52px;border-radius:26px;background:var(--surface);border:1px solid #EDEDEF;display:flex;align-items:center;justify-content:space-between;padding:0 11px;}
  .plus{font-size:22px;font-weight:300;color:#5B5D66;padding:0 5px;}
  .mic{width:34px;height:34px;border-radius:50%;background:var(--ink);display:flex;align-items:center;justify-content:center;}
  .tabbar{flex:0 0 62px;background:var(--surface);border:1px solid #EDEDEF;border-radius:28px;margin:8px 4px 8px;display:flex;align-items:center;justify-content:space-around;padding:0 8px;}
  .tab{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;}
  .tab.on{background:#F1F3F6;}
  .ico{width:15px;height:15px;position:relative;display:block;}
  .ico::before,.ico::after{content:"";position:absolute;display:block;}
  .i-chat{border:1.5px solid #9A9BA3;border-radius:5px;}
  .i-chat::after{left:3px;bottom:-4px;width:4px;height:4px;border-left:1.5px solid #9A9BA3;border-bottom:1.5px solid #9A9BA3;transform:rotate(-25deg);}
  .i-cal{border:1.5px solid #9A9BA3;border-radius:3px;} .i-cal::before{left:-1px;right:-1px;top:3px;border-top:1.5px solid #9A9BA3;}
  .i-doc{border:1.5px solid #9A9BA3;border-radius:3px;} .i-doc::before{left:3px;right:3px;top:4px;border-top:1.5px solid #9A9BA3;} .i-doc::after{left:3px;right:3px;top:8px;border-top:1.5px solid #9A9BA3;}
  .i-check{border:1.5px solid #9A9BA3;border-radius:3px;} .i-check::after{left:4px;top:1px;width:4px;height:8px;border-right:1.5px solid #9A9BA3;border-bottom:1.5px solid #9A9BA3;transform:rotate(40deg);}
  .i-slider::before{left:0;right:0;top:4px;border-top:1.5px solid #9A9BA3;} .i-slider::after{left:0;right:0;top:10px;border-top:1.5px solid #9A9BA3;}
  .tab.on .ico{border-color:#111112;} .tab.on .ico::before,.tab.on .ico::after{border-color:#111112;}
  .section{margin-top:34px;}
  .section h2{font-size:16px;margin:0 0 14px;}
  .panel{background:var(--surface);border:1px solid #E4E5E9;border-radius:14px;padding:18px 20px;}
  .checks{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 22px;list-style:none;margin:0;padding:0;}
  .checks li{font-size:11.5px;line-height:1.7;padding:3px 0;}
  .checks li.pass{color:#0E5B36;} .checks li.fail{color:#A32D2D;font-weight:700;}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
  details{background:var(--surface);border:1px solid #E4E5E9;border-radius:12px;padding:12px 15px;}
  summary{font-size:12px;font-weight:650;cursor:pointer;}
  pre{margin:12px 0 0;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;line-height:1.6;color:#4B4D55;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;}
  .files{font-size:11.5px;color:var(--sub);line-height:2;}
  .files code{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;background:#F3F4F6;border-radius:4px;padding:1px 5px;}
  footer{margin-top:30px;font-size:10.5px;color:var(--muted);line-height:1.8;}
  @media(max-width:1100px){.screens,.checks,.cols{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <h1>提醒确认卡 · 真实链路实测</h1>
      <p>下面每张卡都由 <code>registry.execute("calendar.create")</code> 的真实回执驱动：生产同一条渲染链 <code>decideRender → applyCards → normalizeReplyCardLayout → collectCardPayloads</code> 产出卡 JSON，页面按与 Flutter <code>ReminderConfirmCard</code> 相同的字体分层与轮动参数渲染。事项文本是工具确定性解析的原样结果，未做任何润色。</p>
    </div>
    <div class="pass-pill" id="pass-count">—</div>
  </div>
  <div class="bar">
    <div><b>数据来源</b> 本地 ScheduleTaskService 临时任务库（真实写入 / 改期 / 删除）</div>
    <div><b>生成时间</b> <span id="gen-at">—</span></div>
    <div><b>范围</b> 手机端 · 方案 A（一轮一张卡、多条轮动 · A 版视觉）</div>
    <div><b>状态</b> 只读卡 / 修改·取消原地刷新 / 屏内无注解</div>
  </div>

  <div class="screens" id="screens">
    <div class="screen">
      <div class="screen-label"><div class="t"><span class="n">A</span>创建轮 · 对话先行</div><div class="s">真实单条回执 → 正文两泡 → 一张只读确认卡，卡在正文之后。</div></div>
      <div class="phone">
        <div class="status"><span>9:41</span><div class="notch"></div><div class="right"><div class="bars"><i style="height:3px"></i><i style="height:5px"></i><i style="height:7px"></i><i style="height:9px"></i></div><div class="bat"></div></div></div>
        <div class="nav"><span class="title">阿哲</span><span class="side">···</span></div>
        <div class="chat">
          <div class="time">今天 00:35</div>
          <div class="bubble user">明天 07:00 提醒我叫阿哲起床</div>
          <div class="bubble">好嘞阿哲，七点准时叫你。</div>
          <div class="bubble">不过我不负责把你从被窝里拽出来哈。</div>
          <div class="card-host" data-card="single"></div>
        </div>
        <div class="composer"><div class="input-card"><span class="plus">+</span><span class="mic"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><rect x="7" y="3" width="6" height="10" rx="3"/><path d="M4.5 9.8a5.5 5.5 0 0 0 11 0M10 15.4V18"/></svg></span></div></div>
        <div class="tabbar"><span class="tab on"><i class="ico i-chat"></i></span><span class="tab"><i class="ico i-cal"></i></span><span class="tab"><i class="ico i-doc"></i></span><span class="tab"><i class="ico i-check"></i></span><span class="tab"><i class="ico i-slider"></i></span></div>
      </div>
    </div>

    <div class="screen">
      <div class="screen-label"><div class="t"><span class="n">B</span>一轮 4 条 · 方案 A</div><div class="s">真实创建 4 条 → 合并一张卡，卡内上下轮动、一次只清晰显示一条，邻项隐隐渐隐。</div></div>
      <div class="phone">
        <div class="status"><span>9:41</span><div class="notch"></div><div class="right"><div class="bars"><i style="height:3px"></i><i style="height:5px"></i><i style="height:7px"></i><i style="height:9px"></i></div><div class="bat"></div></div></div>
        <div class="nav"><span class="title">阿哲</span><span class="side">···</span></div>
        <div class="chat">
          <div class="time">今天 00:36</div>
          <div class="bubble user">再排 8 点带工牌、9 点交房租、10 点买咖啡、11 点给妈妈打电话</div>
          <div class="bubble">行，都排上了。</div>
          <div class="bubble">都写进日程里了。</div>
          <div class="card-host" data-card="multi"></div>
        </div>
        <div class="composer"><div class="input-card"><span class="plus">+</span><span class="mic"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><rect x="7" y="3" width="6" height="10" rx="3"/><path d="M4.5 9.8a5.5 5.5 0 0 0 11 0M10 15.4V18"/></svg></span></div></div>
        <div class="tabbar"><span class="tab on"><i class="ico i-chat"></i></span><span class="tab"><i class="ico i-cal"></i></span><span class="tab"><i class="ico i-doc"></i></span><span class="tab"><i class="ico i-check"></i></span><span class="tab"><i class="ico i-slider"></i></span></div>
      </div>
    </div>

    <div class="screen">
      <div class="screen-label"><div class="t"><span class="n">C</span>改期 · 刷新原卡</div><div class="s">真实 calendar.update_task 回执 → card.update 把同一张卡刷成「已改为提醒」。</div></div>
      <div class="phone">
        <div class="status"><span>9:41</span><div class="notch"></div><div class="right"><div class="bars"><i style="height:3px"></i><i style="height:5px"></i><i style="height:7px"></i><i style="height:9px"></i></div><div class="bat"></div></div></div>
        <div class="nav"><span class="title">阿哲</span><span class="side">···</span></div>
        <div class="chat">
          <div class="time">今天 00:35</div>
          <div class="bubble user">明天 07:00 提醒我叫阿哲起床</div>
          <div class="bubble">好嘞阿哲，七点准时叫你。</div>
          <div class="card-host" data-card="updated"></div>
          <div class="bubble user">改成七点半吧</div>
          <div class="bubble">改好了，七点半叫你。</div>
        </div>
        <div class="composer"><div class="input-card"><span class="plus">+</span><span class="mic"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><rect x="7" y="3" width="6" height="10" rx="3"/><path d="M4.5 9.8a5.5 5.5 0 0 0 11 0M10 15.4V18"/></svg></span></div></div>
        <div class="tabbar"><span class="tab on"><i class="ico i-chat"></i></span><span class="tab"><i class="ico i-cal"></i></span><span class="tab"><i class="ico i-doc"></i></span><span class="tab"><i class="ico i-check"></i></span><span class="tab"><i class="ico i-slider"></i></span></div>
      </div>
    </div>

    <div class="screen">
      <div class="screen-label"><div class="t"><span class="n">D</span>取消 · 刷新原卡</div><div class="s">真实 calendar.delete_task 回执 → 卡刷成「已取消提醒」，日程页条目同步删除。</div></div>
      <div class="phone">
        <div class="status"><span>9:41</span><div class="notch"></div><div class="right"><div class="bars"><i style="height:3px"></i><i style="height:5px"></i><i style="height:7px"></i><i style="height:9px"></i></div><div class="bat"></div></div></div>
        <div class="nav"><span class="title">阿哲</span><span class="side">···</span></div>
        <div class="chat">
          <div class="time">今天 00:35</div>
          <div class="bubble user">明天 07:00 提醒我叫阿哲起床</div>
          <div class="bubble">好嘞阿哲，七点准时叫你。</div>
          <div class="card-host" data-card="cancelled"></div>
          <div class="bubble user">算了，取消吧</div>
          <div class="bubble">行，撤了。</div>
        </div>
        <div class="composer"><div class="input-card"><span class="plus">+</span><span class="mic"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><rect x="7" y="3" width="6" height="10" rx="3"/><path d="M4.5 9.8a5.5 5.5 0 0 0 11 0M10 15.4V18"/></svg></span></div></div>
        <div class="tabbar"><span class="tab on"><i class="ico i-chat"></i></span><span class="tab"><i class="ico i-cal"></i></span><span class="tab"><i class="ico i-doc"></i></span><span class="tab"><i class="ico i-check"></i></span><span class="tab"><i class="ico i-slider"></i></span></div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>实测断言（真工具 + 真渲染链）</h2>
    <div class="panel"><ul class="checks" id="checks"></ul></div>
  </div>

  <div class="section">
    <h2>真实载荷</h2>
    <div class="cols">
      <details open><summary>calendar.create 真实回执</summary><pre id="receipt-json"></pre></details>
      <details><summary>下发客户端的确认卡 JSON</summary><pre id="card-json"></pre></details>
    </div>
  </div>

  <div class="section">
    <h2>本次落地</h2>
    <div class="panel files">
      <div>服务端：<code>render/scenes/reminder-confirm.scene.ts</code>（priority 75，一轮一张卡、rows 全量下发、无折叠收口）· <code>scenes/index.ts</code> · <code>services/reminder-card-state.ts</code>（card.update 原地刷新）· <code>packages/agent-protocol/src/display-effects.ts</code>（枚举已重建 dist）</div>
      <div>手机端：<code>features/chat/reminder_confirm_card.dart</code>（A 版轮动自绘卡：固定时间列 / 字体分层 / 分级渐隐 / 手势翻页）· <code>features/chat/agent_result_card.dart</code>（cardType 分发）</div>
      <div>验证：<code>test/render-scenes.test.ts</code> 34/34 · <code>probe-reminder-card-live.ts</code> 16/16 · 服务端 tsc 0 error · dart analyze 0 issue</div>
    </div>
  </div>

  <footer>本页为单文件自包含预览，数据来自 live-evidence.json；重新跑探针 + 构建脚本即可刷新。本期只做手机端。</footer>
</div>

<script id="evidence" type="application/json">${inline}</script>
<script>
(function(){
  var E = JSON.parse(document.getElementById("evidence").textContent);
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=text; return n; }
  function reminderOf(card){ return (card && card.extra && card.extra.reminder) || {}; }
  function lineNode(row, cancelled){
    var line = el("div","line" + (cancelled?" strike":""));
    var col = el("span","when-col");
    if(row.label) col.appendChild(el("span","lab",row.label));
    if(row.time) col.appendChild(el("span","tm",row.time));
    line.appendChild(col);
    line.appendChild(el("span","sep","·"));
    line.appendChild(el("span","ttl",row.title||""));
    return line;
  }
  function attachWheel(wheel, total){
    var nodes = Array.prototype.slice.call(wheel.querySelectorAll(".wrow"));
    var idx = total > 2 ? 1 : 0, y0 = null, dragged = false, last = 0;
    function render(){
      nodes.forEach(function(n,i){
        var d = i - idx, a = Math.abs(d);
        n.style.opacity = a===0?"1":a===1?".32":a===2?".10":"0";
        n.style.transform = "translate("+(a?3*a:0)+"px,"+(44+d*40)+"px) scale("+(a===0?1:a===1?.94:.88)+")";
      });
    }
    function step(v){ var n=Math.max(0,Math.min(total-1,idx+v)); if(n!==idx){ idx=n; render(); } }
    wheel.addEventListener("pointerdown",function(e){ y0=e.clientY; dragged=false; });
    wheel.addEventListener("pointerup",function(e){ if(y0===null)return; var dy=e.clientY-y0; if(Math.abs(dy)>16){ dragged=true; step(dy<0?1:-1); } y0=null; });
    wheel.addEventListener("click",function(e){ if(dragged){ dragged=false; return; } var r=wheel.getBoundingClientRect(); step(e.clientY-r.top<66?-1:1); });
    wheel.addEventListener("wheel",function(e){ e.preventDefault(); var t=performance.now(); if(t-last<220)return; last=t; step(e.deltaY>0?1:-1); },{passive:false});
    render();
  }
  function cardNode(card){
    if(!card) return el("div","sub","(无卡载荷)");
    var r = reminderOf(card), status = r.status || "created";
    var wrap = el("div","rc" + (status==="cancelled"?" cancelled":status==="updated"?" updated":status==="fired"?" fired":""));
    var kicker = el("div","kicker"); kicker.appendChild(el("span","dot")); kicker.appendChild(el("span","",card.title||"已定好提醒")); wrap.appendChild(kicker);
    var rows = (Array.isArray(r.rows) && r.rows.length) ? r.rows : (card.items||[]).map(function(i){ return {label:"",time:"",title:i.text}; });
    var cancelledAll = status === "cancelled";
    if(rows.length >= 2){
      var wheel = el("div","wheel");
      wheel.appendChild(el("div","slot"));
      rows.forEach(function(row){
        var n = el("div","wrow");
        n.appendChild(lineNode(row, cancelledAll || row.status==="cancelled"));
        wheel.appendChild(n);
      });
      wrap.appendChild(wheel);
      attachWheel(wheel, rows.length);
    } else {
      rows.forEach(function(row){ wrap.appendChild(lineNode(row, cancelledAll || row.status==="cancelled")); });
    }
    if(card.footer) wrap.appendChild(el("div","sub",card.footer));
    return wrap;
  }
  var cards = {single:E.single.card, multi:E.multi.card, updated:E.updatedCard, cancelled:E.cancelledCard};
  Array.prototype.forEach.call(document.querySelectorAll("[data-card]"), function(host){
    host.appendChild(cardNode(cards[host.getAttribute("data-card")]));
  });
  var ul = document.getElementById("checks");
  E.checks.forEach(function(c){ ul.appendChild(el("li",c.pass?"pass":"fail",(c.pass?"PASS  ":"FAIL  ")+c.name)); });
  document.getElementById("receipt-json").textContent = JSON.stringify(E.receipt,null,2);
  document.getElementById("card-json").textContent = JSON.stringify(E.single.card,null,2);
  document.getElementById("gen-at").textContent = E.generatedAt || "—";
  document.getElementById("pass-count").textContent = E.checks.filter(function(c){return c.pass;}).length + "/" + E.checks.length + " PASS";
  window.__ready = true;
})();
</script>
</body>
</html>`;

writeFileSync(`${DIR}/live.html`, html, "utf8");

// 用户 11-07 拍板：这批 PNG 不留。默认只产 HTML；需要留图时显式开开关。
const SHOTS = process.env.REMINDER_SHOTS === "1";

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 1.4 });
  await page.goto(`file:///${DIR}/live.html`);
  // 无论是否出图，都做一次真实浏览器渲染校验（4 张卡必须都挂上）
  await page.waitForFunction("window.__ready === true && document.querySelectorAll('.rc').length >= 4");

  if (SHOTS) {
    await page.screenshot({ path: `${DIR}/live-preview.png`, fullPage: true });
    const screens = await page.$("#screens");
    await screens.screenshot({ path: `${DIR}/live-phones.png` });

    // 卡片特写 + 真实翻页留证：滚轮事件走预览页同一套手势逻辑
    const cardEl = await page.$('[data-card="multi"] .rc');
    await cardEl.screenshot({ path: `${DIR}/live-card-detail.png` });
    const wheel = await page.$('[data-card="multi"] .wheel');
    const box = await wheel.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(360);
    await cardEl.screenshot({ path: `${DIR}/live-card-flipped.png` });
  }

  console.log(SHOTS
    ? "OK  live.html + 4 张 PNG"
    : "OK  live.html（默认不出图；REMINDER_SHOTS=1 才留图）");
} finally {
  await browser.close();
}
