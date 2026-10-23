import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/services/client_update_checker.dart";

void main() {
  group("compareVersions", () {
    test("点分数字逐段比较，不受字符串字典序误导", () {
      // 字符串直接比较会得到 "0.1.15" < "0.1.9" 的相反结果
      expect(compareVersions("0.1.15", "0.1.9"), greaterThan(0));
      expect(compareVersions("0.1.9", "0.1.15"), lessThan(0));
      expect(compareVersions("0.2.0", "0.1.99"), greaterThan(0));
      expect(compareVersions("0.10.0", "0.9.9"), greaterThan(0));
      expect(compareVersions("1.0.0", "0.99.99"), greaterThan(0));
    });

    test("相等与 build 尾缀忽略", () {
      // 本地版本来自 exe 资源（pubspec version 含 +build），manifest 是三段式
      expect(compareVersions("0.1.0+1", "0.1.0"), 0);
      expect(compareVersions("0.1.0", "0.1.0"), 0);
      expect(compareVersions("1.2.3+42", "1.2.3+7"), 0);
    });

    test("段数不齐时短侧补零", () {
      expect(compareVersions("0.1", "0.1.0"), 0);
      expect(compareVersions("0.1.1", "0.1"), greaterThan(0));
    });

    test("非法段按 0 处理不抛异常", () {
      expect(compareVersions("0.1.x", "0.1.0"), 0);
      expect(compareVersions("", "0.0.0"), 0);
    });
  });

  group("ClientManifest.fromJson", () {
    test("完整字段解析", () {
      final ClientManifest m = ClientManifest.fromJson(<String, dynamic>{
        "ok": true,
        "latest": "0.2.0",
        "minVersion": "0.1.5",
        "url": "https://obs.example.com/NextBot-Setup-0.2.0.exe",
        "notes": "修复若干问题",
        "channel": "byok",
      });
      expect(m.latest, "0.2.0");
      expect(m.minVersion, "0.1.5");
      expect(m.url, startsWith("https://"));
      expect(m.notes, "修复若干问题");
      expect(m.channel, "byok");
    });

    test("字段缺失时回退默认（channel=byok，其余空串）", () {
      final ClientManifest m = ClientManifest.fromJson(<String, dynamic>{
        "latest": "0.2.0",
        "minVersion": "0.1.5",
      });
      expect(m.url, "");
      expect(m.notes, "");
      expect(m.channel, "byok");
    });
  });
}
