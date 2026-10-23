import type { PictureKit } from "@nextbot/picture";

import type { ToolHandler } from "../../tools/tool-registry.js";
import type { SkillDefinition, SkillHandler } from "../types.js";
import { createPictureGalleryHandler } from "../../tools/capability-modules/picture/handlers.js";
import {
  createPictureHousekeepingHandler,
  createPictureMemoriesHandler,
  createPictureStylizeHandler,
} from "../../tools/capability-modules/photo/handlers.js";

/**
 * 内置 Skill：图片能力套件（PictureKit）→ skill 库（进程内检索）。
 *
 * 数据源是 `@nextbot/picture` 的 PictureKit（存储根 data/pictures），
 * skill 注册后经 buildSessionSkillChatTools → 延迟工具目录 →
 * 检索进程内化后，skill schema 直接进入进程内延迟目录，
 * 执行时 ToolRegistry 优先走 SkillManager（picture.gallery
 * 与 capability-module 工具同名，capability chatTools 已置空避免 schema 冲突）。
 *
 *   picture.gallery     图库查询 / 打标 / 评分 / 场景 / 统计
 *   picture.generate    文生图（OpenAI 兼容 provider）
 *   picture.process     图像处理：缩放 / 裁剪 / 旋转 / 调整 / 水印 / 格式转换
 *   picture.analyze     图像解析：格式 / 尺寸 / EXIF / 色彩统计 / 自动标签
 *   picture.evaluate    照片质量评估打分（单张 / 批量 / 实时反馈）
 *   picture.store       图片存储管理：导入去重 / 查询 / 删除 / 清理
 *   picture.stylize     照片风格化：撕纸海报 / 拍立得 / 黑白胶片 / 双色版画
 *   picture.housekeeping 清理治理：连拍/截图/迷你图建议与确认删除
 *   picture.memories    记忆回顾：近期事件簇聚合
 */

type Deps = {
  pictureKit: PictureKit;
};

/** 薄封装：走 kit 统一工具协议，把 ToolCallResponse 映射为 skill 结果约定（ok 布尔 + 字段平铺） */
async function invokeKitTool(
  pictureKit: PictureKit,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await pictureKit.invokeRaw(toolName, input);
  if (!response.success) {
    return { ok: false, error: response.error ?? `${toolName} 执行失败` };
  }
  return { ...(response.result ?? {}), ok: true };
}

/** 复用 capability-module 的 handler 工厂（含缩略图/原图 URL 富化），签名对齐 SkillHandler */
function adaptPictureHandler(handler: ToolHandler): SkillHandler {
  return (input, context) => handler(input, context);
}

