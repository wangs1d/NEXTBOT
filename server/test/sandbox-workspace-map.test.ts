/**
 * code-sandbox WP3 测试：工作区结构索引 + code.read_file 读法 + code.workspace_map。
 *
 * 借鉴 codebase-memory-mcp「持久索引 + mtime 增量刷新 + outline 先于原文」：
 *  - SandboxWorkspaceIndex：mtime/size 未变命中缓存；变更重建；SQLite 不可用降级
 *  - read_file：小文件全文、大文件 outline-first、mode="range" 分段、mode="full" 旧行为
 *  - workspace_map：多文件聚合概要 + hint 导航
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { CodeSandboxService } from "../src/services/code-sandbox-service.js";
import { resetSandboxWorkspaceIndexForTest, getSandboxWorkspaceIndex } from "../src/services/sandbox-workspace-index.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "sandbox-wp3-"));
after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeService(): { service: CodeSandboxService; root: string } {
  const root = join(tmpRoot, `svc-${Math.random().toString(36).slice(2)}`);
  return { service: new CodeSandboxService(root), root };
}

describe("code.run 主进程直接执行", () => {
  test("handler 直接调用服务，保留 stdin 与工作目录环境", async () => {
    const { service, root } = makeService();
    const { createCodeRunHandler } = await import("../src/tools/capability-modules/code-sandbox/handlers.js");
    const runCode = service.runCode.bind(service);
    let calls = 0;
    service.runCode = async (...args) => {
      calls += 1;
      return runCode(...args);
    };
    const previous = process.env.CODE_RUN_WORKER_ENABLED;
    process.env.CODE_RUN_WORKER_ENABLED = "1";
    try {
      const handler = createCodeRunHandler(service);
      const result = await handler({
        language: "node",
        code: [
          'let input = "";',
          'process.stdin.setEncoding("utf-8");',
          'process.stderr.write("warning");',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => console.log(JSON.stringify({',
          '  input, cwd: process.cwd(), workspace: process.env.SANDBOX_WORKSPACE,',
          '})));',
        ].join("\n"),
        workspaceId: "direct",
        stdin: "payload",
      }, { userId: "actor1", sessionId: "actor1" } as never) as Record<string, unknown>;

      assert.equal(calls, 1);
      assert.equal(result.ok, true);
      assert.equal(result.stderr, "warning");
      const output = JSON.parse(String(result.stdout));
      assert.equal(output.input, "payload");
      assert.equal(output.cwd, join(root, "actor1", "direct"));
      assert.equal(output.workspace, output.cwd);
      assert.doesNotMatch(String(result.summary), /\[worker\]/);
    } finally {
      if (previous === undefined) delete process.env.CODE_RUN_WORKER_ENABLED;
      else process.env.CODE_RUN_WORKER_ENABLED = previous;
    }
  });

  test("stdout/stderr 各截断到 8KB，并清理临时脚本", async () => {
    const { service } = makeService();
    const result = await service.runCode("actor1", {
      language: "node",
      code: 'process.stdout.write("o".repeat(9000)); process.stderr.write("e".repeat(9000));',
      workspaceId: "truncate",
    });

    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.stdout, "utf-8"), 8 * 1024);
    assert.equal(Buffer.byteLength(result.stderr, "utf-8"), 8 * 1024);
    assert.ok(readdirSync(result.workspacePath).every((name) => !name.startsWith("__run_")));
  });

  test("超时 SIGKILL 子进程并返回 timedOut", async () => {
    const { service } = makeService();
    const result = await service.runCode("actor1", {
      language: "node",
      code: "setTimeout(() => {}, 10_000);",
      workspaceId: "timeout",
      timeoutMs: 100,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.durationMs < 5_000, `超时进程未及时退出：${result.durationMs}ms`);
    assert.ok(readdirSync(result.workspacePath).every((name) => !name.startsWith("__run_")));
  });

  test("workspace 按 actor 和 workspaceId 隔离，路径段被清洗", async () => {
    const { service, root } = makeService();
    const first = await service.runCode("actor/a", {
      language: "node",
      code: 'require("node:fs").writeFileSync("marker.txt", "actor-a");',
      workspaceId: "../../shared",
    });
    assert.equal(first.ok, true);
    assert.equal(first.workspacePath, join(root, "actor_a", "shared"));

    const second = await service.runCode("actor/a", {
      language: "node",
      code: 'require("node:fs").readFileSync("marker.txt", "utf-8");',
      workspaceId: "other",
    });
    assert.equal(second.ok, false);
    assert.equal(second.workspacePath, join(root, "actor_a", "other"));

    const otherActor = await service.readFile("actor/b", "shared", "marker.txt");
    assert.equal(otherActor.ok, false);
    assert.match(String(otherActor.error), /读取文件失败/);
  });
});

describe("SandboxWorkspaceIndex 增量缓存", () => {
  test("mtime/size 未变 → 缓存命中不重算；文件变更 → 重建", async () => {
    const dir = join(tmpRoot, `idx-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const idx = resetSandboxWorkspaceIndexForTest(join(dir, "idx.sqlite"));
    const file = join(dir, "data.csv");
    writeFileSync(file, "id,amount\n" + Array.from({ length: 800 }, (_, i) => `A${i},${i}`).join("\n"));

    const first = await idx.getFileOutline(dir, "data.csv", file);
    assert.ok(first);
    assert.equal(first.kind, "csv");
    assert.equal(first.cached, false);
    assert.match(first.outline, /表头/);

    const second = await idx.getFileOutline(dir, "data.csv", file);
    assert.ok(second?.cached, "未变更应命中缓存");

    // 变更内容 + 显式推进 mtime（CI 文件系统时间粒度粗）
    writeFileSync(file, "id,amount,note\n" + Array.from({ length: 900 }, (_, i) => `A${i},${i},n`).join("\n"));
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    const third = await idx.getFileOutline(dir, "data.csv", file);
    assert.equal(third?.cached, false, "mtime 变更应重建");
    assert.match(third!.outline, /note/, "重建后 outline 应反映新表头");
    idx.close();
  });

  test("SQLite 路径不可写时降级进程内缓存，功能不缺失", async () => {
    // NUL 字节路径在 Windows/POSIX 都无法创建文件 → 构造函数走降级分支
    const idx = new (await import("../src/services/sandbox-workspace-index.js")).SandboxWorkspaceIndex(
      join(tmpRoot, "sub\n\nbad", "x.sqlite").replace(/[\r\n]/g, "\0"),
    );
    const dir = join(tmpRoot, `mem-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "a.md");
    writeFileSync(file, "# 标题\n\n" + "内容。".repeat(200));
    const got = await idx.getFileOutline(dir, "a.md", file);
    assert.ok(got);
    assert.match(got.outline, /标题/);
    idx.close();
  });
});

describe("code.read_file 读法（WP3）", () => {
  test("小文件默认全文；大文件默认 outline-first（不返回全文）", async () => {
    const { service } = makeService();
    await service.writeFile("actor1", "ws1", "small.md", "# 标题\n\n短内容。");
    await service.writeFile(
      "actor1",
      "ws1",
      "big.md",
      ["# 报告", "## 第一节", "甲".repeat(3000), "## 第二节", "乙".repeat(3000)].join("\n"),
    );

    const { createCodeReadFileHandler } = await import("../src/tools/capability-modules/code-sandbox/handlers.js");
    const handler = createCodeReadFileHandler(service);
    const ctx = { userId: "actor1", sessionId: "actor1" } as never;

    const small = (await handler({ workspaceId: "ws1", fileName: "small.md" }, ctx)) as Record<string, unknown>;
    assert.equal(small.mode, "full");
    assert.ok(String(small.content).includes("短内容"));

    const big = (await handler({ workspaceId: "ws1", fileName: "big.md" }, ctx)) as Record<string, unknown>;
    assert.equal(big.mode, "outline");
    assert.ok(!("content" in big), "大文件默认不返回全文");
    assert.match(String(big.outline), /第一节/);
    assert.match(String(big.hint), /mode="range"/);
    assert.ok(String(big.preview).length <= 300 + 10, "预览应截断");
  });

  test("mode=\"range\" 分段读 + nextOffset；mode=\"full\" 旧行为返回全文", async () => {
    const { service } = makeService();
    const body = Array.from({ length: 50 }, (_, i) => `段落${i}：${"字".repeat(100)}`).join("\n\n");
    await service.writeFile("actor1", "ws2", "doc.md", body);

    const { createCodeReadFileHandler } = await import("../src/tools/capability-modules/code-sandbox/handlers.js");
    const handler = createCodeReadFileHandler(service);
    const ctx = { userId: "actor1", sessionId: "actor1" } as never;

    const range = (await handler({ workspaceId: "ws2", fileName: "doc.md", mode: "range", offset: 0, limit: 1500 }, ctx)) as Record<string, unknown>;
    assert.equal(range.mode, "range");
    assert.equal(range.returnedChars, 1500);
    assert.equal(range.nextOffset, 1500);
    const tail = (await handler({ workspaceId: "ws2", fileName: "doc.md", mode: "range", offset: range.nextOffset as number, limit: 1500 }, ctx)) as Record<string, unknown>;
    assert.equal(tail.offset, 1500);

    const full = (await handler({ workspaceId: "ws2", fileName: "doc.md", mode: "full" }, ctx)) as Record<string, unknown>;
    assert.equal(full.mode, "full");
    assert.equal(full.content, body, "mode=full 应无损返回全文");
  });
});

describe("code.workspace_map（WP3）", () => {
  test("多文件聚合结构概要，hint 指引定向读取", async () => {
    const { service } = makeService();
    await service.writeFile("actor1", "ws3", "data.csv", "id,city,temp\n" + Array.from({ length: 300 }, (_, i) => `A${i},上海,${i % 40}`).join("\n"));
    await service.writeFile("actor1", "ws3", "report.md", ["# 周报", "## 结论", "结".repeat(300), "## 明细", "细".repeat(300)].join("\n"));
    await service.writeFile("actor1", "ws3", "tiny.txt", "很短");

    const { createWorkspaceMapHandler } = await import("../src/tools/capability-modules/code-sandbox/handlers.js");
    const handler = createWorkspaceMapHandler(service);
    const result = (await handler({ workspaceId: "ws3" }, { userId: "actor1", sessionId: "actor1" } as never)) as Record<string, unknown>;

    assert.equal(result.ok, true);
    assert.equal(result.fileCount, 3);
    const files = result.files as Array<Record<string, unknown>>;
    const csv = files.find((f) => f.path === "data.csv")!;
    assert.equal(csv.kind, "csv");
    assert.match(String(csv.outline), /表头/);
    const md = files.find((f) => f.path === "report.md")!;
    assert.equal(md.kind, "markdown");
    assert.match(String(md.outline), /结论/);
    assert.match(String(result.hint), /mode="range"/);
  });
});

describe("schema 与注册", () => {
  test("workspace_map 已注册进 ToolRegistry；read_file schema 含 mode/range 参数", async () => {
    const { ToolRegistry } = await import("../src/tools/tool-registry.js");
    const { registerCodeSandboxTools } = await import("../src/tools/capability-modules/code-sandbox/handlers.js");
    const { service } = makeService();
    const registry = new ToolRegistry();
    registerCodeSandboxTools(registry, { codeSandboxService: service });
    assert.ok(registry.list().includes("code.workspace_map"), "workspace_map 应注册");

    const { CODE_SANDBOX_CHAT_TOOLS } = await import("../src/tools/capability-modules/code-sandbox/chat-tools.js");
    const readSchema = CODE_SANDBOX_CHAT_TOOLS.find((t) => t.function.name === "code.read_file");
    assert.ok(readSchema);
    assert.ok("mode" in (readSchema.function.parameters as { properties: Record<string, unknown> }).properties);
    const mapSchema = CODE_SANDBOX_CHAT_TOOLS.find((t) => t.function.name === "code.workspace_map");
    assert.ok(mapSchema, "workspace_map schema 应存在");
  });
});
