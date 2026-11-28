import "package:flutter/material.dart";

import "../../core/services/agent_name_store.dart";
import "digital_human_avatar_visual.dart";

/// 桌面端对话区的 Agent 入口浮层：数字人头像 + 下方 agent 名字。
///
/// 2026-11-27 用户最终确认：
/// - **不装在头部条/AppBar 容器里**，而是独立浮层直接叠在对话区最上方；
///   聊天历史从它背后正常滚动投射，头像虚化底座自然融进背景。
/// - 只要**真实数字人模型人物本体**，不是 DG2 球，
///   也不是把浏览器/WebView 直接截过来（那个页面本来就是测试用的）。
/// - 人物头部故意越过圆形容器上沿，形成从框里探出来的效果；
///   无硬边框/横线/胶囊。手机端不渲染本组件（回退为纯名字胶囊）。
class DesktopDigitalHumanHeader extends StatelessWidget {
  const DesktopDigitalHumanHeader({
    super.key,
    this.agentName,
    this.onTap,
  });

  final String? agentName;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String?>(
      valueListenable: AgentNameStore.instance.name,
      builder: (BuildContext context, String? storeName, _) {
        final String name = (storeName ?? agentName ?? "").trim();
        final bool dark = Theme.of(context).brightness == Brightness.dark;
        return SizedBox(
          height: 120,
          child: Center(
            child: Semantics(
              button: true,
              label: "打开数字人面板",
              child: MouseRegion(
                cursor: onTap == null
                    ? SystemMouseCursors.basic
                    : SystemMouseCursors.click,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: onTap,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      const DigitalHumanAvatarVisual(
                        key: ValueKey<String>("desktop-dh-mini"),
                        circleSize: 78,
                        clipInsideCircle: true,
                        blur: 6,
                      ),
                      if (name.isNotEmpty) ...<Widget>[
                        const SizedBox(height: 16),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 200),
                          child: Text(
                            name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.01,
                              color: dark
                                  ? const Color(0xFFE8E8E8)
                                  : const Color(0xFF1C1C1E),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
