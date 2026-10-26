Get-Process -Name NEXTBOT -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize
Get-Process | Where-Object { $_.MainWindowTitle -match 'Nextbot|NEXTBOT' } | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize
