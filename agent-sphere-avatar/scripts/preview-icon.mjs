import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = "E:/ws-project/NextBot/client/flutter_app/assets/agent_avatars";
const MIME = { ".png": "image/png", ".html": "text/html" };
const SITE = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#1a1c1f;font-family:sans-serif;color:#ccc;display:flex;gap:40px;align-items:center;justify-content:center;height:100vh;margin:0}
figure{text-align:center}
img{width:200px;height:200px;border-radius:50%;background:repeating-conic-gradient(#8a8a8a 0% 25%,#b9b9b9 0% 50%) 50%/20px 20px;border:1px solid #444;box-shadow:0 10px 40px rgba(0,0,0,.5)}
figcaption{font-size:14px;margin-top:10px}
</style></head><body>
<figure><img src="/sphere_icon.png"><figcaption>sphere_icon.png（透明底，网格=透明）</figcaption></figure>
</body></html>`;

createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") { res.writeHead(200, {"Content-Type":"text/html"}); res.end(SITE); return; }
  const file = join(ROOT, url);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
}).listen(8833, "127.0.0.1", () => console.log("preview at http://127.0.0.1:8833/"));