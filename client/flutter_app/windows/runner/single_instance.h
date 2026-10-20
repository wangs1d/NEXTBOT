#ifndef RUNNER_SINGLE_INSTANCE_H_
#define RUNNER_SINGLE_INSTANCE_H_

#include <windows.h>

// 主应用单实例：保证同一登录会话内只允许存在一个主应用进程。
//
// 背景：点 X 后窗口隐藏到托盘驻留（见 app_tray_service.dart），进程继续跑。
// 用户从桌面（快捷方式 / 开始菜单 / 任务栏）再次启动时，反复双击会不断叠
// 出新进程——每个新进程各自连后台、各自拉起灵动岛/简报等子窗口，托盘里出现
// 多份、状态互相打架。这里在原生入口做一次判定：后来者找到既有主实例的主
// 窗口，请求它从托盘恢复并前置，随后自己立刻退出，绝不创建第二个窗口。
//
// ⚠️ 仅「主应用模式」可调用。本 exe 同时以「子窗口模式」被主应用
// Process.start 拉起（行程窗 PAI_TRAVEL_PLAN_MAILBOX、今日简报
// PAI_DAILY_BRIEFING_WINDOW、注册预览 PAI_REGISTER_PREVIEW），那些子进程
// 必须跳过本模块，否则它们会把既有主实例当成重复实例、反而把自己杀掉。
namespace pai_single_instance {

// 判定本进程是否可继续作为主实例启动（内部同时完成「互斥体占位」与
// 「请求既有实例前置」）。
//
// 返回 true  = 本进程是主实例（互斥体由本进程新建）：调用方继续创建主窗口；
// 返回 false = 已存在主实例：调用方必须立即退出，不要创建任何窗口与后台
//             线程。**任何情况下都不会出现第二个主实例**。
bool AcquirePrimaryInstance();

// 把 |hwnd| 标记为主实例主窗口，供后续启动的进程用 EnumWindows 定位并
// 请求前置。主窗口标题被刻意置空（WM_SETTEXT 拦截）、窗口类名又与各子窗口
// 共用 FLUTTER_RUNNER_WIN32_WINDOW，只能靠窗口属性区分。
void MarkPrimaryMainWindow(HWND hwnd);

// 「请把主窗口前置」的跨进程注册消息 id（RegisterWindowMessageW 保证同名
// 消息在所有进程中取得同一 id）。注册失败返回 0，调用方需判 0。
UINT ActivateRequestMessage();

}  // namespace pai_single_instance

#endif  // RUNNER_SINGLE_INSTANCE_H_
