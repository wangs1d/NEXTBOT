import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/services/share_intake_service.dart";
import "package:nextbot/features/share/quick_note_sheet.dart";

/// 分享给管家（PRD §8）的措辞契约：内容必须原样带上，末尾必须带上那一句
/// 「你打算怎么做」。这两条是验收项（§8.4）的前半段——用户分享完要看到管家
/// 打算怎么办，而不是又被反问一次。
void main() {
  group("ShareIntakeService.compose", () {
    test("分享文本：原文 + 打算怎么做，且不反问", () {
      final String out = ShareIntakeService.compose(
        text: "周六下午两点 国贸 张三",
        subject: "",
        source: "share_text",
        hasImages: false,
      );
      expect(out, contains("周六下午两点 国贸 张三"));
      expect(out, contains("打算怎么做"));
      expect(out, contains("日程"));
      expect(out, contains("别反问我"));
    });

    test("选中文字 → 管家：措辞区分来源，同一条流程", () {
      final String out = ShareIntakeService.compose(
        text: "记得带伞",
        subject: "",
        source: "process_text",
        hasImages: false,
      );
      expect(out, contains("圈给你"));
      expect(out, contains("记得带伞"));
      expect(out, contains("打算怎么做"));
    });

    test("图片分享：标题（EXTRA_SUBJECT）与正文都带上，不丢上下文", () {
      final String out = ShareIntakeService.compose(
        text: "这张票据",
        subject: "微信聊天截图",
        source: "share_mixed",
        hasImages: true,
      );
      expect(out, contains("微信聊天截图"));
      expect(out, contains("这张票据"));
      expect(out, contains("图片"));
      expect(out, contains("打算怎么做"));
    });

    test("纯图无文字：不会发出一条空消息", () {
      final String out = ShareIntakeService.compose(
        text: "",
        subject: "",
        source: "share_image",
        hasImages: true,
      );
      expect(out.trim().isNotEmpty, isTrue);
      expect(out, contains("这是刚分享给你的图片"));
    });

    test("速记卡写的话不叫「分享」：措辞按来源分开", () {
      final String note = ShareIntakeService.compose(
        text: "明天带伞",
        subject: "",
        source: "quick_note",
        hasImages: false,
      );
      expect(note, startsWith("记一下：明天带伞"));
      expect(note, contains("打算怎么做"));
      final String shot = ShareIntakeService.compose(
        text: "",
        subject: "",
        source: "camera_note",
        hasImages: true,
      );
      expect(shot, contains("刚拍给你的图片"));
    });
  });

  group("QuickNoteSheet 入口文案", () {
    test("五种入口各有各的标题，速记卡与拍照共用一套语义", () {
      expect(QuickNoteSheet.titleOf("quick_note"), "记一下");
      expect(QuickNoteSheet.titleOf("ask_note"), "问一下管家");
      expect(QuickNoteSheet.titleOf("voice_note"), "语音记一下");
      expect(QuickNoteSheet.titleOf("camera_note"), "拍一下");
      // 未知入口退回「记一下」：绝不允许弹一张没有标题的空卡
      expect(QuickNoteSheet.titleOf("whatever"), "记一下");
    });
  });
}
