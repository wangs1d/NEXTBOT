# @nextbot/companion

桌宠的**心智基层**。独立包，**尚未接入现有桌宠**，不影响 `agent-sphere-avatar` / 客户端 / 服务端的任何行为。

## 它解决什么

现有桌宠的动作是「读事件 → if/else 挑一个参数偏移 → 弹簧积分」。事件字符串决定行为分支，这就是硬编码。

这个包把硬编码从**存结果**搬到**存规律**：

```
感知 Percept
  → 心智 mind（驱力累积/衰减、注意力竞争、精力代价、情绪改写身体常数）
  → 契约 Directive（语义意图 + 因 + 身体常数，不含任何坐标曲线）
  → 解算 body（固定步长物理 + 9 个算子叠加）
  → Pose（translate / rotate / deform / glow / gaze / lid / mouth）
```

管线里没有 jump.mp4、没有关键帧、没有预制片段。跳跃 = 一段 `hold` 预压 + 一次 `impulse` + 关闭锚点弹簧交给重力 + 落地事件触发挤压。每一次跳的高度、回弹次数、落地形变都由当时的身体常数实时解算出来。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/protocol/` | 三层之间唯一的通信面。`affect` 心智状态、`directive` 语义意图、`capability` 壳的本体感觉说明书、`pose` 解算输出 |
| `src/mind/` | `drives` 驱力表与事件增益、`attention` 注意力互斥分配、`emotion-physics` 情绪→物理常数、`tick` 决策与节流 |
| `src/body/` | `operators` 9 个算子、`recipes` 12 条配方（只有算子组合，没有动画）、`physics` 固定步长积分器与相位机、`engine` 通道裁剪与累加器 |
| `src/__tests__/` | 42 个测试 + 轨迹 golden 快照 |
| `harness/` | `trace.ts` 录一天、`view.html` 回放取证 |

## 五条真实判据

不是形容词，每条都有对应测试：

1. **有因** —— `Directive.cause` 是必填字段，缺了就过不了 zod。
2. **有惯性** —— 固定步长 1/120s + 速度上限，任何一帧的位移增量有界，从不瞬移。
3. **有代价** —— 每个动作扣精力，精力压低 `intensityCap` 与 `maxSpeed`，连做会软。
4. **有选择** —— 注意力是互斥资源，显著性不够抢不走正在盯的东西。
5. **有记忆** —— 情绪改写的**是身体常数**（`springK`/`damping`/`restitution`/`noiseAmp`），不是行为选择。被凶过一次之后，同一个 `jump` 意图出来是另一种力学。

## 跑起来

```bash
cd packages/companion
npm test              # 42 个测试
npm run check         # tsc --noEmit
npm run trace         # 录 400 秒一天 → harness/out/day.trace.{json,js}
```

然后**直接用浏览器打开** `harness/view.html`（`file://` 即可，无需构建、无依赖）。可以播放/暂停、逐帧、跳到上一个/下一个行为标记，右侧看每条行为的「因」和当时的身体常数。

Golden 快照：改任何物理常数都会指名道姓地说哪几条 intent 的轨迹变了。认账之后用

```bash
COMPANION_GOLDEN=update node --test src/__tests__/golden.test.ts
```

重新生成 `src/__tests__/__golden__/trajectories.json`。零预制动画之后没有 clip 文件可比对，**轨迹快照就是新的资产**。

## 为什么能接任何壳

`CapabilityDescriptor` 是壳向心智声明自己有什么通道、什么锚点、什么边界（全部归一化场景单位，不是像素）。解算层按声明裁剪输出：只声明 `glow` 的灯条壳拿不到 `translate` 包络，并且被丢弃的通道数会计进 `engine.stats().dropped`。协议层用测试钉死不含任何屏幕坐标字段。

## 边界（当前状态）

- 未接入。现有桌宠继续走 `useAgentBodyMotion.ts`，本包不 import 它，它也不 import 本包。
- 不在根 `workspaces` 里，npm 看不见它，因此不会被现有构建带上。
- 脸部表情通道（`gaze`/`lid`/`mouth`）在协议里已占位，配方未写。
- 分层不靠 npm 隔离，靠 `src/__tests__/layering.test.ts` 执行：`protocol→∅`、`mind→protocol`、`body→protocol`，并禁止 `three`/`cannon`/`pixi`/`live2d` 与任何 DOM 全局出现在本包源码里。
