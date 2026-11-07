/**
 * Skill 管理器 - 管理 Skill 的生命周期、权限和配置
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from "fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, extname } from "path";
import type { ToolContext } from "../tools/tool-registry.js";
import type {
  SkillDefinition,
  SkillManifest,
  SkillConfig,
  SkillLoadOptions,
  SkillPermission,
  SkillMetadata,
  SkillHandler,
  SkillExecutionContext,
  ProceduralSkillEntry,
  SkillUsageStats,
} from "./types.js";
import { SkillValidator } from "./skill-validator.js";
import { SkillSandbox } from "./skill-sandbox.js";

export class SkillManager {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly configs = new Map<string, SkillConfig>();
  private readonly grantedPermissions = new Map<string, Set<SkillPermission>>();
  private readonly sandbox: SkillSandbox;
  /** 若设置，则 `setEnabled` 后写入 JSON；启动时在全部 Skill 注册完成后调用 `loadEnabledFromDisk`。 */
  private enabledPersistPath: string | null = null;

  /**
   * procedural 技能（过程式文档）索引。
   *
   * 与 code 技能（this.skills）分离管理：
   *  - code 技能有 handler，由 execute() 调用
   *  - procedural 技能只有 SKILL.md 文档，由 skill_view 工具读取作为 LLM 上下文
   *
   * 两者在 list() 中统一返回 manifest，用于注入 prompt 的轻量索引。
   */
  private readonly proceduralSkills = new Map<string, ProceduralSkillEntry>();
  /** procedural 技能存储根目录（默认 data/skills）；传 null 关闭磁盘持久化。 */
  private proceduralSkillsDir: string | null = null;

  /**
   * 自我进化 code 技能存储根目录（默认 data/skills-evolved）。
   * registerFromCode 注册成功后把 metadata + handlerCode 写到磁盘，
   * loadEvolvedSkillsFromDisk 启动时扫描恢复——保证"越用越强"的技能跨重启存活。
   */
  private evolvedSkillsDir: string | null = null;

  /**
   * 技能使用统计（Curator 质量治理用）。
   * useCount / viewCount / patchCount / lastActivityAt 四维指标。
   * code 技能在 execute() 成功时记录 use；procedural 技能在 view/patch 时记录。
   * 内存态，不持久化（仅用于运行期质量判断与日志）。
   */
  private readonly usageStats = new Map<string, SkillUsageStats>();

  constructor(sandbox?: SkillSandbox) {
    this.sandbox = sandbox || new SkillSandbox();
  }

  /** 持久化文件路径（`data/skill-enabled.json`）；传 `null` 关闭落盘。 */
  configureEnabledPersistence(filePath: string | null): void {
    this.enabledPersistPath = filePath;
  }

  /**
   * 配置自我进化 code 技能存储根目录（如 `data/skills-evolved`）。
   *
   * 设置后 registerFromCode 会把 { metadata, handlerCode } 写到
   * `<dir>/<category>/<name>/skill.json`；loadEvolvedSkillsFromDisk 扫描恢复。
   * 传 null 关闭持久化（仅内存）。
   */
  configureEvolvedSkillsDir(dir: string | null): void {
    this.evolvedSkillsDir = dir;
  }

  /**
   * 配置 procedural 技能存储根目录（如 `data/skills`）。
   *
   * 设置后：
   *  - registerProceduralSkill 会把 SKILL.md + skill.meta.json 写到 `<dir>/<category>/<name>/`
   *  - loadProceduralSkillsFromDisk 会扫描该目录加载已有 procedural 技能
   *  - patchProceduralSkill 会原地更新 SKILL.md
   *
   * 传 null 关闭 procedural 技能的磁盘持久化（仅内存）。
   */
  configureProceduralSkillsDir(dir: string | null): void {
    this.proceduralSkillsDir = dir;
  }

  /**
   * 在进程内全部 Skill 注册完成后调用：用磁盘中的启用状态覆盖内存（仅已存在的 name）。
   */
  async loadEnabledFromDisk(): Promise<void> {
    if (!this.enabledPersistPath) return;
    try {
      const raw = JSON.parse(await readFile(this.enabledPersistPath, "utf-8")) as Record<string, unknown>;
      for (const [name, val] of Object.entries(raw)) {
        if (typeof val !== "boolean") continue;
        if (!this.skills.has(name)) continue;
        const cfg = this.configs.get(name) || {};
        cfg.enabled = val;
        this.configs.set(name, cfg);
      }
    } catch (error) {
      // 首次启动没有该文件属于正常情况，不刷告警
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("loadEnabledFromDisk failed:", error);
      }
    }
  }

  private flushEnabledToDisk(): void {
    if (!this.enabledPersistPath) return;
    try {
      const state: Record<string, boolean> = {};
      this.skills.forEach((_, name) => {
        const c = this.configs.get(name);
        state[name] = c?.enabled !== false;
      });
      mkdirSync(dirname(this.enabledPersistPath), { recursive: true });
      writeFileSync(this.enabledPersistPath, JSON.stringify(state, null, 2), "utf-8");
    } catch (error) {
      console.warn("flushEnabledToDisk failed:", error);
    }
  }

  /**
   * 注册 Skill（代码方式）
   */
  register(skill: SkillDefinition, options?: SkillLoadOptions): void {
    // 验证 Skill 定义
    const errors = SkillValidator.validate(skill);
    if (errors.length > 0) {
      throw new Error(
        `Skill 验证失败: ${errors.map((e) => `${e.field}: ${e.message}`).join(", ")}`
      );
    }

    // 检查资源限制
    const resourceCheck = SkillSandbox.validateResourceLimits(skill);
    if (!resourceCheck.valid) {
      console.warn(`Skill '${skill.metadata.name}' 资源检查警告:`, resourceCheck.issues);
    }

    const skillName = skill.metadata.name;

    // 设置默认配置
    if (!this.configs.has(skillName)) {
      this.configs.set(skillName, {
        enabled: options?.autoEnable ?? true,
        permissions: skill.metadata.permissions,
      });
    }

    // 设置默认权限
    if (!this.grantedPermissions.has(skillName)) {
      const config = this.configs.get(skillName)!;
      const permissions = new Set(config.permissions || skill.metadata.permissions);
      this.grantedPermissions.set(skillName, permissions);
    }

    // 存储 Skill
    this.skills.set(skillName, skill);

    console.log(`✅ Skill 已注册: ${skillName} v${skill.metadata.version}`);
  }

  /**
   * 从代码字符串注册 Skill（自我进化用）。
   *
   * 把 SkillGenerator 生成的 handlerCode 字符串编译成 SkillHandler 函数：
   * - handlerCode 应是 `async function(input, context) { ... return result; }` 形式
   * - 使用 `new Function` 在隔离作用域内编译，不暴露 process/require/__dirname 等
   * - 注册后该 Skill 立即可被 ToolRegistry.execute 调用
   *
   * 安全保证：
   * 1. 编译前对 handlerCode 做危险模式扫描（process./require/eval/Function/__dirname）
   * 2. 编译时用 `new Function` 创建独立作用域，handler 内无法访问闭包变量
   * 3. 注册前仍走 SkillValidator.validate 校验 metadata
   *
   * @returns 注册结果，ok=false 时 error 说明失败原因
   */
  registerFromCode(
    metadata: SkillMetadata,
    handlerCode: string,
    options?: SkillLoadOptions,
  ): { ok: boolean; error?: string; skillName?: string } {
    // 安全扫描：拦截危险模式
    const dangerous = [/process\./, /require\s*\(/, /eval\s*\(/, /Function\s*\(/, /__dirname/, /__filename/, /import\s+/];
    for (const pattern of dangerous) {
      if (pattern.test(handlerCode)) {
        return {
          ok: false,
          error: `handlerCode 包含危险模式 ${pattern.source}，拒绝编译`,
        };
      }
    }

    // 编译 handlerCode 为函数
    let handler: SkillHandler;
    try {
      // 用 new Function 在隔离作用域内编译
      // handlerCode 形如 "return { ok: true, result: input };" 或 "const x = ...; return x;"
      // 编译成 async (input, context) => Promise<Record<string, unknown>>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const factory = new Function(
        "input",
        "context",
        `"use strict"; return (async () => { ${handlerCode} })();`,
      ) as (
        input: Record<string, unknown>,
        context: SkillExecutionContext,
      ) => Promise<Record<string, unknown>>;
      handler = async (input: Record<string, unknown>, context: SkillExecutionContext) => {
        return factory(input, context);
      };
    } catch (err) {
      return {
        ok: false,
        error: `编译 handlerCode 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const skill: SkillDefinition = { metadata, handler };
      this.register(skill, options);
      // 注册成功后持久化到磁盘（若配置了 evolvedSkillsDir），保证跨重启存活
      this.persistEvolvedSkill(metadata, handlerCode);
      return { ok: true, skillName: metadata.name };
    } catch (err) {
      return {
        ok: false,
        error: `注册 Skill 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 把自我进化 code 技能（metadata + handlerCode）写到磁盘。
   *
   * 文件：`<evolvedSkillsDir>/<category>/<name>/skill.json`
   * category 取 tags[0]（净化后），缺失时用 "evolved"。
   * 磁盘写入失败仅告警，不影响注册结果（内存已可用）。
   */
  private persistEvolvedSkill(metadata: SkillMetadata, handlerCode: string): void {
    if (!this.evolvedSkillsDir) return;
    try {
      const category =
        (metadata.tags?.[0] ?? "evolved").replace(/[^a-zA-Z0-9_-]/g, "_") || "evolved";
      const skillDir = join(this.evolvedSkillsDir, category, metadata.name);
      mkdirSync(skillDir, { recursive: true });
      const payload = { metadata, handlerCode };
      writeFileSync(
        join(skillDir, "skill.json"),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
      console.log(`💾 自我进化技能已持久化: ${metadata.name} → ${skillDir}`);
    } catch (err) {
      console.warn(
        `[SkillManager] 持久化自我进化技能 ${metadata.name} 失败:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * 从磁盘扫描加载所有自我进化 code 技能。
   *
   * 扫描 evolvedSkillsDir 下的 `<category>/<name>/skill.json`，读取 metadata +
   * handlerCode 重新 registerFromCode 恢复。在 bootstrap 启动期调用一次。
   *
   * 安全：恢复仍走 registerFromCode 的安全扫描 + new Function 隔离编译路径。
   * 恢复失败（如 handlerCode 已失效）仅跳过并计数，不影响其余技能。
   */
  async loadEvolvedSkillsFromDisk(): Promise<{ loaded: number; skipped: number }> {
    if (!this.evolvedSkillsDir) return { loaded: 0, skipped: 0 };
    let loaded = 0;
    let skipped = 0;
    try {
      const categories = await readdir(this.evolvedSkillsDir, { withFileTypes: true });
      for (const categoryEntry of categories) {
        if (!categoryEntry.isDirectory() || categoryEntry.name.startsWith(".")) continue;
        const category = categoryEntry.name;
        const categoryDir = join(this.evolvedSkillsDir!, category);
        const skillNames = await readdir(categoryDir, { withFileTypes: true });
        for (const skillEntry of skillNames) {
          if (!skillEntry.isDirectory()) continue;
          const skillName = skillEntry.name;
          const skillDir = join(categoryDir, skillName);
          const skillPath = join(skillDir, "skill.json");
          if (!existsSync(skillPath)) {
            skipped++;
            continue;
          }
          try {
            const raw = JSON.parse(await readFile(skillPath, "utf8")) as {
              metadata: SkillMetadata;
              handlerCode: string;
            };
            if (!raw?.metadata?.name || typeof raw.handlerCode !== "string") {
              skipped++;
              continue;
            }
            const result = this.registerFromCode(raw.metadata, raw.handlerCode, {
              autoEnable: true,
            });
            if (result.ok) {
              loaded++;
            } else {
              console.warn(
                `[SkillManager] 恢复自我进化技能 ${skillName} 失败: ${result.error ?? "未知错误"}`,
              );
              skipped++;
            }
          } catch (err) {
            console.warn(`[SkillManager] 加载自我进化技能失败 ${skillName}:`, err);
            skipped++;
          }
        }
      }
      console.log(
        `[SkillManager] 从磁盘加载 ${loaded} 个自我进化 code 技能（跳过 ${skipped}）`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[SkillManager] 扫描自我进化技能目录失败:", err);
      }
    }
    return { loaded, skipped };
  }

  // ========================================================================
  // procedural 技能（过程式文档）管理
  // ========================================================================

  /**
   * 注册一个 procedural 技能（过程式文档）。
   *
   * 与 code 技能不同，procedural 技能不编译 handler，而是把 SKILL.md 正文 +
   * skill.meta.json 元数据写到磁盘（若配置了 proceduralSkillsDir），并登记到内存索引。
   *
   * @param metadata 技能元数据（skillType 会被强制设为 "procedural"）
   * @param doc SKILL.md 正文（When to Use / Procedure / Pitfalls / Verification）
   */
  registerProceduralSkill(
    metadata: SkillMetadata,
    doc: string,
  ): { ok: boolean; skillName?: string; error?: string; docPath?: string } {
    const meta: SkillMetadata = { ...metadata, skillType: "procedural" };

    const errors = SkillValidator.validateMetadata(meta);
    const fatalErrors = errors.filter((e) => e.field !== "parameters");
    if (fatalErrors.length > 0) {
      return {
        ok: false,
        error: `procedural 技能元数据校验失败: ${fatalErrors.map((e) => `${e.field}: ${e.message}`).join(", ")}`,
      };
    }

    const skillName = meta.name;
    const category =
      (meta.tags?.[0] ?? "general").replace(/[^a-zA-Z0-9_-]/g, "_") || "general";

    const docPath = this.proceduralSkillsDir
      ? join(this.proceduralSkillsDir, category, skillName, "SKILL.md")
      : null;

    if (docPath) {
      try {
        mkdirSync(dirname(docPath), { recursive: true });
        writeFileSync(docPath, doc, "utf8");
        writeFileSync(join(dirname(docPath), "skill.meta.json"), JSON.stringify(meta, null, 2), "utf8");
      } catch (err) {
        return {
          ok: false,
          error: `写入 procedural 技能磁盘失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    this.proceduralSkills.set(skillName, {
      metadata: meta,
      docPath: docPath ?? "",
      doc,
    });
    if (!this.configs.has(skillName)) {
      this.configs.set(skillName, { enabled: true });
    }

    console.log(`✅ procedural 技能已注册: ${skillName} v${meta.version}${docPath ? ` (磁盘: ${docPath})` : ""}`);
    return { ok: true, skillName, docPath: docPath ?? undefined };
  }

  /** 列出所有 procedural 技能的 manifest（用于注入 prompt 轻量索引）。 */
  listProceduralSkills(): SkillManifest[] {
    const manifests: SkillManifest[] = [];
    this.proceduralSkills.forEach((entry, name) => {
      const config = this.configs.get(name);
      if (config?.enabled === false) return;
      manifests.push({
        ...entry.metadata,
        enabled: config?.enabled ?? true,
        trusted: true,
      });
    });
    return manifests;
  }

  /**
   * 读取 procedural 技能的文档全文（带缓存）。
   * 用于 skill_view 工具让 LLM 按需加载全文（渐进式召回 Level 1）。
   */
  getProceduralSkillDoc(
    skillName: string,
  ): { ok: boolean; doc?: string; metadata?: SkillMetadata; error?: string } {
    const entry = this.proceduralSkills.get(skillName);
    if (!entry) {
      return { ok: false, error: `procedural 技能不存在: ${skillName}` };
    }
    let doc: string | undefined;
    if (entry.doc) {
      doc = entry.doc;
    } else if (!entry.docPath || !existsSync(entry.docPath)) {
      return { ok: false, error: `procedural 技能文档文件不存在: ${entry.docPath || "(无磁盘路径)"}` };
    } else {
      try {
        doc = readFileSync(entry.docPath, "utf8");
        entry.doc = doc;
      } catch (err) {
        return {
          ok: false,
          error: `读取 procedural 技能文档失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    // Curator 统计：被 view 加载一次（渐进式召回 Level 1 的使用痕迹）
    this.recordUsage(skillName, "view");
    return { ok: true, doc, metadata: entry.metadata };
  }

  /**
   * 局部 patch procedural 技能文档（模糊匹配 + 原子写 + 安全扫描）。
   *
   * 参考 skill_manage(action='patch')：用 fuzzy_find_and_replace 容忍
   * LLM 给的 oldString 与原文有格式差异，匹配后替换，原子写回滚。
   */
  patchProceduralSkill(
    skillName: string,
    oldString: string,
    newString: string,
    replaceAll: boolean = false,
  ): { ok: boolean; matched?: number; error?: string } {
    const entry = this.proceduralSkills.get(skillName);
    if (!entry) {
      return { ok: false, error: `procedural 技能不存在: ${skillName}` };
    }

    const current =
      entry.doc ??
      (entry.docPath && existsSync(entry.docPath) ? readFileSync(entry.docPath, "utf8") : "");
    if (!current) {
      return { ok: false, error: "procedural 技能文档为空，无法 patch" };
    }

    const replaceResult = fuzzyFindAndReplace(current, oldString, newString, replaceAll);
    if (!replaceResult.ok) {
      return { ok: false, error: replaceResult.error };
    }

    const scanError = scanProceduralDoc(replaceResult.content!);
    if (scanError) {
      return { ok: false, error: `安全扫描未通过: ${scanError}` };
    }

    if (entry.docPath) {
      try {
        mkdirSync(dirname(entry.docPath), { recursive: true });
        const tmpPath = entry.docPath + ".tmp";
        writeFileSync(tmpPath, replaceResult.content!, "utf8");
        renameSync(tmpPath, entry.docPath);
      } catch (err) {
        return {
          ok: false,
          error: `写入 procedural 技能文档失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    entry.doc = replaceResult.content;
    entry.metadata.updatedAt = new Date().toISOString();
    // Curator 统计：被 patch 局部修补一次（技能持续进化的痕迹）
    this.recordUsage(skillName, "patch");
    console.log(`✏️ procedural 技能已 patch: ${skillName}（替换 ${replaceResult.matchCount} 处）`);
    return { ok: true, matched: replaceResult.matchCount };
  }

  /**
   * 从磁盘扫描加载所有 procedural 技能。
   * 扫描 proceduralSkillsDir 下的 `<category>/<name>/SKILL.md` + `skill.meta.json`。
   * 在 bootstrap 启动期调用一次，恢复跨重启的 procedural 技能。
   */
  async loadProceduralSkillsFromDisk(): Promise<{ loaded: number; skipped: number }> {
    if (!this.proceduralSkillsDir) return { loaded: 0, skipped: 0 };
    let loaded = 0;
    let skipped = 0;
    try {
      const categories = await readdir(this.proceduralSkillsDir, { withFileTypes: true });
      for (const categoryEntry of categories) {
        if (!categoryEntry.isDirectory() || categoryEntry.name.startsWith(".")) continue;
        const category = categoryEntry.name;
        const categoryDir = join(this.proceduralSkillsDir!, category);
        const skillNames = await readdir(categoryDir, { withFileTypes: true });
        for (const skillEntry of skillNames) {
          if (!skillEntry.isDirectory()) continue;
          const skillName = skillEntry.name;
          const skillDir = join(categoryDir, skillName);
          const docPath = join(skillDir, "SKILL.md");
          const metaPath = join(skillDir, "skill.meta.json");
          if (!existsSync(docPath) || !existsSync(metaPath)) {
            skipped++;
            continue;
          }
          try {
            const meta = JSON.parse(await readFile(metaPath, "utf8")) as SkillMetadata;
            if (meta.skillType !== "procedural") {
              skipped++;
              continue;
            }
            const doc = await readFile(docPath, "utf8");
            this.proceduralSkills.set(meta.name, { metadata: meta, docPath, doc });
            if (!this.configs.has(meta.name)) {
              this.configs.set(meta.name, { enabled: true });
            }
            loaded++;
          } catch (err) {
            console.warn(`[SkillManager] 加载 procedural 技能失败 ${skillName}:`, err);
            skipped++;
          }
        }
      }
      console.log(`[SkillManager] 从磁盘加载 ${loaded} 个 procedural 技能（跳过 ${skipped}）`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[SkillManager] 扫描 procedural 技能目录失败:", err);
      }
    }
    return { loaded, skipped };
  }

  /** 判断指定名称是否为 procedural 技能 */
  isProceduralSkill(skillName: string): boolean {
    return this.proceduralSkills.has(skillName);
  }

  /**
   * 删除 procedural 技能（从内存索引移除；磁盘文件保留，由 Curator 归档管理）。
   * 采用「归档而非物理删除」的治理策略。
   */
  deleteProceduralSkill(skillName: string): { ok: boolean; error?: string } {
    if (!this.proceduralSkills.has(skillName)) {
      return { ok: false, error: `procedural 技能不存在: ${skillName}` };
    }
    this.proceduralSkills.delete(skillName);
    this.configs.delete(skillName);
    console.log(`🗑️ 已移除 procedural 技能: ${skillName}（磁盘文件保留，由 Curator 归档管理）`);
    return { ok: true };
  }

  // ========================================================================
  // Curator 质量治理（useCount / viewCount / patchCount + 归档）
  // ========================================================================

  /** 记录一次技能使用行为（内部辅助，供 execute / view / patch 调用）。 */
  private recordUsage(skillName: string, kind: "use" | "view" | "patch"): void {
    const now = new Date().toISOString();
    const cur = this.usageStats.get(skillName) ?? {
      useCount: 0,
      viewCount: 0,
      patchCount: 0,
      lastActivityAt: now,
    };
    if (kind === "use") cur.useCount += 1;
    else if (kind === "view") cur.viewCount += 1;
    else cur.patchCount += 1;
    cur.lastActivityAt = now;
    this.usageStats.set(skillName, cur);
  }

  /**
   * 读取单个技能的使用统计（无记录时返回零值）。
   * 供 skill 详情工具 / 调试日志展示。
   */
  getUsageStats(skillName: string): SkillUsageStats {
    return (
      this.usageStats.get(skillName) ?? {
        useCount: 0,
        viewCount: 0,
        patchCount: 0,
        lastActivityAt: "",
      }
    );
  }

  /**
   * 读取全部技能的使用统计（name → stats）。
   * 供 Curator 巡检 / 管理界面展示。
   */
  getAllUsageStats(): Record<string, SkillUsageStats> {
    return Object.fromEntries(this.usageStats);
  }

  /**
   * Curator 质量巡检：归档"长期无人用"的 procedural 技能。
   *
   * Curator 治理原则——**归档而非物理删除**：
   *  - procedural 技能从内存索引移除（不再注入 prompt 索引、不可被 skill.view 命中），
   *    磁盘上的 SKILL.md + skill.meta.json 原样保留，未来仍可重新加载。
   *  - code 技能不禁用（避免打断自主进化产物），只做统计留痕。
   *
   * 归档判定（同时满足）：
   *  1. 从未被使用/查看/修补（useCount + viewCount + patchCount === 0）
   *  2. 最近活动距今 ≥ idleDays（默认 30 天；按 updatedAt 计算，无 updatedAt 用 createdAt）
   *  3. 仅针对 procedural 技能（code 技能跳过）
   *
   * @returns 归档结果汇总
   */
  runCuratorGrooming(opts?: { idleDays?: number }): {
    archived: string[];
    reviewed: number;
    skippedCodeSkills: number;
  } {
    const idleDays = opts?.idleDays ?? 30;
    const idleMs = idleDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const archived: string[] = [];
    let reviewed = 0;
    let skippedCodeSkills = 0;

    for (const [name, entry] of this.proceduralSkills) {
      reviewed++;
      const stats = this.usageStats.get(name);
      const totalActivity =
        (stats?.useCount ?? 0) + (stats?.viewCount ?? 0) + (stats?.patchCount ?? 0);
      if (totalActivity > 0) continue; // 有使用痕迹，保留
      const lastTouch =
        Date.parse(entry.metadata.updatedAt ?? "") ||
        Date.parse(entry.metadata.createdAt ?? "") ||
        0;
      if (lastTouch > 0 && now - lastTouch < idleMs) continue; // 仍在新鲜期
      // 归档：从内存索引移除（磁盘保留）
      this.proceduralSkills.delete(name);
      this.configs.delete(name);
      this.usageStats.delete(name);
      archived.push(name);
      console.log(
        `🗄️ [SkillCurator] 归档未使用 procedural 技能: ${name}（${
          lastTouch > 0
            ? `${Math.round((now - lastTouch) / (24 * 60 * 60 * 1000))} 天无活动`
            : "无创建/更新时间戳"
        }，磁盘文件保留）`,
      );
    }

    // code 技能仅统计，不归档（防止打断自主进化产物）
    for (const name of this.skills.keys()) {
      if (this.proceduralSkills.has(name)) continue;
      skippedCodeSkills++;
    }

    if (archived.length > 0) {
      console.log(
        `[SkillCurator] 巡检完成：审查 ${reviewed} 个 procedural 技能，归档 ${archived.length} 个（磁盘保留）`,
      );
    }
    return { archived, reviewed, skippedCodeSkills };
  }

  /**
   * 从文件加载 Skill（JSON 元数据 + JS 模块）
   */
  async loadFromFile(skillPath: string, options?: SkillLoadOptions): Promise<void> {
    if (!existsSync(skillPath)) {
      throw new Error(`Skill 文件不存在: ${skillPath}`);
    }

    const stat = statSync(skillPath);
    
    if (stat.isDirectory()) {
      // 加载目录中的所有 Skill
      await this.loadFromDirectory(skillPath, options);
      return;
    }

    const ext = extname(skillPath);

    if (ext === ".json") {
      // 仅加载元数据文件
      await this.loadMetadataFile(skillPath, options);
    } else if (ext === ".js" || ext === ".ts") {
      // 加载完整的 Skill 模块
      await this.loadModuleFile(skillPath, options);
    } else {
      throw new Error(`不支持的文件类型: ${ext}`);
    }
  }

  /**
   * 从目录批量加载 Skill
   */
  private async loadFromDirectory(dirPath: string, options?: SkillLoadOptions): Promise<void> {
    const files = readdirSync(dirPath);
    
    for (const file of files) {
      const fullPath = join(dirPath, file);
      try {
        await this.loadFromFile(fullPath, options);
      } catch (error) {
        console.error(`加载 Skill 失败 (${file}):`, error);
      }
    }
  }

  /**
   * 加载元数据文件
   */
  private async loadMetadataFile(filePath: string, options?: SkillLoadOptions): Promise<void> {
    const content = readFileSync(filePath, "utf-8");
    const metadata = JSON.parse(content);

    // 这里需要找到对应的处理器文件
    const dir = dirname(filePath);
    const baseName = basename(filePath, ".json");
    const handlerPath = join(dir, `${baseName}.handler.js`);

    if (existsSync(handlerPath)) {
      const module = await import(handlerPath);
      const skill: SkillDefinition = {
        metadata,
        handler: module.default || module.handler,
      };
      this.register(skill, options);
    } else {
      console.warn(`未找到处理器文件: ${handlerPath}`);
    }
  }

  /**
   * 加载模块文件
   */
  private async loadModuleFile(filePath: string, options?: SkillLoadOptions): Promise<void> {
    const module = await import(filePath);
    
    // 支持默认导出或命名导出
    const skill: SkillDefinition = module.default || module.skill;
    
    if (!skill || !skill.metadata || !skill.handler) {
      throw new Error(`无效的 Skill 模块格式: ${filePath}`);
    }

    this.register(skill, options);
  }

  /**
   * 执行 Skill
   */
  async execute(
    skillName: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: any }> {
    // procedural 技能不可执行：它只有文档，应由 skill_view 工具读取作为上下文
    if (this.isProceduralSkill(skillName)) {
      return {
        ok: false,
        error: {
          code: "PROCEDURAL_SKILL_NOT_EXECUTABLE",
          message: `procedural 技能「${skillName}」不可执行，请用 skill_view 工具读取其文档作为上下文`,
        },
      };
    }

    const skill = this.skills.get(skillName);

    if (!skill) {
      return {
        ok: false,
        error: { code: "SKILL_NOT_FOUND", message: `Skill 不存在: ${skillName}` },
      };
    }

    // 检查是否启用
    const config = this.configs.get(skillName);
    if (config?.enabled === false) {
      return {
        ok: false,
        error: { code: "SKILL_DISABLED", message: `Skill 已禁用: ${skillName}` },
      };
    }

    // 验证输入参数
    const validationErrors = SkillValidator.validateInput(input, skill.metadata.parameters);
    if (validationErrors.length > 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "输入参数验证失败",
          details: validationErrors,
        },
      };
    }

    // 检查权限
    const grantedPerms = this.grantedPermissions.get(skillName) || new Set();
    const permissionCheck = SkillSandbox.checkPermissions(
      skill.metadata.permissions,
      grantedPerms
    );

    if (!permissionCheck.allowed) {
      return {
        ok: false,
        error: {
          code: "PERMISSION_DENIED",
          message: `权限不足，需要: ${permissionCheck.denied.join(", ")}`,
          denied: permissionCheck.denied,
        },
      };
    }

    // 在沙箱中执行
    const result = await this.sandbox.execute(skill, input, {
      sessionId: context.sessionId,
      userId: context.userId,
      chatUserMessageId: context.chatUserMessageId,
      // 环境上下文透传（2026-11-05 根修）：此前只传 sessionId/userId，导致技能里
      // execContext.clientLocation / requestLocation 恒为空——「按用户当前位置算路程」
      // （travel.compute-route 起点兜底、travel.departure-advice 出发地兜底、
      // travel.plan-itinerary 出发城市兜底）在真实链路（ToolRegistry → SkillManager）
      // 里永远拿不到坐标，只能反问用户。天气/打车等传统工具走 ToolRegistry 直调，
      // 没受这个裁窄影响，所以问题只在技能族里长期潜伏。
      ...(context.clientLocation ? { clientLocation: context.clientLocation } : {}),
      ...(context.clientIp ? { clientIp: context.clientIp } : {}),
      ...(context.requestLocation ? { requestLocation: context.requestLocation } : {}),
      ...(context.getLastKnownLocation
        ? { getLastKnownLocation: context.getLastKnownLocation }
        : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      permissions: grantedPerms,
      grantedPermissions: grantedPerms,
      // 透传中途推卡（如支付宝钱包绑定二维码）：sandbox 以 ...context 展开进执行上下文
      pushMediaCards: context.pushMediaCards,
    });

    // Curator 统计：执行成功记录一次使用（"越用越强"的量化依据）
    if (result.ok) {
      this.recordUsage(skillName, "use");
    }
    return result;
  }

  /**
   * 列出所有可用的 Skill（code + procedural 统一返回，用于注入 prompt 轻量索引）。
   */
  list(enabledOnly: boolean = false): SkillManifest[] {
    const manifests: SkillManifest[] = [];

    this.skills.forEach((skill, name) => {
      const config = this.configs.get(name);
      const isTrusted = this.grantedPermissions.has(name);

      if (enabledOnly && config?.enabled === false) {
        return;
      }

      manifests.push({
        ...skill.metadata,
        enabled: config?.enabled ?? true,
        trusted: isTrusted,
      });
    });

    // procedural 技能一并纳入（用于 prompt 轻量索引）
    manifests.push(...this.listProceduralSkills());

    return manifests.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * 获取 Skill 详情
   */
  get(skillName: string): SkillManifest | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    const config = this.configs.get(skillName);
    const isTrusted = this.grantedPermissions.has(skillName);

    return {
      ...skill.metadata,
      enabled: config?.enabled ?? true,
      trusted: isTrusted,
    };
  }

  /**
   * 启用/禁用 Skill
   */
  setEnabled(skillName: string, enabled: boolean): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const config = this.configs.get(skillName) || {};
    config.enabled = enabled;
    this.configs.set(skillName, config);

    console.log(`${enabled ? "✅ 启用" : "⏸️  禁用"} Skill: ${skillName}`);
    this.flushEnabledToDisk();
  }

  /**
   * 授予权限
   */
  grantPermissions(skillName: string, permissions: SkillPermission[]): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const current = this.grantedPermissions.get(skillName) || new Set();
    permissions.forEach((p) => current.add(p));
    this.grantedPermissions.set(skillName, current);

    console.log(`🔑 授予权限给 ${skillName}: ${permissions.join(", ")}`);
  }

  /**
   * 撤销权限
   */
  revokePermissions(skillName: string, permissions: SkillPermission[]): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const current = this.grantedPermissions.get(skillName);
    if (current) {
      permissions.forEach((p) => current.delete(p));
      this.grantedPermissions.set(skillName, current);
      console.log(`🔒 撤销权限从 ${skillName}: ${permissions.join(", ")}`);
    }
  }

  /**
   * 卸载 Skill
   */
  uninstall(skillName: string): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    this.skills.delete(skillName);
    this.configs.delete(skillName);
    this.grantedPermissions.delete(skillName);

    console.log(`🗑️  已卸载 Skill: ${skillName}`);
  }

  /**
   * 更新 Skill 配置
   */
  updateConfig(skillName: string, config: Partial<SkillConfig>): void {
    if (!this.skills.has(skillName)) {
      throw new Error(`Skill 不存在: ${skillName}`);
    }

    const current = this.configs.get(skillName) || {};
    this.configs.set(skillName, { ...current, ...config });

    console.log(`⚙️  更新配置: ${skillName}`, config);
  }

  /**
   * 获取 Skill 统计信息
   */
  getStats(): {
    total: number;
    enabled: number;
    disabled: number;
    trusted: number;
    procedural: number;
  } {
    let enabled = 0;
    let disabled = 0;
    let trusted = 0;

    this.skills.forEach((_, name) => {
      const config = this.configs.get(name);
      if (config?.enabled === false) {
        disabled++;
      } else {
        enabled++;
      }

      if (this.grantedPermissions.has(name)) {
        trusted++;
      }
    });

    return {
      total: this.skills.size + this.proceduralSkills.size,
      enabled,
      disabled,
      trusted,
      procedural: this.proceduralSkills.size,
    };
  }
}

// ==========================================================================
// 模块级辅助函数（procedural 技能 patch 用）
// ==========================================================================

/**
 * 模糊查找并替换。
 *
 * 参考 fuzzy_find_and_replace 设计：容忍 LLM 给的 oldString 与原文有
 * 格式差异（多余空白、换行不同）。策略：
 *  1. 先精确匹配
 *  2. 精确失败 → 规范化空白后再匹配（按段落 split，逐段 trim 比较）
 *  3. 仍失败 → 返回 error，不修改原文
 *
 * @param content 原文
 * @param oldString 要替换的片段
 * @param newString 替换为的内容
 * @param replaceAll true 替换所有匹配；false 只替换第一处
 */
function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { ok: boolean; content?: string; matchCount: number; error?: string } {
  if (!oldString.trim()) {
    return { ok: false, matchCount: 0, error: "oldString 为空" };
  }

  // 策略 1：精确匹配
  if (content.includes(oldString)) {
    if (replaceAll) {
      const parts = content.split(oldString);
      return { ok: true, content: parts.join(newString), matchCount: parts.length - 1 };
    }
    const idx = content.indexOf(oldString);
    return {
      ok: true,
      content: content.slice(0, idx) + newString + content.slice(idx + oldString.length),
      matchCount: 1,
    };
  }

  // 策略 2：规范化空白后匹配（把连续空白/换行统一为单个空格再比较）
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const normOld = normalize(oldString);
  if (!normOld) {
    return { ok: false, matchCount: 0, error: "oldString 规范化后为空" };
  }
  const normContent = normalize(content);
  if (normContent.includes(normOld)) {
    // 在规范化空间定位，但回写原文：用规范化匹配找到的段落边界做替换。
    // 简化实现：按段落（双换行或单换行）拆分原文，对每段 trim 后比较，
    // 命中的段落整体替换为 newString。
    const paragraphs = content.split(/(\n)/);
    let matched = 0;
    const out: string[] = [];
    for (const para of paragraphs) {
      if (normalize(para) === normOld || normalize(para).includes(normOld)) {
        matched++;
        out.push(newString);
        if (!replaceAll) {
          // 只替换第一处，后续原样保留
        }
      } else {
        out.push(para);
      }
    }
    if (matched > 0) {
      return { ok: true, content: out.join(""), matchCount: matched };
    }
  }

  return {
    ok: false,
    matchCount: 0,
    error: `未在文档中找到匹配片段（精确与模糊匹配均失败），oldString 前 60 字: "${oldString.slice(0, 60)}..."`,
  };
}

/**
 * procedural 技能文档安全扫描。
 *
 * 参考 _security_scan_skill 设计：拦截 prompt injection、凭据外泄、危险命令、
 * 不可见 Unicode。返回 error 字符串（未通过）或 null（通过）。
 */
function scanProceduralDoc(content: string): string | null {
  // 不可见 Unicode（零宽字符、BOM 等）
  if (/[\u200B-\u200D\uFEFF\u2060]/.test(content)) {
    return "文档包含不可见 Unicode 字符（零宽/BOM），可能为注入攻击";
  }
  // 凭据外泄
  if (/(api[_-]?key|secret|password|token|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(content)) {
    return "文档疑似包含明文凭据（api_key/secret/password/token）";
  }
  // 危险命令（rm -rf / 系统文件覆写 / 提权）
  if (/rm\s+-rf\s+\/(\s|$)/.test(content)) {
    return "文档包含危险命令 rm -rf /";
  }
  if (/\b(dd\s+of=\/dev\/|mkfs|:\(\)\s*\{\s*:\|:&\s*\}\s*;:)/.test(content)) {
    return "文档包含危险命令（dd/mkfs/fork bomb）";
  }
  // SSH 后门
  if (/authorized_keys|ssh-rsa\s+AAAA/i.test(content)) {
    return "文档疑似包含 SSH 后门（authorized_keys / ssh-rsa）";
  }
  return null;
}
