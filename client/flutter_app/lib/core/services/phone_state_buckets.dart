import "dart:convert";

/// 手机状态 15 分钟桶聚合（2026-11-23 主动触达 M1，需求文档 §7.2）。
///
/// 病根：手机状态是「一秒一个事实」的流，服务端要的是「那半个小时这人在不在用手机」。
/// 原始事件不出端——既是隐私账（解锁时刻序列能反推出作息，比桶多得多），
/// 也是流量账（亮灭屏一天几百次）。所以在这里就地聚合成桶再报。
///
/// 口径：
///   - 桶起点按本地 15 分钟对齐（00/15/30/45），服务端跨天统计不用换算；
///   - 亮屏/通话时长按相邻两帧之间的时间累加，跨越桶界的那段**切开**分别记账
///     （原生只在状态变化时推帧，两帧之间可能隔十分钟，全塞进一个桶会歪）；
///   - unlocks 数的是「锁 → 解锁」沿，不是亮屏次数（亮屏看一眼没解锁不算用）；
///   - charging/dnd 取桶内最后一次观测值（它们是状态，不是时长）。
class PhoneStateBucket {
  PhoneStateBucket(this.startMs);

  final int startMs;
  int unlocks = 0;
  int screenOnMs = 0;
  int inCallMs = 0;
  bool charging = false;
  bool dnd = false;

  Map<String, dynamic> toJson() => <String, dynamic>{
        "bucket": startMs,
        "unlocks": unlocks,
        "screenOnMin": (screenOnMs / 60000).round(),
        "inCallMin": (inCallMs / 60000).round(),
        "charging": charging,
        "dnd": dnd,
      };
}

class PhoneStateBucketAggregator {
  PhoneStateBucketAggregator({
    this.bucketMs = 15 * 60 * 1000,
    int Function()? clock,
    this.maxPending = 96,
  }) : _clock = clock ?? (() => DateTime.now().millisecondsSinceEpoch);

  final int bucketMs;
  final int Function() _clock;

  /// 未送出的桶上限（96 个 = 24 小时）：长期离线不倒空时丢最老的，不撑爆内存
  final int maxPending;

  final List<PhoneStateBucket> _pending = <PhoneStateBucket>[];
  PhoneStateBucket? _current;
  int _lastAtMs = 0;
  bool _lastScreenOn = true;
  bool _lastInCall = false;
  bool _lastInteractive = false;

  void _openBucket(int atMs) {
    final int start = (atMs ~/ bucketMs) * bucketMs;
    _current = PhoneStateBucket(start);
    _pending.add(_current!);
    if (_pending.length > maxPending) _pending.removeRange(0, _pending.length - maxPending);
  }

  /// 把 [fromMs, toMs) 这段时长按桶界切开累加
  void _accumulate(int fromMs, int toMs, {required bool screenOn, required bool inCall}) {
    int cursor = fromMs;
    while (cursor < toMs) {
      PhoneStateBucket? b = _current;
      if (b == null || cursor >= b.startMs + bucketMs) {
        _openBucket(cursor);
        b = _current;
      }
      final int end = toMs < b!.startMs + bucketMs ? toMs : b.startMs + bucketMs;
      final int span = end - cursor;
      if (span <= 0) break;
      if (screenOn) b.screenOnMs += span;
      if (inCall) b.inCallMs += span;
      cursor = end;
    }
  }

  /// 每来一帧原生状态调一次。[state] 用原生帧的字段名（interactive/screenOn/inCall/dnd/charging）。
  void observe(Map<String, dynamic> state, {int? atMs}) {
    final int now = atMs ?? _clock();
    final bool screenOn = state["screenOn"] != false;
    final bool inCall = state["inCall"] == true;
    final bool interactive = state["interactive"] == true;
    final bool dnd = state["dnd"] == true;
    final bool charging = state["charging"] == true;

    if (_lastAtMs > 0 && now > _lastAtMs) {
      // 只累加 3 个桶长以内的间隔：App 被冻结/重启造成的空档不算「一直灭屏」，直接跳过
      final int cappedTo = now - _lastAtMs > 3 * bucketMs ? _lastAtMs : now;
      _accumulate(_lastAtMs, cappedTo, screenOn: _lastScreenOn, inCall: _lastInCall);
    }
    // 时长先结算、桶后对齐：这一帧的沿与标志属于 `now` 所在的桶，
    // 记到很久以前打开、还没推进的旧桶里就等于把 11 点的解锁算进早上 9 点。
    _ensureCurrent(now);
    final PhoneStateBucket open = _current!;
    open.charging = charging;
    open.dnd = dnd;
    if (interactive && !_lastInteractive) open.unlocks += 1;
    _lastInteractive = interactive;
    _lastScreenOn = screenOn;
    _lastInCall = inCall;
    _lastAtMs = now;
  }

  /// 保证 `_current` 覆盖 [atMs]；还没有任何一帧时，第一个桶由第一帧开启
  /// （构造即开桶会把「还不知道」报成「这 15 分钟一次都没亮屏」）。
  void _ensureCurrent(int atMs) {
    final PhoneStateBucket? c = _current;
    if (c != null && atMs >= c.startMs && atMs < c.startMs + bucketMs) return;
    _openBucket(atMs);
  }

  /// 取走「已经结束」的桶（当前桶留着继续累加）。上报成功后不需要 ack——
  /// 桶是可重放的历史统计，下一轮再带一次也比丢了好。
  List<Map<String, dynamic>> drainClosed() {
    final int currentStart = _current?.startMs ?? 0;
    final List<Map<String, dynamic>> out = _pending
        .where((PhoneStateBucket b) => b.startMs < currentStart)
        .map((PhoneStateBucket b) => b.toJson())
        .toList(growable: false);
    _pending.removeWhere((PhoneStateBucket b) => b.startMs < currentStart);
    return out;
  }

  /// 当前桶快照（诊断/自测用，不出端）
  Map<String, dynamic>? get currentBucket => _current?.toJson();

  @override
  String toString() => jsonEncode(<String, dynamic>{"pending": _pending.length});
}
