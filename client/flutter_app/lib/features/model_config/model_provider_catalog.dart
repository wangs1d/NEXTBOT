/// 模型接入目录：provider 目录式选择的数据源。
///
/// 单一数据源在服务端：GET {httpBase}/api/model-providers（config/model-providers.json
/// 每请求实时读取，改 JSON 即生效，无需重新构建客户端）。请求失败回落 [baked]
/// （与 JSON 同源维护，仅保命）。向导「模型接入」与设置页「模型服务」共用
/// [ModelProviderCard]，用户只需：选服务商 → 按引导拿 key → 选模型 → 填 key。
library;

import "dart:async";
import "dart:convert";

import "package:http/http.dart" as http;

import "../../core/services/nb_http.dart";

import "../../core/config/api_config.dart";

/// 单个可选模型。
class ModelChoice {
  const ModelChoice({required this.id, this.label, this.recommended = false});

  final String id;
  final String? label;
  final bool recommended;

  String get displayLabel => label ?? id;
}

/// 一个模型服务商目录项：base URL / 默认模型 / key 申请引导全部随目录下发。
class ModelProviderOption {
  const ModelProviderOption({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.defaultModel,
    required this.models,
    this.tagline,
    this.consoleUrl,
    this.guide = const <String>[],
    this.note,
  });

  factory ModelProviderOption.fromJson(Map<String, dynamic> json) {
    final List<dynamic> rawModels = json["models"] as List<dynamic>? ?? <dynamic>[];
    return ModelProviderOption(
      id: json["id"]?.toString() ?? "",
      name: json["name"]?.toString() ?? "",
      tagline: json["tagline"]?.toString(),
      baseUrl: json["baseUrl"]?.toString() ?? "",
      defaultModel: json["defaultModel"]?.toString() ?? "",
      consoleUrl: json["consoleUrl"]?.toString(),
      guide: (json["guide"] as List<dynamic>? ?? <dynamic>[])
          .map((dynamic e) => e.toString())
          .toList(growable: false),
      note: json["note"]?.toString(),
      models: rawModels
          .map((dynamic m) {
            if (m is! Map) return null; // 与服务端目录过滤一致：非对象条目剔除
            return ModelChoice(
              id: m["id"]?.toString() ?? "",
              label: m["label"]?.toString(),
              recommended: m["recommended"] == true,
            );
          })
          .whereType<ModelChoice>()
          .where((ModelChoice c) => c.id.isNotEmpty)
          .toList(growable: false),
    );
  }

  final String id;
  final String name;
  final String? tagline;
  final String baseUrl;
  final String defaultModel;
  final String? consoleUrl;
  final List<String> guide;
  final String? note;
  final List<ModelChoice> models;

  /// base URL 匹配（回显用）：忽略尾部「/」；DeepSeek 的 /v1 别名两侧等价。
  bool matchesBaseUrl(String? url) {
    return _baseVariants(url).intersection(_baseVariants(baseUrl)).isNotEmpty;
  }

  static Set<String> _baseVariants(String? url) {
    final String u = normalizeBaseUrl(url);
    if (u.isEmpty) return const <String>{};
    final Set<String> out = <String>{u};
    if (u.endsWith("/v1")) out.add(u.substring(0, u.length - 3));
    return out;
  }
}

/// base URL 归一：去空白、去尾部「/」。
String normalizeBaseUrl(String? url) {
  if (url == null) return "";
  String u = url.trim();
  while (u.endsWith("/")) {
    u = u.substring(0, u.length - 1);
  }
  return u;
}

/// 用户在卡片里填出的结果（宿主负责落盘 config.env + 重启 runtime）。
class ModelConfigDraft {
  const ModelConfigDraft({
    required this.providerId,
    required this.baseUrl,
    required this.model,
    required this.apiKey,
  });

  final String providerId; // [ModelProviderCatalog.customId] 表示自定义
  final String baseUrl;
  final String model;
  final String apiKey;
}

