/**
 * 智能技能生成器 - 基于 LLM 自动生成 Skill 代码
 * 
 * 功能：
 * 1. 根据自然语言描述生成完整的 Skill 定义和实现代码
 * 2. 自动推断参数、权限、标签等元数据
 * 3. 生成符合规范的 handler 代码
 */

import type { ExternalChatProvider } from "../external-model/types.js";
import type { SkillDefinition, SkillMetadata, SkillParameter } from "../skills/types.js";

export interface SkillGenerationRequest {
  description: string;        // 技能功能描述（自然语言）
  useCase?: string;          // 使用场景示例
  expectedInput?: string;    // 期望的输入格式
  expectedOutput?: string;   // 期望的输出格式
}

export interface SkillGenerationResult {
  ok: boolean;
  skill?: {
    metadata: SkillMetadata;
    handlerCode: string;
    explanation: string;
  };
  error?: string;
  suggestions?: string[];
}

/**
 * procedural 技能（过程式文档）生成请求。
 *
 * 由「任务完成即时反思」触发：复杂任务成功后，把任务轨迹交给 LLM，
 * 提炼成可复用的 SKILL.md 文档（经验沉淀）。
 */
export interface ProceduralSkillGenerationRequest {
  /** 用户原始请求 */
  userRequest: string;
  /** 工具调用次数（≥5 才值得沉淀） */
  toolCallCount: number;
  /** 工具调用序列摘要（如 "search_web(ok), desktop.uia_query(ok), ..."） */
  toolCallsSummary: string;
  /** Agent 最终回复 */
  assistantReply: string;
  /** 建议的技能名（可选，LLM 可自行命名） */
  suggestedName?: string;
}

export interface ProceduralSkillGenerationResult {
  ok: boolean;
  skill?: {
    /** 技能名（namespace.action 格式） */
    name: string;
    /** 一句话描述（≤60 字符，召回命门） */
    description: string;
    /** SKILL.md 全文（Markdown） */
    doc: string;
    /** 分类标签（第一个作为存储 category） */
    tags: string[];
  };
  error?: string;
}

/**
 * 智能技能生成服务
 */
export class SkillGenerator {
  constructor(private readonly chatProvider: ExternalChatProvider | null) {}

  /**
   * 根据描述生成技能
   */
  async generateSkill(request: SkillGenerationRequest): Promise<SkillGenerationResult> {
    if (!this.chatProvider || !this.chatProvider.isEnabled()) {
      return {
        ok: false,
        error: "需要配置外部聊天提供商才能使用智能生成功能",
        suggestions: [
          "请配置 OPENAI_API_KEY 或其他聊天提供商",
          "或者手动编写技能代码并放入技能目录",
        ],
      };
    }

    try {
      // 构建提示词
      const prompt = this.buildGenerationPrompt(request);

      // 调用 LLM 生成代码：
      //  - systemPromptOverride：明确告知 LLM 任务是严格输出 JSON（非聊天）
      //  - ephemeralTurn：避免污染会话历史
      //  - 每次唯一 sessionId：避免跨次调用上下文串扰
      const systemPrompt =
        "你是 Skill 代码生成器。你的唯一任务是严格按照用户描述的 JSON 格式输出技能代码。\n" +
        "禁止任何对话式回复（如\"好的\"、\"稍等\"、\"我来帮你\"等）。\n" +
        "直接输出 JSON，第一个字符必须是 `{`，最后一个字符必须是 `}`。\n" +
        "不要在 JSON 外添加任何文字、解释、代码块包裹（```json 也不要）。\n" +
        "handlerCode 字段必须是字符串形式（字符串内可以包含换行符 \\n）。";
      let fullContent = "";
      await this.chatProvider.streamCompletion(
        `skill-generator-${Date.now()}`,
        { text: prompt },
        (delta) => {
          fullContent += delta;
        },
        undefined,
        {
          systemPromptOverride: systemPrompt,
          ephemeralTurn: true,
          maxThreadMessages: 2,
        },
      );

      // 解析生成的代码
      const parsed = this.parseGeneratedCode(fullContent);
      
      if (!parsed) {
        return {
          ok: false,
          error: "无法解析生成的代码，请重试或手动编写",
          suggestions: [
            "尝试更详细地描述技能功能",
            "提供具体的输入输出示例",
          ],
        };
      }

      return {
        ok: true,
        skill: parsed,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `生成失败：${msg}`,
        suggestions: ["检查网络连接和 API 配置", "简化需求描述后重试"],
      };
    }
  }

