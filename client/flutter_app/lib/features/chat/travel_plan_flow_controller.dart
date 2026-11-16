part of "travel_plan_archive.dart";

// 控制器对同库暴露 _FlowItem/_DossierData 等私有模型（part 同库访问），
// 这些类型只在应用内部使用，不构成对外 API 契约。
// ignore_for_file: library_private_types_in_public_api

// ═══════════════════════════════════════════════════════════════════
// 规划会话状态机（2026-11-14 抽取）
//
// 原本整条 plan-session 状态机（发起 / 追问 / 选卡 / 补心愿 / 预订 /
// 预算确认 / 生成）写在 _PlanningStageState 里，桌面规划页独占。手机端要
// 在聊天流里内联复用同一条问答流，因此把「会话状态 + HTTP 调用」抽成
// 这里唯一的 ChangeNotifier：
//   - 桌面 _PlanningStage：薄壳，只负责页面级布局/输入框/出票动画；
//   - 手机 TravelPlanInlineFlowView：聊天流末尾的内联卡片视图。
// 两处共用同一份状态机，避免各写一套后行为漂移。
// ═══════════════════════════════════════════════════════════════════

/// 规划会话控制器：服务端 plan-session 协议的唯一客户端状态机。
class TravelPlanFlowController extends ChangeNotifier {
  TravelPlanFlowController({
    this.onActiveChanged,
    this.onPlanGenerated,
    this.onGenerated,
  });

  /// 当前会话 id 变化（新会话出 id / 每轮成功 / 清空）。
  final void Function(String? sessionId)? onActiveChanged;

  /// 真实生成成功（桌面刷新左栏列表用）。
  final VoidCallback? onPlanGenerated;

  /// 预算确认后服务端下发最终草案（桌面播出票动画用）。
  final void Function(_DraftData draft, String pricingMode)? onGenerated;

  static const Duration _turnTimeout = Duration(seconds: 40);
  static const Duration _generateTimeout = Duration(seconds: 150);

  bool _flowStarted = false;
  bool _busy = false;
  bool _completed = false;
  String? _sessionId;
  String? _lastState;
  _DossierData? _dossier;
  final List<_FlowItem> _flow = <_FlowItem>[];

  bool get flowStarted => _flowStarted;
  bool get busy => _busy;

  /// 已出最终方案（服务端 state=generated / 回执带 draft）。
  bool get completed => _completed;
  String? get sessionId => _sessionId;
  String? get lastState => _lastState;
  _DossierData? get dossier => _dossier;
  List<_FlowItem> get flow => List<_FlowItem>.unmodifiable(_flow);

  /// 预算卡的「钱的水位」：直接读流里最新那张预算卡。
  _BudgetData? get latestBudget {
    for (final _FlowItem f in _flow.reversed) {
      if (f.kind == _FlowKind.budget) return f.budget;
    }
    return null;
  }

  /// 核实风险：读最新草案的核实闸结果。
  _DraftData? get latestDraft {
    for (final _FlowItem f in _flow.reversed) {
      if (f.kind == _FlowKind.draft) return f.draft;
    }
    return null;
  }

  // ── 流操作 ─────────────────────────────────────────────────────

  void _append(_FlowItem item) {
    _flow.add(item);
    notifyListeners();
  }

  void _setDossier(_DossierData? data) {
    _dossier = data;
    notifyListeners();
  }

  void _removeTyping() {
    final int i = _flow.lastIndexWhere((_FlowItem f) => f.kind == _FlowKind.typing);
    if (i < 0) return;
    _flow.removeAt(i);
    notifyListeners();
  }

  void _insertSayAndCards(_TurnResult r) {
    _lastState = r.state;
    onActiveChanged?.call(_sessionId);
    _removeTyping();
    if (r.dossier != null) _setDossier(r.dossier);
    if (r.say.isNotEmpty) _append(_FlowItem.say(r.say));
    if (r.budget != null) _append(_FlowItem.budget(r.budget!));
    if (r.draft != null) {
      _append(_FlowItem.draft(r.draft!));
      onPlanGenerated?.call();
    }
    // 收尾补充卡（天气）放在最终方案之后，保证流程里它是最后一张卡。
    for (final Object card in r.cards) {
      if (card is _WeatherCardData) {
        _append(_FlowItem.weather(card));
      } else if (card is _ChoiceCardData) {
        _append(_FlowItem.choice(card));
      } else if (card is _GuideCardData) {
        _append(_FlowItem.guide(card));
      } else if (card is _WishlistCardData) {
        _append(_FlowItem.wishlist(card));
      }
    }
    if (r.state == "generated" || r.draft != null) _completed = true;
  }

