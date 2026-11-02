/**
 * 图片能力模块(图库)统一出口。
 *
 * 数据源:`@nextbot/picture` 的 PictureKit,按 actor 分区在
 * data/pictures/<actorKey>/(assets/thumbs/index.json)。
 */
import type { ToolRegistry } from "../../tool-registry.js";
import type { PictureKitRegistry } from "../../../services/picture-kit-registry.js";

import { createPictureGalleryHandler } from "./handlers.js";

export { PICTURE_INTENT_RULES } from "./intent.js";

/** 注册 picture 工具到 ToolRegistry(调用方:create-app-services.ts 启动阶段) */
export function registerPictureModuleTools(
  registry: ToolRegistry,
  deps: { pictureKits: PictureKitRegistry },
): void {
  registry.register("picture.gallery", createPictureGalleryHandler(deps.pictureKits));
}
