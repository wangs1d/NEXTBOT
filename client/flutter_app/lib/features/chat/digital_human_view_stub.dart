import "package:flutter/material.dart";

/// 数字人视图 —— Web 占位实现。
///
/// Windows 真实实现见 [digital_human_view_io.dart](digital_human_view_io.dart)，
/// 手机端见 [digital_human_view_mobile.dart](digital_human_view_mobile.dart)。
class DigitalHumanView extends StatefulWidget {
  const DigitalHumanView({super.key, this.mini = false, this.active = true});

  final bool mini;
  final bool active;

  static Uri resolveUri({required bool mini, String? base}) => Uri.parse(
        (base ?? "http://127.0.0.1:8765"),
      ).resolve(mini ? "/?mode=mini" : "/?mode=detail");

  @override
  State<DigitalHumanView> createState() => DigitalHumanViewState();
}

class DigitalHumanViewState extends State<DigitalHumanView> {
  Future<void> reloadAvatar() async {}

  Future<void> setListening(bool listening) async {}

  @override
  Widget build(BuildContext context) => Image.asset(
        "assets/agent_avatars/muse.png",
        width: double.infinity,
        height: double.infinity,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.high,
      );
}
