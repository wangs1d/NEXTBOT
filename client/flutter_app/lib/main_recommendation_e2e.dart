// 效果图 E2E 入口（独立 main，不改生产入口）：
// 渲染 product_pick 卡（立场化推荐 + UGC 口碑 + 备选横滑）的完整 mock 消息流，
// 供 PS 按进程主窗口截图（推荐价值升级方案 P2/P3 的视觉验收）。
//
// 用法见 .tmp_shot/rec_e2e/ 下构建与截图脚本；图片由本机 8899 静态服务器提供。
// window_manager 仅做尺寸/居中（在首帧回调里调，避免 waitUntilReadyToShow
// 在此环境偶发不回调导致窗口不显示）。
import "package:flutter/material.dart";
import "package:flutter/services.dart";
import "package:window_manager/window_manager.dart";

import "features/chat/product_pick_card.dart";
import "core/utils/agent_result_parser.dart";

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  runApp(const _RecShotApp());
}

class _RecShotApp extends StatelessWidget {
  const _RecShotApp();

  @override
  Widget build(BuildContext context) {
    // 首帧后再调窗口尺寸/居中：window_manager 的 waitUntilReadyToShow 在本
    // 环境偶发不回调（窗口永不显示），首帧回调时 plugin channel 已就绪。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      windowManager.setSize(const Size(560, 960));
      windowManager.center();
    });
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: const Color(0xFF7FD4A0), useMaterial3: true),
      home: AnnotatedRegion<SystemUiOverlayStyle>(
        value: SystemUiOverlayStyle.dark,
        child: Scaffold(
          backgroundColor: const Color(0xFFF6F7F5),
          // 屏幕物理高度有限（125% DPI 下工作区 ~720 逻辑高），FittedBox 把
          // 整条消息流等比缩小到一屏内，保证效果图为完整单卡截图。
          body: Center(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              child: SizedBox(
                width: 470,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Align(
                      alignment: Alignment.centerRight,
                      child: _UserBubble(
                          text: "预算 2000 内推荐个降噪耳机，通勤地铁用，续航要长"),
                    ),
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFFFFF),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                            color: const Color(0xFF000000)
                                .withValues(alpha: 0.06)),
                      ),
                      child: const Text(
                        "结合你的通勤场景和预算，我从在售里选了这款——降噪、续航、佩戴都压得住。",
                        style: TextStyle(
                            fontSize: 13.5, height: 1.45, color: Color(0xFF1B1C1E)),
                      ),
                    ),
                    const SizedBox(height: 10),
                    const ProductPickCard(
                        data: _mockPickCard, cs: _mockColorScheme),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 贴近真实聊天流的 mock：服务端 tool-card-registry → buildCardMarker 的
/// JSON 经 agent_result_parser 解析后即为此结构（此处直接构造等价对象）。
const AgentResultData _mockPickCard = AgentResultData(
  cardType: "product_pick",
  title: "主推 · Sony WH-1000XM5 头戴降噪耳机",
  footer: "口碑来自小红书真实帖子（服务端聚合）；实时在售价以实际渠道为准",
  pick: AgentResultPick(
    productId: "p-xm5",
    label: "Sony WH-1000XM5 头戴降噪耳机",
    priceLabel: "¥1,899",
    image: "http://127.0.0.1:8899/xm5.png",
    headline: "你的诉求是「预算 2000 内 + 通勤降噪 + 续航」——XM5 的降噪、佩戴、续航均衡度正是主场，还比备选便宜 300",
    reasons: <String>[
      "30 小时续航，快充 3 分钟多用 3 小时，通勤一周一充",
      "地铁/机舱降噪第一梯队，人声低频都压得住",
    ],
    cautions: <String>["取消了折叠结构，收纳比上一代略占地方"],
    channels: <AgentResultPickChannel>[
      AgentResultPickChannel(name: "京东", priceCny: 1899),
      AgentResultPickChannel(name: "淘宝", priceCny: 1949),
      AgentResultPickChannel(name: "拼多多", priceCny: 1869),
    ],
  ),
  ugc: AgentResultUgc(
    platformLabel: "小红书",
    mentions: 128,
    pros: <String>[
      "通勤半年体验：降噪是真的顶，地铁上像换了世界",
      "戴着跑了个半马，佩戴稳得离谱",
    ],
    cons: <String>["触控容易误触，暂停歌要小心"],
    posts: <AgentResultUgcPost>[
      AgentResultUgcPost(title: "通勤半年体验：降噪天花板"),
      AgentResultUgcPost(title: "学生党闭眼入，性价比真的高"),
      AgentResultUgcPost(title: "对比 QC Ultra 后我选了它"),
    ],
  ),
  alternatives: <AgentResultPickAlt>[
    AgentResultPickAlt(
      productId: "p-qcu",
      label: "Bose QC Ultra",
      priceLabel: "¥2,199",
      image: "http://127.0.0.1:8899/bose.png",
      whenChoose: "预算再 +300，更在乎佩戴舒适",
    ),
    AgentResultPickAlt(
      productId: "p-ult",
      label: "Sony ULT Wear",
      priceLabel: "¥1,299",
      image: "http://127.0.0.1:8899/ult.png",
      whenChoose: "预算往下压 600，低音更重",
    ),
  ],
);

/// 与卡片内部强调色一致的浅色 ColorScheme（视觉验收用固定值，不随系统变化）。
const ColorScheme _mockColorScheme = ColorScheme.light(
  primary: Color(0xFF2E7D5B),
  surface: Color(0xFFFFFFFF),
  surfaceContainerHigh: Color(0xFFFAFBF9),
  surfaceContainerHighest: Color(0xFFEFF1EE),
  onSurface: Color(0xFF1B1C1E),
  onSurfaceVariant: Color(0xFF6B7069),
  outline: Color(0xFFC9CDC7),
);

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 340),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: const Color(0xFF2E7D5B),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          text,
          style: const TextStyle(fontSize: 13.5, height: 1.4, color: Colors.white),
        ),
      ),
    );
  }
}
