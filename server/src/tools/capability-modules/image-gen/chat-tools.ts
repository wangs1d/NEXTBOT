import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 图像生成能力 —— ChatCompletionTool schema。
 *
 * 工具名：`image.generate`
 * 走 deferred（延迟目录）：，
 * 因为：
 *   1. LLM 不会每轮都生成图，进核心会浪费 token
 *   2. 关键词触发（"画一张" / "生成图片" / "做张图"）时由 tool_discover 拉出
 *   3. 调用频率远低于 weather / clock / search_web
 *
 * 与客户端 voice_message_bubble 联动：客户端识别 imageUrl 走 image preview 渲染。
 */
export const IMAGE_GEN_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "image.generate",
      description:
        "文本生成图片（text-to-image）。走服务端配置的 OpenAI 兼容图像模型。" +
        "适用场景：用户说「画一张」「生成图片」「做张图」「画个 logo」「配张插图」等。\n" +
        "prompt 中英文均可，尽量具体描述主体、风格、构图、光影。\n" +
        "返回 imageUrl（本地静态 URL，可永久访问）+ 实际使用模型。",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "图像描述（中英文均可）。建议包含主体 / 风格 / 构图 / 光影。例如：\"a cute cat sitting on a windowsill, soft morning light, watercolor style\"",
          },
          model: {
            type: "string",
            description:
              "图像模型名（可选，传服务端图像端点支持的模型 id）。未传时由服务端按默认选择。",
          },
          imageSize: {
            type: "string",
            description:
              "图片尺寸，可选：1024x1024（默认正方形）/ 768x1024（竖图）/ 1024x768（横图）/ 512x512（小图）。",
          },
          batchSize: {
            type: "integer",
            description: "一次生成几张图，1-4，默认 1。多张时 imageUrl 返回第一张。",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
];
