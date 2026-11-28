/**
 * Adaptive Hierarchical Tool Intelligence System —— Phase-1 三级元数据模型。
 *
 * 设计要点：
 *   - 三级元数据分级存储 / 分级加载：
 *       Level-1 索引  → Qdrant 向量库 + Redis 热点（高频访问，体积小）
 *       Level-2 能力  → SQLite（结构化描述，按 resource_id 批量读）
 *       Level-3 Schema→ SQLite 延迟加载（仅命中后按需读取，服务启动绝对不预读）
 *   - ResourceRecord 聚合根只持有 level3_pointer（指针），不内嵌 Level-3 Schema，
 *     保证主记录读取恒定 O(1)、且不触发 Level-3 反序列化。
 *   - 所有类型用 TS type/interface（与项目 skills/types.ts 风格一致），
 *     枚举采用 `as const` + `typeof` 联合（参考 protocol-unified-errors.ts）。
 *
 * 与现有 DeferredToolEntry 的对齐：
 *   - embedding 维度由调用方决定（通常与 tool-embedding.ts 复用 text-embedding-3-small 1536 维）
 *   - domain / capability 字段对齐 tool-category.ts 的两层分类语义
 */

// ===== 枚举常量 =====

export const ResourceType = {
  Tool: "tool",
  Skill: "skill",
  McpServer: "mcp_server",
} as const;
export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

export const ResourceStatus = {
  Online: "online",
  Offline: "offline",
  RateLimited: "rate_limited",
  Maintenance: "maintenance",
} as const;
export type ResourceStatus = (typeof ResourceStatus)[keyof typeof ResourceStatus];

export const AuthLevel = {
  Default: "default",
  Admin: "admin",
  Guest: "guest",
} as const;
export type AuthLevel = (typeof AuthLevel)[keyof typeof AuthLevel];

