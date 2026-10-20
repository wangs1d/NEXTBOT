#include "single_instance.h"

namespace pai_single_instance {
namespace {

// 主实例互斥体名。Local\ 前缀 = 当前登录会话命名空间：多用户/RDP 各自独立，
// 互不干扰；同一会话内则全局唯一。
constexpr wchar_t kMutexName[] = L"Local\\PrivateAIAgent.PrimaryInstance";

// 主窗口属性键：给主实例的主窗口打标记，供后续进程遍历定位。
constexpr wchar_t kPrimaryWindowProp[] = L"PAI_PrimaryMainWindow";

// 跨进程注册消息名（RegisterWindowMessageW 同名 → 各进程 id 一致）。
constexpr wchar_t kActivateMessageName[] = L"PAI_SingleInstance_Activate";

// 主实例持有互斥体句柄直到进程结束（进程退出时系统自动释放）：
// 提前 CloseHandle 会让互斥体消亡，后启动的进程就会错误地认为自己是主实例。
HANDLE g_primary_mutex = nullptr;

BOOL CALLBACK FindPrimaryWindowProc(HWND hwnd, LPARAM lparam) {
  if (GetPropW(hwnd, kPrimaryWindowProp) != nullptr) {
    *reinterpret_cast<HWND*>(lparam) = hwnd;
    return FALSE;  // 找到即停止枚举
  }
  return TRUE;
}

HWND FindPrimaryWindow() {
  HWND found = nullptr;
  EnumWindows(FindPrimaryWindowProc, reinterpret_cast<LPARAM>(&found));
  return found;
}

}  // namespace

UINT ActivateRequestMessage() {
  // 注册消息 id 在同一会话内稳定，缓存一次即可（避免每条消息都注册）。
  static const UINT id = RegisterWindowMessageW(kActivateMessageName);
  return id;
}

bool AcquirePrimaryInstance() {
  HANDLE mutex = CreateMutexW(nullptr, FALSE, kMutexName);
  const DWORD create_err = GetLastError();
  if (mutex == nullptr) {
    // 互斥体都建不出来（句柄配额耗尽等极端情况）：无从判定，按正常启动处理。
    return true;
  }
  if (create_err != ERROR_ALREADY_EXISTS) {
    g_primary_mutex = mutex;  // 我是主实例：句柄持有到进程结束
    return true;
  }
  CloseHandle(mutex);

  // 已有主实例（点 X 后驻留在托盘里）：找到它的主窗口，请求恢复并前置。
  //
  // 先显式授权：本进程刚被用户从桌面拉起，此刻还握有「设置前台窗口」的权限，
  // 而既有实例已退到后台/托盘——不授权的话它的 SetForegroundWindow
  // （window_manager.focus() 内部即此调用）会被系统拒绝，表现为窗口显示出来
  // 却不置顶、只在任务栏闪一下。
  const UINT activate_msg = ActivateRequestMessage();
  if (activate_msg != 0) {
    AllowSetForegroundWindow(ASFW_ANY);
    // 主实例可能仍在启动、主窗口尚未创建，给若干次短重试。主窗口 HWND 在
    // wWinMain 里 window.Create() 阶段就已建好并打标（早于 Dart bootstrap），
    // 所以正常路径第 0 次即命中。
    for (int attempt = 0; attempt < 20; ++attempt) {
      if (HWND hwnd = FindPrimaryWindow()) {
        PostMessageW(hwnd, activate_msg, 0, 0);
        break;
      }
      Sleep(100);
    }
  }

  // 无论如何都退出——绝不产生第二个主实例。
  // 定位不到窗口的唯一情形是主实例仍在自己启动（窗口还没建好），它稍后
  // 本来就会把窗口显示出来，此处静默退出不会让用户「点了图标没反应」。
  return false;
}

void MarkPrimaryMainWindow(HWND hwnd) {
  if (hwnd != nullptr) {
    SetPropW(hwnd, kPrimaryWindowProp,
             reinterpret_cast<HANDLE>(static_cast<INT_PTR>(1)));
  }
}

}  // namespace pai_single_instance
