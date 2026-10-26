import 'package:flutter_test/flutter_test.dart';
import 'package:nextbot/core/presentation/dynamic_island.dart';

void main() {
  // 渲染端已迁至原生 C++ 分层窗口；Dart 侧保留状态大脑的确定性测试。
  group('DynamicIslandController 优先级仲裁', () {
    test('高优先级抢占，被抢占者回队列', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'update', title: '更新', kind: IslandKind.update, priority: 1));
      expect(c.entry?.id, 'task');

      c.present(const IslandEntry(
          id: 'schedule',
          title: '日程',
          kind: IslandKind.schedule,
          priority: -1));
      expect(c.entry?.id, 'schedule');

      c.dismiss('schedule');
      // FIFO：先入队的 update 先露面，被抢占的 task 随后回来。
      expect(c.entry?.id, 'update');
      c.dismiss('update');
      expect(c.entry?.id, 'task');
    });

    test('同优先级后来者排队不抢屏，FIFO 轮播且队列有界', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'a', title: 'A', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'b', title: 'B', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'd', title: 'D', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'e', title: 'E', kind: IslandKind.schedule, priority: 2));
      expect(c.entry?.id, 'a');
      c.dismiss('a');
      // FIFO：最早入队的 b 先露面。
      expect(c.entry?.id, 'b');
      // 继续灌队触发容量 3 淘汰：当前队列 [d,e] → f → [d,e,f] → g 挤掉 d。
      c.present(const IslandEntry(
          id: 'f', title: 'F', kind: IslandKind.schedule, priority: 2));
      c.present(const IslandEntry(
          id: 'g', title: 'G', kind: IslandKind.schedule, priority: 2));
      c.dismiss('b');
      expect(c.entry?.id, 'e');
    });

    test('dismissAll 清空一切，同 id 原地刷新', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'update', title: '更新', kind: IslandKind.update, priority: 1));
      c.dismissAll();
      expect(c.entry, isNull);

      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'task',
          title: '任务刷新',
          kind: IslandKind.task,
          priority: 0,
          trailing: "3′0″"));
      expect(c.entry?.id, 'task');
      expect(c.entry?.title, '任务刷新');
    });

    test('低优先级不抢占高优先级，只入队', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      c.present(const IslandEntry(
          id: 'inbox', title: '未读', kind: IslandKind.inbox, priority: 2));
      expect(c.entry?.id, 'task');
      c.dismiss('task');
      expect(c.entry?.id, 'inbox');
    });
  });

  group('DynamicIslandController 环境数据（hover 行 + 任务动态）', () {
    test('agentActive = 后台任务面 or 前台轮次，两者独立记账', () {
      final DynamicIslandController c = DynamicIslandController();
      expect(c.agentActive, isFalse);

      c.updateTaskPlaneCount(2);
      expect(c.agentActive, isTrue);
      c.updateTaskPlaneCount(0);
      expect(c.agentActive, isFalse);

      c.setForegroundAgent(active: true);
      expect(c.agentActive, isTrue);
      // 前台收尾不影响后台计数。
      c.updateTaskPlaneCount(1);
      c.setForegroundAgent(active: false);
      expect(c.agentActive, isTrue);
    });

    test('未读数与状态行刷新进环境数据', () {
      final DynamicIslandController c = DynamicIslandController();
      c.setAmbientUnread(3);
      c.updateAgentStatusLine(' 正在搜索资料 ');
      expect(c.ambientUnread, 3);
      expect(c.agentStatusLine, '正在搜索资料');
      c.setAmbientUnread(3); // 幂等
      expect(c.ambientUnread, 3);
    });
  });

  group('DynamicIslandController 任务动态步骤流（展开卡总览节）', () {
    test('begin 追加 / 同 key 进行中刷新文案，finish 标记成功/失败', () {
      final DynamicIslandController c = DynamicIslandController();
      c.setForegroundAgent(active: true);
      c.beginAgentStep('web_search', '正在搜索资料');
      c.beginAgentStep('calendar_add', '正在创建日程');
      expect(c.agentSteps.map((IslandAgentStep s) => s.key).toList(),
          <String>['web_search', 'calendar_add']);

      // 同 key 仍进行中：原地刷新文案，不追加。
      c.beginAgentStep('web_search', '正在搜索航班');
      expect(c.agentSteps.length, 2);
      expect(c.agentSteps.first.label, '正在搜索航班');

      c.finishAgentStep('web_search', ok: true);
      expect(c.agentSteps.first.state, 1);
      c.finishAgentStep('calendar_add', ok: false);
      expect(c.agentSteps[1].state, 2);

      // 已收尾的同 key 再 begin：新一轮步骤（同名工具重试各自成步）。
      c.beginAgentStep('web_search', '正在重新搜索');
      expect(c.agentSteps.length, 3);
      expect(c.agentSteps.last.state, 0);
    });

    test('滚动窗口只留最近 4 步（与原生 kMaxSteps 对齐）', () {
      final DynamicIslandController c = DynamicIslandController();
      c.setForegroundAgent(active: true);
      for (int i = 0; i < 6; i++) {
        c.beginAgentStep('tool_$i', '步骤 $i');
      }
      expect(c.agentSteps.map((IslandAgentStep s) => s.key).toList(),
          <String>['tool_2', 'tool_3', 'tool_4', 'tool_5']);
    });

    test('轮次结束保留步骤供回看，新一轮开始才清空', () {
      final DynamicIslandController c = DynamicIslandController();
      c.setForegroundAgent(active: true);
      c.beginAgentStep('web_search', '正在搜索资料');
      c.finishAgentStep('web_search', ok: true);
      c.setForegroundAgent(active: false);
      expect(c.agentSteps.length, 1, reason: '轮次结束后保留供展开回看');

      c.setForegroundAgent(active: true);
      expect(c.agentSteps.isEmpty, isTrue, reason: '新一轮开始清上一轮');
    });

    test('finish 无对应进行中步骤时空过（sub-agent 结果兜底）', () {
      final DynamicIslandController c = DynamicIslandController();
      c.finishAgentStep('unknown_tool', ok: true);
      expect(c.agentSteps.isEmpty, isTrue);
    });
  });

  group('DynamicIslandController 未读摘要（展开卡总览节）', () {
    test('只保留前 3 条且同列表幂等不通知', () {
      final DynamicIslandController c = DynamicIslandController();
      c.setUnreadPreview(<String>['A', 'B', 'C', 'D']);
      expect(c.unreadTitles, <String>['A', 'B', 'C']);
      int notifications = 0;
      c.addListener(() => notifications++);
      c.setUnreadPreview(<String>['A', 'B', 'C']);
      expect(notifications, 0, reason: '同列表不重复通知');
      c.setUnreadPreview(<String>['A', 'B']);
      expect(c.unreadTitles, <String>['A', 'B']);
      expect(notifications, 1);
    });
  });

  group('DynamicIslandController 语音模式独占', () {
    test('独占开启：现有条目停泊，非语音条目不抢屏，退出按序放行', () {
      final DynamicIslandController c = DynamicIslandController();
      c.present(const IslandEntry(
          id: 'schedule.next',
          title: '日程',
          kind: IslandKind.schedule,
          priority: 2));
      c.setVoiceExclusive(true);
      expect(c.entry, isNull, reason: '日程应停泊，语音模式从零开始');

      c.present(const IslandEntry(
          id: 'voice', title: '等待唤醒', kind: IslandKind.voice, priority: 0));
      expect(c.entry?.id, 'voice');

      // 语音期间后台任务启动：停泊，不打断语音条目。
      c.present(const IslandEntry(
          id: 'task', title: '任务', kind: IslandKind.task, priority: 0));
      expect(c.entry?.id, 'voice');

      // 退出：停泊条目按原顺序放行，撤语音后停泊第一条顶上。
      c.setVoiceExclusive(false);
      c.dismiss('voice');
      expect(c.entry?.id, 'schedule.next');
      c.dismiss('schedule.next');
      expect(c.entry?.id, 'task');
    });

    test('独占期间 dismiss 非语音条目只从停泊区摘除，不外漏', () {
      final DynamicIslandController c = DynamicIslandController();
      c.setVoiceExclusive(true);
      c.present(const IslandEntry(
          id: 'voice', title: '等待唤醒', kind: IslandKind.voice, priority: 0));
      c.present(const IslandEntry(
          id: 'inbox', title: '未读', kind: IslandKind.inbox, priority: 3));
      expect(c.entry?.id, 'voice', reason: 'inbox 应停在停泊区');

      c.dismiss('inbox');
      c.setVoiceExclusive(false);
      expect(c.entry?.id, 'voice', reason: '被 dismiss 的停泊条目不外漏');
      c.dismiss('voice');
      expect(c.entry, isNull);
    });
  });

  group('IslandReminderPolicy 下一事项预告窗口闸', () {
    test('还在很久不预告，进入该事项首档提前量窗口才预告', () {
      // 普通事项窗口 30 分：睡前列表里的「该休息啦」下午不占胶囊。
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '该休息啦', 'minutesAhead': 430}),
          isFalse, reason: '还有 7 小时 10 分不该预告');
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '该休息啦', 'minutesAhead': 31}),
          isFalse);
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '该休息啦', 'minutesAhead': 30}),
          isTrue);
      // 会议类窗口 25 分。
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '设计评审', 'minutesAhead': 26}),
          isFalse);
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '设计评审', 'minutesAhead': 25}),
          isTrue);
      // 出行类窗口最宽（180 分）——按情况放宽。
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '去机场赶航班', 'minutesAhead': 181}),
          isFalse);
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '去机场赶航班', 'minutesAhead': 180}),
          isTrue);
    });

    test('E2E 台账注入未带 minutesAhead：视为已在窗口内放行', () {
      expect(IslandReminderPolicy.withinPreviewWindow(
          <String, Object?>{'title': '设计评审', 'trailing': '25 分钟后'}),
          isTrue);
    });
  });
}
