/**
 * 自我编程工具集 - 赋予 Agent 自主创建、更新、升级自身的能力
 * 
 * 核心功能：
 * 1. create_skill: 根据需求描述自动创建新 Skill
 * 2. update_skill: 更新现有 Skill 的实现或元数据
 * 3. delete_skill: 删除不再需要的 Skill
 * 4. analyze_capabilities: 分析当前能力缺口，提出改进建议
 * 5. generate_tool_code: 根据需求生成工具代码
 * 
 * 使用示例：
 * 
 * **示例 1：手动创建技能**
 * ```
 * 用户：我需要一個能把华氏度转换成摄氏度的工具
 * 
 * Agent 调用 self.create_skill:
 * {
 *   "skillName": "temperature.convert",
 *   "displayName": "温度转换器",
 *   "description": "在华氏度和摄氏度之间转换温度",
 *   "handlerCode": "const f = input.fahrenheit; const c = (f - 32) * 5/9; return { fahrenheit: f, celsius: c };",
 *   "parameters": [
 *     { "name": "fahrenheit", "type": "number", "required": true, "description": "华氏度" }
 *   ]
 * }
 * ```
 * 
 * **示例 2：智能生成技能**
 * ```
 * 用户：我想让 Agent 能帮我计算房贷月供
 * 
 * Agent 调用 self.generate_skill:
 * {
 *   "description": "计算等额本息房贷的月供金额",
 *   "useCase": "用户输入贷款金额、年利率、贷款年限，返回月供",
 *   "expectedInput": "{ loanAmount: 1000000, annualRate: 0.049, years: 30 }",
 *   "expectedOutput": "{ monthlyPayment: 5307.27, totalInterest: 910616.2 }"
 * }
 * 
 * Agent 收到生成的代码后，调用 self.create_skill 提交
 * ```
 * 
 * **示例 3：检测能力缺口**
 * ```
 * 用户：能帮我分析一下这张图片里的内容吗？
 * 
 * Agent 调用 self.detect_skill_need:
 * {
 *   "userRequest": "能帮我分析一下这张图片里的内容吗？"
 * }
 * 
 * 返回：{
 *   "needNewSkill": true,
 *   "reason": "用户请求涉及图像处理",
 *   "suggestedSkillName": "image.analyzer"
 * }
 * 
 * Agent 然后可以调用 self.generate_skill 来创建图像分析技能
 * ```
 * 
 * **示例 4：自我学习和改进**
 * ```
 * Agent 在每次交互后调用 self.record_interaction:
 * {
 *   "userRequest": "查询明天的天气",
 *   "attemptedTools": ["weather.get_local"],
 *   "success": true,
 *   "responseTime": 1200
 * }
 * 
 * 定期调用 self.analyze_improvements 获取改进建议
 * ```
 */

import { getDataDir } from "../config/data-dir.js";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { SkillManager } from "../skills/index.js";
import type { SkillDefinition, SkillMetadata, SkillParameter } from "../skills/types.js";
import { SkillValidator } from "../skills/skill-validator.js";
import { invalidateFullCatalogCache } from "../gateway/index.js";

/**
 * 注册自我编程工具
 */
