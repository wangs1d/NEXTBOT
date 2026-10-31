import "dart:convert";
import "dart:io" show File, FileStat, Platform;
import "dart:typed_data";

import "media_session_service.dart" show MediaLyricLine;

/// 汽水音乐本地歌词缓存（%APPDATA%/SodaMusic/LunaCacheV2/entries.db）兜底。
///
/// 该库是自定义 KV：track 记录以「<19位id>·track·」锚点开头，同一簇内紧跟
/// 歌名/歌手，歌词（卡拉OK数据 + 标准 LRC 文本）也在簇内。网易云查不到时，
/// 按锚点簇关联出属于当前曲目的 LRC 块；查不到返回 null，不编造。
class SodaLyricCache {
  SodaLyricCache._();

  static final SodaLyricCache instance = SodaLyricCache._();

  static const int _maxTitleToAnchorDist = 4000;
  static const int _blobGapBytes = 400;

  Uint8List? _bytes;
  DateTime _mtime = DateTime.fromMillisecondsSinceEpoch(0);

  /// 库文件随听歌不断轮换：每次都 stat，mtime 变了才重读 2.9MB。
  Future<Uint8List?> _loadDb() async {
    try {
      final String appData = Platform.environment["APPDATA"] ?? "";
      if (appData.isEmpty) return null;
      final File file = File("$appData\\SodaMusic\\LunaCacheV2\\entries.db");
      if (!await file.exists()) return null;
      final FileStat stat = await file.stat();
      if (_bytes != null && stat.modified == _mtime) return _bytes;
      _bytes = await file.readAsBytes();
      _mtime = stat.modified;
      return _bytes;
    } catch (_) {
      return null;
    }
  }

  /// 按歌名（+歌手）在汽水本地缓存中找带时间轴歌词；没有则返回 null。
  Future<List<MediaLyricLine>?> resolve(String title, String artist) async {
    final String cleanTitle = title.trim();
    if (cleanTitle.isEmpty) return null;
    final Uint8List? db = await _loadDb();
    if (db == null) return null;
    try {
      return _scan(db, cleanTitle, artist.trim());
    } catch (_) {
      return null;
    }
  }

  List<MediaLyricLine>? _scan(Uint8List db, String title, String artist) {
    // latin1 解码保证 String 下标 == 字节偏移，后续全部按下标对齐。
    final String latin = latin1.decode(db, allowInvalid: true);

    final List<int> titleHits = _findAll(db, utf8.encode(title));
    if (titleHits.isEmpty) return null;
    final List<int> artistHits =
        artist.isEmpty ? const <int>[] : _findAll(db, utf8.encode(artist));

    // track 锚点与各自簇边界（下一锚点）。
    final RegExp anchorRe = RegExp(r"(\d{18,20}).{0,2}track.{0,2}");
    final List<MapEntry<int, int>> anchors = <MapEntry<int, int>>[];
    for (final RegExpMatch m in anchorRe.allMatches(latin)) {
      anchors.add(MapEntry<int, int>(m.start, 0));
    }
    if (anchors.isEmpty) return null;
    for (int i = 0; i < anchors.length; i++) {
      final int bound =
          i + 1 < anchors.length ? anchors[i + 1].key : db.length;
      anchors[i] = MapEntry<int, int>(anchors[i].key, bound);
    }

    // LRC 块起点（连续时间戳聚成一簇）。
    final RegExp stampRe = RegExp(r"\[\d\d:\d\d[.:]\d\d\]");
    final List<MapEntry<int, int>> blobs = <MapEntry<int, int>>[];
    for (final RegExpMatch m in stampRe.allMatches(latin)) {
      if (blobs.isNotEmpty && m.start - blobs.last.value < _blobGapBytes) {
        blobs[blobs.length - 1] =
            MapEntry<int, int>(blobs.last.key, m.start + 12);
      } else {
        blobs.add(MapEntry<int, int>(m.start, m.start + 12));
      }
    }

    // 歌名命中 → 归属簇（向前最近锚点且距离近、歌手在同簇附近）→ 簇内首个 LRC 块。
    final Set<int> candidates = <int>{};
    for (final int p in titleHits) {
      int owner = -1;
      int bound = db.length;
      for (int i = 0; i < anchors.length; i++) {
        if (anchors[i].key <= p) {
          owner = anchors[i].key;
          bound = anchors[i].value;
        } else {
          break;
        }
      }
      if (owner < 0 || p - owner > _maxTitleToAnchorDist) continue;
      if (artistHits.isNotEmpty) {
        final bool artistNear = artistHits
            .any((x) => x > owner - 3000 && x < p + 3000);
        if (!artistNear) continue;
      }
      for (final MapEntry<int, int> b in blobs) {
        if (b.key > owner && b.key < bound) {
          candidates.add(b.key);
          break;
        }
      }
    }
    if (candidates.isEmpty) return null;

    // 多个候选取最早出现的一块，逐行解析；同一时间戳只留第一行（译文不入岛）。
    final int blobStart = (candidates.toList()..sort()).first;
    final int regionEnd = blobStart + 20000 < db.length ? blobStart + 20000 : db.length;
    final String region =
        utf8.decode(db.sublist(blobStart, regionEnd), allowMalformed: true);
    final RegExp lineRe = RegExp(r"^\[(\d\d):(\d\d)(?:[.:](\d{1,3}))?\](.*)$");
    final RegExp creditRe = RegExp(
        r"^(作词|作曲|编曲|制作|监制|出品|录音|混音|母带|吉他|贝斯|鼓|和声|弦乐|发行|策划|统筹|美术|设计)[^:：]{0,8}[:：]");
    final List<MediaLyricLine> lines = <MediaLyricLine>[];
    final Set<int> seenT = <int>{};
    for (final String raw in region.split("\n")) {
      final RegExpMatch? m = lineRe.firstMatch(raw.trim());
      if (m == null) break; // 离开 LRC 文本区（后面是卡拉OK数据/其他记录）
      final int t = (int.parse(m.group(1)!) * 60 +
              int.parse(m.group(2)!)) *
          1000 +
          int.parse(((m.group(3) ?? "0").padRight(3, "0")));
      final String text = m.group(4)!.trim();
      if (text.isEmpty || seenT.contains(t) || creditRe.hasMatch(text)) continue;
      seenT.add(t);
      lines.add(MediaLyricLine(tMs: t, text: text));
      if (lines.length >= 200) break;
    }
    if (lines.length < 5) return null;
    return lines;
  }

  static List<int> _findAll(Uint8List data, List<int> needle) {
    final List<int> hits = <int>[];
    if (needle.isEmpty || needle.length > data.length) return hits;
    final int last = data.length - needle.length;
    int i = 0;
    while (i <= last) {
      if (data[i] == needle[0]) {
        bool ok = true;
        for (int j = 1; j < needle.length; j++) {
          if (data[i + j] != needle[j]) {
            ok = false;
            break;
          }
        }
        if (ok) hits.add(i);
      }
      i++;
    }
    return hits;
  }
}
