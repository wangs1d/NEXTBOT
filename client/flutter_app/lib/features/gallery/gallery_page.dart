import "dart:async";
import "dart:convert" show jsonDecode, jsonEncode;
import "dart:typed_data";

import "package:file_picker/file_picker.dart";
import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../chat/media_disk_cache.dart";

/// 图库页：常用工具「图库」入口的落地页。
///
/// 对接服务端 `/picture/*` 路由（@private-ai-agent/picture 套件）：
/// - 网格浏览已入库照片（缩略图分页加载）
/// - 本地图片上传入库
/// - 点开大图后可删除照片（连源文件与缩略图一并移除）
class GalleryPage extends StatefulWidget {
  const GalleryPage({super.key, this.embedded = false});

  /// 嵌入右侧双面板时为 true：隐藏自带 AppBar（面板顶栏已有"图库"标题），
  /// 上传按钮改为面板内右上角图标。
  final bool embedded;

  @override
  State<GalleryPage> createState() => _GalleryPageState();
}

class _Photo {
  _Photo.fromJson(Map<String, dynamic> json)
      : id = json["id"] as String,
        fileName = (json["fileName"] as String?) ?? "",
        fileSize = (json["fileSize"] as num?)?.toInt(),
        takenAt = json["takenAt"] as String?,
        tags = ((json["tags"] as List<dynamic>?) ?? const <dynamic>[])
            .map((e) => e.toString())
            .toList(growable: false),
        thumbnailUrl = (json["thumbnailUrl"] as String?) ?? "",
        imageUrl = (json["imageUrl"] as String?) ?? "";

  final String id;
  final String fileName;
  final int? fileSize;
  final String? takenAt;
  final List<String> tags;
  final String thumbnailUrl;
  final String imageUrl;
}

class _GalleryPageState extends State<GalleryPage> {
  final ScrollController _scrollController = ScrollController();
  final List<_Photo> _photos = <_Photo>[];
  bool _loading = false;
  bool _loadingMore = false;
  bool _hasMore = true;
  int _page = 0;
  String? _error;

  /// 多选模式（长按进入）：选中集合 + 批量删除/收藏
  bool _selectMode = false;
  final Set<String> _selectedIds = <String>{};
  bool _batchBusy = false;

  @override
  void initState() {
    super.initState();
    _refresh();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final double position = _scrollController.position.maxScrollExtent -
        _scrollController.position.pixels;
    if (position < 400 && !_loadingMore && _hasMore && !_loading) {
      _loadMore();
    }
  }

  Uri _uri(String path, [Map<String, String>? query]) {
    return Uri.parse("${ApiConfig.httpBase}$path")
        .replace(queryParameters: query);
  }

