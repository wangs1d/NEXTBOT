import "dart:io";
import "dart:ui" show ImageFilter;

import "package:flutter/material.dart";

import "../../core/services/digital_human_avatar_store.dart";
import "digital_human_live_view.dart";

/// 数字人形象：WebSocket 实时帧渲染（会动），底层保留静态抠图做未连接兜底。
///
/// 实时画面来自本地 avatar-talk-service 的 `/ws` 逐帧推流（空闲微动呼吸帧），
/// 不嵌浏览器/WebView。人物源图 683:900（兜底）与引擎输出同比例。
/// 默认 `clipInsideCircle: true`：人物收在圆形虚化底座内（顶对齐、圆形裁剪）；
/// 传 false 时保留越框效果。`showBase: false` 为右面板裸展示。
///
/// 分层规则（2026-11-28 背景透明化）：实时帧带 alpha 背景，**静态层必须只在
/// 实时流无帧时兜底显示**——否则静态图的背景会从实时层的透明区域透出来。
class DigitalHumanAvatarVisual extends StatefulWidget {
  const DigitalHumanAvatarVisual({
    super.key,
    required this.circleSize,
    this.headOverflow = 30,
    this.blur = 6,
    this.showBase = true,
    this.clipInsideCircle = true,
  });

  /// 圆形底座直径；`showBase == false` 时作为人物显示高度使用。
  final double circleSize;

  /// 头部越过圆圈上沿的高度（仅 `clipInsideCircle == false` 时生效）。
  final double headOverflow;

  final double blur;

  /// 是否渲染圆形虚化底座。右面板裸展示时传 false，只渲染人物本体。
  final bool showBase;

  /// 人物是否收在圆框内（圆形裁剪、顶对齐）。false 时头部越出圆圈上沿。
  final bool clipInsideCircle;

  @override
  State<DigitalHumanAvatarVisual> createState() =>
      _DigitalHumanAvatarVisualState();
}

class _DigitalHumanAvatarVisualState extends State<DigitalHumanAvatarVisual> {
  /// 实时流是否有帧在画：true 时隐藏静态兜底层（透明背景会透出它）。
  final ValueNotifier<bool> _liveActive = ValueNotifier<bool>(false);

  // 人物源图 683:900，底边对齐圆圈底 → 图高 = 圆圈直径 + 越框高度。
  double get _imageHeight => widget.circleSize + widget.headOverflow;
  double get _imageWidth => _imageHeight * 683.0 / 900.0;

