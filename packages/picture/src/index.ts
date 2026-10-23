/**
 * @nextbot/picture
 * 图片能力套件:图像生成、图像处理、图像解析、缩略图、存储管理,
 * 以及摄影 Agent 工具(移植自 photography_agent)。
 */
// 门面
export { createPictureKit } from './kit.js';
export type { PictureKit, PictureKitOptions } from './kit.js';

// 模型与协议
export * from './models.js';
export * from './registry.js';

// 图像解析
export { ImageAnalysisService } from './analysis/service.js';
export { computeImageStats } from './analysis/color.js';
export {
  parseExif,
  parseExifBlock,
  extractExifBlock,
  exifTimeToIso,
  parseRational,
} from './analysis/exif.js';

// 图像处理
export { ImageProcessingService } from './processing/service.js';
export type { ImageAdjustments, ProcessResult, OutputFormat, ResizeOptions, WatermarkOptions } from './processing/service.js';
export {
  BatchService,
  SharpBatchEngine,
  SCENE_PRESETS,
} from './processing/batch.js';
export type { BatchEngine, BatchAdjustments } from './processing/batch.js';

// 缩略图
export { ThumbnailService, THUMBNAIL_SIZES } from './thumbnails/service.js';
export type { ThumbnailSize } from './thumbnails/service.js';

// 图片生成
export {
  ImageGenerationService,
  OpenAIImageProvider,
} from './generation/service.js';
export type {
  ImageProvider,
  ImageGenerationRequest,
  GeneratedImage,
  ImageProviderGenerateOptions,
} from './generation/service.js';

// 存储管理
export { ImageStore } from './storage/manager.js';
export type {
  ImageStoreOptions,
  IngestOptions,
  IngestResult,
  QueryFilters,
  QueryParams,
  QueryResult,
  StoreStats,
} from './storage/manager.js';

// 摄影 Agent 能力(移植)
export { GalleryService } from './photography/gallery.js';
export { PresetService } from './photography/presets.js';
export { GuidanceService } from './photography/guidance.js';
export { HabitService } from './photography/habit.js';
export { EvaluationService, FileFallbackCapture } from './photography/evaluation.js';
export type { CameraCapture } from './photography/evaluation.js';

// 工具注册
export { registerPictureTools } from './tools.js';