export function registerSelfProgrammingTools(
  registry: ToolRegistry,
  skillManager?: SkillManager | null,
): void {
  // ========== 1. 创建新技能 ==========
  registry.register("self.create_skill", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const skillName = String(input.skillName ?? "").trim();
      const displayName = String(input.displayName ?? "").trim();
      const description = String(input.description ?? "").trim();
      const handlerCode = String(input.handlerCode ?? "").trim();
      const parameters = input.parameters as SkillParameter[] || [];
      const permissions = (input.permissions as string[]) || [];
      const tags = (input.tags as string[]) || ["self-created"];
      
      // 验证必填字段
      if (!skillName || !displayName || !description || !handlerCode) {
        return {
          ok: false,
          error: "缺少必填字段：skillName, displayName, description, handlerCode",
        };
      }
      
      // 验证技能名称格式
      if (!/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/.test(skillName)) {
        return {
          ok: false,
          error: "技能名称必须符合 'namespace.action' 格式，如 'my_tool.calculate'",
        };
      }
      
      // 检查是否已存在同名技能
      if (skillManager && skillManager.get(skillName)) {
        return {
          ok: false,
          error: `技能已存在：${skillName}，请使用 self.update_skill 更新`,
        };
      }
      
      // 构建技能元数据
      const metadata: SkillMetadata = {
        name: skillName,
        version: "1.0.0",
        displayName,
        description,
        kind: "community",
        author: actorId,
        tags,
        parameters,
        permissions: permissions as any[],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      // 验证元数据
      const validationErrors = SkillValidator.validateMetadata(metadata);
      if (validationErrors.length > 0) {
        return {
          ok: false,
          error: "元数据验证失败",
          details: validationErrors,
        };
      }
      
      // 保存技能文件
      const skillDir = join(getDataDir(), "community-skills", skillName);
      await mkdir(skillDir, { recursive: true });
      
      // 写入 skill.json
      const jsonPath = join(skillDir, "skill.json");
      await writeFile(jsonPath, JSON.stringify(metadata, null, 2), "utf8");
      
      // 写入 handler 代码
      const handlerPath = join(skillDir, "skill.handler.js");
      const wrappedCode = wrapHandlerCode(handlerCode);
      await writeFile(handlerPath, wrappedCode, "utf8");
      
      // 如果 SkillManager 可用，立即加载
      if (skillManager && skillManager.loadFromFile) {
        try {
          await skillManager.loadFromFile(jsonPath, { autoEnable: true });
          // 新 skill 注册后立即失效 tool-search BM25 全量索引缓存，
          // 让 LLM 下一轮调用 tool_discover 时能搜到新 skill
          invalidateFullCatalogCache();
        } catch (loadError) {
          console.error(`[self.create_skill] 加载技能失败:`, loadError);
          return {
            ok: false,
            error: "技能文件创建成功，但加载失败",
            details: loadError instanceof Error ? loadError.message : String(loadError),
          };
        }
      }

      return {
        ok: true,
        skillId: skillName,
        message: `技能创建成功：${displayName}`,
        skillPath: skillDir,
        metadata,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `创建技能失败：${msg}` };
    }
  });
  
  // ========== 2. 更新现有技能 ==========
  registry.register("self.update_skill", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const skillName = String(input.skillName ?? "").trim();
      const handlerCode = input.handlerCode ? String(input.handlerCode).trim() : undefined;
      const metadataUpdates = input.metadataUpdates as Partial<SkillMetadata> | undefined;
      
      if (!skillName) {
        return { ok: false, error: "缺少必填字段：skillName" };
      }
      
      // 检查技能是否存在
      if (!skillManager) {
        return { ok: false, error: "SkillManager 未初始化" };
      }
      
      const existingSkill = skillManager.get(skillName);
      if (!existingSkill) {
        return { ok: false, error: `技能不存在：${skillName}` };
      }
      
      const skillDir = join(getDataDir(), "community-skills", skillName);
      
      // 更新 handler 代码
      if (handlerCode) {
        const handlerPath = join(skillDir, "skill.handler.js");
        const wrappedCode = wrapHandlerCode(handlerCode);
        await writeFile(handlerPath, wrappedCode, "utf8");
      }
      
      // 更新元数据
      if (metadataUpdates) {
        const jsonPath = join(skillDir, "skill.json");
        const existingMetadata = JSON.parse(await readFile(jsonPath, "utf8"));
        const updatedMetadata = {
          ...existingMetadata,
          ...metadataUpdates,
          updatedAt: new Date().toISOString(),
        };
        await writeFile(jsonPath, JSON.stringify(updatedMetadata, null, 2), "utf8");
        
        // 重新加载技能
        if (skillManager.loadFromFile) {
          await skillManager.loadFromFile(jsonPath, { autoEnable: true });
          // skill 更新后失效 tool-search BM25 索引缓存
          invalidateFullCatalogCache();
        }
      }
      
      return {
        ok: true,
        skillId: skillName,
        message: `技能更新成功：${existingSkill.displayName}`,
        updatedFields: {
          handlerUpdated: !!handlerCode,
          metadataUpdated: !!metadataUpdates,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `更新技能失败：${msg}` };
    }
  });
  
  // ========== 3. 删除技能 ==========
  registry.register("self.delete_skill", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const skillName = String(input.skillName ?? "").trim();
      
      if (!skillName) {
        return { ok: false, error: "缺少必填字段：skillName" };
      }
      
      // 检查技能是否存在
      if (!skillManager) {
        return { ok: false, error: "SkillManager 未初始化" };
      }
      
      const existingSkill = skillManager.get(skillName);
      if (!existingSkill) {
        return { ok: false, error: `技能不存在：${skillName}` };
      }
      
      // 只允许删除社区技能（自己创建的）
      if (existingSkill.kind !== "community") {
        return {
          ok: false,
          error: "只能删除社区技能，不能删除内置技能",
        };
      }
      
      const skillDir = join(getDataDir(), "community-skills", skillName);
      
      // 卸载技能
      skillManager.uninstall(skillName);
      // skill 删除后失效 tool-search BM25 索引缓存
      invalidateFullCatalogCache();

      // 删除文件
      await rm(skillDir, { recursive: true, force: true });
      
      return {
        ok: true,
        skillId: skillName,
        message: `技能已删除：${existingSkill.displayName}`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `删除技能失败：${msg}` };
    }
  });
  
  // ========== 4. 分析能力缺口 ==========
  registry.register("self.analyze_capabilities", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const userRequest = String(input.userRequest ?? "").trim();
      
      if (!userRequest) {
        return {
          ok: false,
          error: "请提供用户需求描述，以便分析需要哪些能力",
        };
      }
      
      // 获取当前所有可用工具和技能
      const availableTools = registry.list();
      const availableSkills = skillManager ? skillManager.list(true) : [];
      
      // 分析用户需求（这里使用简单的关键词匹配，实际应该调用 LLM）
      const analysis = analyzeCapabilityGap(userRequest, availableTools, availableSkills);
      
      return {
        ok: true,
        analysis,
        suggestions: analysis.suggestions,
        missingCapabilities: analysis.missingCapabilities,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `能力分析失败：${msg}` };
    }
  });
  
  // ========== 5. 生成工具代码模板 ==========
  registry.register("self.generate_tool_template", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const toolName = String(input.toolName ?? "").trim();
      const description = String(input.description ?? "").trim();
      const functionality = String(input.functionality ?? "").trim();
      
      if (!toolName || !description || !functionality) {
        return {
          ok: false,
          error: "缺少必填字段：toolName, description, functionality",
        };
      }
      
      // 生成代码模板
      const template = generateToolCodeTemplate(toolName, description, functionality);
      
      return {
        ok: true,
        toolName,
        template,
        instructions: [
          "1. 根据实际需求修改 handler 函数的实现逻辑",
          "2. 确保参数验证和错误处理完整",
          "3. 使用 self.create_skill 工具提交创建",
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `生成模板失败：${msg}` };
    }
  });
  
  // ========== 6. 列出所有自定义技能 ==========
  registry.register("self.list_custom_skills", async (_input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      if (!skillManager) {
        return { ok: false, error: "SkillManager 未初始化" };
      }
      
      const allSkills = skillManager.list(true);
      const customSkills = allSkills.filter(
        (skill) => skill.kind === "community" && skill.author === actorId,
      );
      
      return {
        ok: true,
        customSkills: customSkills.map((skill) => ({
          name: skill.name,
          displayName: skill.displayName,
          description: skill.description,
          version: skill.version,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
        })),
        totalCount: customSkills.length,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `获取技能列表失败：${msg}` };
    }
  });
}

