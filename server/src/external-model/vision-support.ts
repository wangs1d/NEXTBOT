/**
 * 视觉能力判定。
 *
 * 纯文本模型（deepseek-chat / deepseek-reasoner / gpt-3.5 等）无法接收
 * `image_url` 多模态输入，注入会直接导致 OpenAI 兼容 API 报 400。
 * 因此所有「图片 → LLM」的注入点都必须先按模型能力分流：
 *  - 视觉模型 → image_url 原样注入，让 LLM 直接看图
 *  - 非视觉模型 → 图片不注入（2026-09-15 起 PaddleOCR 文本降级已移除，
 *    图片理解统一依赖视觉模型）
 *
 * 该模块独立成文件，供 abstract-chat-provider（主对话）、
 * openai-compatible-tool-loop（工具结果注入）、image-caption-service、
 * presence-detect 共用，避免多处判断不一致。
 */

const VISION_MODEL_PATTERNS = [
  "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1",
  "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qvq",
  "glm-4v", "glm-4.6v", "glm-4-plus",
  "moonshot-v1", "kimi",
  "gemini", "llava", "internvl",
  "deepseek-vl", "deepseek-vl2",
  // DeepSeek 官方 V4.1-Flash（deepseek-flash；旧名 deepseek-v4-flash[-vision-exp] 亦由其服务）
  "deepseek-flash", "deepseek-v4-flash",
  // MiniMax M3 系（2026-10-21 实测：OpenAI 兼容端点已接受 image_url，
  // M3 / M3.1-Flash 均能正确读图并输出描述；此前 1033 报错已不复现）
  "minimax-m3",
];

/** 检测模型是否支持视觉（多模态图片输入）。
 *  deepseek-chat / deepseek-reasoner / gpt-3.5 等纯文本模型不支持，
 *  注入 image_url 会导致 API 报错。 */
export function modelSupportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return VISION_MODEL_PATTERNS.some((p) => m.includes(p));
}
