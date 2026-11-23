// 手机状态 15 分钟桶聚合（需求 §7.2）：原始事件不出端，出端的是桶。
// 盯四件事：时长跨桶切分、解锁按沿计、冻结空档不补历史、只交已结束的桶。
import "package:nextbot/core/services/phone_state_buckets.dart";
import "package:flutter_test/flutter_test.dart";

void main() {
  const int bucketMs = 15 * 60 * 1000;
  final int t0 = DateTime(2026, 11, 23, 9, 0).millisecondsSinceEpoch;

  Map<String, dynamic> frame({
    bool interactive = false,
    bool screenOn = false,
    bool inCall = false,
    bool charging = false,
    bool dnd = false,
  }) =>
      <String, dynamic>{
        "interactive": interactive,
        "screenOn": screenOn,
        "inCall": inCall,
        "charging": charging,
        "dnd": dnd,
      };

  test("亮屏时长按相邻两帧累加", () {
    int now = t0;
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => now);
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    now += 4 * 60 * 1000;
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    now += 2 * 60 * 1000;
    agg.observe(frame(screenOn: false), atMs: now);
    expect(agg.currentBucket!["screenOnMin"], 6);
  });

  test("一段亮屏跨两个桶时切开分别记账", () {
    int now = t0;
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => now);
    // 09:58 起亮屏，10:07 灭屏——这段亮屏跨过了 10:00 的桶界
    final int edge = t0 + 4 * bucketMs;
    agg.observe(frame(screenOn: true, interactive: true), atMs: edge - 2 * 60 * 1000);
    agg.observe(frame(screenOn: true, interactive: true), atMs: edge);
    now = edge + 7 * 60 * 1000;
    agg.observe(frame(screenOn: false), atMs: now);
    // 推进到下一个桶，两个桶才算「已结束」
    now = edge + bucketMs + 60 * 1000;
    agg.observe(frame(screenOn: false), atMs: now);
    final List<Map<String, dynamic>> closed = agg.drainClosed();
    expect(closed.length, 2);
    expect(closed.first["screenOnMin"], 2);
    expect(closed.last["screenOnMin"], 7);
  });

  test("解锁按「锁 → 解锁」沿计，长亮不看第二眼不重复计数", () {
    int now = t0;
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => now);
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    now += 60 * 1000;
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    now += 60 * 1000;
    agg.observe(frame(screenOn: false, interactive: false), atMs: now);
    now += 60 * 1000;
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    expect(agg.currentBucket!["unlocks"], 2);
  });

  test("App 被冻结的空档不补成灭屏时长", () {
    int now = t0;
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => now);
    agg.observe(frame(screenOn: false), atMs: now);
    now += 6 * bucketMs; // 六个小时没收到任何帧
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    expect(agg.currentBucket!["screenOnMin"], 0);
    expect(agg.currentBucket!["unlocks"], 1);
  });

  test("charging/dnd 记桶内最后一次观测", () {
    int now = t0;
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => now);
    agg.observe(frame(screenOn: true, charging: true, dnd: true), atMs: now);
    now += 60 * 1000;
    agg.observe(frame(screenOn: true, charging: false, dnd: false), atMs: now);
    expect(agg.currentBucket!["charging"], false);
    expect(agg.currentBucket!["dnd"], false);
  });

  test("首帧之前不产生空桶：没观测过不等于这 15 分钟没亮屏", () {
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => t0);
    expect(agg.currentBucket, isNull);
    expect(agg.drainClosed(), isEmpty);
  });

  test("drainClosed 只交已结束的桶，交完不再重复带", () {
    int now = t0;
    final PhoneStateBucketAggregator agg =
        PhoneStateBucketAggregator(clock: () => now);
    agg.observe(frame(screenOn: true, interactive: true), atMs: now);
    expect(agg.drainClosed(), isEmpty);
    now = t0 + bucketMs + 60 * 1000; // 推进到下一个桶
    agg.observe(frame(screenOn: false), atMs: now);
    final List<Map<String, dynamic>> first = agg.drainClosed();
    expect(first.length, 1);
    expect(first.first["bucket"], t0);
    expect(agg.drainClosed(), isEmpty);
  });
}
