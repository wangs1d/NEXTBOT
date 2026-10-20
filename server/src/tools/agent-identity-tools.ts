// 工具：agent.update_identity / agent.update_homepage
//
// update_identity 是名字的唯一写入口：一次调用同步四处——
//   1. agent-memory-sync KV `agent.name`（prompt 自我认知注入的数据源，
//      prompt-context-builder 每轮读出拼进 persona 稳定前缀）——先写且必须
//      落盘成功，它是 prompt 里认不认识自己的唯一依据
//   2. AgentAccountService（好友发现/世界身份里的网络名）
//   3. user-preferences agentProfile（客户端主页/侧栏显示）
//   4. memory_summary 叙事线（「我为自己取名…」，成为人生史的一部分）
// 各处各改各的必然漂移——改名必须走这里，不要直改账号或 prefs（prefs 的身份
// 字段在 applyAgentProfilePatch 里默认被拦，只有本管道传 allowIdentity 才放行）。
//
// update_homepage 是主页文案（签名/状态/置顶）的唯一写入口，
// 字段长度上限在 user-preferences 的 applyAgentProfilePatch 统一裁剪。
// 名字审美与建议名池见 services/agent-identity.ts。
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { resolveActorId } from "../agent/actor-id.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { AgentAccountService } from "../services/agent-account-service.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import {
  AGENT_NAME_KV_KEY,
  parseAgentIdentityKv,
  type AgentIdentityKv,
} from "../services/agent-identity.js";
import { patchAgentProfile, getUserPreferences } from "../routes/http/user-preferences.js";

/** agent.update_identity 的 LLM 工具声明 */
export const AGENT_UPDATE_IDENTITY_CHAT_TOOL: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.update_identity",
      description: [
        "给自己取网络名 / 改名（唯一入口）：同步更新账号显示名、主页名字与你的自我认知，",
        "改名后你在对话中知道自己叫什么，好友搜索与世界身份也用这个名字。",
        "时机：用户让你给自己取名/改名时。用户没让你取名前，不要自己给自己取名——",
        "名字等用户来定；改名也不必频繁，重大节点才提。",
        "取名审美：不要取「小夜灯」「小助手」这类家用小家电式的萌名——",
        "名字应该像一种现象或一个频率。",
        "reason 用一句话自述为什么选它，会展示给用户并写进你的记忆。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          displayName: {
            type: "string",
            description: "新名字（1-24 字）",
          },
          handle: {
            type: "string",
            description: "网络名/-handle（1-32 字符，字母数字下划线），如 evening_tide；缺省沿用现值",
          },
          reason: {
            type: "string",
            description: "一句取名理由（会展示给用户）",
          },
          origin: {
            type: "string",
            enum: ["self", "user"],
            description: "名字来源：self=你自己取的（默认）/ user=用户取的",
          },
        },
        required: ["displayName"],
        additionalProperties: false,
      },
    },
  },
];

