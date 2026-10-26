export interface PackageTrackConfig {
  /** 丰桥顾客编码（partnerID） */
  sfPartnerId: string;
  /** 丰桥 API 校验码（签名 word），沙箱/生产各一套 */
  sfCheckWord: string;
  sfApiBaseUrl: string;
  /**
   * 跨承运商查询白名单（逗号分隔的内部规范码，如 `ZTO,YD`）。
   * 缺省空 = 只查顺丰：丰桥路由查询对其他承运商的覆盖要**联调确认后才敢开**，
   * 默认全开会把一堆"查无此单"冒充成接口能力。
   */
  sfExtraCouriers: string[];
  timeoutMs: number;
}

export function getPackageTrackConfig(env: NodeJS.ProcessEnv = process.env): PackageTrackConfig {
  return {
    sfPartnerId: env.SF_QIAO_PARTNER_ID?.trim() || "",
    sfCheckWord: env.SF_QIAO_CHECK_WORD?.trim() || "",
    // 注意：open.sf-express.com 是控制台域名，真实调用主机是 sfapi.*（沙箱 sfapi-sbox.*）
    sfApiBaseUrl: env.SF_QIAO_API_BASE?.trim() || "https://sfapi.sf-express.com/std/service",
    sfExtraCouriers: (env.SF_QIAO_EXTRA_COURIERS?.trim() || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    timeoutMs: Number(env.SF_QIAO_TIMEOUT_MS ?? 8000),
  };
}
