/**
 * 多模态融合皮层（Phase 4.1）
 *
 * 设计原则：
 * - 不引入 embedding 级融合（token 成本高）
 * - 在 SensoryFrame 基础上做结构化冲突检测 + 优先级仲裁
 * - 冲突检测：用户文本说"很高兴"但 emotion 检测为 negative → 标记 conflict
 * - 优先级：audio > visual > activity（人类对话中语音优先）
 * - 输出 FusedFrame（SensoryFrame 别名，向后兼容）
 *
 * 降级开关：BRAIN_MULTIMODAL_FUSION_ENABLED=0 时回退到 buildSensoryFrame
 */

import type { FusedFrame, EmotionVector, UserActivityState } from "./types.js";

/** 融合输入项 */
export interface FusionInput {
  actorId: string;
  audioText?: string;
  visualDescription?: string;
  emotion?: EmotionVector;
  activity?: UserActivityState;
}

/** 冲突类型 */
export type ConflictType =
  | "audio_emotion_conflict" // 语音说开心但情绪检测为负面
  | "visual_activity_conflict" // 视觉显示忙碌但活动状态为空闲
  | "audio_visual_mismatch"; // 语音内容与视觉描述不匹配

/** 是否启用多模态融合 */
export function isMultimodalFusionEnabled(): boolean {
  const raw = process.env.BRAIN_MULTIMODAL_FUSION_ENABLED?.trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false") return false;
  return true;
}

/**
 * 多模态融合皮层
 *
 * 纯规则仲裁，无 LLM 调用。
 * 在 SensoryFrame 基础上增加冲突检测和优先级仲裁。
 */
export class MultimodalFusionCortex {
  /**
   * 融合多模态输入为 FusedFrame
   *
   * @param inputs 各模态的输入
   * @returns 融合后的帧（含冲突标记和置信度）
   */
  fuse(inputs: FusionInput): FusedFrame {
    const { actorId, audioText, visualDescription, emotion, activity } = inputs;
    const conflictFlags: string[] = [];
    let fusionConfidence = 1.0;
    const now = new Date().toISOString();

    // 冲突检测 1：语音 vs 情绪
    if (audioText && emotion) {
      const conflict = this.detectAudioEmotionConflict(audioText, emotion);
      if (conflict) {
        conflictFlags.push("audio_emotion_conflict");
        fusionConfidence *= 0.8; // 冲突降低置信度
      }
    }

    // 冲突检测 2：视觉 vs 活动
    if (visualDescription && activity) {
      const conflict = this.detectVisualActivityConflict(visualDescription, activity.activity);
      if (conflict) {
        conflictFlags.push("visual_activity_conflict");
        fusionConfidence *= 0.85;
      }
    }

    // 确定主导模态
    const primaryModality = this.determinePrimaryModality(inputs);

    // 仲裁：冲突时以优先模态为准
    const resolvedAudioText = audioText;
    const resolvedEmotion = this.resolveEmotionConflict(audioText, emotion, conflictFlags);

    return {
      actorId,
      audioText: resolvedAudioText,
      visualDescription,
      emotion: resolvedEmotion ?? emotion,
      activity,
      capturedAt: now,
      conflictFlags: conflictFlags.length > 0 ? conflictFlags : undefined,
      fusionConfidence: Math.max(0.3, fusionConfidence),
      primaryModality,
    };
  }

  /**
   * 检测语音与情绪的冲突
   * 如用户文本说"很开心"但 emotion.valence < -0.3
   */
  private detectAudioEmotionConflict(
    audioText: string,
    emotion: EmotionVector,
  ): boolean {
    const positiveWords = ["开心", "高兴", "快乐", "哈哈", "不错", "喜欢", "棒", "好"];
    const negativeWords = ["难过", "伤心", "生气", "烦", "累", "焦虑", "害怕"];

    const hasPositive = positiveWords.some((w) => audioText.includes(w));
    const hasNegative = negativeWords.some((w) => audioText.includes(w));

    // 语音正面但情绪负面
    if (hasPositive && emotion.valence < -0.3) return true;
    // 语音负面但情绪正面
    if (hasNegative && emotion.valence > 0.3) return true;

    return false;
  }

  /**
   * 检测视觉描述与活动状态的冲突
   */
  private detectVisualActivityConflict(
    visualDescription: string,
    activity: string,
  ): boolean {
    const workKeywords = ["代码", "文档", "表格", "邮件", "终端", "IDE", "编辑器"];
    const leisureKeywords = ["视频", "游戏", "音乐", "社交", "聊天"];

    const visualIsWork = workKeywords.some((k) => visualDescription.includes(k));
    const visualIsLeisure = leisureKeywords.some((k) => visualDescription.includes(k));

    if (visualIsWork && (activity === "idle" || activity === "sleeping")) return true;
    if (visualIsLeisure && activity === "in_focus") return true;

    return false;
  }

  /**
   * 确定主导模态
   * 优先级：audio > visual > activity > emotion
   */
  private determinePrimaryModality(inputs: FusionInput): "audio" | "visual" | "activity" | "emotion" {
    if (inputs.audioText) return "audio";
    if (inputs.visualDescription) return "visual";
    if (inputs.activity) return "activity";
    return "emotion";
  }

  /**
   * 解决情绪冲突
   * 当语音和情绪冲突时，以情绪检测为准（情绪更难伪装）
   */
  private resolveEmotionConflict(
    audioText: string | undefined,
    emotion: EmotionVector | undefined,
    conflictFlags: string[],
  ): EmotionVector | undefined {
    if (!emotion || !conflictFlags.includes("audio_emotion_conflict")) {
      return emotion;
    }
    // 冲突时信任情绪检测，但降低置信度
    return {
      ...emotion,
      confidence: (emotion.confidence ?? 0.5) * 0.7,
      cause: emotion.cause ?? "语音与情绪检测冲突，采用情绪检测结果",
    };
  }
}