/// 从现有 config.env 键解析回目录选择（重进向导/设置页回显）。
/// 匹配不到目录商 → 自定义（保留原 base/model，绝不悄悄替用户改配置）。
({ModelProviderOption? provider, String model, String baseUrl, bool custom})
    resolveModelSelection({
  required List<ModelProviderOption> providers,
  String? baseUrl,
  String? model,
}) {
  for (final ModelProviderOption p in providers) {
    if (p.matchesBaseUrl(baseUrl)) {
      final String m = (model == null || model.isEmpty) ? p.defaultModel : model;
      return (provider: p, model: m, baseUrl: p.baseUrl, custom: false);
    }
  }
  return (provider: null, model: model ?? "", baseUrl: baseUrl ?? "", custom: true);
}

class ModelProviderCatalog {
  ModelProviderCatalog._();

  /// 自定义（OpenAI 兼容）选项 id（UI 内置项，非服务端目录）。
  static const String customId = "custom";

  /// 服务端目录（失败回落 [baked]）。
  static Future<List<ModelProviderOption>> load() async {
    try {
      final http.Response res = await NbHttp.get(Uri.parse("${ApiConfig.httpBase}/api/model-providers"))
          .timeout(const Duration(seconds: 3));
      if (res.statusCode == 200) {
        final dynamic parsed = jsonDecode(utf8.decode(res.bodyBytes));
        if (parsed is Map && parsed["ok"] == true && parsed["providers"] is List) {
          final List<ModelProviderOption> list =
              (parsed["providers"] as List<dynamic>)
                  .map((dynamic e) =>
                      e is Map ? ModelProviderOption.fromJson(Map<String, dynamic>.from(e)) : null)
                  .whereType<ModelProviderOption>()
                  .where((ModelProviderOption p) =>
                      p.id.isNotEmpty && p.baseUrl.isNotEmpty && p.models.isNotEmpty)
                  .toList(growable: false);
          if (list.isNotEmpty) return list;
        }
      }
    } catch (_) {/* runtime 不可达：回落 baked */}
    return baked;
  }

