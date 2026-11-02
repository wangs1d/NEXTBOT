import "dart:async";

import "package:flutter/painting.dart";

import "../../core/config/media_url.dart";

/// 行程图预热器：行程数据到手即并发预取（封面优先、条目实拍跟随），
/// 卡片海报/画廊/面板打开时全部命中内存缓存——打开即见，不闪渐变占位。
///
/// 设计要点：
/// - 全局去重（Set），卡片 build/消息到达等多处触发只生效一次；
/// - 有界并发（默认 4 路），不与聊天图片流量抢带宽；
/// - 不依赖 BuildContext 存活：不挂 Element 树，卡片滚出列表/重建都不受影响；
/// - 失败静默完成（展示层自有渐变/候选回退），单图 20s 超时防止占死 worker。
abstract final class TravelImageWarmer {
  /// 已预热过的 URL（跨卡片全局去重）。
  static final Set<String> _warmed = <String>{};

  /// 并发路数。
  static const int _concurrency = 4;

  /// 单图预取超时。
  static const Duration _timeout = Duration(seconds: 20);

  /// 预热一组图（URL 需已完成 resolveTravelMediaUrl 归一）。同步入队、
  /// 异步执行，永不抛异常。
  static void warm(List<String> urls) {
    final List<String> pending = <String>[
      for (final String u in urls)
        if (u.startsWith("http") && _warmed.add(u)) u,
    ];
    if (pending.isEmpty) return;
    const ImageConfiguration config = ImageConfiguration.empty;
    int cursor = 0;
    Future<void> worker() async {
      while (cursor < pending.length) {
        final int idx = cursor++;
        try {
          await _warmOne(config, pending[idx]).timeout(_timeout);
        } catch (_) {/* 失败静默：展示层有渐变与候选回退 */}
      }
    }

    for (int i = 0; i < _concurrency && i < pending.length; i++) {
      unawaited(worker());
    }
  }

  /// 单图预取：首帧解码完成/失败都安静收场。
  static Future<void> _warmOne(ImageConfiguration config, String url) {
    final Completer<void> done = Completer<void>();
    final ImageStream stream = NetworkImage(
      url,
      headers: MediaUrl.headersFor(url),
    ).resolve(config);
    late final ImageStreamListener listener;
    listener = ImageStreamListener(
      (ImageInfo _, bool __) {
        if (!done.isCompleted) done.complete();
      },
      onError: (Object _, StackTrace? __) {
        if (!done.isCompleted) done.complete();
      },
    );
    stream.addListener(listener);
    return done.future.whenComplete(() => stream.removeListener(listener));
  }
}