export function createPictureBuiltinSkills(deps: Deps): SkillDefinition[] {
  const { pictureKit } = deps;

  const gallery: SkillDefinition = {
    metadata: {
      name: "picture.gallery",
      version: "1.0.0",
      displayName: "图片图库管理",
      description:
        "查询与管理本地照片图库：分页浏览最近照片、按标签筛选、查看单张详情、添加/移除收藏标签、评分、标记场景类型、查看图库统计。",
      kind: "builtin",
      tags: ["picture", "gallery", "photo", "照片", "图片", "相册", "图库", "收藏", "评分"],
      icon: "🖼️",
      parameters: [
        {
          name: "action",
          type: "string",
          required: false,
          default: "query",
          enum: ["query", "get", "add_tag", "remove_tag", "set_rating", "set_scene", "stats"],
          description: "操作类型，默认 query 分页查询",
        },
        { name: "page", type: "number", required: false, description: "页码（query，从 1 开始）" },
        { name: "pageSize", type: "number", required: false, description: "每页数量（query，最大 50）" },
        { name: "tagFilter", type: "string", required: false, description: "按标签筛选（query）" },
        { name: "photoId", type: "string", required: false, description: "照片 id（get/add_tag/remove_tag/set_rating/set_scene）" },
        { name: "tag", type: "string", required: false, description: "标签名（add_tag/remove_tag）" },
        { name: "rating", type: "number", required: false, description: "评分（set_rating）" },
        { name: "sceneType", type: "string", required: false, description: "场景类型（set_scene）" },
      ],
      outputSchema: { ok: "boolean", photos: "照片列表（含缩略图/原图 URL）", total: "总数" },
      permissions: ["storage:read", "filesystem:read"],
      timeoutMs: 10_000,
    },
    handler: adaptPictureHandler(createPictureGalleryHandler(pictureKit)),
  };

  const generate: SkillDefinition = {
    metadata: {
      name: "picture.generate",
      version: "1.0.0",
      displayName: "图片生成",
      description:
        "文生图：按提示词生成图片（OpenAI 兼容图片模型），可指定尺寸/数量/风格，生成结果落盘并返回本地路径。",
      kind: "builtin",
      tags: ["picture", "generate", "image", "画图", "画一张", "生成图片", "文生图", "插画"],
      icon: "🎨",
      parameters: [
        { name: "prompt", type: "string", required: true, description: "生成提示词" },
        { name: "size", type: "string", required: false, description: "尺寸，如 1024x1024" },
        { name: "n", type: "number", required: false, description: "生成张数，默认 1" },
        { name: "model", type: "string", required: false, description: "模型名，缺省用 provider 配置" },
        { name: "quality", type: "string", required: false, description: "质量档位" },
        { name: "style", type: "string", required: false, description: "风格档位" },
      ],
      outputSchema: { ok: "boolean", images: "生成结果列表（含本地路径）", count: "张数" },
      permissions: ["storage:write", "filesystem:write", "network:external"],
      timeoutMs: 120_000,
    },
    handler: async (input) => invokeKitTool(pictureKit, "image_generate", input),
  };

  const process: SkillDefinition = {
    metadata: {
      name: "picture.process",
      version: "1.0.0",
      displayName: "图像处理",
      description:
        "对本地图片文件做基础处理：缩放 resize / 裁剪 crop / 旋转 rotate / 翻转 flip / 调整 adjust（亮度对比度饱和度等）/ 格式转换 convert / 加水印 watermark / 查看信息 info。",
      kind: "builtin",
      tags: ["picture", "process", "resize", "crop", "缩放", "裁剪", "旋转", "水印", "格式转换", "处理图片"],
      icon: "🪄",
      parameters: [
        {
          name: "action",
          type: "string",
          required: true,
          enum: ["resize", "crop", "rotate", "flip", "adjust", "convert", "watermark", "info"],
          description: "处理操作类型",
        },
        { name: "input", type: "string", required: true, description: "图片文件路径" },
        { name: "output", type: "string", required: false, description: "输出文件路径，缺省自动生成" },
        { name: "width", type: "number", required: false, description: "目标宽度（resize/crop）" },
        { name: "height", type: "number", required: false, description: "目标高度（resize/crop）" },
        { name: "left", type: "number", required: false, description: "裁剪左上角 x（crop）" },
        { name: "top", type: "number", required: false, description: "裁剪左上角 y（crop）" },
        { name: "angle", type: "number", required: false, description: "旋转角度（rotate）" },
        { name: "adjustments", type: "object", required: false, description: "调整参数对象，如 {brightness:1.1, saturation:1.2}" },
        { name: "format", type: "string", required: false, enum: ["jpeg", "png", "webp", "tiff", "avif", "gif"], description: "目标格式（convert）" },
        { name: "quality", type: "number", required: false, description: "压缩质量（convert）" },
        { name: "watermark_path", type: "string", required: false, description: "水印图片路径（watermark）" },
      ],
      outputSchema: { ok: "boolean", result: "处理结果（含输出路径）" },
      permissions: ["storage:read", "storage:write", "filesystem:read", "filesystem:write"],
      timeoutMs: 30_000,
    },
    handler: async (input) => invokeKitTool(pictureKit, "image_process", input),
  };

  const analyze: SkillDefinition = {
    metadata: {
      name: "picture.analyze",
      version: "1.0.0",
      displayName: "图像解析",
      description:
        "解析本地图片文件：格式与尺寸、EXIF 元数据（相机/镜头/参数）、拍摄时间、主色调统计与自动内容标签。",
      kind: "builtin",
      tags: ["picture", "analyze", "exif", "metadata", "解析", "元数据", "拍摄时间", "主色调"],
      icon: "🔍",
      parameters: [
        { name: "input", type: "string", required: true, description: "图片文件路径" },
      ],
      outputSchema: { ok: "boolean", result: "解析结果（格式/尺寸/EXIF/色彩/标签）" },
      permissions: ["storage:read", "filesystem:read"],
      timeoutMs: 30_000,
    },
    handler: async (input) => invokeKitTool(pictureKit, "image_analyze", input),
  };

  const evaluate: SkillDefinition = {
    metadata: {
      name: "picture.evaluate",
      version: "1.0.0",
      displayName: "照片质量评估",
      description:
        "对照片做摄影质量评估打分（构图/曝光/色彩等维度）：单张 evaluate、批量 evaluate_batch、实时取景建议 live_feedback。",
      kind: "builtin",
      tags: ["picture", "evaluate", "score", "照片打分", "评估", "质量", "构图", "拍得怎么样"],
      icon: "⭐",
      parameters: [
        {
          name: "action",
          type: "string",
          required: true,
          enum: ["evaluate", "evaluate_batch", "live_feedback", "capture_and_evaluate", "capture_and_feedback"],
          description: "评估操作类型",
        },
        { name: "photo_path", type: "string", required: false, description: "照片路径（evaluate）" },
        { name: "photo_paths", type: "array", required: false, description: "照片路径列表（evaluate_batch）" },
        { name: "frame_path", type: "string", required: false, description: "取景帧路径（live_feedback）" },
        { name: "target_params", type: "object", required: false, description: "目标参数（live_feedback）" },
        { name: "photo_id", type: "string", required: false, description: "关联图库照片 id（可选）" },
      ],
      outputSchema: { ok: "boolean", result: "评估结果（分数与维度明细）" },
      permissions: ["storage:read", "filesystem:read"],
      timeoutMs: 60_000,
    },
    handler: async (input) => invokeKitTool(pictureKit, "evaluation", input),
  };

  const store: SkillDefinition = {
    metadata: {
      name: "picture.store",
      version: "1.0.0",
      displayName: "图片存储管理",
      description:
        "图片存储库管理：导入照片 ingest（SHA-256 去重、自动建缩略图）、按条件查询 query、删除 remove、孤儿清理 cleanup、索引落盘 persist、统计 stats。",
      kind: "builtin",
      tags: ["picture", "store", "ingest", "导入照片", "存储", "去重", "清理", "入库"],
      icon: "🗃️",
      parameters: [
        {
          name: "action",
          type: "string",
          required: true,
          enum: ["ingest", "get", "query", "add_tag", "remove_tag", "set_scene", "set_rating", "remove", "stats", "cleanup", "persist"],
          description: "存储操作类型",
        },
        { name: "input", type: "string", required: false, description: "照片文件路径（ingest）" },
        { name: "options", type: "object", required: false, description: "导入选项，如 {file_name, tags, scene_type, dedupe}" },
        { name: "asset_id", type: "string", required: false, description: "照片 id（get/remove 等）" },
        { name: "filters", type: "object", required: false, description: "查询过滤条件，如 {tags:[\"收藏\"]}（query）" },
        { name: "page", type: "number", required: false, description: "页码（query）" },
        { name: "page_size", type: "number", required: false, description: "每页数量（query）" },
        { name: "sort_by", type: "string", required: false, description: "排序字段（query）" },
        { name: "sort_order", type: "string", required: false, description: "排序方向 asc/desc（query）" },
        { name: "tag", type: "string", required: false, description: "标签名（add_tag/remove_tag）" },
        { name: "scene_type", type: "string", required: false, description: "场景类型（set_scene）" },
        { name: "rating", type: "number", required: false, description: "评分（set_rating）" },
        { name: "delete_files", type: "boolean", required: false, description: "删除时是否同时删文件，默认 true（remove）" },
      ],
      outputSchema: { ok: "boolean", result: "存储操作结果" },
      permissions: ["storage:read", "storage:write", "filesystem:read", "filesystem:write"],
      timeoutMs: 30_000,
    },
    handler: async (input) => invokeKitTool(pictureKit, "image_store", input),
  };

  const stylize: SkillDefinition = {
    metadata: {
      name: "picture.stylize",
      version: "1.0.0",
      displayName: "照片风格化",
      description:
        "把图库里的照片变成另一种视觉风格（输出仍是图片，自动入库并贴上照片墙）。可用风格：poster_torn 撕纸海报（撕纸拼贴+纸张底纹+红色饰带+打字机标题）、polaroid 拍立得（白框+暖调褪色+手写签名）、noir 黑白胶片（高对比+颗粒+暗角）、print_duotone 双色版画（纸面双色强对比）。纯程序合成，零模型零网络。action=styles 查风格列表，action=apply 出图。",
      kind: "builtin",
      tags: ["picture", "stylize", "风格化", "海报", "撕纸", "拍立得", "黑白", "版画", "滤镜", "变成"],
      icon: "🖼️",
      parameters: [
        {
          name: "action",
          type: "string",
          required: false,
          default: "apply",
          enum: ["apply", "styles"],
          description: "apply=生成风格化版本；styles=列出可用风格",
        },
        { name: "photoId", type: "string", required: false, description: "图库照片 id（apply 必填，picture.gallery 查得）" },
        {
          name: "style",
          type: "string",
          required: false,
          enum: ["poster_torn", "polaroid", "noir", "print_duotone"],
          description: "目标风格（apply 必填）",
        },
        { name: "title", type: "string", required: false, description: "画面上的标题文字（如海报名/签名），不传用照片描述" },
      ],
      outputSchema: { ok: "boolean", photo: "新生成的风格化照片（含缩略图/原图 URL）", styleLabel: "风格名" },
      permissions: ["storage:read", "storage:write", "filesystem:read"],
      timeoutMs: 60_000,
    },
    handler: createPictureStylizeHandler(pictureKit) as SkillHandler,
  };

  const housekeeping: SkillDefinition = {
    metadata: {
      name: "picture.housekeeping",
      version: "1.0.0",
      displayName: "图库清理治理",
      description:
        "分析图库给出清理建议（连拍簇、截图、迷你小图），用户逐类确认后执行删除。删除是破坏性操作：必须先 action=suggest 展示建议、用户明确同意后再以 action=remove&confirmed=true 执行。",
      kind: "builtin",
      tags: ["picture", "cleanup", "清理", "整理", "删除照片", "去重", "治理", "释放空间"],
      icon: "🧹",
      parameters: [
        {
          name: "action",
          type: "string",
          required: true,
          enum: ["suggest", "remove"],
          description: "suggest=出清理建议；remove=确认删除",
        },
        { name: "photoIds", type: "array", required: false, description: "要删除的照片 id 列表（remove）" },
        { name: "confirmed", type: "boolean", required: false, description: "用户已明确同意删除后传 true（remove）" },
      ],
      outputSchema: { ok: "boolean", totalCandidates: "建议清理总数", removed: "已删除数" },
      permissions: ["storage:read", "storage:write", "filesystem:write"],
      timeoutMs: 60_000,
    },
    handler: createPictureHousekeepingHandler(pictureKit) as SkillHandler,
  };

  const memories: SkillDefinition = {
    metadata: {
      name: "picture.memories",
      version: "1.0.0",
      displayName: "照片记忆回顾",
      description:
        "把近期照片按事件聚合成「记忆」：默认回看最近 30 天，挑出照片最多的几段（时间/地点/代表照片与一句描述）。",
      kind: "builtin",
      tags: ["picture", "memories", "回忆", "记忆", "回顾", "这个月", "照片墙"],
      icon: "🕯️",
      parameters: [
        { name: "days", type: "number", required: false, description: "回看窗口天数，默认 30" },
        { name: "count", type: "number", required: false, description: "取几段记忆，默认 3" },
      ],
      outputSchema: { ok: "boolean", memories: "记忆段列表（含代表照片）", text: "一段可直读的汇总" },
      permissions: ["storage:read"],
      timeoutMs: 10_000,
    },
    handler: createPictureMemoriesHandler(pictureKit) as SkillHandler,
  };

  return [gallery, generate, process, analyze, evaluate, store, stylize, housekeeping, memories];
}

export function registerPictureBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: Deps,
): void {
  for (const s of createPictureBuiltinSkills(deps)) {
    register(s);
  }
}
