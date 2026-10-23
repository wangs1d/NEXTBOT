/**
 * 智能技能生成工具 - 将 SkillGenerator 集成到 ToolRegistry
 */

import { getDataDir } from "../config/data-dir.js";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { SkillManager } from "../skills/index.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import { SkillGenerator, type SkillGenerationRequest } from "../services/skill-generator.js";

/**
 * 注册智能技能生成工具
 */
export function registerAISkillGenerationTools(
  registry: ToolRegistry,
  chatProvider: ExternalChatProvider | null,
  skillManager?: SkillManager | null,
  existingGenerator?: SkillGenerator | null,
): void {
  const generator = existingGenerator ?? new SkillGenerator(chatProvider);

  // ========== 智能生成技能 ==========
  registry.register("self.generate_skill", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const description = String(input.description ?? "").trim();
      const useCase = input.useCase ? String(input.useCase).trim() : undefined;
      const expectedInput = input.expectedInput ? String(input.expectedInput).trim() : undefined;
      const expectedOutput = input.expectedOutput ? String(input.expectedOutput).trim() : undefined;
      
      if (!description) {
        return {
          ok: false,
          error: "请提供技能功能描述（description）",
        };
      }
      
      // 调用智能生成器
      const request: SkillGenerationRequest = {
        description,
        useCase,
        expectedInput,
        expectedOutput,
      };
      
      const result = await generator.generateSkill(request);
      
      if (!result.ok || !result.skill) {
        return {
          ok: false,
          error: result.error || "生成失败",
          suggestions: result.suggestions,
        };
      }
      
      // 如果 SkillManager 可用，尝试直接创建
      let created = false;
      let createError: string | undefined;
      
      if (skillManager) {
        try {
          // 这里可以自动创建，但为了安全起见，我们只返回生成的代码
          // 让用户确认后手动调用 self.create_skill
          created = false;
        } catch (err) {
          createError = err instanceof Error ? err.message : String(err);
        }
      }
      
      return {
        ok: true,
        generated: true,
        skill: {
          metadata: result.skill.metadata,
          handlerCode: result.skill.handlerCode,
          explanation: result.skill.explanation,
        },
        nextSteps: [
          "审查生成的代码是否符合预期",
          "使用 self.create_skill 工具提交创建",
          "或手动修改代码后提交",
        ],
        autoCreated: created,
        createError,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `智能生成失败：${msg}` };
    }
  });
  
  // ========== 根据示例生成技能 ==========
  registry.register("self.generate_from_example", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const example = String(input.example ?? "").trim();
      const description = String(input.description ?? "").trim();
      
      if (!example || !description) {
        return {
          ok: false,
          error: "需要提供示例代码（example）和功能描述（description）",
        };
      }
      
      // 构建提示词，基于示例生成新技能
      const prompt = `请基于以下示例代码，为我创建一个类似但功能不同的技能。

**示例代码：**
\`\`\`javascript
${example}
\`\`\`

**新技能需求：**
${description}

请生成完整的技能定义和实现代码，保持与示例相似的代码风格，但实现新的功能。`;

      // 调用 LLM
      let fullContent = "";
      if (chatProvider && chatProvider.isEnabled()) {
        await chatProvider.streamCompletion(
          "skill-example-session",
          { text: prompt },
          (delta) => {
            fullContent += delta;
          }
        );
        
        // 解析结果
        const jsonMatch = fullContent.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            return {
              ok: true,
              generated: true,
              skill: {
                metadata: parsed.metadata,
                handlerCode: parsed.handlerCode,
                explanation: parsed.explanation || "基于示例生成的技能",
              },
              note: "基于提供的示例代码生成",
            };
          } catch (parseError) {
            return {
              ok: false,
              error: "解析生成的代码失败",
              rawOutput: fullContent.substring(0, 500),
            };
          }
        }
      }
      
      return {
        ok: false,
        error: "需要配置外部聊天提供商才能使用此功能",
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `生成失败：${msg}` };
    }
  });
  
  // ========== 优化现有技能 ==========
  registry.register("self.optimize_skill", async (input, context) => {
    const actorId = resolveActorId(context);
    
    try {
      const skillName = String(input.skillName ?? "").trim();
      const optimizationGoal = String(input.optimizationGoal ?? "").trim();
      
      if (!skillName || !optimizationGoal) {
        return {
          ok: false,
          error: "需要提供技能名称（skillName）和优化目标（optimizationGoal）",
        };
      }
      
      if (!skillManager) {
        return { ok: false, error: "SkillManager 未初始化" };
      }
      
      const existingSkill = skillManager.get(skillName);
      if (!existingSkill) {
        return { ok: false, error: `技能不存在：${skillName}` };
      }
      
      // 读取现有的 handler 代码
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const skillDir = join(getDataDir(), "community-skills", skillName);
      const handlerPath = join(skillDir, "skill.handler.js");
      
      let existingCode: string;
      try {
        existingCode = await readFile(handlerPath, "utf8");
      } catch (err) {
        return {
          ok: false,
          error: "无法读取现有技能代码",
        };
      }
      
      // 构建优化提示词
      const prompt = `请优化以下技能代码，目标是：${optimizationGoal}

**现有代码：**
\`\`\`javascript
${existingCode}
\`\`\`

**优化要求：**
1. 保持相同的输入输出接口
2. 提高代码质量和性能
3. 添加更好的错误处理
4. 保持代码可读性

请返回优化后的完整代码。`;

      // 调用 LLM
      let fullContent = "";
      if (chatProvider && chatProvider.isEnabled()) {
        await chatProvider.streamCompletion(
          "skill-optimize-session",
          { text: prompt },
          (delta) => {
            fullContent += delta;
          }
        );
        
        // 提取代码
        const codeMatch = fullContent.match(/```javascript\s*([\s\S]*?)\s*```/) ||
                         fullContent.match(/```js\s*([\s\S]*?)\s*```/) ||
                         fullContent.match(/```\s*([\s\S]*?)\s*```/);
        
        if (codeMatch) {
          const optimizedCode = codeMatch[1];
          
          return {
            ok: true,
            optimized: true,
            skillName,
            originalCodeLength: existingCode.length,
            optimizedCodeLength: optimizedCode.length,
            optimizedCode,
            nextStep: "使用 self.update_skill 应用优化后的代码",
          };
        }
      }
      
      return {
        ok: false,
        error: "需要配置外部聊天提供商才能使用此功能",
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `优化失败：${msg}` };
    }
  });
}
