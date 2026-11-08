// 手机端对话式首启引导：唯一编排点。
//
// 链路（2026-11-07 定稿）：
//   session.init(mobile) → 一次性闸门 → SpeechHub（走现有人格 prompt，材料在 user 轮）
//     → 两泡 agent.proactive_message（问候 / 能力介绍+问称呼）
//   用户回称呼 → 确定性写 structured_facts「称呼」→ 追问 agent 名
//   用户回名字 → 确定性走 agent.update_identity 统一改名管道（账号+KV+prefs）
//     → 广播 identity_renamed（两端共享）→ 标记 done，此后永不再触发。
//
// 「确保落库」不靠 LLM 自觉调工具：agent.update_identity 默认不在常驻工具集、
// 且 prompt 禁写工具名/场景映射，所以两步答案都由服务端确定性拦截写入。
import { getMemoryComponents } from "../agentic-memory/index.js";
import { applyAgentIdentityRename } from "../tools/agent-identity-tools.js";
import { getUserPreferences } from "../routes/http/user-preferences.js";
import type { SpeechHub } from "../proactivity/speech-express.js";
import type { AgentAccountService } from "./agent-account-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { WsConnectionRegistry } from "./ws-connection-registry.js";
import {
  AGENT_NAME_KV_KEY,
  AGENT_NAME_SUGGESTIONS,
  parseAgentIdentityKv,
} from "./agent-identity.js";
import {
  buildIntroTaskPrompt,
  explicitAgentName,
  extractAgentName,
  extractUserAlias,
  INTRO_FALLBACK,
  onboardingTurnHint,
  readOnboardingStage,
  seedOnboardingStage,
  splitIntroIntoBubbles,
  userAliasOf,
  writeOnboardingStage,
} from "./onboarding-state.js";

export type OnboardingIntroDeps = {
  accounts: AgentAccountService;
  memorySync: AgentMemorySyncService;
  wsRegistry: WsConnectionRegistry | null;
  /** 统一主动开口出口；null = 全模板兜底（不阻塞引导） */
  speech: SpeechHub | null;
  now: () => number;
  /** 两泡间隔（毫秒）；测试可置 0 同步推送。默认 700ms。 */
  secondBubbleDelayMs?: number;
};

/** 两泡之间的间隔：像真人连发两条消息，不并成一坨。 */
const SECOND_BUBBLE_DELAY_MS = 700;

/** 取名卡抬头（候选名取自 AGENT_NAME_SUGGESTIONS）。 */
const AGENT_NAME_CARD_TITLE = "你想怎么称呼我？之后随时可以改。";

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
    const started = await seedOnboardingStage(
      memorySync,
      actorId,
      "awaiting_alias",
      now,
    );
    if (!started) return;
    const intro = await this.generateIntro(actorId);
    const bubbles = splitIntroIntoBubbles(intro);
    this.pushBubble(actorId, bubbles[0] ?? INTRO_FALLBACK.split("\n")[0]!);
    if (bubbles[1]) {
      const second = bubbles[1];
      const delay = this.deps.secondBubbleDelayMs ?? SECOND_BUBBLE_DELAY_MS;
      if (delay <= 0) {
        this.pushBubble(actorId, second);
      } else {
        const timer = setTimeout(() => this.pushBubble(actorId, second), delay);
        timer.unref?.();
      }
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
    if (!name) return;
    if (!(await this.rename(actorId, name))) return;
    await writeOnboardingStage(memorySync, actorId, "done", now);
  }

  /** 主对话每轮的引导意图（只给状态与意图，措辞归人格 prompt）。 */
  hintForTurn(actorId: string): string | undefined {
    return onboardingTurnHint(this.deps.memorySync, actorId);
  }

  /**
   * 取名卡（2026-11-08）：只在「等用户给 agent 取名」阶段给出三个候选名，
   * 由本轮 assistant_done 之后补发，客户端挂在回复气泡下方。
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

  private async generateIntro(actorId: string): Promise<string> {
    if (!this.deps.speech) return INTRO_FALLBACK;
    try {
      return await this.deps.speech.speakRaw({
        kind: "first_meeting_intro",
        sessionId: actorId,
        fallback: INTRO_FALLBACK,
        tier: "light",
        importance: "critical",
        maxChars: 260,
        allowNewlines: true,
        userPrompt: buildIntroTaskPrompt(),
      });
    } catch (err) {
      console.log(`[OnboardingIntro] 开场白生成失败（用兜底）: ${err}`);
      return INTRO_FALLBACK;
    }
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

  /** 定向手机推两条普通文本气泡；每条一个 messageId，客户端逐条落本地历史。 */
  private pushBubble(actorId: string, text: string): void {
    const payload = {
      // 留空：引导气泡不是「主动性触达」，不参与 outcome 统计/重连补投。
      deliveryId: "",
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
}
