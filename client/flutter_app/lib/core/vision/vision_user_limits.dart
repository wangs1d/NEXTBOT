/// 用户侧一次随消息发送的视觉帧上限（与默认 `AGENT_VISION_MAX_FRAMES` 对齐，避免 WS 校验失败）。
const int kAgentUserVisionMaxFrames = 4;

/// 服务端单帧上限默认 4MiB（`AGENT_VISION_MAX_BYTES_PER_FRAME`）。
/// 客户端把发送目标压到 3MiB，留 1MiB 余量给不同平台编码差异。
const int kAgentUserVisionMaxBytesPerFrame = 3 * 1024 * 1024;

/// 小于该值的图片不重编码：再压缩收益有限，还会多一次 isolate 开销。
const int kAgentUserVisionSkipBytes = 256 * 1024;

/// 视觉模型主流输入规格：最长边 2048px 足够可读，再大只增加 token 成本。
const int kAgentUserVisionMaxEdgePx = 2048;
