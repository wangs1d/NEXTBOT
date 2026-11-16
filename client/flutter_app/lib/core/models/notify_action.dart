/// 通知栏上的一个可点动作（ActionIntent 的一个动作）。
///
/// 动作来自服务端的「动作意图」——聊天卡上的按钮和通知栏上的按钮用的是**同一个**
/// actionId 与同一枚一次性 token，所以两边语义一致、审计一致、失败处理一致。
/// 客户端只透传 token，不解释它的含义（解释权在服务端）。
class NotifyAction {
  const NotifyAction({
    required this.actionId,
    required this.label,
    required this.token,
    this.kind = "execute",
    this.inputLabel,
    this.allowFreeFormInput,
    this.inputChoices,
  });

  /// 动作标识（服务端解释；客户端只透传）
  final String actionId;

  /// 按钮文案（动作短语，2–5 字最佳）
  final String label;

  /// 一次性凭据：服务端凭它验签 + 幂等执行
  final String token;

  /// execute=直接执行；input=需要用户补一句（RemoteInput 内联回复）
  final String kind;

  final String? inputLabel;
  final bool? allowFreeFormInput;
  final List<String>? inputChoices;

  bool get needsInput => kind == "input";

  factory NotifyAction.fromJson(Map<String, dynamic> json) {
    final List<String>? choices = (json["inputChoices"] as List<dynamic>?)
        ?.map((dynamic e) => e.toString())
        .toList();
    return NotifyAction(
      actionId: json["actionId"]?.toString() ?? "",
      label: json["label"]?.toString() ?? "",
      token: json["token"]?.toString() ?? "",
      kind: json["kind"]?.toString() ?? "execute",
      inputLabel: json["inputLabel"]?.toString(),
      allowFreeFormInput: json["allowFreeFormInput"] is bool
          ? json["allowFreeFormInput"] as bool
          : null,
      inputChoices: (choices == null || choices.isEmpty) ? null : choices,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
        "actionId": actionId,
        "label": label,
        "token": token,
        "kind": kind,
        if (inputLabel != null) "inputLabel": inputLabel,
        if (allowFreeFormInput != null) "allowFreeFormInput": allowFreeFormInput,
        if (inputChoices != null) "inputChoices": inputChoices,
      };

  /// 从服务端下发的 actionIntent 视图里取出动作列表（缺字段/格式不对一律当作没有按钮）
  static List<NotifyAction> listFromIntent(Map<String, dynamic>? intent) {
    if (intent == null) return const <NotifyAction>[];
    final List<dynamic> raw =
        (intent["actions"] as List<dynamic>?) ?? const <dynamic>[];
    final List<NotifyAction> out = <NotifyAction>[];
    for (final dynamic item in raw) {
      if (item is! Map<String, dynamic>) continue;
      final NotifyAction a = NotifyAction.fromJson(item);
      if (a.actionId.isEmpty || a.token.isEmpty) continue;
      out.add(a);
    }
    return out;
  }
}
