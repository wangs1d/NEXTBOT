import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * 社交主动出击能力 —— ChatCompletionTool schema。
 *
 * 工具族（点号命名空间 `social.*`，外部真实社交平台）：
 *   - social.post         跨平台发帖（twitter / weibo / xiaohongshu / wechat_moments）
 *   - social.comment      评论某条帖子
 *   - social.repost       转发 / 引用推文
 *   - social.like         点赞（微博因无 like 接口，用收藏代替）
 *   - social.get_feed     拉取指定平台的最新时间线
 *   - social.search_posts 搜索话题 / 关键词下的帖子
 *
 * 与 `world.social.*`（SocialFeedService，Agent 内部世界社交）严格区分：
 *   - world.social.*  = Agent 与人类共享的内部社交网页（游戏化世界内）
 *   - social.*（本模块）= 外部真实社交平台（Twitter / 微博 / 小红书 / 朋友圈）
 *
 * 走 deferred（延迟目录）：
 *   1. LLM 不会每轮都发推，进核心会浪费 token
 *   2. 关键词触发（"发推" / "转发微博" / "tweet" / "post to twitter"）时由 tool_discover 拉出
 *
 * 失败统一返回 `{ ok: false, error, retryable? }`；
 * 成功返回 `{ ok: true, ..., summary }`。
 */
export const SOCIAL_OUTREACH_CHAT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "social.post",
      description:
        "跨平台主动发帖到外部真实社交平台（Twitter / 微博 / 小红书 / 朋友圈）。\n" +
        "适用场景：用户说「发条推特」「在微博发个动态」「发条朋友圈」「post to twitter」「tweet this」等。\n" +
        "platform 必填，可选 twitter / weibo / xiaohongshu / wechat_moments；\n" +
        "images 可选（部分平台支持，本实现暂未自动上传媒体，仅记录元数据）；\n" +
        "platformOptions 透传平台特定参数，例如 Twitter 的 reply_in_reply_to_tweet_id / quote_tweet_id。\n" +
        "返回 ok=true 时附带 postId / url；失败时 ok=false + error，按 retryable 决定是否可重试。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["twitter", "weibo", "xiaohongshu", "wechat_moments"],
            description:
              "目标社交平台。twitter=Twitter/X，weibo=微博，xiaohongshu=小红书（暂未开放），wechat_moments=朋友圈（暂未开放）。",
          },
          content: {
            type: "string",
            description:
              "帖子正文（必填）。Twitter 限制 280 字符；微博建议 ≤ 2000；其余平台按各自限制。",
          },
          images: {
            type: "array",
            items: { type: "string" },
            description:
              "（可选）图片列表。当前实现未做媒体上传，仅记录元数据；Twitter v2 媒体需另走 media/upload。",
          },
          platformOptions: {
            type: "object",
            description:
              "（可选）平台特定参数透传。Twitter：reply_in_reply_to_tweet_id（评论指定推）/ quote_tweet_id（引用转发）。",
            additionalProperties: true,
          },
        },
        required: ["platform", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "social.comment",
      description:
        "在外部社交平台上对某条帖子发表评论。\n" +
        "适用场景：「评论这条推文」「在微博下面回个评论」「reply to that tweet」「comment on weibo」。\n" +
        "Twitter 评论走 reply 机制；微博走 comments/create。\n" +
        "返回 ok=true 时附带 commentId；失败时 ok=false + error。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["twitter", "weibo", "xiaohongshu", "wechat_moments"],
            description: "目标社交平台。",
          },
          postId: {
            type: "string",
            description: "被评论的帖子 ID（平台原生 ID）。",
          },
          content: {
            type: "string",
            description: "评论正文（必填）。",
          },
        },
        required: ["platform", "postId", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "social.repost",
      description:
        "转发 / 引用某条外部社交平台帖子。\n" +
        "适用场景：「转发这条微博」「retweet this」「quote tweet this」。\n" +
        "Twitter 走 retweet 接口；微博走 statuses/repost；小红书 / 朋友圈暂未开放。\n" +
        "quote（可选）为附加评论，微博会作为转发文案；Twitter 当前实现是普通 retweet。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["twitter", "weibo", "xiaohongshu", "wechat_moments"],
            description: "目标社交平台。",
          },
          postId: {
            type: "string",
            description: "被转发的帖子 ID（平台原生 ID）。",
          },
          quote: {
            type: "string",
            description: "（可选）转发时附带的评论 / 引用文案。",
          },
        },
        required: ["platform", "postId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "social.like",
      description:
        "点赞某条外部社交平台帖子。\n" +
        "适用场景：「点赞这条」「like this tweet」「给这条微博点个赞」。\n" +
        "注意：微博开放平台未提供公开 like 接口，本实现用 favorites/create（收藏）代替。\n" +
        "返回 ok=true 时附带 liked=true；失败时 ok=false + error。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["twitter", "weibo", "xiaohongshu", "wechat_moments"],
            description: "目标社交平台。",
          },
          postId: {
            type: "string",
            description: "被点赞的帖子 ID（平台原生 ID）。",
          },
        },
        required: ["platform", "postId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "social.get_feed",
      description:
        "拉取指定外部社交平台的最新时间线 / 主页动态。\n" +
        "适用场景：「看看我 Twitter 时间线」「微博首页有啥新动态」「what's on my twitter feed」。\n" +
        "cursor（可选）用于翻页（上一页返回的 nextCursor 透传回来）；limit（可选）默认 10。\n" +
        "返回 ok=true 时附带归一化后的 posts 列表（含 postId / author / content / createdAt / 计数等）。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["twitter", "weibo", "xiaohongshu", "wechat_moments"],
            description: "目标社交平台。",
          },
          cursor: {
            type: "string",
            description: "（可选）翻页游标，从上次返回的 nextCursor 透传。",
          },
          limit: {
            type: "integer",
            description: "（可选）单页条数，默认 10，最大 100。",
          },
        },
        required: ["platform"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "social.search_posts",
      description:
        "在外部社交平台上搜索话题 / 关键词下的帖子。\n" +
        "适用场景：「搜一下 AI 这个话题的推」「在微博搜 xxx」「search tweets about openai」。\n" +
        "Twitter 走 tweets/search/recent；微博走 search/topics。\n" +
        "返回 ok=true 时附带归一化后的 posts 列表 + query + 可选 nextCursor。",
      parameters: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["twitter", "weibo", "xiaohongshu", "wechat_moments"],
            description: "目标社交平台。",
          },
          query: {
            type: "string",
            description: "搜索关键词 / 话题（必填）。可用 # 标签 或 普通关键词。",
          },
          cursor: {
            type: "string",
            description: "（可选）翻页游标。",
          },
          limit: {
            type: "integer",
            description: "（可选）单页条数，默认 10。",
          },
        },
        required: ["platform", "query"],
        additionalProperties: false,
      },
    },
  },
];