  /// 用户重新补充信息：未答的问题卡与上一版预算/最终方案都不再代表当前需求。
  void _dropStaleOutput() {
    _flow.removeWhere(
      (_FlowItem f) =>
          f.kind == _FlowKind.choice ||
          f.kind == _FlowKind.guide ||
          f.kind == _FlowKind.wishlist ||
          f.kind == _FlowKind.budget ||
          f.kind == _FlowKind.draft,
    );
  }

  // ── 服务端调用 ─────────────────────────────────────────────────

  Future<Map<String, dynamic>?> _post(
    String path,
    Map<String, dynamic> body,
    Duration timeout,
  ) async {
    final http.Response resp = await NbHttp.post(
          Uri.parse("${ApiConfig.httpBase}$path"),
          headers: const <String, String>{"Content-Type": "application/json"},
          body: jsonEncode(body),
        )
        .timeout(timeout);
    final Object? decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception("HTTP ${resp.statusCode}");
    }
    if (resp.statusCode != 200 || decoded["ok"] != true) {
      final String error = decoded["error"]?.toString() ?? "HTTP ${resp.statusCode}";
      final String hint = decoded["hint"]?.toString() ?? "";
      throw Exception(hint.isEmpty ? error : "$error（$hint）");
    }
    return decoded;
  }

  Future<Map<String, dynamic>?> _get(String path, Duration timeout) async {
    final http.Response resp =
        await NbHttp.get(Uri.parse("${ApiConfig.httpBase}$path")).timeout(timeout);
    final Object? decoded = jsonDecode(resp.body);
    if (decoded is! Map<String, dynamic>) {
      throw Exception("HTTP ${resp.statusCode}");
    }
    if (resp.statusCode != 200 || decoded["ok"] != true) {
      final String error = decoded["error"]?.toString() ?? "HTTP ${resp.statusCode}";
      throw Exception(error);
    }
    return decoded;
  }

  /// 发起会话（输入框 / 手机聊天首条规划消息）。
  Future<void> start(String message) async {
    if (_busy) return;
    _busy = true;
    _flowStarted = true;
    _completed = false;
    _sessionId = null;
    _dossier = null;
    notifyListeners();
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
          "/travel/plan-session", <String, dynamic>{"message": message}, _turnTimeout);
      _sessionId = decoded?["sessionId"]?.toString();
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
    if (ready) await generate();
  }

  /// 发送一条自由文本（flow 中续说）。
  Future<void> sendText(String text) async {
    if (_busy) return;
    _dropStaleOutput();
    _append(_FlowItem.user(text));
    if (!_flowStarted) {
      await start(text);
    } else {
      await _turnMessage(text);
    }
  }

  /// 手机端聊天输入框的续说：用户气泡由聊天层负责，这里只推进会话。
  Future<void> sendContinuation(String text) async {
    if (_busy) return;
    _dropStaleOutput();
    if (!_flowStarted) {
      await start(text);
    } else {
      await _turnMessage(text);
    }
  }

  Future<void> _turnMessage(String message) async {
    final String? id = _sessionId;
    if (id == null) {
      await start(message);
      return;
    }
    _busy = true;
    notifyListeners();
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/turn",
        <String, dynamic>{"message": message},
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
    if (ready) await generate();
  }

  /// 点选回传（单选立即 / 多选确认）。
  Future<void> sendChoice(
    _FlowItem item,
    _ChoiceCardData card,
    List<String> values,
    String? note,
  ) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    _flow.remove(item);
    _dropStaleOutput();
    _busy = true;
    notifyListeners();
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/turn",
        <String, dynamic>{
          "cardId": card.id,
          "values": values,
          if (note != null && note.trim().isNotEmpty) "note": note.trim(),
        },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
    if (ready) await generate();
  }

  /// 筛选卡确认：勾选结果作为心愿清单提交，随后进入真实生成（核价）。
  Future<void> submitGuide(
    _FlowItem item,
    _GuideCardData card, {
    bool delegate = false,
  }) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    final Map<String, List<String>> selected = <String, List<String>>{
      "view": <String>[],
      "stay": <String>[],
    };
    for (final _GuideCatData cat in card.cats) {
      for (final _GuideItemData entry in cat.items) {
        if (entry.picked) selected[cat.key]?.add(entry.name);
      }
    }
    if (!delegate && selected.values.every((List<String> l) => l.isEmpty)) {
      return;
    }
    _flow.remove(item);
    _dropStaleOutput();
    _busy = true;
    notifyListeners();
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/guide",
        delegate
            ? <String, dynamic>{"delegate": true}
            : <String, dynamic>{
                "view": selected["view"],
                "stay": selected["stay"],
              },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
    if (ready) await generate();
  }

  /// 自选补充：带上用户自己写的景点/酒店/餐厅（可为空=跳过），随后进入核价。
  Future<void> submitExtras(
    _FlowItem item,
    Map<String, List<String>> extras,
    String note,
  ) async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    final List<String> added = <String>[
      ...?extras["view"],
      ...?extras["stay"],
    ];
    _flow.remove(item);
    _dropStaleOutput();
    _busy = true;
    notifyListeners();
    _append(_FlowItem.user(
      added.isEmpty ? "没有补充了，直接算预算" : "还想加：${added.join("、")}",
    ));
    _append(_FlowItem.typing());
    bool ready = false;
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/extras",
        <String, dynamic>{
          "view": extras["view"] ?? const <String>[],
          "stay": extras["stay"] ?? const <String>[],
          if (note.trim().isNotEmpty) "note": note.trim(),
        },
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      _insertSayAndCards(r);
      ready = r.state == "ready";
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
    if (ready) await generate();
  }

  Future<void> generate() async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    _busy = true;
    notifyListeners();
    _append(_FlowItem.typing());
    try {
      final Map<String, dynamic>? decoded = await _post(
          "/travel/plan-session/$id/generate", <String, dynamic>{}, _generateTimeout);
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      if (r.dossier != null) _setDossier(r.dossier);
      _lastState = r.state;
      _removeTyping();
      onActiveChanged?.call(_sessionId);
      if (r.say.isNotEmpty) _append(_FlowItem.say(r.say));
      // flow A：生成完先只给预算明细，用户确认后才出最终方案。
      if (r.budget != null) _append(_FlowItem.budget(r.budget!));
      if (r.draft != null) {
        _append(_FlowItem.draft(r.draft!));
        _completed = true;
        onPlanGenerated?.call();
      }
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// 预算确认 → 服务端下发最终草案。
  Future<void> approve() async {
    final String? id = _sessionId;
    if (id == null || _busy) return;
    if (_flow.any((_FlowItem f) => f.budget?.approved == true)) return;
    _busy = true;
    notifyListeners();
    _append(_FlowItem.typing());
    try {
      final Map<String, dynamic>? decoded = await _post(
        "/travel/plan-session/$id/approve",
        <String, dynamic>{},
        _turnTimeout,
      );
      final _TurnResult r = _TurnResult.fromJson(decoded ?? <String, dynamic>{});
      for (final _FlowItem f in _flow) {
        if (f.kind == _FlowKind.budget) f.budget!.approved = true;
      }
      _insertSayAndCards(r);
      if (r.draft != null) {
        String pricingMode = "";
        for (final _FlowItem f in _flow) {
          if (f.kind == _FlowKind.budget) pricingMode = f.budget?.pricingMode ?? "";
        }
        onGenerated?.call(r.draft!, pricingMode);
      }
    } catch (e) {
      _recoverFromError(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// 失败恢复：typing 移除 + 错误条目；会话失效时清空 sessionId。
  void _recoverFromError(Object e) {
    _removeTyping();
    final String msg = "$e".replaceFirst("Exception: ", "");
    final bool expired = msg.contains("会话不存在") || msg.contains("已过期");
    if (expired) _sessionId = null;
    _append(_FlowItem.error(expired ? "会话已过期，重新说一句发起吧" : "出错了：$msg"));
  }

  // ── 恢复历史会话 ────────────────────────────────────────────────

  /// history 载荷 → 对话流条目（恢复时用户气泡 / Agent 说话块原样重建）。
  static List<_FlowItem> _flowFromHistory(List<dynamic>? history) => <_FlowItem>[
        for (final dynamic h in history ?? const <dynamic>[])
          if (h is Map<String, dynamic>)
            if ((h["role"]?.toString() ?? "") == "user" &&
                (h["content"]?.toString() ?? "").isNotEmpty)
              _FlowItem.user(h["content"].toString())
            else if ((h["role"]?.toString() ?? "") == "assistant" &&
                (h["content"]?.toString() ?? "").isNotEmpty)
              _FlowItem.say(h["content"].toString()),
      ];

  /// 服务端恢复卡（guide/wishlist 等确定性重建的挂起卡）→ 流条目。
  static _FlowItem? _flowItemFromCard(Object? card) {
    if (card is! Map<String, dynamic>) return null;
    return switch (card["type"]?.toString()) {
      "weather" => _FlowItem.weather(_WeatherCardData.fromJson(card)),
      "choice" => _FlowItem.choice(_ChoiceCardData.fromJson(card)),
      "guide" => _FlowItem.guide(_GuideCardData.fromJson(card)),
      "wishlist" => _FlowItem.wishlist(_WishlistCardData.fromJson(card)),
      _ => null,
    };
  }

  /// 拉全量状态恢复对话流；失败抛出给宿主提示。
  Future<void> resume(String sessionId) async {
    if (_busy) return;
    if (_flowStarted && _sessionId == sessionId) return;
    _busy = true;
    notifyListeners();
    try {
      final Map<String, dynamic>? decoded =
          await _get("/travel/plan-session/$sessionId", _turnTimeout);
      if (decoded == null) throw Exception("空回执");
      final String state = decoded["state"]?.toString() ?? "gathering";
      final _DossierData? dossier = decoded["dossier"] is Map<String, dynamic>
          ? _DossierData.fromJson(decoded["dossier"] as Map<String, dynamic>)
          : null;
      final _BudgetData? budget = decoded["budget"] is Map<String, dynamic>
          ? _BudgetData.fromJson(decoded["budget"] as Map<String, dynamic>)
          : null;
      final _DraftData? draft = decoded["draft"] is Map<String, dynamic>
          ? _DraftData.fromJson(decoded["draft"] as Map<String, dynamic>)
          : null;
      final List<_FlowItem> restored =
          _flowFromHistory(decoded["history"] as List<dynamic>?);
      final _FlowItem? resumeCard = _flowItemFromCard(decoded["resumeCard"]);
      _flowStarted = true;
      _sessionId = sessionId;
      _lastState = state;
      _completed = state == "generated";
      _dossier = dossier;
      _flow
        ..clear()
        ..addAll(restored);
      if (state == "generated" && draft != null) {
        // 已出方案：预算卡标已确认 + 草案卡补回，档案栏口径与中断前一致
        if (budget != null) {
          budget.approved = true;
          _flow.add(_FlowItem.budget(budget));
        }
        _flow.add(_FlowItem.draft(draft));
      } else if (state == "budget_ready" && budget != null) {
        _flow.add(_FlowItem.budget(budget));
      }
      if (resumeCard != null) _flow.add(resumeCard);
      if (state == "gathering" && resumeCard == null) {
        // choice 问题卡的选项不落盘，恢复不了原卡：引导直接接着说
        _flow.add(_FlowItem.say("接着上次的继续——想补或想改什么，直接说就行。"));
      }
      onActiveChanged?.call(_sessionId);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// 清空当前流回 idle（新会话 / 手机端结束规划）。
  void reset() {
    if (_busy) return;
    if (!_flowStarted && _sessionId == null) return;
    _flowStarted = false;
    _sessionId = null;
    _lastState = null;
    _completed = false;
    _dossier = null;
    _flow.clear();
    onActiveChanged?.call(null);
    notifyListeners();
  }
}
