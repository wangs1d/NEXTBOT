import "package:flutter_test/flutter_test.dart";

import "package:nextbot/core/utils/assistant_text_sanitizer.dart";

void main() {
  test("strips leading timestamp frame from full text", () {
    expect(
      stripAssistantTimestampFrames("[ts:2026-08-08 19:29:02|周六|just now] 你好"),
      "你好",
    );
  });

  test("preserves spaces across streamed chunks", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(
      sanitizer.ingest("[ts:2026-08-08 19:29:02|周六|just now]Hello"),
      "Hello",
    );
    expect(sanitizer.ingest(" world"), " world");
    expect(sanitizer.ingest("!"), "!");
  });

  test("waits for an incomplete timestamp frame before showing text", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(sanitizer.ingest("[ts:2026-08-08"), "");
    expect(
      sanitizer.ingest(" 19:29:02|周六|just now]你好"),
      "你好",
    );
  });

  test("does not strip ordinary bracketed content", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(sanitizer.ingest("[计划] 先检查一下"), "[计划] 先检查一下");
  });

  test("strips echoed variant frame with weekday and relative tail", () {
    expect(
      stripAssistantTimestampFrames("[ts:2026-09-03 21:35:07]周四[now]\n\n王哥，"),
      "王哥，",
    );
  });

  test("strips malformed frame with line break inside (incident form)", () {
    expect(
      stripAssistantTimestampFrames("[ts\n2026-09-03 21:35:07]周四[now]\n王哥，"),
      "王哥，",
    );
  });

  test("stripAllTimestampFrameLines removes frame lines in the middle", () {
    expect(
      stripAssistantProtocolFrames(
        "王哥，\n[ts:2026-09-03 21:35:07]周四[now]\n这照片得用专门的图库搜，",
      ),
      "王哥，\n这照片得用专门的图库搜，",
    );
  });

  test("stripAllTimestampFrameLines removes malformed frame lines", () {
    expect(
      stripAllTimestampFrameLines("开头\n[ts\n2026-09-03 21:35:07]周四[now]\n结尾"),
      "开头\n结尾",
    );
  });

  test("keeps ordinary bracketed lines when removing frame lines", () {
    const text = "前缀 [ts:2026-09-03 21:35:07]周四[now] 后缀\n[计划] 先检查";
    expect(stripAllTimestampFrameLines(text), text);
  });

  test("ingest tolerates malformed frame split across chunks", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(sanitizer.ingest("[ts"), "");
    expect(sanitizer.ingest("\n2026-09-03 21:35:07]周四[now]"), "");
    expect(sanitizer.ingest("\n王哥，"), "\n王哥，");
  });

  test("ingest drops a frame line arriving mid-stream", () {
    final AssistantTextSanitizer sanitizer = AssistantTextSanitizer();

    expect(sanitizer.ingest("王哥，"), "王哥，");
    expect(sanitizer.ingest("\n[ts:2026-09-03 21:35:07]周四[now]"), "");
    expect(sanitizer.ingest("\n稍等"), "\n稍等");
  });
}