  @override
  void dispose() {
    _liveActive.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String?>(
      valueListenable: DigitalHumanAvatarStore.instance.path,
      builder: (BuildContext context, String? customPath, _) {
        final bool dark = Theme.of(context).brightness == Brightness.dark;
        final File? customFile = customPath == null ? null : File(customPath);
        final bool hasCustom = customFile != null && customFile.existsSync();

        return ValueListenableBuilder<bool>(
          valueListenable: _liveActive,
          builder: (BuildContext context, bool liveActive, _) {
            final bool showStatic = !liveActive;

            if (!widget.showBase) {
              // 裸展示：不带任何底座/框，只有人物本体（实时帧 + 静态兜底）。
              final Widget bare = showStatic
                  ? (hasCustom
                      ? Image.file(
                          customFile,
                          width: _imageWidth,
                          height: _imageHeight,
                          fit: BoxFit.cover,
                          filterQuality: FilterQuality.high,
                        )
                      : Image.asset(
                          "assets/agent_avatars/real_human_cutout.png",
                          width: _imageWidth,
                          height: _imageHeight,
                          fit: BoxFit.fill,
                          filterQuality: FilterQuality.high,
                        ))
                  : const SizedBox.expand();
              return SizedBox(
                width: _imageWidth,
                height: _imageHeight,
                child: Stack(
                  fit: StackFit.expand,
                  children: <Widget>[
                    Center(child: bare),
                    // 实时数字人（会动）：本地推流始终盖在静态层之上（自定义
                    // 头像也会经服务重建进推流），断流/无服务时静态层兜底。
                    if (DigitalHumanLiveView.globallyEnabled)
                      DigitalHumanLiveView(
                        fit: BoxFit.cover,
                        alignment: Alignment.topCenter,
                        liveActive: _liveActive,
                      ),
                  ],
                ),
              );
            }

            // 圆内人物：宽 = 圆直径，高按 683:900 等比放大、顶对齐，
            // 超出圆底的部分被 ClipOval 裁掉 → 头顶贴圆顶、人物收在框内。
            final Widget character = showStatic
                ? (hasCustom
                    ? Image.file(
                        customFile,
                        width: widget.circleSize,
                        height: widget.circleSize * 900.0 / 683.0,
                        fit: BoxFit.cover,
                        alignment: Alignment.topCenter,
                        filterQuality: FilterQuality.high,
                      )
                    : Image.asset(
                        "assets/agent_avatars/real_human_cutout.png",
                        width: widget.circleSize,
                        height: widget.circleSize * 900.0 / 683.0,
                        fit: BoxFit.cover,
                        alignment: Alignment.topCenter,
                        filterQuality: FilterQuality.high,
                      ))
                : const SizedBox.expand();

            if (widget.clipInsideCircle) {
              // 人物收在圆框中：圆形虚化底座 + 顶对齐人物，整体圆形裁剪。
              return SizedBox(
                width: widget.circleSize,
                height: widget.circleSize,
                child: ClipOval(
                  clipBehavior: Clip.antiAlias,
                  child: Stack(
                    fit: StackFit.expand,
                    children: <Widget>[
                      // 圆形虚化底座：背景虚化融进聊天背景，无硬边框。
                      BackdropFilter(
                        filter: ImageFilter.blur(
                            sigmaX: widget.blur, sigmaY: widget.blur),
                        child: ColoredBox(
                          color: dark
                              ? const Color(0x14FFFFFF)
                              : const Color(0x0A000000),
                        ),
                      ),
                      Align(
                        alignment: Alignment.topCenter,
                        child: character,
                      ),
                      // 实时数字人（会动）：本地推流始终盖在静态层之上。
                      if (DigitalHumanLiveView.globallyEnabled)
                        Positioned.fill(
                          child: DigitalHumanLiveView(
                            fit: BoxFit.cover,
                            alignment: Alignment.topCenter,
                            liveActive: _liveActive,
                          ),
                        ),
                    ],
                  ),
                ),
              );
            }

            // 越框模式：人物头部越过圆圈上沿，底边落在圆圈内。
            final double width = _imageWidth > widget.circleSize
                ? _imageWidth
                : widget.circleSize;
            return SizedBox(
              width: width,
              height: widget.circleSize,
              child: Stack(
                clipBehavior: Clip.none,
                alignment: Alignment.topCenter,
                children: <Widget>[
                  Positioned(
                    top: 0,
                    child: SizedBox(
                      width: widget.circleSize,
                      height: widget.circleSize,
                      child: ClipOval(
                        clipBehavior: Clip.antiAlias,
                        child: BackdropFilter(
                          filter: ImageFilter.blur(
                              sigmaX: widget.blur, sigmaY: widget.blur),
                          child: ColoredBox(
                            color: dark
                                ? const Color(0x14FFFFFF)
                                : const Color(0x0A000000),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: -widget.headOverflow,
                    child: overflowCharacter(showStatic),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  /// 越框模式的人物：实时流优先（会动、透明背景），静态层兜底。
  Widget overflowCharacter(bool showStatic) {
    final Widget live = DigitalHumanLiveView.globallyEnabled
        ? SizedBox(
            width: _imageWidth,
            height: _imageHeight,
            child: DigitalHumanLiveView(
              fit: BoxFit.cover,
              alignment: Alignment.topCenter,
              liveActive: _liveActive,
            ),
          )
        : const SizedBox.expand();
    final Widget staticFallback = !showStatic
        ? const SizedBox.expand()
        : (DigitalHumanAvatarStore.instance.currentPath != null
            ? Image.file(
                File(DigitalHumanAvatarStore.instance.currentPath!),
                width: _imageWidth,
                height: _imageHeight,
                fit: BoxFit.cover,
                filterQuality: FilterQuality.high,
              )
            : Image.asset(
                "assets/agent_avatars/real_human_cutout.png",
                width: _imageWidth,
                height: _imageHeight,
                fit: BoxFit.fill,
                filterQuality: FilterQuality.high,
              ));
    return SizedBox(
      width: _imageWidth,
      height: _imageHeight,
      child: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          Center(child: staticFallback),
          live,
        ],
      ),
    );
  }
}
