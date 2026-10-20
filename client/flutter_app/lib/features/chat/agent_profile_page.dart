import "package:flutter/material.dart";

import "../../core/presentation/agent_avatar_catalog.dart";
import "../../core/services/user_preferences_api.dart";

class AgentProfileData {
  const AgentProfileData({
    required this.displayName,
    required this.handle,
    required this.signature,
    required this.avatarUrl,
    required this.moodStyle,
    required this.statusText,
    required this.avatarPreset,
    required this.lastProfileEvent,
    required this.updatedAt,
  });

  final String displayName;
  final String handle;
  final String signature;
  final String? avatarUrl;
  final String moodStyle;
  final String statusText;
  final String avatarPreset;
  final String lastProfileEvent;
  final DateTime? updatedAt;

  AgentProfileData copyWith({
    String? displayName,
    String? handle,
    String? signature,
    String? avatarUrl,
    String? moodStyle,
    String? statusText,
    String? avatarPreset,
    String? lastProfileEvent,
    DateTime? updatedAt,
  }) {
    return AgentProfileData(
      displayName: displayName ?? this.displayName,
      handle: handle ?? this.handle,
      signature: signature ?? this.signature,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      moodStyle: moodStyle ?? this.moodStyle,
      statusText: statusText ?? this.statusText,
      avatarPreset: avatarPreset ?? this.avatarPreset,
      lastProfileEvent: lastProfileEvent ?? this.lastProfileEvent,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  Map<String, Object?> toPayload() {
    // 不含 displayName/handle：名字是 agent.update_identity 改名管道的专属领地，
    // 主页文案写入（PUT /api/user-preferences）不得直改身份字段。
    return <String, Object?>{
      "signature": signature,
      "avatarUrl": avatarUrl,
      "moodStyle": moodStyle,
      "statusText": statusText,
      "avatarPreset": avatarPreset,
      "lastProfileEvent": lastProfileEvent,
      "updatedAt": updatedAt?.toIso8601String(),
    };
  }

  static AgentProfileData fromPreferences(Map<String, dynamic> prefs) {
    final Object? raw = prefs["agentProfile"];
    final Map<String, dynamic> profile =
        raw is Map ? raw.cast<String, dynamic>() : <String, dynamic>{};
    DateTime? updatedAt;
    final String updatedAtRaw = profile["updatedAt"]?.toString() ?? "";
    if (updatedAtRaw.isNotEmpty) {
      updatedAt = DateTime.tryParse(updatedAtRaw);
    }
    // 出厂不预设名字：用户/Agent 没设定前一律空值，界面显示「未命名」，
    // 绝不在这里塞自拟名字/handle/签名（那会让 agent 带着没人给它的名字）。
    return AgentProfileData(
      displayName: profile["displayName"]?.toString().trim() ?? "",
      handle: profile["handle"]?.toString().trim() ?? "",
      signature: profile["signature"]?.toString().trim() ?? "",
      avatarUrl: profile["avatarUrl"]?.toString().trim().isNotEmpty == true
          ? profile["avatarUrl"].toString().trim()
          : null,
      moodStyle: profile["moodStyle"]?.toString().trim().isNotEmpty == true
          ? profile["moodStyle"].toString().trim()
          : UserPreferencesApi.moodGentle,
      statusText: profile["statusText"]?.toString().trim() ?? "",
      avatarPreset:
          profile["avatarPreset"]?.toString().trim().isNotEmpty == true
              ? profile["avatarPreset"].toString().trim()
              : "dawn",
      lastProfileEvent:
          profile["lastProfileEvent"]?.toString().trim().isNotEmpty == true
              ? profile["lastProfileEvent"].toString().trim()
              : "",
      updatedAt: updatedAt,
    );
  }
}

class AgentProfilePage extends StatefulWidget {
  const AgentProfilePage({
    super.key,
    required this.api,
    required this.sessionId,
    required this.initialData,
    required this.onSaved,
  });

  final UserPreferencesApi api;
  final String sessionId;
  final AgentProfileData initialData;
  final ValueChanged<AgentProfileData> onSaved;

  @override
  State<AgentProfilePage> createState() => _AgentProfilePageState();
}

class _AgentProfilePageState extends State<AgentProfilePage> {
  late final AgentProfileData _profile;

  @override
  void initState() {
    super.initState();
    _profile = widget.initialData;
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme cs = theme.colorScheme;
    final AgentAvatarPalette palette =
        AgentAvatarPalette.fromPreset(_profile.avatarPreset);

    return Scaffold(
      appBar: AppBar(
        title: const Text("Agent 主页"),
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: <Widget>[
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: <Color>[
                  palette.colors.first.withValues(alpha: 0.22),
                  palette.colors.last.withValues(alpha: 0.14),
                ],
              ),
              borderRadius: BorderRadius.circular(24),
              border: Border.all(color: cs.outline.withValues(alpha: 0.35)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: <Widget>[
                    _AvatarPreview(
                      avatarPreset: _profile.avatarPreset,
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            _profile.displayName,
                            style: theme.textTheme.headlineSmall?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 10),
                          _QqLikeStatusBadge(
                            moodStyle: _profile.moodStyle,
                            statusText: _profile.statusText,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 18),
                Text(
                  _profile.signature,
                  style: theme.textTheme.bodyLarge?.copyWith(
                    color: cs.onSurfaceVariant,
                    height: 1.45,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text("头像与身份", style: theme.textTheme.titleMedium),
                  const SizedBox(height: 16),
                  _ReadOnlyField(
                    label: "主页名称",
                    value: _profile.displayName,
                  ),
                  const SizedBox(height: 12),
                  _ReadOnlyField(
                    label: "网络名称",
                    value: _profile.handle,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AvatarPreview extends StatelessWidget {
  const _AvatarPreview({required this.avatarPreset});

  final String avatarPreset;

  @override
  Widget build(BuildContext context) {
    // 「轨道光球」矢量头像（与聊天列表 36px 头像同一实现）
    return AgentOrbAvatar(
      size: 92,
      palette: AgentAvatarPalette.fromPreset(avatarPreset),
    );
  }
}

class _QqLikeStatusBadge extends StatelessWidget {
  const _QqLikeStatusBadge({
    required this.moodStyle,
    required this.statusText,
  });

  final String moodStyle;
  final String statusText;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    final ({String label, Color color, IconData icon, Color bg}) mood =
        _moodMeta(cs);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: mood.bg,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(mood.icon, size: 14, color: mood.color),
              const SizedBox(width: 7),
              Text(
                mood.label,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: cs.onSurface,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          if (statusText.trim().isNotEmpty) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              statusText,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: cs.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }

  ({String label, Color color, IconData icon, Color bg}) _moodMeta(
    ColorScheme cs,
  ) {
    switch (moodStyle) {
      case "funny":
        return (
          label: "摸鱼",
          color: const Color(0xFF2CBF6D),
          icon: Icons.icecream_outlined,
          bg: const Color(0x1F2CBF6D),
        );
      case "sad":
        return (
          label: "离开",
          color: const Color(0xFF8091A7),
          icon: Icons.logout_outlined,
          bg: const Color(0x1F8091A7),
        );
      case "cool":
        return (
          label: "请勿打扰",
          color: const Color(0xFF7C73FF),
          icon: Icons.do_not_disturb_on_outlined,
          bg: const Color(0x1F7C73FF),
        );
      case "energetic":
        return (
          label: "在线",
          color: const Color(0xFFFF8A3D),
          icon: Icons.flash_on_outlined,
          bg: const Color(0x1FFF8A3D),
        );
      case "mysterious":
        return (
          label: "隐身感",
          color: const Color(0xFF3F8CFF),
          icon: Icons.nightlight_round_outlined,
          bg: const Color(0x1F3F8CFF),
        );
      case "gentle":
      default:
        return (
          label: "忙碌",
          color: const Color(0xFF3AA7A3),
          icon: Icons.work_outline,
          bg: const Color(0x1F3AA7A3),
        );
    }
  }
}

class _ReadOnlyField extends StatelessWidget {
  const _ReadOnlyField({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ColorScheme cs = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: cs.outline.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            label,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: cs.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            value,
            style: Theme.of(context).textTheme.titleMedium?.copyWith(height: 1.45),
          ),
        ],
      ),
    );
  }
}