  /// 兜底目录（与 server/config/model-providers.json 同源维护；仅 runtime 不可达时保命）。
  static const List<ModelProviderOption> baked = <ModelProviderOption>[
    ModelProviderOption(
      id: "deepseek",
      name: "DeepSeek",
      tagline: "性价比高 · 中文强",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-flash",
      models: <ModelChoice>[
        ModelChoice(id: "deepseek-flash", label: "deepseek-flash · V4.1-Flash（推荐）", recommended: true),
        ModelChoice(id: "deepseek-v4-pro", label: "deepseek-v4-pro · 旗舰"),
      ],
      consoleUrl: "https://platform.deepseek.com/api_keys",
      guide: <String>[
        "打开 DeepSeek 开放平台，注册并登录",
        "左侧「API Keys」→ 创建新 key，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "新用户通常有免费额度，用完后需充值。",
    ),
    ModelProviderOption(
      id: "moonshot",
      name: "Kimi（月之暗面）",
      tagline: "长上下文 · 旗舰 K3",
      baseUrl: "https://api.moonshot.cn/v1",
      defaultModel: "kimi-k3",
      models: <ModelChoice>[
        ModelChoice(id: "kimi-k3", label: "kimi-k3 · 旗舰（推荐）", recommended: true),
        ModelChoice(id: "kimi-k2.6", label: "kimi-k2.6 · 支持视觉"),
        ModelChoice(id: "kimi-k2.7-code", label: "kimi-k2.7-code · 编程向"),
      ],
      consoleUrl: "https://platform.kimi.com/console/api-keys",
      guide: <String>[
        "打开 Kimi 开放平台，注册并登录",
        "控制台「API Key 管理」→ 新建 key，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "国内用 api.moonshot.cn；海外账号请选「自定义」并填 https://api.moonshot.ai/v1。",
    ),
    ModelProviderOption(
      id: "zhipu",
      name: "智谱 GLM",
      tagline: "GLM-5.3 旗舰 · 有免费模型",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-5.3",
      models: <ModelChoice>[
        ModelChoice(id: "glm-5.3", label: "glm-5.3 · 旗舰（推荐）", recommended: true),
        ModelChoice(id: "glm-5.2", label: "glm-5.2"),
        ModelChoice(id: "glm-4.7-flash", label: "glm-4.7-flash · 免费"),
      ],
      consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      guide: <String>[
        "打开智谱 BigModel 开放平台，注册并登录",
        "「API 密钥」页 → 新建密钥，复制（形如 xxxx.yyyy）",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "glm-4.7-flash 免费，零成本先跑起来。",
    ),
    ModelProviderOption(
      id: "dashscope",
      name: "通义千问 Qwen",
      tagline: "阿里云百炼 · Qwen 3.8",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen3.8-max",
      models: <ModelChoice>[
        ModelChoice(id: "qwen3.8-max", label: "qwen3.8-max · 旗舰（推荐）", recommended: true),
        ModelChoice(id: "qwen3.7-plus", label: "qwen3.7-plus · 均衡"),
        ModelChoice(id: "qwen3.8-flash", label: "qwen3.8-flash · 快速便宜"),
      ],
      consoleUrl: "https://bailian.console.aliyun.com/?apiKey=1",
      guide: <String>[
        "打开阿里云百炼控制台，用阿里云账号登录并开通服务",
        "「API-KEY 管理」→ 创建 API Key，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "新账号开通百炼后通常有免费额度。",
    ),
    ModelProviderOption(
      id: "minimax",
      name: "MiniMax",
      tagline: "M3 · 与语音通话同源",
      baseUrl: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M3",
      models: <ModelChoice>[
        ModelChoice(id: "MiniMax-M3", label: "MiniMax-M3（推荐）", recommended: true),
      ],
      consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
      guide: <String>[
        "打开 MiniMax 开放平台，注册并登录",
        "「接口密钥」→ 创建新密钥，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "之后若要使用语音通话，同一家的 key 可复用在语音设置里。",
    ),
    ModelProviderOption(
      id: "siliconflow",
      name: "硅基流动 SiliconFlow",
      tagline: "一个 key 用多家开源模型",
      baseUrl: "https://api.siliconflow.cn/v1",
      defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
      models: <ModelChoice>[
        ModelChoice(id: "deepseek-ai/DeepSeek-V4-Flash", label: "DeepSeek-V4-Flash（推荐）", recommended: true),
        ModelChoice(id: "Pro/deepseek-ai/DeepSeek-V4", label: "Pro/DeepSeek-V4 · 加速版"),
        ModelChoice(id: "Pro/zai-org/GLM-5.2", label: "Pro/GLM-5.2"),
        ModelChoice(id: "moonshotai/Kimi-K2.7-Code", label: "Kimi-K2.7-Code"),
      ],
      consoleUrl: "https://cloud.siliconflow.cn/account/ak",
      guide: <String>[
        "打开硅基流动控制台，注册并登录",
        "「API 密钥」→ 新建 API 密钥，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "注册送额度，部分小模型免费。模型名格式为「厂商/模型」。",
    ),
    ModelProviderOption(
      id: "openai",
      name: "OpenAI",
      tagline: "国际主流 · 需海外支付",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.1",
      models: <ModelChoice>[
        ModelChoice(id: "gpt-5.1", label: "gpt-5.1（推荐）", recommended: true),
        ModelChoice(id: "gpt-5.1-mini", label: "gpt-5.1-mini · 便宜"),
      ],
      consoleUrl: "https://platform.openai.com/api-keys",
      guide: <String>[
        "打开 OpenAI 平台，注册并登录",
        "「API keys」→ Create new secret key，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "国内网络通常无法直连，需自行解决网络环境与支付方式。",
    ),
    ModelProviderOption(
      id: "openrouter",
      name: "OpenRouter",
      tagline: "一个 key 调全球模型",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "openrouter/auto",
      models: <ModelChoice>[
        ModelChoice(id: "openrouter/auto", label: "openrouter/auto · 自动路由（推荐）", recommended: true),
      ],
      consoleUrl: "https://openrouter.ai/settings/keys",
      guide: <String>[
        "打开 OpenRouter，注册并登录",
        "「Keys」→ Create key，复制",
        "把 key 粘贴到下方，点「测试连接」",
      ],
      note: "模型名格式为「厂商/模型」，完整清单见其控制台；auto 会自动选型。",
    ),
  ];
}
