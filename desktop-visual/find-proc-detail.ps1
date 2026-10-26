Get-CimInstance Win32_Process -Filter "ProcessId=7016 OR ProcessId=22032" | Select-Object ProcessId, CreationDate, CommandLine | Format-List
