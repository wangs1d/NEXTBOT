import "dart:async";
import "dart:convert" show jsonDecode, jsonEncode;

import "package:flutter/material.dart";
import "package:flutter/services.dart" show KeyEvent, LogicalKeyboardKey;
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../chat/media_disk_cache.dart";

/// 回顾视图：盲盒清理（Linger 式随机断舍离）+ 记忆放映（Yope 式 moments）。
///
/// 盲盒一轮 15 张：随机抽样（排除收藏与 7 天内新入库），一屏一张三向滑动——
/// 上滑删除 / 下滑收藏 / 左右跳过；桌面端底部三个对应按钮 + 方向键同构。
/// 一轮结束统一确认（入回收站 30 天可撤销），"删除变成顺手的动作而非任务"。
///
/// 记忆放映：按事件簇（3D 墙同一聚类）回放近 30 天照片，Ken Burns 缓推 +
/// caption 打字机，看完可「存为记忆」。
class GalleryReviewPage extends StatefulWidget {
  const GalleryReviewPage({super.key});

  @override
  State<GalleryReviewPage> createState() => _GalleryReviewPageState();
}

class _ReviewPhoto {
  _ReviewPhoto.fromJson(Map<String, dynamic> json)
      : id = json["id"] as String,
        fileName = (json["fileName"] as String?) ?? "",
        fileSize = (json["fileSize"] as num?)?.toInt() ?? 0,
        takenAt = json["takenAt"] as String?,
        caption = json["caption"] as String?,
        place = json["place"] as String?,
        previewUrl = (json["previewUrl"] as String?) ?? "",
        imageUrl = (json["imageUrl"] as String?) ?? "";

  final String id;
  final String fileName;
  final int fileSize;
  final String? takenAt;
  final String? caption;
  final String? place;
  final String previewUrl;
  final String imageUrl;

  String get whenText {
    final DateTime? t = DateTime.tryParse(takenAt ?? "");
    if (t == null) return "时间未记录";
    return "${t.year}/${t.month.toString().padLeft(2, "0")}/${t.day.toString().padLeft(2, "0")}";
  }
}

enum _Phase { loading, playing, summary, empty }

enum _Decision { delete, favorite, skip }

class _GalleryReviewPageState extends State<GalleryReviewPage> {
  final List<_ReviewPhoto> _round = <_ReviewPhoto>[];
  final List<_ReviewPhoto> _toDelete = <_ReviewPhoto>[];
  final Set<String> _seenIds = <String>{};
  int _index = 0;
  int _roundNo = 0;
  int _favCount = 0;
  _Phase _phase = _Phase.loading;
  bool _busy = false;
  String? _error;

  // 卡片拖拽 / 飞出动画
  Offset _drag = Offset.zero;
  Offset _flyTarget = Offset.zero;
  bool _flying = false;

  @override
  void initState() {
    super.initState();
    _drawRound();
  }

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse("${ApiConfig.httpBase}$path").replace(queryParameters: query);

  Future<Map<String, dynamic>> _get(String path, [Map<String, String>? query]) async {
    final http.Response response =
        await http.get(_uri(path, query)).timeout(const Duration(seconds: 15));
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final http.Response response = await http
        .post(
          _uri(path),
          headers: const <String, String>{"Content-Type": "application/json"},
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 30));
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  /// 抽一轮：排除收藏/7 天内新入库/本会话已看过的
  Future<void> _drawRound() async {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.loading;
      _error = null;
    });
    try {
      final Map<String, dynamic> body = await _get(
        "/picture/assets/random",
        <String, String>{
          "count": "15",
          "recentDays": "7",
          if (_seenIds.isNotEmpty) "excludeIds": _seenIds.join(","),
        },
      );
      if (!mounted) return;
      final List<dynamic> photos = (body["photos"] as List<dynamic>?) ?? const <dynamic>[];
      if (photos.isEmpty) {
        setState(() {
          _phase = _Phase.empty;
          _round.clear();
        });
        return;
      }
      _round
        ..clear()
        ..addAll(photos.map((dynamic p) => _ReviewPhoto.fromJson(p as Map<String, dynamic>)));
      for (final _ReviewPhoto p in _round) {
        _seenIds.add(p.id);
      }
      setState(() {
        _index = 0;
        _toDelete.clear();
        _roundNo++;
        _phase = _Phase.playing;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.empty;
        _error = "加载失败：$e";
      });
    }
  }

  _ReviewPhoto? get _current =>
      _index < _round.length && _index >= 0 ? _round[_index] : null;

  Future<void> _decide(_Decision action) async {
    if (_phase != _Phase.playing || _flying || _busy || _current == null) return;
    final _ReviewPhoto photo = _current!;
    switch (action) {
      case _Decision.delete:
        setState(() {
          _toDelete.add(photo);
          _flyTarget = const Offset(0, -900);
          _flying = true;
        });
        break;
      case _Decision.favorite:
        setState(() {
          _favCount++;
          _flyTarget = const Offset(0, 900);
          _flying = true;
        });
        // 收藏即时生效（失败静默，轮末计数仅供参考）
        unawaited(
          _post("/picture/assets/batch-tag", <String, dynamic>{"ids": <String>[photo.id], "tag": "收藏"})
              .catchError((_) => <String, dynamic>{}),
        );
        break;
      case _Decision.skip:
        setState(() {
          _flyTarget = Offset(
            _drag.dx >= 0 ? 900 : -900,
            0,
          );
          _flying = true;
        });
        break;
    }
    await Future<void>.delayed(const Duration(milliseconds: 230));
    if (!mounted) return;
    setState(() {
      _flying = false;
      _drag = Offset.zero;
      _index++;
      if (_index >= _round.length) _phase = _Phase.summary;
    });
  }

  void _onDragUpdate(DragUpdateDetails details) {
    if (_flying) return;
    setState(() => _drag += details.delta);
  }

  void _onDragEnd(DragEndDetails details) {
    if (_flying) return;
    if (_drag.dy < -100) {
      _decide(_Decision.delete);
    } else if (_drag.dy > 100) {
      _decide(_Decision.favorite);
    } else if (_drag.dx.abs() > 100) {
      _decide(_Decision.skip);
    } else {
      setState(() => _drag = Offset.zero);
    }
  }

  /// 键盘方向键与手势同构（桌面主通道）：↑ 删 / ↓ 藏 / ← → 跳
  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (_phase != _Phase.playing) return KeyEventResult.ignored;
    if (event.runtimeType.toString() != "KeyDownEvent") return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      _decide(_Decision.delete);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      _decide(_Decision.favorite);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowLeft ||
        event.logicalKey == LogicalKeyboardKey.arrowRight) {
      // 键盘跳过统一向右飞出
      setState(() => _drag = const Offset(120, 0));
      _decide(_Decision.skip);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// 展示几秒后自动消失的反馈条（悬停会暂停内置倒计时，定时器到点强制收起）。
  void _showAutoSnackbar(ScaffoldMessengerState messenger, SnackBar bar) {
    final ScaffoldFeatureController<SnackBar, SnackBarClosedReason> controller =
        messenger.showSnackBar(bar);
    Timer(bar.duration + const Duration(milliseconds: 500), controller.close);
  }

  Future<void> _confirmDelete() async {
    if (_busy || _toDelete.isEmpty) return;
    setState(() => _busy = true);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    try {
      final Map<String, dynamic> body = await _post("/picture/assets/batch-delete", <String, dynamic>{
        "ids": _toDelete.map((p) => p.id).toList(),
      });
      final List<String> trashIds = ((body["trashIds"] as List<dynamic>?) ?? const <dynamic>[])
          .map((e) => e.toString())
          .where((e) => e.isNotEmpty)
          .toList();
      if (!mounted) return;
      messenger.hideCurrentSnackBar();
      _showAutoSnackbar(
        messenger,
        SnackBar(
          duration: const Duration(seconds: 5),
          content: Text("已删除 ${_toDelete.length} 张（回收站保留 30 天）"),
          action: trashIds.isEmpty
              ? null
              : SnackBarAction(
                  label: "撤销",
                  onPressed: () {
                    unawaited(
                      _post("/picture/trash/restore", <String, dynamic>{"ids": trashIds})
                          .then((value) {
                        _showAutoSnackbar(
                          messenger,
                          SnackBar(
                            duration: const Duration(seconds: 3),
                            content: const Text("已恢复"),
                          ),
                        );
                      }),
                    );
                  },
                ),
        ),
      );
      await _drawRound();
    } catch (e) {
      _showAutoSnackbar(
        messenger,
        SnackBar(duration: const Duration(seconds: 4), content: Text("删除失败：$e")),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _giveUpRound() {
    setState(() {
      _phase = _Phase.summary;
    });
  }

  void _nextAfterSummary() {
    setState(() => _toDelete.clear());
    _drawRound();
  }

  String formatBytes(int bytes) {
    if (bytes >= 1024 * 1024) return "${(bytes / 1024 / 1024).toStringAsFixed(1)} MB";
    if (bytes >= 1024) return "${(bytes / 1024).toStringAsFixed(0)} KB";
    return "$bytes B";
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return switch (_phase) {
      _Phase.loading => const Center(child: CircularProgressIndicator(strokeWidth: 2.4)),
      _Phase.empty => _buildEmpty(cs),
      _Phase.playing => _buildPlaying(cs),
      _Phase.summary => _buildSummary(cs),
    };
  }

  Widget _buildEmpty(ColorScheme cs) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.auto_awesome_rounded, size: 44, color: cs.outline),
            const SizedBox(height: 14),
            Text(
              _error ?? "这轮没有可回顾的照片了",
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14),
            ),
            const SizedBox(height: 8),
            Text(
              _error == null ? "上传新照片、或稍后再来开一轮盲盒" : "请确认服务已启动后重试",
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
            ),
            const SizedBox(height: 18),
            OutlinedButton(onPressed: _drawRound, child: const Text("再抽一轮")),
          ],
        ),
      ),
    );
  }

  // ──────────────────────────── 盲盒进行中 ────────────────────────────

  Widget _buildPlaying(ColorScheme cs) {
    final _ReviewPhoto? photo = _current;
    return Focus(
      autofocus: true,
      onKeyEvent: _onKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
            child: Row(
              children: <Widget>[
                Text(
                  "🎲 第 $_roundNo 轮 · ${_index + 1}/${_round.length}",
                  style: TextStyle(fontSize: 12.5, letterSpacing: 0.04, color: cs.onSurfaceVariant),
                ),
                const Spacer(),
                if (_toDelete.isNotEmpty)
                  Text(
                    "已选删 ${_toDelete.length} 张",
                    style: TextStyle(fontSize: 12.5, color: cs.error),
                  ),
                TextButton.icon(
                  onPressed: () => showMemoryPlayback(context),
                  icon: const Icon(Icons.play_circle_outline_rounded, size: 18),
                  label: const Text("本月记忆"),
                ),
                TextButton(onPressed: _giveUpRound, child: const Text("结束本轮")),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 4),
              child: photo == null ? const SizedBox.shrink() : _buildCard(photo, cs),
            ),
          ),
          _buildActionButtons(cs),
        ],
      ),
    );
  }

  Widget _buildCard(_ReviewPhoto photo, ColorScheme cs) {
    final Offset offset = _flying ? _flyTarget : _drag;
    final double angle = _flying ? _flyTarget.dy < 0 ? -0.18 : _flyTarget.dy > 0 ? 0.12 : _flyTarget.dx / 900 : _drag.dx / 1400;
    final double dyOverlay = _flying ? _flyTarget.dy : _drag.dy;
    return GestureDetector(
      onPanUpdate: _onDragUpdate,
      onPanEnd: _onDragEnd,
      child: TweenAnimationBuilder<Offset>(
        key: ValueKey<Offset>(offset),
        tween: Tween<Offset>(end: offset),
        duration: _flying
            ? const Duration(milliseconds: 230)
            : const Duration(milliseconds: 120),
        curve: Curves.easeOutCubic,
        builder: (BuildContext context, Offset value, Widget? child) => Transform.translate(
          offset: value,
          child: Transform.rotate(angle: angle, child: child),
        ),
        child: Column(
          children: <Widget>[
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: cs.outline.withValues(alpha: 0.25)),
                  color: cs.surfaceContainerLow,
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(9),
                  child: Stack(
                    fit: StackFit.expand,
                    children: <Widget>[
                      CachedMediaImage(
                        url: "${ApiConfig.httpBase}${photo.imageUrl}",
                        fit: BoxFit.contain,
                        errorBuilder: (_, Object e, StackTrace? s) => Center(
                          child: Text("图片加载失败", style: TextStyle(color: cs.onSurfaceVariant)),
                        ),
                      ),
                      // 手势提示浮层
                      if (dyOverlay < -60)
                        _stamp(context, Icons.delete_outline_rounded, "删除", cs.error),
                      if (dyOverlay > 60)
                        _stamp(context, Icons.favorite_rounded, "收藏", const Color(0xFF3D8361)),
                    ],
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 10, 4, 2),
              child: Row(
                children: <Widget>[
                  Text(photo.whenText,
                      style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant, letterSpacing: 0.04)),
                  if ((photo.place ?? "").isNotEmpty) ...<Widget>[
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(photo.place!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                    ),
                  ] else
                    const Spacer(),
                ],
              ),
            ),
            if ((photo.caption ?? "").isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
                child: SizedBox(
                  width: double.infinity,
                  child: Text(
                    photo.caption!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, height: 1.4, color: cs.onSurface.withValues(alpha: 0.85)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _stamp(BuildContext context, IconData icon, String label, Color color) {
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.92),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, color: Colors.white, size: 18),
            const SizedBox(width: 6),
            Text(label, style: const TextStyle(color: Colors.white, fontSize: 15, letterSpacing: 0.1)),
          ],
        ),
      ),
    );
  }

  /// 底部三按钮：与三向滑动同构（桌面端主操作通道）
  Widget _buildActionButtons(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 4, 24, 12),
      child: Row(
        children: <Widget>[
          Expanded(
            child: _ActionButton(
              icon: Icons.keyboard_arrow_left_rounded,
              label: "跳过 ←",
              onTap: () => _decide(_Decision.skip),
              cs: cs,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _ActionButton(
              icon: Icons.keyboard_arrow_down_rounded,
              label: "收藏 ↓",
              onTap: () => _decide(_Decision.favorite),
              cs: cs,
              tint: const Color(0xFF3D8361),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: _ActionButton(
              icon: Icons.keyboard_arrow_up_rounded,
              label: "删除 ↑",
              onTap: () => _decide(_Decision.delete),
              cs: cs,
              tint: cs.error,
            ),
          ),
        ],
      ),
    );
  }

  // ──────────────────────────── 轮末汇总 ────────────────────────────

  Widget _buildSummary(ColorScheme cs) {
    final int bytes = _toDelete.fold(0, (int sum, p) => sum + p.fileSize);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                "本轮汇总",
                style: TextStyle(fontSize: 14, letterSpacing: 0.06, color: cs.onSurface),
              ),
              const Spacer(),
              Text(
                "收藏 $_favCount · 待删 ${_toDelete.length} 张${bytes > 0 ? " · 释放 ${formatBytes(bytes)}" : ""}",
                style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Expanded(
            child: _toDelete.isEmpty
                ? Center(
                    child: Text(
                      "这轮没有要删的照片",
                      style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
                    ),
                  )
                : GridView.builder(
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 120,
                      mainAxisSpacing: 6,
                      crossAxisSpacing: 6,
                    ),
                    itemCount: _toDelete.length,
                    itemBuilder: (BuildContext context, int i) {
                      final _ReviewPhoto p = _toDelete[i];
                      return GestureDetector(
                        onTap: () => setState(() => _toDelete.remove(p)), // 点掉=反悔，留回图库
                        child: Stack(
                          fit: StackFit.expand,
                          children: <Widget>[
                            ClipRRect(
                              borderRadius: BorderRadius.circular(6),
                              child: CachedMediaImage(
                                url: "${ApiConfig.httpBase}${p.previewUrl}",
                                fit: BoxFit.cover,
                                errorBuilder: (_, Object e, StackTrace? s) =>
                                    ColoredBox(color: cs.surfaceContainerHigh),
                              ),
                            ),
                            Positioned(
                              right: 4,
                              top: 4,
                              child: Icon(Icons.cancel_rounded,
                                  size: 18, color: cs.onSurface.withValues(alpha: 0.8)),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
          const SizedBox(height: 12),
          Row(
            children: <Widget>[
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : _nextAfterSummary,
                  child: const Text("全部放弃，再来一轮"),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: cs.errorContainer,
                    foregroundColor: cs.onErrorContainer,
                  ),
                  onPressed: _busy || _toDelete.isEmpty ? null : _confirmDelete,
                  icon: const Icon(Icons.delete_outline_rounded, size: 18),
                  label: Text(_busy ? "删除中…" : "确认删除 ${_toDelete.length} 张"),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.icon,
    required this.label,
    required this.onTap,
    required this.cs,
    this.tint,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final ColorScheme cs;
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final Color color = tint ?? cs.onSurfaceVariant;
    return Material(
      color: cs.surfaceContainerLow,
      shape: StadiumBorder(side: BorderSide(color: color.withValues(alpha: 0.4))),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              Icon(icon, size: 19, color: color),
              const SizedBox(width: 5),
              Text(label, style: TextStyle(fontSize: 13, color: color, letterSpacing: 0.04)),
            ],
          ),
        ),
      ),
    );
  }
}

// ══════════════════════════════ 记忆放映（Yope 式 moments）═════════════════════════════

/// 全屏放映：近 30 天事件簇自动编排（无近期照片时回退全部），Ken Burns +
/// caption 打字机；结尾可「存为记忆」。
Future<void> showMemoryPlayback(BuildContext context) async {
  await showDialog<void>(
    context: context,
    barrierColor: Colors.black,
    barrierDismissible: false,
    useSafeArea: false,
    builder: (BuildContext context) => const _MemoryPlaybackDialog(),
  );
}

class _MemoryPlaybackDialog extends StatefulWidget {
  const _MemoryPlaybackDialog();

  @override
  State<_MemoryPlaybackDialog> createState() => _MemoryPlaybackDialogState();
}

class _Slide {
  _Slide(this.url, this.caption, this.eventTitle);
  final String url;
  final String? caption;
  final String eventTitle;
}

class _MemoryPlaybackDialogState extends State<_MemoryPlaybackDialog>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 4200));
  final List<_Slide> _slides = <_Slide>[];
  final Set<String> _slideIds = <String>{};
  bool _loading = true;
  bool _ended = false;
  String? _error;
  int _i = 0;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final http.Response response = await http
          .get(Uri.parse("${ApiConfig.httpBase}/gallery-wall/layout"))
          .timeout(const Duration(seconds: 15));
      final Map<String, dynamic> layout = jsonDecode(response.body) as Map<String, dynamic>;
      final List<dynamic> events = (layout["events"] as List<dynamic>?) ?? const <dynamic>[];
      final DateTime cutoff = DateTime.now().subtract(const Duration(days: 30));
      List<dynamic> chosen = events
          .where((dynamic e) =>
              e is Map &&
              e["start"] is String &&
              DateTime.tryParse(e["start"] as String)?.isAfter(cutoff) == true)
          .toList();
      if (chosen.isEmpty) chosen = events.toList();
      for (final dynamic event in chosen) {
        final String title = (event["title"] as String?) ?? "";
        for (final dynamic p in (event["photos"] as List<dynamic>? ?? const <dynamic>[])) {
          final Map<String, dynamic> photo = p as Map<String, dynamic>;
          if (_slideIds.length >= 40) break;
          if (_slideIds.add(photo["id"] as String)) {
            _slides.add(_Slide(
              (photo["thumbUrl"] as String?) ?? "",
              photo["caption"] as String?,
              title,
            ));
          }
        }
      }
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (_slides.isEmpty) _ended = true;
      });
      if (_slides.isNotEmpty) {
        _controller.forward(from: 0);
        _controller.addListener(_onTick);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = "$e";
      });
    }
  }

  void _onTick() {
    if (_controller.isCompleted && !_ended && mounted) {
      _next();
    }
  }

  void _next() {
    if (_i >= _slides.length - 1) {
      setState(() => _ended = true);
      return;
    }
    setState(() => _i++);
    _controller.forward(from: 0);
  }

  Future<void> _saveAsMemory() async {
    if (_saving) return;
    setState(() => _saving = true);
    // messenger 要在 pop 前取（pop 后 dialog context 已失效）
    final ScaffoldMessengerState? messenger = ScaffoldMessenger.maybeOf(context);
    try {
      await http
          .post(
            Uri.parse("${ApiConfig.httpBase}/picture/assets/batch-tag"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{
              "ids": _slideIds.toList(),
              "tag": "记忆",
            }),
          )
          .timeout(const Duration(seconds: 30));
      if (!mounted) return;
      Navigator.of(context).pop();
      if (messenger != null) {
        final ScaffoldFeatureController<SnackBar, SnackBarClosedReason> controller =
            messenger.showSnackBar(
          const SnackBar(
            duration: Duration(seconds: 3),
            content: Text("已存为记忆（打了「记忆」标签）"),
          ),
        );
        Timer(const Duration(milliseconds: 3500), controller.close);
      }
    } catch (_) {
      if (!mounted) return;
      setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Dialog.fullscreen(
      backgroundColor: Colors.black,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          if (_loading)
            const Center(child: CircularProgressIndicator(strokeWidth: 2.4))
          else if (_error != null)
            Center(
              child: Text("加载失败：$_error", style: const TextStyle(color: Colors.white70)),
            )
          else if (_slides.isEmpty)
            const Center(
              child: Text("还没有照片可以放映", style: TextStyle(color: Colors.white70)),
            )
          else if (!_ended)
            GestureDetector(
              onTap: _next,
              child: AnimatedBuilder(
                animation: _controller,
                builder: (BuildContext context, _) => _buildSlide(_controller.value),
              ),
            )
          else
            _buildEnded(cs),
          // 关闭按钮
          Positioned(
            right: 12,
            top: 12,
            child: IconButton(
              icon: const Icon(Icons.close_rounded, color: Colors.white70),
              onPressed: () => Navigator.of(context).pop(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSlide(double t) {
    final _Slide slide = _slides[_i];
    // Ken Burns：交替缓推/横移
    final double scale = 1.0 + 0.10 * t;
    final Alignment beginAlign = _i.isEven ? const Alignment(-0.06, 0.04) : const Alignment(0.06, -0.04);
    final Alignment endAlign = _i.isEven ? const Alignment(0.06, -0.04) : const Alignment(-0.06, 0.04);
    final Alignment align = Alignment.lerp(beginAlign, endAlign, t)!;

    // caption 打字机
    final String caption = slide.caption ?? "";
    final int chars = caption.isEmpty ? 0 : (t * 1.8 * caption.length).floor().clamp(1, caption.length);

    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        Transform(
          alignment: Alignment.center,
          transform: Matrix4.identity()..scaleByDouble(scale, scale, 1.0, 1.0),
          child: Align(
            alignment: align,
            child: CachedMediaImage(
              url: "${ApiConfig.httpBase}${slide.url}",
              fit: BoxFit.cover,
              alignment: align,
              errorBuilder: (_, Object e, StackTrace? s) =>
                  const ColoredBox(color: Color(0xFF151515)),
            ),
          ),
        ),
        // 底部渐变 + 文案
        Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: Container(
            padding: const EdgeInsets.fromLTRB(24, 40, 24, 26),
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[Colors.transparent, Color(0xCC000000)],
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  slide.eventTitle,
                  style: TextStyle(
                    fontSize: 12.5,
                    letterSpacing: 0.14,
                    color: Colors.white.withValues(alpha: 0.72),
                  ),
                ),
                if (caption.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 6),
                  Text(
                    caption.substring(0, chars),
                    style: const TextStyle(
                      fontSize: 19,
                      height: 1.5,
                      color: Colors.white,
                      letterSpacing: 0.02,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        // 进度细线
        Positioned(
          left: 0,
          right: 0,
          top: 0,
          child: LinearProgressIndicator(
            value: (_i + t) / _slides.length,
            minHeight: 2,
            backgroundColor: Colors.white12,
            valueColor: const AlwaysStoppedAnimation<Color>(Colors.white70),
          ),
        ),
      ],
    );
  }

  Widget _buildEnded(ColorScheme cs) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Icon(Icons.auto_awesome_rounded, color: Colors.white54, size: 42),
          const SizedBox(height: 14),
          Text(
            "本次放映到这里 · 共 ${_slides.length} 张",
            style: const TextStyle(color: Colors.white70, fontSize: 14),
          ),
          const SizedBox(height: 22),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              OutlinedButton(
                onPressed: () => Navigator.of(context).pop(),
                style: OutlinedButton.styleFrom(foregroundColor: Colors.white70),
                child: const Text("关闭"),
              ),
              const SizedBox(width: 12),
              FilledButton.icon(
                onPressed: _saving ? null : _saveAsMemory,
                icon: const Icon(Icons.bookmark_add_outlined, size: 18),
                label: Text(_saving ? "保存中…" : "存为记忆"),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
