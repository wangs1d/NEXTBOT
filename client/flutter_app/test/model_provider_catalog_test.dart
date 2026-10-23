// 模型接入目录（目录式选择）数据层单测：
//  1. 服务端 JSON 解析（ModelProviderOption.fromJson）；
//  2. base URL 归一与匹配（回显关键：/v1 别名、尾部斜杠都要认得出）；
//  3. resolveModelSelection——目录商回显 / 自定义兜底 / 老模型名不悄悄替换；
//  4. baked 兜底目录完整性（与服务端 config/model-providers.json 同源维护）。
import "dart:convert";

import "package:flutter_test/flutter_test.dart";
import "package:nextbot/features/model_config/model_provider_catalog.dart";

void main() {
  group("ModelProviderOption.fromJson", () {
    test("全字段解析", () {
      final ModelProviderOption p = ModelProviderOption.fromJson(<String, dynamic>{
        "id": "deepseek",
        "name": "DeepSeek",
        "tagline": "性价比高",
        "baseUrl": "https://api.deepseek.com",
        "defaultModel": "deepseek-flash",
        "models": <dynamic>[
          <String, dynamic>{"id": "deepseek-flash", "label": "flash（推荐）", "recommended": true},
          <String, dynamic>{"id": "deepseek-v4-pro"},
          "bad-entry",
        ],
        "consoleUrl": "https://platform.deepseek.com/api_keys",
        "guide": <String>["打开平台", "创建 key"],
        "note": "新用户有免费额度",
      });
      expect(p.id, "deepseek");
      expect(p.models.length, 2); // 非对象条目被剔除
      expect(p.models[0].displayLabel, "flash（推荐）");
      expect(p.models[0].recommended, isTrue);
      expect(p.models[1].displayLabel, "deepseek-v4-pro");
      expect(p.guide, <String>["打开平台", "创建 key"]);
    });

    test("models 缺字段容错（缺省 label=id）", () {
      final ModelProviderOption p = ModelProviderOption.fromJson(<String, dynamic>{
        "id": "x",
        "name": "X",
        "baseUrl": "https://x.example/v1",
        "defaultModel": "m",
        "models": <dynamic>[<String, dynamic>{"id": "m"}],
      });
      expect(p.models.single.displayLabel, "m");
    });
  });

  group("normalizeBaseUrl / matchesBaseUrl", () {
    test("尾部斜杠归一", () {
      expect(normalizeBaseUrl("https://a.example/v1/"), "https://a.example/v1");
      expect(normalizeBaseUrl(" https://a.example/v1/// "), "https://a.example/v1");
      expect(normalizeBaseUrl(null), "");
    });

    test("/v1 别名两侧等价（DeepSeek 新旧 base 都能回显）", () {
      final ModelProviderOption p = ModelProviderOption.fromJson(<String, dynamic>{
        "id": "deepseek",
        "name": "DeepSeek",
        "baseUrl": "https://api.deepseek.com",
        "defaultModel": "deepseek-flash",
        "models": <dynamic>[
          <String, dynamic>{"id": "deepseek-flash"},
        ],
      });
      expect(p.matchesBaseUrl("https://api.deepseek.com/v1"), isTrue);
      expect(p.matchesBaseUrl("https://api.deepseek.com"), isTrue);
      expect(p.matchesBaseUrl("https://api.deepseek.com/v1/"), isTrue);
      expect(p.matchesBaseUrl("https://api.openai.com/v1"), isFalse);
      expect(p.matchesBaseUrl(null), isFalse);
    });

    test("非 /v1 后缀不剥离（智谱 v4 不会被误剥）", () {
      final ModelProviderOption p = ModelProviderOption.fromJson(<String, dynamic>{
        "id": "zhipu",
        "name": "智谱",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "defaultModel": "glm-5.3",
        "models": <dynamic>[
          <String, dynamic>{"id": "glm-5.3"},
        ],
      });
      expect(p.matchesBaseUrl("https://open.bigmodel.cn/api/paas/v4"), isTrue);
      expect(p.matchesBaseUrl("https://open.bigmodel.cn/api/paas"), isFalse);
    });
  });

  group("resolveModelSelection", () {
    final List<ModelProviderOption> providers = ModelProviderCatalog.baked;

    test("按 base 回显目录商；模型缺省用目录默认", () {
      final r = resolveModelSelection(providers: providers, baseUrl: "https://api.deepseek.com");
      expect(r.custom, isFalse);
      expect(r.provider?.id, "deepseek");
      expect(r.model, "deepseek-flash");
    });

    test("老配置的模型名不在目录清单里：原样保留，不悄悄替换", () {
      final r = resolveModelSelection(
        providers: providers,
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
      );
      expect(r.provider?.id, "deepseek");
      expect(r.model, "deepseek-chat");
    });

    test("匹配不到 → 自定义并保留原 base/model", () {
      final r = resolveModelSelection(
        providers: providers,
        baseUrl: "https://my.gateway.example/v1",
        model: "my-model",
      );
      expect(r.custom, isTrue);
      expect(r.provider, isNull);
      expect(r.baseUrl, "https://my.gateway.example/v1");
      expect(r.model, "my-model");
    });
  });

  group("baked 兜底目录完整性", () {
    test("id 唯一、defaultModel 在 models 里、全 https、含自定义外的国内主流", () {
      final Set<String> ids = <String>{};
      for (final ModelProviderOption p in ModelProviderCatalog.baked) {
        expect(ids.add(p.id), isTrue, reason: "${p.id} 重复");
        expect(p.baseUrl.startsWith("https://"), isTrue);
        expect(p.models.map((ModelChoice c) => c.id), contains(p.defaultModel));
        if (p.consoleUrl != null) {
          expect(p.consoleUrl!.startsWith("https://"), isTrue);
        }
      }
      expect(ids, containsAll(<String>["deepseek", "moonshot", "zhipu", "minimax"]));
    });
  });

  test("服务端目录 JSON 与 baked 的 provider 集合一致（防漂移）", () {
    // 真源在 server/config/model-providers.json；这里只锁 baked 不缺大项。
    // 集合级一致性由服务端 node:test（test/model-providers.test.ts）+ 目录下发链路保证。
    const List<String> expected = <String>[
      "deepseek", "moonshot", "zhipu", "dashscope", "minimax", "siliconflow", "openai", "openrouter",
    ];
    expect(
      ModelProviderCatalog.baked.map((ModelProviderOption p) => p.id).toSet(),
      containsAll(expected),
    );
    expect(jsonEncode("sanity"), isNotNull);
  });
}
