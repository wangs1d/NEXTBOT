import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/services/soda_lyric_cache.dart";

void main() {
  // 实机直测：读本机汽水缓存，验证锚点关联与诚实 miss。
  test("soda local cache resolve", () async {
    final hit = await SodaLyricCache.instance.resolve("your call (氛围版)", "MorningBizarre");
    if (hit != null) {
      expect(hit.length, greaterThanOrEqualTo(5));
      print("your call: ${hit.length} lines, first=${hit.first.tMs}ms ${hit.first.text}");
      print("last=${hit.last.tMs}ms ${hit.last.text}");
      for (int i = 1; i < hit.length; i++) {
        expect(hit[i].tMs, greaterThanOrEqualTo(hit[i - 1].tMs));
      }
    } else {
      print("your call: miss (db rotated?)");
    }

    final miss = await SodaLyricCache.instance.resolve("不存在的曲目名称abc", "不存在歌手");
    expect(miss, isNull);
    print("nonexistent: honest miss ok");
  });
}
