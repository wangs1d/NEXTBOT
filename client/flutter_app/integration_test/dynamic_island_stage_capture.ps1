# 灵动岛「三级渐进展开」交互驱动 + 截图：真实鼠标输入依次驱动 胶囊→hover→展开卡
# 三级、hover 滚轮切页、形变保护连点、鼠标离开分级收回；每步 CopyFromScreen 截图到
# %TEMP%\pai_island_stage（岛窗口 TOPMOST，不会被遮挡）。
#
# 运行流程：
#   1. 构建带注入引导的 Debug 包：
#        flutter build windows --debug --dart-define=PAI_ISLAND_E2E=true
#      （若 flutter 选不到 VS18 工具链，可手动 cmake 构建，见 README 注释）
#   2. 启动 build\windows\x64\runner\runner\Debug\NEXTBOT.exe
#   3. powershell -ExecutionPolicy Bypass -File dynamic_island_stage_capture.ps1
#   4. 截图在 %TEMP%\pai_island_stage\*.png，应用收到 driver_done 后自动退出。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PaiIslandStage {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")]
  public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[PaiIslandStage]::SetProcessDPIAware() | Out-Null

$out = Join-Path $env:TEMP 'pai_island_stage'
Remove-Item "$out\*.png" -ErrorAction SilentlyContinue
Remove-Item "$out\driver_done.flag" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null

# ── 找岛窗口 ──
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline) {
  $hwnd = [PaiIslandStage]::FindWindowW('PAI_DynamicIsland_Window', $null)
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 500
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'island window not found' }
Write-Host 'island window found'

# ── 等数据就绪（集成测试注入日程/未读/步骤流后写标志）──
$ready = Join-Path $out 'data_ready.flag'
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not (Test-Path $ready)) {
  Start-Sleep -Milliseconds 500
}
if (-not (Test-Path $ready)) { throw 'data_ready.flag timeout' }
Start-Sleep -Seconds 4
Write-Host 'data ready; starting stage walkthrough'

# 把应用主窗口拉到前台：后台进程的动画定时器会被 Windows 节流，
# 岛的重绘滞后状态机 1s+，截图与实际状态错位（真实使用场景岛进程
# 即前台无此问题；仅自动化驱动时需要）。
$mainHwnd = [PaiIslandStage]::FindWindowW('FLUTTER_RUNNER_WIN32_WINDOW', $null)
if ($mainHwnd -ne [IntPtr]::Zero) {
  [PaiIslandStage]::SwitchToThisWindow($mainHwnd, $true)
  Start-Sleep -Milliseconds 800
}

function Get-Dpi {
  $r = New-Object PaiIslandStage+RECT
  [PaiIslandStage]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  return (($r.Bottom - $r.Top) / 460.0)
}

function Get-CenterX {
  $r = New-Object PaiIslandStage+RECT
  [PaiIslandStage]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  return [int](($r.Left + $r.Right) / 2)
}

function Get-WinTop {
  $r = New-Object PaiIslandStage+RECT
  [PaiIslandStage]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  return $r.Top
}

function Click([int]$x, [int]$y) {
  [PaiIslandStage]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [PaiIslandStage]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
  Start-Sleep -Milliseconds 60
  [PaiIslandStage]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
}

function Wheel([int]$x, [int]$y, [int]$down) {
  # down=1 → 滚轮下滚（-120）；down=0 → 上滚（+120）。硬编码 uint32，
  # 避免 PS 的 -band/[uint32] 转换异常把事件整个吞掉。
  [PaiIslandStage]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  $d = [UInt32]4294967176  # -120
  if ($down -eq 0) { $d = [UInt32]120 }
  [PaiIslandStage]::mouse_event(0x0800, 0, 0, $d, [UIntPtr]::Zero)  # WHEEL
}

function Log-Marker([string]$step) {
  try {
    $line = "[" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "] PS: $step"
    Add-Content -Path (Join-Path $out 'island_log.txt') -Value $line -Encoding ASCII
  } catch { Write-Host "marker failed: $step" }
}

function Capture([string]$name) {
  $r = New-Object PaiIslandStage+RECT
  [PaiIslandStage]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -le 0 -or $h -le 0) { Write-Host "bad rect for $name"; return }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save("$out\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "captured $name"
}

$dpi = Get-Dpi
$cx = Get-CenterX
$top = Get-WinTop
$capCy = [int]($top + 24 * $dpi)     # 胶囊/hover 行中心/展开卡头部（三态均可命中）

# 1. 待机：数据已注入（task 条目已 present → compact 显示「后台任务进行中」
#    声明档胶囊）。
Capture '00_compact_task_entry'

# 2. 点击胶囊 → hover 态（环境行：下一节 · 未读；日期已删）
Log-Marker 's2_click_compact'
Click $cx $capCy
Start-Sleep -Milliseconds 1400
Capture '01_hover_today'

# 3. hover 滚轮下滚 → 任务页（Agent · 正在搜索资料）
Log-Marker 's3_wheel_down'
Wheel $cx $capCy 1
Start-Sleep -Milliseconds 1200
Capture '02_hover_agent_tab'

# 4. 再下滚 → 滚过「任务」直接进展开卡（零点击展开）
Log-Marker 's4_wheel_down_expand'
Wheel $cx $capCy 1
Start-Sleep -Milliseconds 1600
Capture '03_expanded_via_wheel'

# 5. 点展开卡头部 → 逐级收起回 hover（不是一步缩回胶囊）
Log-Marker 's5_click_card_header'
Click $cx $capCy
Start-Sleep -Milliseconds 1400
Capture '04_back_to_hover'

# 6. 点 hover → 展开（点击路径）
Log-Marker 's6_click_hover_expand'
Click $cx $capCy
Start-Sleep -Milliseconds 1400
Capture '05_expanded_via_click'

# 7. 形变保护：点击后 80ms 内再点一次，第二次应被吞掉（终态 hover，
#    不卡在中间尺寸）
Log-Marker 's7_double_click_guard'
Click $cx $capCy
Start-Sleep -Milliseconds 80
Click $cx $capCy
Start-Sleep -Milliseconds 1800
Capture '06_after_double_click_guard'

# 8. 鼠标移开 → hover 2.5s 后静默回胶囊（分级自动收回）
[PaiIslandStage]::SetCursorPos($cx, $top + [int](320 * $dpi)) | Out-Null
Start-Sleep -Milliseconds 3600
Capture '07_auto_collapsed_compact'

# 9. 点击任务胶囊 → hover → 再点 → 展开（第二轮回归验证；两次点击间隔
#    拉开到 1.4s，避开形变保护窗口，让第二次点击走合法的 hover→展开路径）
Log-Marker 's9_second_round'
Click $cx $capCy
Start-Sleep -Milliseconds 1400
Capture '08_second_round_hover'
Click $cx $capCy
Start-Sleep -Milliseconds 1600
Capture '09_second_round_expanded'

# 收尾标志
[PaiIslandStage]::SetCursorPos($cx, $top + [int](320 * $dpi)) | Out-Null
[System.IO.File]::WriteAllText((Join-Path $out 'driver_done.flag'), 'done')
Write-Host 'ALL_CAPTURED'
