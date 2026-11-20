import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 媒体音乐能力 —— ChatCompletionTool schema。
 *
 * 工具族：
 *   - media.search       搜索歌曲 / 艺术家 / 专辑（接网易云开放搜索 API）
 *   - media.play         让用户客户端播放指定曲目（推 WS `agent.media.play`）
 *   - media.pause        暂停客户端播放
 *   - media.resume       恢复客户端播放
 *   - media.stop         停止并清空播放状态
 *   - media.now_playing  查询当前正在播放的曲目
 *
 * 走 deferred（延迟目录）：
 *   1. LLM 不会每轮都放歌，进核心会浪费 token
 *   2. 关键词触发（"放歌" / "播放" / "暂停" / "now playing"）时由 tool_discover 拉出
 *   3. 调用频率远低于 weather / clock / search_web
 *
 * 与客户端联动：客户端订阅 `agent.media.*` 事件族即可覆盖所有播放控制场景；
 * 服务端仅下发控制信令，实际音频流由客户端拉取（避免版权与带宽问题）。
 */
export const MEDIA_MUSIC_CHAT_TOOLS: ChatCompletionTool[] = [
  // media.search — 搜索歌曲 / 艺术家 / 专辑
  {
    type: "function",
    function: {
      name: "media.search",
      description:
        "搜索歌曲 / 艺术家 / 专辑（接网易云音乐 API）。\n" +
        "适用场景：用户说「搜一下xxx」「找一首歌」「有什么xxx的歌」。\n" +
        "返回曲目列表（id / name / artist / album / durationSec）。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "搜索关键词（歌名 / 艺术家 / 专辑名 均可）。例如：\"周杰伦 晴天\"、\"Taylor Swift\"、\"范特西专辑\"",
          },
          limit: {
            type: "integer",
            description: "返回条数上限，1-20，默认 10。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  // media.play — 播放指定曲目
  {
    type: "function",
    function: {
      name: "media.play",
      description:
        "播放指定曲目。服务端按 trackId 解析可播放 URL 后推 `agent.media.play` 事件给用户客户端，客户端直接播放。\n" +
        "适用场景：用户说「放一首xxx」「播放xxx」「来首歌」。\n" +
        "⚠ 前置条件：客户端须在 session.init 声明媒体播放能力（capabilities.mediaPlayback），" +
        "未声明的客户端不会消费播放事件——调用会如实返回失败。\n" +
        "⚠ 诚实要求：若返回 urlError（无版权/仅 VIP/解析超时），说明客户端无法真正出声，" +
        "必须如实告知用户，绝不能宣称「歌已经在放了」。\n" +
        "推荐先用 media.search 拿到 trackId 再调用本工具；也可直接传 trackId。",
      parameters: {
        type: "object",
        properties: {
          trackId: {
            type: "string",
            description: "曲目 ID（来自 media.search 返回）。例如：\"1234567\"",
          },
          trackName: {
            type: "string",
            description: "曲目名称（用于客户端 UI 显示，可选）。",
          },
          artist: {
            type: "string",
            description: "艺术家名称（可选）。",
          },
          album: {
            type: "string",
            description: "专辑名称（可选）。",
          },
          durationSec: {
            type: "integer",
            description: "曲目时长（秒，可选）。",
          },
          url: {
            type: "string",
            description:
              "可播放的音频 URL（可选；网易云搜索 API 通常不直接返回，客户端可自行按 trackId 拉流）。",
          },
        },
        required: ["trackId"],
        additionalProperties: false,
      },
    },
  },
  // media.pause — 暂停客户端播放
  {
    type: "function",
    function: {
      name: "media.pause",
      description: "暂停当前客户端播放。服务端推 `agent.media.pause` 事件。\n适用场景：用户说「暂停」「停一下」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  // media.resume — 恢复已暂停的播放
  {
    type: "function",
    function: {
      name: "media.resume",
      description: "恢复已暂停的播放。服务端推 `agent.media.resume` 事件。\n适用场景：用户说「继续」「接着放」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  // media.stop — 停止播放并清空状态
  {
    type: "function",
    function: {
      name: "media.stop",
      description:
        "停止播放并清空当前播放状态。服务端推 `agent.media.stop` 事件。\n" +
        "适用场景：用户说「别放了」「关掉音乐」。\n" +
        "与 media.pause 区别：pause 保留状态可 resume，stop 完全清空。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  // media.now_playing — 查询当前正在播放的曲目
  {
    type: "function",
    function: {
      name: "media.now_playing",
      description: "查询当前正在播放的曲目（含暂停状态）。\n适用场景：用户问「现在放的什么歌」「这首歌叫什么」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  // media.login_status — 查询音源登录状态（登录音源可解析 VIP 曲目）
  {
    type: "function",
    function: {
      name: "media.login_status",
      description:
        "查询当前音源状态：网易云登录音源（用户已导入 Cookie，可解析 VIP/版权曲目）或匿名音源（仅非 VIP 曲目）。\n" +
        "适用场景：播放失败提示无版权/VIP 时自查原因、用户问「为什么放不了这首歌」「怎么接我的网易云会员」。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];
