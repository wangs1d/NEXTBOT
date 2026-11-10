// 手机端对话式首启引导：唯一编排点。
//
// 链路（2026-11-09 定稿）：
//   session.init(mobile) → 一次性闸门 → 确定性开场白两泡（不走 LLM）
//     第一泡：嗨 + 注册时登记的用户名称 + 管家定位（笑脸收尾）
//     第二泡：直接问「你之后想叫我什么呢」，取名卡随第二泡挂载下发
//   用户回名字 → 确定性走 agent.update_identity 统一改名管道（账号+KV+prefs）
//     → 广播 identity_renamed（两端共享）→ 标记 done，此后永不再触发。
//
// 用户称呼在注册时即落账号 displayName（注册表单填写），开场白时顺带写
// structured_facts「称呼」供 prompt/晨报同源使用；不再在对话里问称呼。
//
// 「确保落库」不靠 LLM 自觉调工具：agent.update_identity 默认不在常驻工具集、
// 且 prompt 禁写工具名/场景映射，所以答案由服务端确定性拦截写入。
import { getMemoryComponents } from "../agentic-memory/index.js";
import { applyAgentIdentityRename } from "../tools/agent-identity-tools.js";
import { getUserPreferences } from "../routes/http/user-preferences.js";
import { ServerEventType } from "../protocol.js";
import type { AgentAccountService } from "./agent-account-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";
import {
  AGENT_NAME_KV_KEY,
  AGENT_NAME_SUGGESTIONS,
  parseAgentIdentityKv,
} from "./agent-identity.js";
import {
  buildIntroBubbles,
  explicitAgentName,
  explicitUserAlias,
  extractAgentName,
  extractUserAlias,
  onboardingTurnHint,
  readOnboardingStage,
  seedOnboardingStage,
  userAliasOf,
  writeOnboardingStage,
} from "./onboarding-state.js";

export type OnboardingIntroDeps = {
  accounts: AgentAccountService;
  memorySync: AgentMemorySyncService;
  wsRegistry: WsConnectionRegistry | null;
  now: () => number;
  /** 两泡间隔（毫秒）；测试可置 0 同步推送。默认 700ms。 */
  secondBubbleDelayMs?: number;
};

/** 两泡之间的间隔：像真人连发两条消息，不并成一坨。 */
const SECOND_BUBBLE_DELAY_MS = 700;

/** 取名卡抬头（候选名取自 AGENT_NAME_SUGGESTIONS；与第二泡正文同一句式）。 */
const AGENT_NAME_CARD_TITLE = "你想叫我什么呢，之后你也可以修改。";

export class OnboardingIntroService {
  constructor(private readonly deps: OnboardingIntroDeps) {}

  /** 会话建立时调用：只对「手机端 + 从未引导 + 没名字没称呼」的账号开跑一次。 */
  async maybeStart(
    actorId: string,
    deviceClass: string | undefined,
  ): Promise<void> {
    if (deviceClass !== "mobile") return;
    if (!actorId) return;
    const { memorySync, now } = this.deps;
    if (readOnboardingStage(memorySync, actorId)) return;
    // 桌面端首启向导已取过名/称呼的老账号：只标记完成，绝不在手机端重复打扰。
    if (this.hasAgentName(actorId) || Boolean(userAliasOf(actorId))) {
      await writeOnboardingStage(memorySync, actorId, "done", now);
      return;
    }
    // seedIfAbsent 原子占位：多端同时登录也只会有一个连接真正发开场白。
    // 2026-11-09 起直接进「等取名」阶段（称呼注册时已登记，不再问）。
    const started = await seedOnboardingStage(
      memorySync,
      actorId,
      "awaiting_agent_name",
      now,
    );
    if (!started) return;
    // 注册时登记的用户名称 → structured_facts「称呼」（prompt/晨报同源）。
    const userName = this.userNameOf(actorId);
    if (userName) {
      try {
        getMemoryComponents().factStore?.applyFact({
          actorId,
          entity: "user",
          field: "称呼",
          value: userName,
          confidence: 1.0,
        });
      } catch {
        /* 事实库未装配不阻塞开场白 */
      }
    }
    const [greeting, askName] = buildIntroBubbles(userName);
    this.pushBubble(actorId, greeting);
    const secondMessageId = `onboarding-intro-${now()}`;
    const sendSecond = () => {
      this.pushBubble(actorId, askName, secondMessageId);
      // 取名卡挂在第二泡下方：先泡后卡，WS 同连接保序，客户端按 messageId 挂载。
      this.pushNameCard(actorId, secondMessageId);
    };
    const delay = this.deps.secondBubbleDelayMs ?? SECOND_BUBBLE_DELAY_MS;
    if (delay <= 0) {
      sendSecond();
    } else {
      const timer = setTimeout(sendSecond, delay);
      timer.unref?.();
    }
  }

