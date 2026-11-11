import "dart:convert";

import "package:flutter/material.dart";
import "package:http/http.dart" as http;

import "../../core/config/api_config.dart";
import "../../core/services/nb_http.dart";

/// 能力面板（Feature Catalog 客户端视图）。
///
/// 数据源：服务端 `GET /api/catalog/domains` 与 `GET /api/catalog/features`——
/// 12 个生活域的分类统计由 Feature Catalog 自动生成，客户端不维护分类，
/// 新能力落地后这里自动出现。
class CatalogApiClient {
  CatalogApiClient({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? ApiConfig.httpBase,
        _client = client ?? NbClient();

  final String baseUrl;
  final http.Client _client;

  Future<Map<String, dynamic>?> _getJson(String path) async {
    try {
      final Uri uri = Uri.parse("$baseUrl$path")
          .replace(scheme: baseUrl.startsWith("https") ? "https" : Uri.parse(baseUrl).scheme);
      final res = await _client
          .get(uri, headers: NbHttp.headersFor(uri))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return null;
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> fetchDomains() async {
    final data = await _getJson("/api/catalog/domains");
    final domains = data?["domains"];
    if (domains is! List) return const [];
    return domains.whereType<Map<String, dynamic>>().toList();
  }

  Future<List<Map<String, dynamic>>> fetchFeatures(String domain) async {
    final data = await _getJson("/api/catalog/features?domain=$domain");
    final features = data?["features"];
    if (features is! List) return const [];
    return features.whereType<Map<String, dynamic>>().toList();
  }
}

/// 能力面板页：按 12 生活域分组展示 agent 全部能力（点域看明细）。
class CatalogPage extends StatefulWidget {
  const CatalogPage({super.key, this.apiClient});

  final CatalogApiClient? apiClient;

  @override
  State<CatalogPage> createState() => _CatalogPageState();
}

class _CatalogPageState extends State<CatalogPage> {
  late final CatalogApiClient _api = widget.apiClient ?? CatalogApiClient();
  List<Map<String, dynamic>>? _domains;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final domains = await _api.fetchDomains();
    if (!mounted) return;
    setState(() {
      _domains = domains;
      _error = domains.isEmpty ? "无法连接主服务（$ApiConfig.httpBase），或 Feature Catalog 未装配" : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("能力面板")),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _buildBody(Theme.of(context)),
      ),
    );
  }

  Widget _buildBody(ThemeData theme) {
    if (_domains == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text(_error!, style: theme.textTheme.bodyMedium),
          ),
        ],
      );
    }
    final total = _domains!.fold<int>(0, (sum, d) => sum + ((d["count"] as num?)?.toInt() ?? 0));
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: Text(
            "你的私人管家共有 $total 项能力，按 12 个生活域组织（自动分类）",
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
        for (final domain in _domains!) _DomainTile(domain: domain, api: _api),
      ],
    );
  }
}

class _DomainTile extends StatelessWidget {
  const _DomainTile({required this.domain, required this.api});

  final Map<String, dynamic> domain;
  final CatalogApiClient api;

  @override
  Widget build(BuildContext context) {
    final count = (domain["count"] as num?)?.toInt() ?? 0;
    final label = (domain["label"] as String?) ?? (domain["domain"] as String? ?? "");
    final description = (domain["description"] as String?) ?? "";
    return ListTile(
      title: Text("$label · $count 项"),
      subtitle: Text(description, maxLines: 1, overflow: TextOverflow.ellipsis),
      trailing: const Icon(Icons.chevron_right),
      onTap: count == 0
          ? null
          : () {
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => _DomainFeaturesPage(
                    domain: (domain["domain"] as String?) ?? "",
                    label: label,
                    api: api,
                  ),
                ),
              );
            },
    );
  }
}

class _DomainFeaturesPage extends StatefulWidget {
  const _DomainFeaturesPage({required this.domain, required this.label, required this.api});

  final String domain;
  final String label;
  final CatalogApiClient api;

  @override
  State<_DomainFeaturesPage> createState() => _DomainFeaturesPageState();
}

class _DomainFeaturesPageState extends State<_DomainFeaturesPage> {
  List<Map<String, dynamic>>? _features;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final features = await widget.api.fetchFeatures(widget.domain);
    if (!mounted) return;
    setState(() {
      _features = features;
      _error = features.isEmpty ? "加载失败或该域暂无能力" : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.label)),
      body: _features == null
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Text(_error!))
              : ListView(
                  children: [
                    for (final f in _features!) ListTile(
                      dense: true,
                      title: Text((f["name"] as String?) ?? ""),
                      subtitle: Text(
                        "${f["surface"]} · ${f["action"]} · 风险 ${f["risk"]}",
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
    );
  }
}