  Map<String, dynamic> _decodeBody(http.Response response) {
    final dynamic decoded = jsonDecode(response.body);
    return decoded as Map<String, dynamic>;
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final http.Response response = await http
          .get(_uri("/picture/assets", <String, String>{
        "page": "1",
        "pageSize": "30",
      }))
          .timeout(const Duration(seconds: 10));
      final Map<String, dynamic> body = _decodeBody(response);
      if (body["ok"] != true) {
        throw StateError((body["error"] as String?) ?? "加载失败");
      }
      final List<dynamic> photos = (body["photos"] as List<dynamic>?) ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        _photos
          ..clear()
          ..addAll(photos.map((dynamic item) => _Photo.fromJson(item as Map<String, dynamic>)));
        _page = 1;
        _hasMore = _photos.length < ((body["total"] as num?)?.toInt() ?? 0);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = "图库加载失败：$e\n请确认服务端已启动并已上传/生成过图片";
      });
    }
  }

  Future<void> _loadMore() async {
    if (_loadingMore || !_hasMore) return;
    setState(() => _loadingMore = true);
    try {
      final http.Response response = await http
          .get(_uri("/picture/assets", <String, String>{
        "page": "${_page + 1}",
        "pageSize": "30",
      }))
          .timeout(const Duration(seconds: 10));
      final Map<String, dynamic> body = _decodeBody(response);
      final List<dynamic> photos = (body["photos"] as List<dynamic>?) ?? const <dynamic>[];
      if (!mounted) return;
      setState(() {
        _photos.addAll(photos.map((dynamic item) => _Photo.fromJson(item as Map<String, dynamic>)));
        _page += 1;
        _hasMore = photos.isNotEmpty;
        _loadingMore = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingMore = false);
    }
  }

  Future<void> _uploadImages() async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      type: FileType.image,
      allowMultiple: true,
      withData: true,
    );
    if (result == null || result.files.isEmpty) return;
    int success = 0;
    for (final PlatformFile file in result.files) {
      try {
        final http.MultipartRequest request = http.MultipartRequest(
          "POST",
          _uri("/picture/assets"),
        );
        final Uint8List? bytes = file.bytes;
        if (bytes != null) {
          request.files.add(
            http.MultipartFile.fromBytes("file", bytes, filename: file.name),
          );
        } else if (file.path != null) {
          request.files.add(
            await http.MultipartFile.fromPath("file", file.path!, filename: file.name),
          );
        } else {
          continue;
        }
        final http.StreamedResponse streamed =
            await request.send().timeout(const Duration(seconds: 60));
        if (streamed.statusCode == 200) {
          success += 1;
        }
      } catch (_) {
        // 单张失败不影响其余
      }
    }
    messenger.showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 4),
        content: Text("已上传 $success/${result.files.length} 张"),
      ),
    );
    await _refresh();
  }

  Future<void> _deletePhoto(_Photo photo) async {
    final NavigatorState navigator = Navigator.of(context, rootNavigator: true);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final String displayName =
        photo.fileName.isEmpty ? "未命名照片" : photo.fileName;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("删除照片"),
        content: Text("确定删除「$displayName」吗？照片将移入回收站，30 天内可恢复。"),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("取消"),
          ),
          TextButton(
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      final http.Response response = await http
          .delete(_uri("/picture/assets/${photo.id}"))
          .timeout(const Duration(seconds: 15));
      final Map<String, dynamic> body = _decodeBody(response);
      if (response.statusCode == 200 && body["ok"] == true) {
        final String? trashId = body["trashId"] as String?;
        navigator.pop(); // 关闭大图/详情
        await _refresh();
        messenger.hideCurrentSnackBar();
        _showAutoSnackbar(
          messenger,
          SnackBar(
            duration: const Duration(seconds: 5),
            content: Text("已移入回收站「$displayName」"),
            action: trashId == null
                ? null
                : SnackBarAction(
                    label: "撤销",
                    onPressed: () => _restoreTrash(<String>[trashId]),
                  ),
          ),
        );
      } else {
        _showAutoSnackbar(
          messenger,
          SnackBar(
            duration: const Duration(seconds: 4),
            content:
                Text("删除失败：${body["reason"] ?? body["error"] ?? response.statusCode}"),
          ),
        );
      }
    } catch (e) {
      _showAutoSnackbar(
        messenger,
        SnackBar(duration: const Duration(seconds: 4), content: Text("删除失败：$e")),
      );
    }
  }

  /// 展示几秒后自动消失的反馈条。
  /// SnackBar 在鼠标悬停时会暂停内置倒计时（会一直占位），
  /// 这里用定时器到点强制 close 兜底，保证"响应几秒钟就行"。
  void _showAutoSnackbar(ScaffoldMessengerState messenger, SnackBar bar) {
    final ScaffoldFeatureController<SnackBar, SnackBarClosedReason> controller =
        messenger.showSnackBar(bar);
    Timer(bar.duration + const Duration(milliseconds: 500), controller.close);
  }

  /// 从回收站批量恢复（删除后的「撤销」通道）
  Future<void> _restoreTrash(List<String> trashIds) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    try {
      final http.Response response = await http
          .post(
            _uri("/picture/trash/restore"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{"ids": trashIds}),
          )
          .timeout(const Duration(seconds: 15));
      final Map<String, dynamic> body = _decodeBody(response);
      _showAutoSnackbar(
        messenger,
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text(body["restored"] != null ? "已恢复 ${body["restored"]} 张" : "恢复完成"),
        ),
      );
      await _refresh();
    } catch (e) {
      _showAutoSnackbar(
        messenger,
        SnackBar(duration: const Duration(seconds: 4), content: Text("恢复失败：$e")),
      );
    }
  }

  // ──────────────────────────── 多选与批量操作 ────────────────────────────

  void _enterSelectMode([String? photoId]) {
    setState(() {
      _selectMode = true;
      if (photoId != null) _selectedIds.add(photoId);
    });
  }

  void _exitSelectMode() {
    setState(() {
      _selectMode = false;
      _selectedIds.clear();
    });
  }

  void _toggleSelected(String photoId) {
    setState(() {
      if (!_selectedIds.remove(photoId)) _selectedIds.add(photoId);
    });
  }

  List<_Photo> get _selectedPhotos =>
      _photos.where((p) => _selectedIds.contains(p.id)).toList(growable: false);

  String _formatBytes(int bytes) {
    if (bytes >= 1024 * 1024) return "${(bytes / 1024 / 1024).toStringAsFixed(1)} MB";
    if (bytes >= 1024) return "${(bytes / 1024).toStringAsFixed(0)} KB";
    return "$bytes B";
  }

  int get _selectedBytes => _selectedPhotos
      .fold(0, (sum, p) => sum + (p.fileSize ?? 0));

  Future<void> _batchFavorite() async {
    if (_batchBusy || _selectedIds.isEmpty) return;
    setState(() => _batchBusy = true);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    try {
      await http
          .post(
            _uri("/picture/assets/batch-tag"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{"ids": _selectedIds.toList(), "tag": "收藏"}),
          )
          .timeout(const Duration(seconds: 20));
      _showAutoSnackbar(
        messenger,
        SnackBar(
          duration: const Duration(seconds: 4),
          content: Text("已收藏 ${_selectedIds.length} 张"),
        ),
      );
      _exitSelectMode();
      await _refresh();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text("收藏失败：$e")));
    } finally {
      if (mounted) setState(() => _batchBusy = false);
    }
  }

  Future<void> _batchDelete() async {
    if (_batchBusy || _selectedIds.isEmpty) return;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final int count = _selectedIds.length;
    final int bytes = _selectedBytes;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text("批量删除"),
        content: Text(
          "确定删除选中的 $count 张照片吗？"
          "${bytes > 0 ? "将释放约 ${_formatBytes(bytes)}。" : ""}\n照片将移入回收站，30 天内可恢复。",
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text("取消"),
          ),
          TextButton(
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.error,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text("删除"),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _batchBusy = true);
    try {
      final http.Response response = await http
          .post(
            _uri("/picture/assets/batch-delete"),
            headers: const <String, String>{"Content-Type": "application/json"},
            body: jsonEncode(<String, dynamic>{"ids": _selectedIds.toList()}),
          )
          .timeout(const Duration(seconds: 30));
      final Map<String, dynamic> body = _decodeBody(response);
      final int removed = (body["removed"] as num?)?.toInt() ?? 0;
      final List<String> trashIds = ((body["trashIds"] as List<dynamic>?) ?? const <dynamic>[])
          .map((e) => e.toString())
          .where((e) => e.isNotEmpty)
          .toList();
      _exitSelectMode();
      await _refresh();
      messenger.hideCurrentSnackBar();
      _showAutoSnackbar(
        messenger,
        SnackBar(
          duration: const Duration(seconds: 5),
          content: Text("已删除 $removed 张（回收站保留 30 天）"),
          action: trashIds.isEmpty
              ? null
              : SnackBarAction(
                  label: "撤销",
                  onPressed: () => _restoreTrash(trashIds),
                ),
        ),
      );
    } catch (e) {
      _showAutoSnackbar(
        messenger,
        SnackBar(duration: const Duration(seconds: 4), content: Text("批量删除失败：$e")),
      );
    } finally {
      if (mounted) setState(() => _batchBusy = false);
    }
  }

  void _openPhotoDetail(_Photo photo) {
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (BuildContext sheetContext) {
        return DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.92,
          builder: (BuildContext context, ScrollController scrollController) {
            return Column(
              children: <Widget>[
                Expanded(
                  child: InteractiveViewer(
                    maxScale: 4,
                    child: Center(
                      child: CachedMediaImage(
                        url: "${ApiConfig.httpBase}${photo.imageUrl}",
                        fit: BoxFit.contain,
                        errorBuilder: (_, Object error, StackTrace? stack) =>
                            const Text("图片加载失败"),
                      ),
                    ),
                  ),
                ),
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                    child: SizedBox(
                      width: double.infinity,
                      child: OutlinedButton.icon(
                        style: OutlinedButton.styleFrom(
                          foregroundColor:
                              Theme.of(context).colorScheme.error,
                        ),
                        onPressed: () => _deletePhoto(photo),
                        icon: const Icon(Icons.delete_outline),
                        label: const Text("删除照片"),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    if (widget.embedded) {
      return Scaffold(
        floatingActionButton: _selectMode
            ? null
            : FloatingActionButton.extended(
                onPressed: _uploadImages,
                icon: const Icon(Icons.upload_outlined),
                label: const Text("上传"),
              ),
        body: _buildBody(cs),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text("图库")),
      floatingActionButton: _selectMode
          ? null
          : FloatingActionButton.extended(
              onPressed: _uploadImages,
              icon: const Icon(Icons.upload_outlined),
              label: const Text("上传"),
            ),
      body: _buildBody(cs),
    );
  }

  Widget _buildBody(ColorScheme cs) {
    if (_loading && _photos.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _photos.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(Icons.photo_library_outlined, size: 48, color: cs.outline),
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton.tonal(onPressed: _refresh, child: const Text("重试")),
            ],
          ),
        ),
      );
    }
    if (_photos.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.photo_outlined, size: 48, color: cs.outline),
            const SizedBox(height: 12),
            const Text("图库还是空的，点右下角上传照片"),
          ],
        ),
      );
    }
    return Stack(
      children: <Widget>[
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _buildSelectHeader(cs),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _refresh,
                child: GridView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 96),
                  // 密度：按可用宽度自适应（每格 ≤112px），照片不再一格占 1/3 屏
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 112,
                    mainAxisSpacing: 4,
                    crossAxisSpacing: 4,
                  ),
                  itemCount: _photos.length + (_hasMore ? 1 : 0),
                  itemBuilder: (BuildContext context, int index) {
                    if (index >= _photos.length) {
                      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
                    }
                    final _Photo photo = _photos[index];
                    return _PhotoTile(
                      photo: photo,
                      httpBase: ApiConfig.httpBase,
                      selectMode: _selectMode,
                      selected: _selectedIds.contains(photo.id),
                      onTap: () => _selectMode
                          ? _toggleSelected(photo.id)
                          : _openPhotoDetail(photo),
                      onLongPress: () => _enterSelectMode(photo.id),
                    );
                  },
                ),
              ),
            ),
          ],
        ),
        if (_selectMode && _selectedIds.isNotEmpty)
          Positioned(left: 0, right: 0, bottom: 0, child: _buildBatchBar(cs)),
      ],
    );
  }

  /// 多选模式顶栏：进入/退出、全选、已选计数
  Widget _buildSelectHeader(ColorScheme cs) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 6),
      child: Row(
        children: <Widget>[
          if (_selectMode) ...<Widget>[
            TextButton(
              onPressed: _batchBusy ? null : _exitSelectMode,
              child: const Text("取消"),
            ),
            const SizedBox(width: 4),
            TextButton(
              onPressed: _batchBusy
                  ? null
                  : () => setState(() {
                        if (_selectedIds.length == _photos.length) {
                          _selectedIds.clear();
                        } else {
                          _selectedIds.addAll(_photos.map((p) => p.id));
                        }
                        setState(() {});
                      }),
              child: Text(
                _selectedIds.length == _photos.length ? "取消全选" : "全选",
              ),
            ),
            const Spacer(),
            Text(
              "已选 ${_selectedIds.length}",
              style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
            ),
          ] else
            const Spacer(),
          TextButton.icon(
            onPressed: () => _selectMode ? _exitSelectMode() : _enterSelectMode(),
            icon: Icon(
              _selectMode ? Icons.close : Icons.checklist_rounded,
              size: 18,
            ),
            label: Text(_selectMode ? "退出多选" : "多选"),
          ),
        ],
      ),
    );
  }

  /// 底部批量操作条：收藏 / 删除（带数量与释放空间估算）
  Widget _buildBatchBar(ColorScheme cs) {
    return Material(
      color: cs.surface,
      elevation: 8,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  "已选 ${_selectedIds.length} 张"
                  "${_selectedBytes > 0 ? " · ${_formatBytes(_selectedBytes)}" : ""}",
                  style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant),
                ),
              ),
              TextButton.icon(
                onPressed: _batchBusy ? null : _batchFavorite,
                icon: const Icon(Icons.favorite_border_rounded, size: 18),
                label: const Text("收藏"),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                style: FilledButton.styleFrom(
                  backgroundColor: cs.errorContainer,
                  foregroundColor: cs.onErrorContainer,
                ),
                onPressed: _batchBusy ? null : _batchDelete,
                icon: const Icon(Icons.delete_outline_rounded, size: 18),
                label: const Text("删除"),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PhotoTile extends StatelessWidget {
  const _PhotoTile({
    required this.photo,
    required this.httpBase,
    required this.onTap,
    this.selectMode = false,
    this.selected = false,
    this.onLongPress,
  });

  final _Photo photo;
  final String httpBase;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool selectMode;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          CachedMediaImage(
            url: "$httpBase${photo.thumbnailUrl}",
            fit: BoxFit.cover,
            errorBuilder: (_, Object error, StackTrace? stack) => const ColoredBox(
              color: Color(0x22800000),
              child: Center(child: Icon(Icons.broken_image_outlined)),
            ),
          ),
          // 多选态：选中罩层 + 右上角勾选圈
          if (selectMode && selected)
            ColoredBox(color: cs.onSurface.withValues(alpha: 0.35)),
          if (selectMode)
            Positioned(
              right: 5,
              top: 5,
              child: Container(
                width: 20,
                height: 20,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: selected ? cs.primary : cs.surface.withValues(alpha: 0.85),
                  border: Border.all(
                    color: selected ? cs.primary : cs.outline,
                    width: 1.4,
                  ),
                ),
                child: selected
                    ? Icon(Icons.check_rounded, size: 14, color: cs.onPrimary)
                    : null,
              ),
            ),
        ],
      ),
    );
  }
}
