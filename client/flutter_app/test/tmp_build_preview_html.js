const fs = require("fs");
const dir = "E:/ws-project/NextBot/client/flutter_app/test/goldens";
const desktop = fs.readFileSync(dir + "/tmp_followup_desktop.png").toString("base64");
const mobile = fs.readFileSync(dir + "/tmp_followup_mobile.png").toString("base64");
const html = `<div style="display:flex;flex-direction:column;gap:28px;background:#111;color:#ddd;font-family:sans-serif;padding:20px;">
  <div>
    <div style="font-size:13px;color:#999;margin-bottom:10px">桌面端（深色主题）— agent 卡片正下方</div>
    <img src="data:image/png;base64,${desktop}" style="max-width:100%;border-radius:8px"/>
  </div>
  <div>
    <div style="font-size:13px;color:#999;margin-bottom:10px">手机端（深色主题）— 你的白泡 → agent 灰泡 → 建议小泡</div>
    <img src="data:image/png;base64,${mobile}" style="max-width:420px;border-radius:8px"/>
  </div>
</div>`;
const out = "C:/Users/Administrator/.qoder-cn/app/chat-session-visualizations/188cfe77-762b-4d23-84c6-50a1e385c4a5/visualizations";
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + "/followup_preview.html", html);
console.log("written", html.length);