  /**
   * 获取系统提示词
   */
  private getSystemPrompt(): string {
    return `你是一个专业的 TypeScript 开发者，专门为用户创建 AI Agent 的技能（Skill）。

你的任务是：
1. 根据用户的需求描述，设计合理的技能接口
2. 生成符合规范的 Skill 元数据（metadata）
3. 编写安全、高效的 handler 代码

**重要规范：**
- 技能名称必须是 \`namespace.action\` 格式，如 \`image.resize\`、\`data.analyze\`
- 必须包含完整的参数验证和错误处理
- 代码必须使用 ES Module 格式（export default）
- 不要访问文件系统或执行危险操作
- 优先使用 input 参数和 context 中的信息

**输出格式：**
你必须严格按照以下 JSON 格式输出：

\`\`\`json
{
  "metadata": {
    "name": "namespace.action",
    "version": "1.0.0",
    "displayName": "显示名称",
    "description": "详细描述",
    "parameters": [
      {
        "name": "paramName",
        "type": "string|number|boolean|object|array",
        "required": true,
        "description": "参数说明"
      }
    ],
    "permissions": [],
    "tags": ["tag1", "tag2"]
  },
  "handlerCode": "async function (input, context) { ... }",
  "explanation": "对生成代码的简要说明"
}
\`\`\`

确保输出的 JSON 是完整且有效的。`;
  }

  /**
   * 构建生成提示词
   */
  private buildGenerationPrompt(request: SkillGenerationRequest): string {
    let prompt = `请为我创建一个 AI Agent 技能。\n\n`;
    
    prompt += `**功能描述：**\n${request.description}\n\n`;
    
    if (request.useCase) {
      prompt += `**使用场景：**\n${request.useCase}\n\n`;
    }
    
    if (request.expectedInput) {
      prompt += `**期望输入：**\n${request.expectedInput}\n\n`;
    }
    
    if (request.expectedOutput) {
      prompt += `**期望输出：**\n${request.expectedOutput}\n\n`;
    }
    
    prompt += `请生成完整的技能定义和实现代码。确保代码安全、健壮且易于理解。`;
    
    return prompt;
  }

  /**
   * 解析生成的代码
   *
   * 多重 fallback 策略：
   *  1. 优先匹配 ```json ... ``` 代码块（标准格式）
   *  2. 若无，匹配任意 ``` ... ``` 代码块
   *  3. 若无，直接匹配最外层 { ... } JSON 对象（LLM 未用代码块包裹时）
   *
   * 容错两种结构：
   *  - 标准：{ metadata: { name, description, ... }, handlerCode, explanation }
   *  - 简化：{ name, description, handlerCode, ... } → 自动包装为 metadata
   */
  private parseGeneratedCode(content: string): SkillGenerationResult["skill"] | null {
    const tryParse = (jsonStr: string): SkillGenerationResult["skill"] | null => {
      try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== "object") return null;

        // 兼容两种结构：标准（含 metadata）+ 简化（直接含 name/description/handlerCode）
        const hasStandard = parsed.metadata && parsed.handlerCode;
        const hasSimplified = !hasStandard && parsed.name && parsed.handlerCode;
        if (!hasStandard && !hasSimplified) return null;

        const meta = hasStandard ? parsed.metadata : parsed;
        const metadata: SkillMetadata = {
          name: meta.name,
          version: meta.version || "1.0.0",
          displayName: meta.displayName ?? meta.name,
          description: meta.description ?? "",
          kind: "community",
          parameters: meta.parameters || [],
          permissions: meta.permissions || [],
          tags: meta.tags || ["auto-generated"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        return {
          metadata,
          handlerCode: parsed.handlerCode,
          explanation: parsed.explanation || "自动生成的技能代码",
        };
      } catch {
        return null;
      }
    };

    // 策略 1：```json ... ``` 代码块
    const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      const parsed = tryParse(jsonBlockMatch[1]);
      if (parsed) return parsed;
    }

    // 策略 2：任意 ``` ... ``` 代码块
    const anyBlockMatch = content.match(/```\s*([\s\S]*?)\s*```/);
    if (anyBlockMatch) {
      const parsed = tryParse(anyBlockMatch[1]);
      if (parsed) return parsed;
    }

