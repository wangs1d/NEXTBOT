// 发言归组纯逻辑验证脚本（Dart，无 Flutter 依赖，可直接 `dart run` 执行）。
//
// 本机 Flutter 工具链被环境管道限制卡死（flutter_tools 调 git/where 报
// CreateFile failed 231），无法跑 `flutter test`。归组逻辑刻意做成纯 Dart，
// 用本脚本做等价验证：断言不变量 + 回放真机事故（王爷两条气泡）。
//
// 运行：cd client/flutter_app && dart run tool/verify_utterance_grouping.dart
import '../lib/features/chat/utterance_grouping.dart';

int _passed = 0;
int _failed = 0;

void check(String name, Object? actual, Object? expected) {
  final bool ok = actual == expected;
  if (ok) {
    _passed++;
    print('  ok   $name');
  } else {
    _failed++;
    print('  FAIL $name → actual=$actual expected=$expected');
  }
}

void main() {
  print('发言归组验证（utterance grouping）');

  // --- 发言 id 提取 ---
  check('分泡 id 提取发言 id', UtteranceGrouping.utteranceIdOf('assistant-t1-b1'), 't1');
  check('分泡 id 提取（两位数泡序）', UtteranceGrouping.utteranceIdOf('assistant-t1-b12'), 't1');
  check('单泡 id 提取发言 id', UtteranceGrouping.utteranceIdOf('assistant-t1'), 't1');
  check('用户消息不参与归组', UtteranceGrouping.utteranceIdOf('user-abc'), null);
  check('简报消息不参与归组', UtteranceGrouping.utteranceIdOf('assistant-briefing-t1'), 'briefing-t1');

  // --- 分段消息判定 ---
  check('分泡消息判定', UtteranceGrouping.isSegmentMessageId('assistant-t1-b2'), true);
  check('单泡消息判定', UtteranceGrouping.isSegmentMessageId('assistant-t1'), false);

  // --- 续泡判定（核心） ---
  check(
    '事故回放：同轮 b1/b2 视为同一条发言',
    UtteranceGrouping.isContinuationOf('assistant-t1-b1', 'assistant-t1-b2'),
    true,
  );
  check(
    '同轮 单泡 → 分泡 也视为同一发言',
    UtteranceGrouping.isContinuationOf('assistant-t1', 'assistant-t1-b1'),
    true,
  );
  check(
    '不同轮不归组',
    UtteranceGrouping.isContinuationOf('assistant-t1-b1', 'assistant-t2-b1'),
    false,
  );
  check(
    '同一条消息不算续泡',
    UtteranceGrouping.isContinuationOf('assistant-t1-b1', 'assistant-t1-b1'),
    false,
  );
  check(
    '用户消息不产生续泡',
    UtteranceGrouping.isContinuationOf('user-1', 'assistant-t1-b1'),
    false,
  );
  check(
    '用户消息在前不误判',
    UtteranceGrouping.isContinuationOf('assistant-t1-b1', 'user-2'),
    false,
  );

  // --- 事故回放：王爷两条气泡的展示决策 ---
  // 服务端 BubbleTracker 给两条气泡分配：
  //   b1 = "好的王爷，记下了。"（过程话，未塌缩时）
  //   b2 = "好的王爷，已经记上啦。"
  // 客户端判定：第 2 条是续泡 → 不重复头像/名字/时间头 → 读作一条消息的两句话。
  const String b1 = 'assistant-1759999999-abc-b1';
  const String b2 = 'assistant-1759999999-abc-b2';
  check('王爷事故：第 2 条渲染为续泡', UtteranceGrouping.isContinuationOf(b1, b2), true);
  check('王爷事故：第 1 条不带头像抑制之外的变化', UtteranceGrouping.isContinuationOf('user-1', b1), false);

  // --- 服务端塌缩后：只剩一条消息，不应被判成续泡 ---
  check('塌缩后单条不误判', UtteranceGrouping.isContinuationOf('user-1', 'assistant-1759999999-abc'), false);

  print('结果：pass=$_passed fail=$_failed');
  if (_failed > 0) {
    throw StateError('utterance grouping verification failed: $_failed case(s)');
  }
}