/**
 * 包装 handler 代码为标准格式
 */
function wrapHandlerCode(code: string): string {
  const trimmed = code.trim();
  
  // 如果已经是 export 格式，直接返回
  if (trimmed.startsWith("export ")) {
    return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  }
  
  // 否则包装成默认导出函数
  return `export default async function (input, context) {\n${code}\n}\n`;
}

/**
 * 分析能力缺口
 */
function analyzeCapabilityGap(
  userRequest: string,
  availableTools: string[],
  availableSkills: Array<{ name: string; description: string }>,
): {
  missingCapabilities: string[];
  suggestions: Array<{
    skillName: string;
    displayName: string;
    description: string;
    parameters: SkillParameter[];
    reason: string;
  }>;
} {
  const missingCapabilities: string[] = [];
  const suggestions: Array<{
    skillName: string;
    displayName: string;
    description: string;
    parameters: SkillParameter[];
    reason: string;
  }> = [];
  
  // 简单的关键词匹配示例（实际应使用 LLM 进行智能分析）
  const requestLower = userRequest.toLowerCase();
  
  // 示例：检测是否需要图像处理能力
  if (requestLower.includes("图片") || requestLower.includes("图像") || requestLower.includes("photo")) {
    if (!availableTools.some((t) => t.includes("image") || t.includes("vision"))) {
      missingCapabilities.push("图像处理能力");
      suggestions.push({
        skillName: "image.process",
        displayName: "图像处理器",
        description: "处理和分析图像内容",
        parameters: [
          { name: "imageUrl", type: "string", required: true, description: "图片 URL" },
          { name: "operation", type: "string", required: true, description: "操作类型" },
        ],
        reason: "用户需求涉及图像处理，但当前系统缺少相关能力",
      });
    }
  }
  
  // 示例：检测是否需要数据分析能力
  if (requestLower.includes("分析") || requestLower.includes("统计") || requestLower.includes("数据")) {
    if (!availableTools.some((t) => t.includes("analytics") || t.includes("statistics"))) {
      missingCapabilities.push("数据分析能力");
      suggestions.push({
        skillName: "data.analytics",
        displayName: "数据分析器",
        description: "对数据进行统计分析和可视化",
        parameters: [
          { name: "dataSource", type: "string", required: true, description: "数据源" },
          { name: "analysisType", type: "string", required: true, description: "分析类型" },
        ],
        reason: "用户需求涉及数据分析，建议创建专门的分析工具",
      });
    }
  }
  
  // 如果没有检测到缺失，给出通用建议
  if (suggestions.length === 0) {
    suggestions.push({
      skillName: "custom.helper",
      displayName: "自定义助手",
      description: "根据用户需求定制的辅助工具",
      parameters: [
        { name: "task", type: "string", required: true, description: "任务描述" },
      ],
      reason: "建议根据具体需求创建定制化工具",
    });
  }
  
  return {
    missingCapabilities,
    suggestions,
  };
}

/**
 * 生成工具代码模板
 */
function generateToolCodeTemplate(
  toolName: string,
  description: string,
  functionality: string,
): string {
  return `/**
 * ${description}
 * 功能：${functionality}
 */

// 输入参数验证
if (!input || typeof input !== 'object') {
  throw new Error('输入必须是对象');
}

// TODO: 在这里实现具体的业务逻辑
// 可以使用 context 访问会话信息、权限等

const result = {
  success: true,
  message: '${toolName} 执行成功',
  data: {}, // 返回结果数据
};

return result;
`;
}
