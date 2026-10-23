# 释放本地联调端口 3000 / 3333 / 3001（监听进程 + 残留的 server watch 子进程）
param([int]$Rounds = 3, [int]$PauseMs = 400)

$ports = 3000, 3333, 3001
$freed = @()

function Stop-ListenersOnPorts {
    param([int[]]$PortList)
    $stopped = @()
    foreach ($port in $PortList) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            $processId = $c.OwningProcess
            if ($processId -and $processId -notin $script:freed) {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                $script:freed += $processId
                $stopped += $processId
            }
        }
    }
    return $stopped
}

function Stop-OrphanDevServerNodes {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
        $cmd = $p.CommandLine
        if (-not $cmd) { continue }
        if ($cmd -notmatch 'src[/\\]index\.ts') { continue }
        if ($cmd -notmatch 'Nextbot[/\\]server|nextbot-server') { continue }
        $id = $p.ProcessId
        if ($id -and $id -notin $script:freed) {
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            $script:freed += $id
        }
    }
}

for ($i = 1; $i -le $Rounds; $i++) {
    $null = Stop-ListenersOnPorts -PortList $ports
    Stop-OrphanDevServerNodes
    if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) -and
        -not (Get-NetTCPConnection -LocalPort 3333 -State Listen -ErrorAction SilentlyContinue) -and
        -not (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) {
        break
    }
    if ($i -lt $Rounds) { Start-Sleep -Milliseconds $PauseMs }
}
