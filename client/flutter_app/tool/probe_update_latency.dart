// 探针：模拟 release 客户端「检查更新」真实链路（dart:io HttpClient，
// 与 package:http 同底层），测 http://login.nextbot.top 明文 80 → 301 → HTTPS
// 整条链路的耗时。每次新进程 = 冷启动，等价于应用刚启动后点「检查更新」。
import "dart:convert";
import "dart:io";

Future<void> probe(String label, String url) async {
  final sw = Stopwatch()..start();
  final client = HttpClient();
  try {
    final req = await client.getUrl(Uri.parse(url));
    final res = await req.close().timeout(const Duration(seconds: 3));
    final body = await res.transform(const Utf8Decoder()).join();
    sw.stop();
    print("[$label] ${sw.elapsedMilliseconds}ms status=${res.statusCode} "
        "redirect=${res.isRedirect} bytes=${body.length}");
    if (res.statusCode == 301 || res.statusCode == 302) {
      print("[$label] location=${res.headers.value("location")}");
    }
  } catch (e) {
    sw.stop();
    print("[$label] FAILED after ${sw.elapsedMilliseconds}ms: $e");
  } finally {
    client.close(force: true);
  }
}

Future<void> main(List<String> args) async {
  await probe("http80", "http://login.nextbot.top/api/client/manifest?edition=internal");
  await probe("https", "https://login.nextbot.top/api/client/manifest?edition=internal");
  // 第二轮：进程内二次请求（模拟保活连接）
  await probe("http80-warm", "http://login.nextbot.top/api/client/manifest?edition=internal");
  await probe("https-warm", "https://login.nextbot.top/api/client/manifest?edition=internal");
}
