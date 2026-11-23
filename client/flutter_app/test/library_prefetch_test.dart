import "package:flutter_test/flutter_test.dart";
import "package:nextbot/core/config/api_config.dart";
import "package:nextbot/core/services/local_file_opener.dart";
import "package:nextbot/mobile_ui/startup_media_prefetch.dart";

/// 2026-11-23 资料库全量预取：验证一次清单能抽出全部四类预热目标，
/// 且 URL / 缓存 key 与消费端同口径（拼接漂移会让预热白做）。
void main() {
  setUp(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = () => "inst_prefetch_test";
  });

  tearDown(() {
    ApiConfig.runtimeUserId = null;
    ApiConfig.installIdentityProvider = null;
  });

  Map<String, dynamic> sampleBody() => <String, dynamic>{
        "ok": true,
        "groups": <dynamic>[
          <String, dynamic>{
            "sessionId": "s1",
            "items": <String, dynamic>{
              "images": <dynamic>[
                <String, dynamic>{"name": "a.png", "url": "/agent/images/u/a.png"},
                <String, dynamic>{"name": "b.png", "url": "/agent/images/u/b.png"},
              ],
              "files": <dynamic>[
                <String, dynamic>{"name": "报告.pdf"},
                <String, dynamic>{"name": "data.xlsx"},
              ],
              "notes": <dynamic>[
                <String, dynamic>{"id": "note-1", "title": "N1"},
              ],
              "travelPlans": <dynamic>[
                <String, dynamic>{
                  "planId": "plan-1",
                  "coverImage": "/agent/travel-media/cover.jpg",
                },
              ],
            },
          },
        ],
      };

  test("四类内容全部进预热队列", () {
    final WarmTargets t = StartupMediaPrefetch.collectTargets(sampleBody());

    // 原图 2 张 + 缩略图 2 张 + 行程封面 1 张
    expect(t.originals, hasLength(2));
    expect(t.originals.first, endsWith("/agent/images/u/a.png"));
    expect(t.thumbs, contains("${ApiConfig.httpBase}/agent/images/u/a.png?w=400"));
    expect(t.thumbs, contains("${ApiConfig.httpBase}/agent/travel-media/cover.jpg"));

    // 文件 2 个，走 /agent/files/<actor>/<name>
    expect(t.files, hasLength(2));
    expect(t.files.first, contains("/agent/files/inst_prefetch_test/"));

    // 笔记正文 + 行程详情 id
    expect(t.noteIds, <String>["note-1"]);
    expect(t.planIds, <String>["plan-1"]);
  });

  test("URL 与缓存 key 单源：预取端和消费端一致", () {
    expect(
      StartupMediaPrefetch.noteCacheKey("n1"),
      "library_note_inst_prefetch_test_n1",
    );
    expect(
      StartupMediaPrefetch.planCacheKey("p1"),
      "library_plan_inst_prefetch_test_p1",
    );
    expect(
      StartupMediaPrefetch.noteUrlFor("n1"),
      contains("/notes/n1?sessionId=inst_prefetch_test"),
    );
    expect(
      StartupMediaPrefetch.planUrlFor("p1"),
      contains("/travel/plans/p1?sessionId=inst_prefetch_test"),
    );
  });

  test("去重 + 上限：同一 URL 不重复预热", () {
    final Map<String, dynamic> body = sampleBody();
    final List<dynamic> groups = body["groups"] as List<dynamic>;
    groups.add(groups.first); // 整组重复
    final WarmTargets t = StartupMediaPrefetch.collectTargets(body);
    expect(t.originals, hasLength(2));
    expect(t.thumbs.where((u) => u.contains("a.png?w=400")), hasLength(1));
    expect(t.noteIds, <String>["note-1"]);
  });

  test("文件 MIME 推断覆盖资料库实际产物类型", () {
    expect(LocalFileOpener.mimeOf("报告.pdf"), "application/pdf");
    expect(LocalFileOpener.mimeOf("数据表.xlsx"), contains("spreadsheet"));
    expect(LocalFileOpener.mimeOf("notes.md"), "text/markdown");
    expect(LocalFileOpener.mimeOf("unknown.xyz"), "*/*");
  });
}
