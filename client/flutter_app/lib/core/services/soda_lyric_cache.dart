import "dart:convert";
import "dart:io" show File, FileStat, Platform;
import "dart:typed_data";

import "media_session_service.dart" show MediaLyricChar, MediaLyricLine;

/// 汽水音乐本地歌词缓存（%APPDATA%/SodaMusic/LunaCacheV2/entries.db）兜底。
///
/// 该库是自定义 KV：track 记录以「<19位id>·track·」锚点开头，同一簇内紧跟
/// 歌名/歌手，歌词（KRC 逐字时间轴 + 标准 LRC 文本）也在簇内。网易云查不到时，
/// 按锚点簇关联出属于当前曲目的歌词；优先用 KRC 的词级时间轴，没有再用 LRC。
class SodaLyricCache {
  SodaLyricCache._();

  static final SodaLyricCache instance = SodaLyricCache._();

  // track 记录里封面/码率等字段会把歌名推到锚点后十几 KB，给足距离再靠歌手
  // 邻近校验防串簇（原 4000 会让条目齐全的歌直接被漏掉）。
  static const int _maxTitleToAnchorDist = 16000;
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

    // 歌名命中 → 归属簇（向前最近锚点且距离近、歌手在同簇附近）→ 簇内
    // 优先取 KRC 逐字歌词（词级时间轴），没有再退回 LRC 逐行文本。
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
      final List<MediaLyricLine>? krc = _parseKrcBlock(db, latin, owner, bound);
      if (krc != null) return krc;
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
      // 末行后面可能直接黏着二进制记录（无换行分隔）：在第一个控制字符或
      // 非法 UTF-8 字节（解码成 U+FFFD）处截断。
      String text = m.group(4)!;
      final int cut =
          text.indexOf(RegExp(r"[\x00-\x1f\x7f\uFFFD]"));
      if (cut >= 0) text = text.substring(0, cut);
      text = text.trim();
      if (text.isEmpty || seenT.contains(t) || creditRe.hasMatch(text)) continue;
      seenT.add(t);
      lines.add(MediaLyricLine(tMs: t, text: text));
      if (lines.length >= 200) break;
    }
    if (lines.length < 5) return null;
    return lines;
  }

  /// 在曲目锚点簇内找 KRC 逐字歌词块：
  /// `[行起点ms,行长ms]<字偏移ms,字时长ms,0>字…`（偏移相对行起点）。
  /// 找不到返回 null，由调用方回退到 LRC 文本；解析失败/词行过少都不编造。
  List<MediaLyricLine>? _parseKrcBlock(
      Uint8List db, String latin, int start, int end) {
    if (end <= start) return null;
    final RegExp lineHead = RegExp(r"\[(\d+),(\d+)\]<\d+,\d+,\d+>");
    final RegExpMatch? first = lineHead.firstMatch(latin.substring(start, end));
    if (first == null) return null;

    final int blockStart = start + first.start;
    final int regionEnd =
        blockStart + 60000 < end ? blockStart + 60000 : end;
    final String region =
        utf8.decode(db.sublist(blockStart, regionEnd), allowMalformed: true);

    final RegExp lineRe = RegExp(r"^\[(\d+),(\d+)\](.*)$");
    final RegExp markerRe = RegExp(r"<(\d+),(\d+),\d+>");
    final List<MediaLyricLine> lines = <MediaLyricLine>[];
    final Set<int> seenT = <int>{};

    for (final String raw in region.split("\n")) {
      final String trimmed = raw.trim();
      if (trimmed.isEmpty) continue;
      final RegExpMatch? m = lineRe.firstMatch(trimmed);
      if (m == null) {
        // 离开 KRC 文本区（后面是二进制记录），到此为止。
        if (lines.isNotEmpty) break;
        continue;
      }
      final int lineStart = int.parse(m.group(1)!);
      if (seenT.contains(lineStart)) continue;
      final String body = m.group(3)!;

      final List<MediaLyricChar> chars = <MediaLyricChar>[];
      final List<RegExpMatch> marks = markerRe.allMatches(body).toList();
      for (int i = 0; i < marks.length; i++) {
        final int from = marks[i].end;
        final int to = i + 1 < marks.length ? marks[i + 1].start : body.length;
        final int off = int.parse(marks[i].group(1)!);
        final int dur = int.parse(marks[i].group(2)!);
        String text = body.substring(from, to);
        final int cut = text.indexOf(RegExp(r"[\x00-\x1f\x7f\uFFFD]"));
        if (cut >= 0) text = text.substring(0, cut);
        if (text.isEmpty) continue;
        chars.add(MediaLyricChar(tMs: lineStart + off, dMs: dur, text: text));
      }
      // 去掉首尾空白唱段（英文词尾的空格保留在词内，不单独成段）。
      while (chars.isNotEmpty && chars.first.text.trim().isEmpty) {
        chars.removeAt(0);
      }
      while (chars.isNotEmpty && chars.last.text.trim().isEmpty) {
        chars.removeLast();
      }
      if (chars.isNotEmpty) {
        chars[0] = MediaLyricChar(
            tMs: chars[0].tMs,
            dMs: chars[0].dMs,
            text: chars[0].text.replaceFirst(RegExp(r"^\s+"), ""));
        final MediaLyricChar last = chars.last;
        chars[chars.length - 1] = MediaLyricChar(
            tMs: last.tMs,
            dMs: last.dMs,
            text: last.text.replaceFirst(RegExp(r"\s+$"), ""));
      }

      final String text = chars.map((c) => c.text).join();
      if (text.isEmpty) continue;
      seenT.add(lineStart);
      lines.add(MediaLyricLine(tMs: lineStart, text: text, chars: chars));
      if (lines.length >= 200) break;
    }

    // 歌词过少通常是误命中了别的记录，宁可返回 null 走 LRC/服务端兜底。
    if (lines.length < 5) return null;

    // 同簇若还有一份 LRC，逐字块的时间范围必须与它对得上；对不上说明这块
    // KRC 属于相邻的另一首歌，直接放弃，避免拿别人的节奏硬套。
    final RegExp lrcStamp = RegExp(r"\[(\d\d):(\d\d)(?:[.:](\d{1,3}))?\]");
    final RegExpMatch? lrcFirst = lrcStamp.firstMatch(latin.substring(start, end));
    if (lrcFirst != null) {
      final int lrcStart = start + lrcFirst.start;
      final int lrcEnd = lrcStart + 20000 < end ? lrcStart + 20000 : end;
      final String lrcRegion =
          utf8.decode(db.sublist(lrcStart, lrcEnd), allowMalformed: true);
      int? firstT;
      int? lastT;
      for (final String raw in lrcRegion.split("\n")) {
        final RegExpMatch? m = lrcStamp.firstMatch(raw.trim());
        if (m == null) {
          if (lastT != null) break;
          continue;
        }
        final int t =
            (int.parse(m.group(1)!) * 60 + int.parse(m.group(2)!)) * 1000 +
                int.parse((m.group(3) ?? "0").padRight(3, "0"));
        firstT ??= t;
        lastT = t;
      }
      if (firstT != null && lastT != null) {
        if (lines.last.tMs < firstT - 1000 ||
            lines.first.tMs > lastT + 1000) {
          return null;
        }
      }
    }

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
