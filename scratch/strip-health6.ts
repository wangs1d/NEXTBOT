import fs from "node:fs";

function strip(path: string, drop: (line: string) => boolean): void {
  const raw = fs.readFileSync(path, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const out = raw.split(/\r?\n/).filter((l) => !drop(l));
  fs.writeFileSync(path, out.join(eol));
}

// 注释残留
strip("server/src/bootstrap/types.ts", (l) => l.includes("健康/运动数据服务（health.log_metric"));

// 客户端友好标签：health./period. 与两个域
strip("client/flutter_app/lib/core/utils/tool_friendly_label.dart", (l) =>
  /^\s*\("period\.",/.test(l) ||
  /^\s*\("health\./.test(l) ||
  /^\s*\("health_fitness",/.test(l) ||
  /^\s*\("period_care",/.test(l),
);
console.log("stripped");
