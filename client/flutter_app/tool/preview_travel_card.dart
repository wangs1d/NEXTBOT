// 行程卡「实际效果」预览（2026-09-28）：
// 用 server/data/travel-plans 里的真实行程数据（存量远程封面）渲染行程卡，
// 走真实网络（本机 server /travel/media/remote 代理链），供真机取证截图。
// flutter run -d windows -t tool/preview_travel_card.dart
import "dart:convert";
import "dart:io";

import "package:flutter/material.dart";

import "../lib/features/chat/agent_result_card.dart";
import "../lib/core/utils/agent_result_parser.dart";

Future<void> main() async {
  final File planFile =
      File("E:/ws-project/NextBot/server/data/travel-plans/plan-1790266331245.json");
  final Map<String, dynamic> plan =
      jsonDecode(planFile.readAsStringSync()) as Map<String, dynamic>;
  final List<dynamic> days = (plan["days"] as List<dynamic>? ?? <dynamic>[]);
  final AgentResultData data = AgentResultData(
    cardType: "travel_itinerary",
    title: plan["title"]?.toString() ?? "",
    items: <AgentResultItem>[
      for (int i = 0; i < days.length; i++)
        AgentResultItem(
          type: "num",
          text:
              "Day ${i + 1} · ${days[i]["date"]}: ${(days[i]["items"] as List<dynamic>).isNotEmpty ? ((days[i]["items"] as List<dynamic>).first["name"] ?? "") : ""} 等",
        ),
    ],
    footer: "共 ${days.length} 天 · 28 项安排",
    travelPlan: plan,
  );

  runApp(MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: ThemeData.dark(useMaterial3: true),
    home: Scaffold(
      backgroundColor: const Color(0xFF101418),
      body: Center(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: AgentResultCard(data: data),
          ),
        ),
      ),
    ),
  ));
}