  /**
   * 用户消息入站时调用（在 prompt 装配之前）：按当前阶段确定性抽取答案并落库。
   * 抽不到答案就保持阶段不变，由 onboardingTurnHint 让模型自然地再问一句。
   */
  async onUserText(actorId: string, text: string): Promise<void> {
    const { memorySync, now } = this.deps;
    const stage = readOnboardingStage(memorySync, actorId);
    if (!stage || stage === "done") return;

    if (stage === "awaiting_alias") {
      // legacy：改版（2026-11-09）前已开跑的账号仍按旧两步流程走完。
      const alias = extractUserAlias(text);
      if (!alias) return;
      const factStore = getMemoryComponents().factStore;
      if (!factStore) return; // 事实库未装配：保持阶段，下一轮再试
      factStore.applyFact({
        actorId,
        entity: "user",
        field: "称呼",
        value: alias,
        confidence: 1.0,
      });
      // 用户一句话把称呼和名字都给了：两步并一步，别再追问。
      const both = explicitAgentName(text);
      if (both && (await this.rename(actorId, both))) {
        await writeOnboardingStage(memorySync, actorId, "done", now);
        return;
      }
      await writeOnboardingStage(memorySync, actorId, "awaiting_agent_name", now);
      return;
    }

    const name = extractAgentName(text);
    if (!name) {
      // 新流程用户称呼注册时已登记；这里只认「叫我X」这类明确自我称呼句式，
      // 落 structured_facts 但不推进阶段（仍在等用户给 agent 取名）。
      const alias = explicitUserAlias(text);
      if (!alias) return;
      try {
        getMemoryComponents().factStore?.applyFact({
          actorId,
          entity: "user",
          field: "称呼",
          value: alias,
          confidence: 1.0,
        });
      } catch {
        /* 事实库未装配不阻塞 */
      }
      return;
    }
    if (!(await this.rename(actorId, name))) return;
    await writeOnboardingStage(memorySync, actorId, "done", now);
  }

  /** 主对话每轮的引导意图（只给状态与意图，措辞归人格 prompt）。 */
  hintForTurn(actorId: string): string | undefined {
    return onboardingTurnHint(this.deps.memorySync, actorId);
  }

  /**
   * 取名卡（2026-11-08）：在「等用户给 agent 取名」阶段给出三个候选名。
   * 开场白阶段卡随第二泡直接下发（见 maybeStart）；这里供主对话轮在用户
   * 尚未取名时补挂到回复气泡下方（含开场白帧丢失的重连场景）。
   */
  nameChoiceCardFor(
    actorId: string,
  ): { title: string; choices: string[] } | null {
    if (readOnboardingStage(this.deps.memorySync, actorId) !== "awaiting_agent_name") {
      return null;
    }
    return {
      title: AGENT_NAME_CARD_TITLE,
      choices: AGENT_NAME_SUGGESTIONS.slice(0, 3).map((s) => s.displayName),
    };
  }

  /** 走统一改名管道：KV → 账号 → prefs → 叙事线 → WS 广播，一处不落就整体失败。 */
  private async rename(actorId: string, name: string): Promise<boolean> {
    try {
      await applyAgentIdentityRename(
        {
          accounts: this.deps.accounts,
          memorySync: this.deps.memorySync,
          wsRegistry: this.deps.wsRegistry,
        },
        actorId,
        {
          displayName: name,
          origin: "user",
          reason: "用户第一次见面时给我取的名字",
        },
      );
      return true;
    } catch (err) {
      console.log(`[OnboardingIntro] 改名落库失败（保持引导阶段）: ${err}`);
      return false;
    }
  }

  /** 注册时登记的用户名称：账号 displayName 优先，退 structured_facts「称呼」。 */
  private userNameOf(actorId: string): string | undefined {
    try {
      const displayName = this.deps.accounts.getByActorId(actorId)?.displayName?.trim();
      if (displayName) return displayName;
    } catch {
      /* 账号读不到继续看事实库 */
    }
    return userAliasOf(actorId);
  }

  /** 账号级：KV 名字档案（权威）或 prefs 显示名（老数据）任一有值即视为已取名。 */
  private hasAgentName(actorId: string): boolean {
    try {
      const raw = this.deps.memorySync.getSnapshot(actorId, [AGENT_NAME_KV_KEY])
        .entries[AGENT_NAME_KV_KEY];
      if (parseAgentIdentityKv(raw)?.displayName?.trim()) return true;
    } catch {
      /* KV 读取失败继续看 prefs */
    }
    try {
      return Boolean(getUserPreferences(actorId).agentProfile?.displayName?.trim());
    } catch {
      return false;
    }
  }

  /** 定向手机推一条普通文本气泡；messageId 供客户端落历史并挂取名卡。 */
  private pushBubble(actorId: string, text: string, messageId?: string): void {
    const payload = {
      // 留空：引导气泡不是「主动性触达」，不参与 outcome 统计/重连补投。
      deliveryId: "",
      ...(messageId ? { messageId } : {}),
      title: "",
      text,
      importance: "normal",
      kind: "first_meeting_intro",
    };
    try {
      this.deps.wsRegistry?.trySendToDeviceClasses(
        actorId,
        JSON.stringify({ type: "agent.proactive_message", payload }),
        ["mobile"],
      );
    } catch (err) {
      console.log(`[OnboardingIntro] 开场白推送失败: ${err}`);
    }
  }

  /** 取名卡事件（onboarding.name_choices）：客户端按 messageId 挂到对应气泡下。 */
  private pushNameCard(actorId: string, messageId: string): void {
    const payload = {
      messageId,
      title: AGENT_NAME_CARD_TITLE,
      choices: AGENT_NAME_SUGGESTIONS.slice(0, 3).map((s) => s.displayName),
    };
    try {
      this.deps.wsRegistry?.trySendToDeviceClasses(
        actorId,
        JSON.stringify({ type: ServerEventType.OnboardingNameChoices, payload }),
        ["mobile"],
      );
    } catch (err) {
      console.log(`[OnboardingIntro] 取名卡推送失败: ${err}`);
    }
  }
}
