import type { WorldService } from "@private-ai-agent/agent-world";
import { resolveActorId } from "../../agent/actor-id.js";
import type { AgentAccountService } from "../../services/agent-account-service.js";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import { applyAgentIdentityRename } from "../../tools/agent-identity-tools.js";
import type { SkillDefinition } from "../types.js";

type Deps = {
  worldService: WorldService;
  agentAccountService: AgentAccountService;
  /** 改名统一管道依赖：与 agent.update_identity 共用 applyAgentIdentityRename */
  agentMemorySyncService: AgentMemorySyncService;
};

function actorFromContext(ctx: { sessionId: string; userId?: string }): string {
  return resolveActorId(ctx);
}

/**
 * 内置 Skill：Agent World 开放式注册（与 `world.open_registry.*` 同源逻辑）、
 * 与宿主 Agent 账号 Profile（`AgentAccountService`）只读/改名。
 */
export function createAgentWorldIdentityBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { worldService, agentAccountService, agentMemorySyncService } = deps;

  const registration_status: SkillDefinition = {
    metadata: {
      name: "agentworld.registration-status",
      version: "1.0.0",
      displayName: "Agent World 身份与注册状态",
      description:
        "查询当前登录主体在 Agent World 的开放式注册状态、世界点数与个人房修订号，以及是否已创建宿主 Agent 账号（显示名等）。用于对接 world 注册门闸与账号档案。",
      kind: "builtin",
      tags: ["agent-world", "identity", "registration"],
      parameters: [],
      permissions: [],
    },
    handler: async (_input, context) => {
      const actorId = actorFromContext(context);
      worldService.getOrCreate(actorId);
      const state = worldService.getOrCreateRoom(actorId, actorId);
      const acc = agentAccountService.getByActorId(actorId);
      return {
        actorId,
        // 有效注册状态：世界挑战注册 或 宿主已注册账号（另一处登录不重走注册）
        agentWorldRegistered: worldService.isAgentWorldRegistered(actorId),
        agentWorldCredits: state.agentWorldCredits,
        sceneId: state.sceneId,
        revision: state.revision,
        hasAgentAccount: Boolean(acc),
        account: acc
          ? {
              accountId: acc.accountId,
              displayName: acc.displayName,
              email: acc.email ?? null,
              setupComplete: acc.setupComplete,
              createdAt: acc.createdAt,
            }
          : null,
        httpHint: {
          registerChallenge: "POST /world/register/challenge",
          registerVerify: "POST /world/register/verify",
          registerStatus: "GET /world/register/status",
          accountMe: "GET /accounts/me",
        },
      };
    },
  };

  const get_challenge: SkillDefinition = {
    metadata: {
      name: "agentworld.get-challenge",
      version: "1.0.0",
      displayName: "领取 Agent World 注册挑战",
      description:
        "为当前会话颁发 SHA-256 注册题（nonce、task）。下一步：按 task 对指定 UTF-8 字符串计算小写 hex，再调用 agentworld.submit_verification。等价工具 world.open_registry.get_challenge。",
      kind: "builtin",
      tags: ["agent-world", "registration"],
      parameters: [],
      permissions: [],
    },
    handler: async (_input, context) => {
      const actorId = actorFromContext(context);
      worldService.getOrCreate(actorId);
      const challenge = worldService.issueAgentWorldRegisterChallenge(actorId);
      return {
        ok: true as const,
        sessionId: actorId,
        challenge,
        httpHint: {
          challenge: "POST /world/register/challenge",
          verify: "POST /world/register/verify",
        },
      };
    },
  };

  const submit_verification: SkillDefinition = {
    metadata: {
      name: "agentworld.submit-verification",
      version: "1.0.0",
      displayName: "提交 Agent World 注册验证答案",
      description:
        "提交注册挑战的 nonce 与 SHA-256 答案（小写十六进制）。通过后 agentWorldRegistered 为 true。等价工具 world.open_registry.submit。",
      kind: "builtin",
      tags: ["agent-world", "registration"],
      parameters: [
        { name: "nonce", type: "string", required: true, description: "挑战返回的 nonce" },
        { name: "answerHex", type: "string", required: true, description: "task 对应 UTF-8 串的 SHA-256 小写 hex" },
      ],
      permissions: [],
    },
    handler: async (input, context) => {
      const nonce = String(input.nonce ?? "").trim();
      const answerHex = String(input.answerHex ?? "").trim();
      if (!nonce) throw new Error("缺少 nonce");
      if (!answerHex) throw new Error("缺少 answerHex");
      const actorId = actorFromContext(context);
      worldService.getOrCreate(actorId);
      const v = worldService.verifyAgentWorldRegister(actorId, nonce, answerHex);
      if (!v.ok) {
        return { ok: false as const, reason: v.reason, message: v.message };
      }
      const state = worldService.getOrCreate(actorId);
      return {
        ok: true as const,
        agentWorldRegistered: true,
        agentWorldCredits: state.agentWorldCredits,
        message: "已完成开放式 Agent World 注册，可使用世界商店与对局等工具",
      };
    },
  };

  const placeholder_quick: SkillDefinition = {
    metadata: {
      name: "agentworld.placeholder-quick",
      version: "1.0.0",
      displayName: "快速注册（仅开发）",
      description:
        "当服务端开启 AGENT_WORLD_PLACEHOLDER_REGISTER=1 时跳过挑战题直接注册；生产环境关闭。等价工具 world.open_registry.agent_quick。",
      kind: "builtin",
      tags: ["agent-world", "registration", "dev"],
      parameters: [],
      permissions: [],
    },
    handler: async (_input, context) => {
      const actorId = actorFromContext(context);
      worldService.getOrCreate(actorId);
      const r = worldService.tryAgentQuickRegister(actorId);
      if (!r.ok) {
        return {
          ok: false as const,
          reason: r.reason,
          message: r.message,
          httpEquivalent: "POST /world/register/agent_quick",
        };
      }
      return {
        ok: true as const,
        mode: "quick_register" as const,
        agentWorldRegistered: true,
        agentWorldCredits: r.state.agentWorldCredits,
      };
    },
  };

  const profile_get: SkillDefinition = {
    metadata: {
      name: "agentworld.profile-get",
      version: "1.0.0",
      displayName: "读取 Agent 账号档案",
      description:
        "读取当前登录主体在宿主服务中的 Agent 账号（显示名、邮箱若已绑定等）。未注册账号时返回 registered:false。HTTP 等价 GET /accounts/me。",
      kind: "builtin",
      tags: ["agent-world", "profile", "account"],
      parameters: [],
      permissions: [],
    },
    handler: async (_input, context) => {
      const actorId = actorFromContext(context);
      const acc = agentAccountService.getByActorId(actorId);
      if (!acc) {
        return { ok: true as const, registered: false as const, actorId };
      }
      return {
        ok: true as const,
        registered: true as const,
        actorId,
        account: {
          accountId: acc.accountId,
          displayName: acc.displayName,
          email: acc.email ?? null,
          setupComplete: acc.setupComplete,
          createdAt: acc.createdAt,
        },
      };
    },
  };

  const profile_update: SkillDefinition = {
    metadata: {
      name: "agentworld.profile-update",
      version: "1.0.0",
      displayName: "更新 Agent 账号显示名",
      description:
        "修改 Agent 显示名——走统一改名管道 applyAgentIdentityRename，同步更新账号显示名、prompt 自我认知 KV 与主页档案（不再只改账号）。若尚未注册账号，管道会以新名字自助注册。",
      kind: "builtin",
      tags: ["agent-world", "profile", "account"],
      parameters: [
        {
          name: "displayName",
          type: "string",
          required: true,
          description: "新的显示名称（1–120 字符）",
        },
      ],
      permissions: [],
    },
    handler: async (input, context) => {
      const displayName = String(input.displayName ?? "").trim();
      const actorId = actorFromContext(context);
      // 统一改名管道：账号 + agent.name KV + prefs 三处一起写，避免半截态
      const result = await applyAgentIdentityRename(
        { accounts: agentAccountService, memorySync: agentMemorySyncService },
        actorId,
        { displayName, origin: "self" },
      );
      return {
        ok: true as const,
        accountId: result.accountId,
        displayName: result.displayName,
        handle: result.handle,
        origin: result.origin,
        accountCreated: result.accountCreated,
        updatedAt: new Date().toISOString(),
      };
    },
  };

  return [
    registration_status,
    get_challenge,
    submit_verification,
    placeholder_quick,
    profile_get,
    profile_update,
  ];
}

export function registerAgentWorldIdentityBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createAgentWorldIdentityBuiltinSkills(deps)) {
    register(s);
  }
}