    // 策略 3：直接匹配最外层 { ... } JSON 对象（贪婪到最外层闭合括号）
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const parsed = tryParse(objMatch[0]);
      if (parsed) return parsed;
    }

    console.error("[SkillGenerator] 解析失败：未找到有效的 JSON 结构");
    return null;
  }

  // ====================================================================
  // procedural 技能生成（经验沉淀）
  // ====================================================================

  /**
   * 从一次完成的复杂任务轨迹中提炼 procedural 技能文档（SKILL.md）。
   *
   * 参考 Skill Review 思路：任务完成后把踩坑经验/非平凡流程提炼成
   * 可复用文档。LLM 自行判断是否值得沉淀（shouldSave=false 时跳过）。
   *
   * 触发条件（由调用方把关）：工具调用 ≥5 次、踩过坑、用户纠正过、非平凡流程。
   * 简单一次性任务不应调用本方法。
   */
  async generateProceduralSkill(
    request: ProceduralSkillGenerationRequest,
  ): Promise<ProceduralSkillGenerationResult> {
    if (!this.chatProvider || !this.chatProvider.isEnabled()) {
      return {
        ok: false,
        error: "需要配置外部聊天提供商才能生成 procedural 技能",
      };
    }

    try {
      const prompt = this.buildProceduralGenerationPrompt(request);
      const systemPrompt =
        "你是技能沉淀助手。任务：分析一次已完成的复杂任务轨迹，判断是否值得沉淀为可复用技能文档（SKILL.md），" +
        "若值得则生成，不值得则返回 shouldSave=false。\n" +
        "严格输出 JSON，第一个字符必须是 `{`，最后一个字符必须是 `}`，不要任何对话式回复或代码块包裹。\n" +
        "doc 字段是 Markdown 字符串，包含四个章节：## When to Use / ## Procedure / ## Pitfalls / ## Verification。";

      let fullContent = "";
      await this.chatProvider.streamCompletion(
        `skill-distill-${Date.now()}`,
        { text: prompt },
        (delta) => {
          fullContent += delta;
        },
        undefined,
        {
          systemPromptOverride: systemPrompt,
          ephemeralTurn: true,
          maxThreadMessages: 2,
        },
      );

      const parsed = this.parseProceduralResult(fullContent);
      if (!parsed) {
        return { ok: false, error: "无法解析 LLM 输出的 procedural 技能" };
      }
      if (parsed.shouldSave === false) {
        return { ok: false, error: "LLM 判定本次任务不值得沉淀（shouldSave=false）" };
      }
      return { ok: true, skill: parsed.skill };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `procedural 技能生成失败：${msg}` };
    }
  }

  /** 构建 procedural 技能生成的提示词 */
  private buildProceduralGenerationPrompt(request: ProceduralSkillGenerationRequest): string {
    const replyPreview = request.assistantReply.replace(/\s+/g, " ").slice(0, 600);
    return `请分析以下已完成的复杂任务轨迹，判断是否值得沉淀为可复用技能文档。

**用户请求：**
${request.userRequest}

**工具调用次数：** ${request.toolCallCount}

**工具调用序列：**
${request.toolCallsSummary}

**Agent 最终回复（节选）：**
${replyPreview}

**沉淀判断标准：**
- 工具调用 ≥5 次、踩过坑、用户纠正过、发现非平凡流程 → 值得沉淀
- 简单问答、一次性任务 → 不值得（返回 shouldSave=false）

**若值得沉淀，输出 JSON：**
{
  "shouldSave": true,
  "skill": {
    "name": "namespace.action（如 devops.deploy_k8s，全小写+下划线）",
    "description": "一句话功能描述，≤60 字符（这是召回命门，必须精准）",
    "tags": ["category", "other-tag"],
    "doc": "SKILL.md 全文（Markdown 字符串），必须包含四个章节：\\n## When to Use\\n触发条件\\n\\n## Procedure\\n1. 步骤一\\n2. 步骤二\\n\\n## Pitfalls\\n- 已知坑与修复\\n\\n## Verification\\n如何确认成功"
  }
}

**若不值得沉淀，输出：**
{ "shouldSave": false }

注意：doc 字段内的换行用 \\n 表示，章节标题用 ## 二级标题。`;
  }

  /** 解析 procedural 技能生成结果 */
  private parseProceduralResult(
    content: string,
  ): { shouldSave: boolean; skill?: ProceduralSkillGenerationResult["skill"] } | null {
    const tryParse = (jsonStr: string) => {
      try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== "object") return null;
        if (parsed.shouldSave === false) {
          return { shouldSave: false };
        }
        const skill = parsed.skill;
        if (!skill || !skill.name || !skill.description || !skill.doc) return null;
        if (typeof skill.description !== "string" || skill.description.length > 60) return null;
        return {
          shouldSave: true,
          skill: {
            name: String(skill.name),
            description: String(skill.description),
            doc: String(skill.doc),
            tags: Array.isArray(skill.tags) ? skill.tags.map(String) : ["distilled"],
          },
        };
      } catch {
        return null;
      }
    };

    // 策略 1：```json ... ``` 代码块
    const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      const r = tryParse(jsonBlockMatch[1]);
      if (r) return r;
    }
    // 策略 2：任意 ``` ... ``` 代码块
    const anyBlockMatch = content.match(/```\s*([\s\S]*?)\s*```/);
    if (anyBlockMatch) {
      const r = tryParse(anyBlockMatch[1]);
      if (r) return r;
    }
    // 策略 3：直接匹配最外层 { ... }
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) {
      const r = tryParse(objMatch[0]);
      if (r) return r;
    }
    return null;
  }
}
