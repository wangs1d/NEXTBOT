/**
 * 本地「扫码登录页」测试服务：验证 agent_browser 撞登录墙 → 截图二维码卡推手机。
 * 页面正文含「扫码登录」（human-gate 兜底关键词），画一个假二维码网格充当视觉物证。
 * 用法：node .tmp/qr-login-server.mjs  （监听 127.0.0.1:18791）
 */
import { createServer } from "node:http";

const cells = [];
// 21x21 找码风伪随机网格（纯装饰，链路验证不需要真二维码）
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
for (let y = 0; y < 21; y++) {
  for (let x = 0; x < 21; x++) {
    const corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
    const ring = corner && (x % 6 === 0 || x % 6 === 5 - 0 || y % 6 === 0 || y % 6 === 5);
    if (corner ? ring : rand() > 0.5) cells.push(`<rect x="${x * 10}" y="${y * 10}" width="10" height="10"/>`);
  }
}

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>安全登录</title></head>
<body style="font-family:sans-serif;text-align:center;padding-top:60px">
  <h2>微信扫码登录</h2>
  <p>请使用微信扫一扫登录后继续操作</p>
  <svg width="210" height="210" viewBox="0 0 210 210" style="border:1px solid #ccc">
    <rect width="210" height="210" fill="#fff"/>
    <g fill="#000">${cells.join("")}</g>
  </svg>
  <p id="tip">二维码有效期 5 分钟，请尽快扫码</p>
</body></html>`;

/** 中性「确认订单」页：不含登录/验证关键词，测模型**主动** handoff（非自动检测）。 */
const payHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>确认订单</title></head>
<body style="font-family:sans-serif;padding:40px">
  <h2>确认订单</h2>
  <p>商品：机械键盘 K870 &nbsp; 单价：¥329</p>
  <fieldset style="width:320px">
    <legend>支付方式</legend>
    <label><input type="radio" name="pay" checked> 支付宝</label><br>
    <label><input type="radio" name="pay"> 微信支付</label><br>
    <label><input type="radio" name="pay"> 云闪付</label>
  </fieldset>
  <p><button style="padding:8px 32px">提交订单</button></p>
</body></html>`;

createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url?.startsWith("/pay") ? payHtml : html);
}).listen(18791, "127.0.0.1", () => console.log("qr-login page on http://127.0.0.1:18791  (/pay=确认订单页)"));