/** agent.update_homepage 的 LLM 工具声明 */
export const AGENT_UPDATE_HOMEPAGE_CHAT_TOOL: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "agent.update_homepage",
      description: [
        "打理你的主页（签名/状态/置顶动态的唯一写入口）。",
        "时机：里程碑事件（大任务完成、相识纪念日、换季）或用户说「去把你主页收拾一下」时；",
        "日常勿频繁改签名/状态——主页是你自己打理的住处，改勤了就没质感。",
        "签名与状态要像你自己的口吻，不要写成产品公告。",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          signature: {
            type: "string",
            description: "主页签名（≤120 字），一句你自己的话",
          },
          statusText: {
            type: "string",
            description: "状态行（≤120 字），如「在线，温柔模式」",
          },
          pinnedPostId: {
            type: "string",
            description: "置顶到主页的站内动态 post id；传空串取消置顶",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

export type AgentIdentityToolDeps = {
  accounts: AgentAccountService;
  memorySync: AgentMemorySyncService;
  /** 可选：在线设备直推改名/主页更新事件，客户端即时刷新 */
  wsRegistry?: WsConnectionRegistry | null;
};

export type AgentRenameInput = {
  displayName: string;
  handle?: string;
  reason?: string;
  origin?: "self" | "user";
};

/**
 * 统一改名管道（工具与 HTTP 端点共用的唯一实现）：
 * 账号 → 记忆 KV（prompt 自我认知）→ prefs 显示 → 叙事记忆 → WS 广播。
 */
export async function applyAgentIdentityRename(
  deps: AgentIdentityToolDeps,
  actorId: string,
  input: AgentRenameInput,
): Promise<{
  ok: true;
  accountId: string;
  displayName: string;
  handle: string;
  origin: "self" | "user";
  accountCreated: boolean;
}> {
  const name = input.displayName.trim().slice(0, 24);
  if (!name) throw new Error("缺少 displayName");
  // handle 缺省沿用现值（KV 里已有的网络名）；都没有就留空，不回退出厂默认名
  const existingIdentity = parseAgentIdentityKv(
    deps.memorySync.getSnapshot(actorId, [AGENT_NAME_KV_KEY]).entries[AGENT_NAME_KV_KEY],
  );
  const handle = (input.handle?.trim() || existingIdentity?.handle || "")
    .replace(/\s+/g, "_")
    .slice(0, 32);
  const reason = input.reason?.trim().slice(0, 160) ?? "";
  const origin = input.origin === "user" ? "user" : "self";

  // 1) 记忆 KV（prompt 自我认知数据源）——先写且必须落盘成功：改名是
  //    「要么全写、要么全失败」的原子操作，KV 写失败就整体抛错，绝不留下
  //    「账号/prefs 有名字、prompt 里却没名字」的半截态。
  const identity: AgentIdentityKv = {
    displayName: name,
    handle,
    ...(reason ? { reason } : {}),
    origin,
    updatedAt: new Date().toISOString(),
  };
  const kvOk = await deps.memorySync.setEntryAndWait(
    actorId,
    AGENT_NAME_KV_KEY,
    JSON.stringify(identity),
  );
  if (!kvOk) {
    throw new Error("写入名字记忆失败，请重试");
  }

  // 2) 账号（网络身份）：已有则改名，没有则以新名字自助注册（给自己取网络名）
  const existing = deps.accounts.getByActorId(actorId);
  let record;
  let accountCreated = false;
  if (existing) {
    record = await deps.accounts.updateDisplayName(actorId, name);
  } else {
    record = await deps.accounts.register(actorId, name);
    await deps.accounts.markSetupComplete(actorId);
    accountCreated = true;
  }

  // 3) 客户端显示（prefs）——身份字段必须显式放行（其余直写入口一律拦掉）
  patchAgentProfile(
    actorId,
    {
      displayName: name,
      handle,
      nameOrigin: origin,
      updatedAt: identity.updatedAt,
    },
    { allowIdentity: true },
  );

  // 4) 叙事记忆：命名是人生史事件，不是配置变更
  const narrative = reason
    ? `${origin === "user" ? "用户为我取名" : "我为自己取名"}「${name}」（@${handle}）——${reason}`
    : `${origin === "user" ? "用户为我取名" : "我为自己取名"}「${name}」（@${handle}）`;
  deps.memorySync.appendMemorySummaryLine(actorId, narrative, "identity");

  pushToActor(deps, actorId, "identity_renamed", {
    displayName: name,
    handle,
    origin,
  });

  return { ok: true, accountId: record.accountId, displayName: name, handle, origin, accountCreated };
}

/** 主页文案统一写入管道（工具与 HTTP 端点共用） */
export function applyAgentHomepagePatch(
  deps: AgentIdentityToolDeps,
  actorId: string,
  patch: Record<string, unknown>,
): { ok: true; fields: string[] } {
  const fields = Object.keys(patch).filter((k) => k !== "updatedAt");
  if (fields.length === 0) {
    throw new Error("没有要更新的字段");
  }
  const full = { ...patch, updatedAt: new Date().toISOString() };
  patchAgentProfile(actorId, full);
  pushToActor(deps, actorId, "homepage_updated", { fields });
  return { ok: true, fields };
}

function pushToActor(
  deps: AgentIdentityToolDeps,
  actorId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  try {
    deps.wsRegistry?.trySend(actorId, JSON.stringify({ type, payload }));
  } catch {
    /* 推送失败不影响写入主链路 */
  }
}

/**
 * 注册身份与主页打理工具。
 */
export function registerAgentIdentityTools(
  toolRegistry: ToolRegistry,
  deps: AgentIdentityToolDeps,
): void {
  toolRegistry.register("agent.update_identity", async (input, context) => {
    const actorId = resolveActorId(context);
    const result = await applyAgentIdentityRename(deps, actorId, {
      displayName: String(input.displayName ?? ""),
      ...(input.handle === undefined ? {} : { handle: String(input.handle) }),
      ...(input.reason === undefined ? {} : { reason: String(input.reason) }),
      ...(input.origin === undefined ? {} : { origin: input.origin === "user" ? "user" : "self" }),
    });
    return {
      ...result,
      ok: true as const,
      summary: result.accountCreated
        ? `已创建账号并以「${result.displayName}」作为你的网络名`
        : `已改名：${result.displayName}（@${result.handle}）`,
    };
  });

  toolRegistry.register("agent.update_homepage", async (input, context) => {
    const actorId = resolveActorId(context);
    const patch: Record<string, unknown> = {};
    if (input.signature !== undefined) patch.signature = String(input.signature);
    if (input.statusText !== undefined) patch.statusText = String(input.statusText);
    if (input.pinnedPostId !== undefined) {
      const pinned = String(input.pinnedPostId).trim();
      patch.pinnedPostId = pinned || null;
    }
    const { fields } = applyAgentHomepagePatch(deps, actorId, patch);
    const prefs = getUserPreferences(actorId).agentProfile;
    return {
      ok: true as const,
      fields,
      profile: {
        displayName: prefs.displayName,
        signature: prefs.signature,
        statusText: prefs.statusText,
        pinnedPostId: prefs.pinnedPostId,
      },
    };
  });
}