export const Environment = {
  Dev: "dev",
  Staging: "staging",
  Prod: "prod",
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

// ===== Level-1 索引元数据 =====

/**
 * Level-1 索引元数据：常驻 Qdrant 向量库 + Redis 热点缓存。
 * 体积小、访问高频；只携带路由打分必需的最小字段。
 */
export type Level1IndexMeta = {
  /** 资源唯一标识（uuid v4，由 RegistryService 在注册时生成） */
  resource_id: string;
  resource_type: ResourceType;
  name: string;
  description: string;
  /** 所属域列表（与 tool-category.ts 的 Category 对齐，如 communication / system / phone） */
  domain: string[];
  /** 能力标签（二级前缀，如 phone.call / browser.navigate） */
  capability: string[];
  tags: string[];
  /** 语义化版本（如 1.0.0 / 1.2.0-beta.1） */
  version: string;
  status: ResourceStatus;
  /** 冷启动基础分（0~1）；新资源默认 0.5 保障曝光，避免被排在末尾 */
  base_score: number;
  /** 工具的多视图稠密向量；检索时对 query 取各视图 max-sim。 */
  embeddings: number[][];
  /** 声明时延（毫秒，按域估算，与 Python models 对齐）；重排阶段用作超时软惩罚 */
  latency_ms: number;
};

// ===== Level-2 能力描述元数据 =====

/**
 * Level-2 能力描述元数据：存 SQLite，结构化描述资源输入输出 / 使用场景 / 依赖。
 * 在 Level-1 命中后按需批量读取（按 resource_id 列表）。
 */
export type Level2CapabilityMeta = {
  resource_id: string;
  /** 输入类型签名（如 "object:SendEmailInput" / "text" / "json"） */
  input_type: string;
  /** 输出类型签名（如 "object:EmailSendResult" / "boolean"） */
  output_type: string;
  /** 典型使用场景（自然语言描述，用于召回时 prompt 拼接） */
  use_cases: string[];
  /** 能力限制（如 "不支持群发"、"单次最大 10MB"） */
  limitations: string[];
  /** 前置条件（如 "需要已配置 SMTP"） */
  preconditions: string[];
  /** 依赖的其他 resource_id 列表（用于循环依赖检测 + 图谱建边） */
  dependencies: string[];
};

// ===== Level-3 执行 Schema =====

/**
 * Level-3 执行 Schema 的参数定义（与 skills/types.ts 的 SkillParameter 对齐）。
 */
export type Level3Parameter = {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
  default?: unknown;
  enum?: unknown[];
};

/**
 * Level-3 Tool Schema：普通工具执行参数与校验规则。
 */
export type Level3ToolSchema = {
  resource_id: string;
  parameters: Level3Parameter[];
  /** 必填字段名列表（parameters 中 required=true 的子集，便于快速校验） */
  required_fields: string[];
  /** 参数级校验规则（如 { email: { format: "email" }, count: { min: 1, max: 100 } }） */
  validation_rules: Record<string, unknown>;
  /** 执行超时时间（毫秒） */
  timeout_ms: number;
};

/**
 * Level-3 Skill Schema：Skill 工作流编排结构。
 */
export type Level3SkillSchema = {
  resource_id: string;
  /** 工作流编排结构（DAG / 状态机描述，具体格式由 Skill 引擎解析） */
  workflow: Record<string, unknown>;
  /** 子工具执行序列（resource_id 或 registryName 列表） */
  subtools: string[];
  /** 分支条件（key 为分支名，value 为条件表达式） */
  branch_conditions: Record<string, unknown>;
  /** 重试策略 */
  retry_policy: { max_retries: number; backoff_ms: number };
  /** 异常兜底资源 id（无则 null） */
  fallback_resource_id: string | null;
};

/**
 * Level-3 MCP Schema：MCP Server 连接与调用配置。
 */
export type Level3McpSchema = {
  resource_id: string;
  transport: "stdio" | "sse" | "http";
  endpoint: string;
  /** 暴露的 RPC 方法名列表 */
  rpc_methods: string[];
  /** 鉴权配置（不内嵌明文密钥，存引用 + 运行时解密） */
  auth_config: Record<string, unknown>;
  /** 连接池大小 */
  pool_size: number;
  /** 心跳探测间隔（毫秒） */
  heartbeat_interval_ms: number;
};

/** Level-3 Schema 联合类型（按 resource_type 区分） */
export type Level3Schema = Level3ToolSchema | Level3SkillSchema | Level3McpSchema;

/** Level-3 Schema 类型标签（持久化到 SQLite 的 schema_type 字段，便于反序列化时识别） */
export const Level3SchemaType = {
  Tool: "tool",
  Skill: "skill",
  Mcp: "mcp",
} as const;
export type Level3SchemaType = (typeof Level3SchemaType)[keyof typeof Level3SchemaType];

// ===== 版本管理 =====

/**
 * 资源版本记录：一个 resource_id 下可有多个历史版本，仅一个 is_active=true。
 */
export type ResourceVersion = {
  /** 语义化版本号 */
  version: string;
  /** 发布时间（ISO 8601 字符串） */
  released_at: string;
  /** 灰度标记：true 表示仅灰度流量可见 */
  is_canary: boolean;
  /** 当前激活版本（同一 resource_id 下仅一个为 true） */
  is_active: boolean;
};

// ===== 资源主记录（聚合根）=====

/**
 * 资源主记录：三级元数据聚合根，存 SQLite。
 *
 * 注意：level3_pointer 仅是“指向 Level-3 Schema 存储位置的指针”，
 * 不内嵌 Level-3 Schema 数据本身——读取主记录时不会触发 Level-3 反序列化。
 * Level-3 Schema 的延迟加载逻辑在 Phase-7 lazy-loader 实现。
 */
export type ResourceRecord = {
  level1: Level1IndexMeta;
  level2: Level2CapabilityMeta;
  /** 指向 Level-3 Schema 存储位置的指针（当前实现 = resource_id，未来可换外部存储 key） */
  level3_pointer: string;
  /** 版本历史（含当前激活版本） */
  versions: ResourceVersion[];
  environment: Environment;
  tenant_id: string;
  auth_level: AuthLevel;
  created_at: string;
  updated_at: string;
};
