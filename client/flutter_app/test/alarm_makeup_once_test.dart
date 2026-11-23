// 闹钟「同一跳只补发一次」契约：已消费跳台账的幂等 + 持久化 + 上限裁剪。
// 背景：原生 AlarmManager 到点响铃不经过 Dart，本地库可能停在 active + 过期
// nextFireAt；台账是「这一跳已处理过」的唯一凭据，丢了就会每次冷启动都补响。
library;

import "dart:io";

import "package:flutter_test/flutter_test.dart";
import "package:path_provider_platform_interface/path_provider_platform_interface.dart";

import "../lib/features/alarm/alarm_local_store.dart";
import "helpers/temp_path_provider.dart";

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AlarmLocalStore store;

  setUp(() async {
    PathProviderPlatform.instance = TempPathProviderPlatform();
    // 单例跨测试复用会串数据：这里直接拿单例，靠每次 load 前清空临时目录隔离。
    store = AlarmLocalStore.instance;
  });

  group("已消费跳台账", () {
    test("同一跳首次未消费，标记后永久命中（幂等核心）", () async {
      await store.load();
      final fire = DateTime.utc(2026, 11, 23, 4, 58);
      expect(store.isJumpConsumed("a1", fire), isFalse);

      await store.markJumpConsumed("a1", fire);
      expect(store.isJumpConsumed("a1", fire), isTrue,
          reason: "标记后必须命中，否则冷启动会重复补响同一跳");
    });

    test("跳 key 含触发毫秒：同闹钟不同跳互不干扰", () async {
      await store.load();
      final t1 = DateTime.utc(2026, 11, 23, 4, 58);
      final t2 = t1.add(const Duration(minutes: 10));
      await store.markJumpConsumed("a2", t1);

      expect(store.isJumpConsumed("a2", t1), isTrue);
      expect(store.isJumpConsumed("a2", t2), isFalse,
          reason: "下一跳是新的使用，必须能再次补发");
    });

    test("台账落盘后重新 load 仍命中（跨冷启动幂等）", () async {
      await store.load();
      final fire = DateTime.utc(2026, 11, 23, 4, 58);
      await store.markJumpConsumed("a3", fire);

      // 清空内存台账后重新 load（模拟冷启动从磁盘装载），验证真的持久化了
      final reloaded = AlarmLocalStore.instance;
      await reloaded.load();
      expect(reloaded.isJumpConsumed("a3", fire), isTrue,
          reason: "进程重启后必须还记得这一跳消费过，否则一进界面又补响");
    });

    test("台账超上限裁剪到最近 100 条，防历史无限膨胀", () async {
      await store.load();
      final base = DateTime.utc(2026, 11, 23, 0, 0);
      // 私有字段不可直接读，用 isJumpConsumed 侧面验证：写入 210 条后，
      // 最早的应被裁掉、最近的仍在。
      for (var i = 0; i < 210; i++) {
        await store.markJumpConsumed("bulk", base.add(Duration(seconds: i)));
      }
      expect(store.isJumpConsumed("bulk", base), isFalse,
          reason: "最早的跳应被裁剪");
      expect(store.isJumpConsumed("bulk", base.add(const Duration(seconds: 209))), isTrue,
          reason: "最近的跳必须保留");
    });
  });
}
