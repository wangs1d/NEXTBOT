import fs from "node:fs";
import { buildCapabilityModules } from "../server/src/tools/capability-modules/index.js";
import { CHAT_LANE_CORE_NAMES, TASK_LANE_CORE_NAMES } from "../server/src/external-model/lane-tool-sets.js";

const stub: unknown = new Proxy(function () { return stub; }, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : stub),
  apply: () => stub,
  construct: () => stub as object,
});

async function main() {
  const modules = buildCapabilityModules(stub as never);
  const out = {
    generatedAt: new Date().toISOString(),
    resident: { chat: [...CHAT_LANE_CORE_NAMES], task: [...TASK_LANE_CORE_NAMES] },
    domains: modules
      .map((m) => ({
        domain: m.domain,
        label: m.label,
        tools: (m.chatTools ?? [])
          .map((t) => (t.type === "function" ? t.function?.name ?? "" : ""))
          .filter(Boolean),
      }))
      .filter((d) => d.tools.length > 0)
      .sort((a, b) => a.domain.localeCompare(b.domain)),
  };
  fs.writeFileSync("design/tool-inventory.json", JSON.stringify(out, null, 1));
  const total = out.domains.reduce((n, d) => n + d.tools.length, 0);
  console.log(`domains=${out.domains.length} capabilityTools=${total} residentChat=${out.resident.chat.length} residentTask=${out.resident.task.length}`);
}
main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
