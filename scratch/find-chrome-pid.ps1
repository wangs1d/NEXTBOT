Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*nb-shots*' } |
  Sort-Object CreationDate |
  Select-Object -First 1 -ExpandProperty ProcessId
