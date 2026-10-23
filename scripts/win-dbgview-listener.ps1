# Global OutputDebugString listener (DBWIN protocol).
# Writes "<pid> <text>" lines to the log file given as -Out, until killed.
param([string] $Out = 'E:\ws-project\NextBot\shots\dbgview.log')

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Threading;
using System.Threading.Tasks;

public static class DbWinListener {
  public static Task Start(string path) {
    var bufferReady = new EventWaitHandle(true, EventResetMode.AutoReset, "DBWIN_BUFFER_READY");
    var dataReady = new EventWaitHandle(false, EventResetMode.AutoReset, "DBWIN_DATA_READY");
    var mmf = MemoryMappedFile.CreateOrOpen("DBWIN_BUFFER", 4096);
    var view = mmf.CreateViewAccessor(0, 4096);
    var writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };

    return Task.Run(() => {
      while (true) {
        bufferReady.Set();
        if (!dataReady.WaitOne(500)) continue;
        uint pid = view.ReadUInt32(0);
        var bytes = new byte[4096 - 4];
        view.ReadArray(4, bytes, 0, bytes.Length);
        int len = Array.IndexOf(bytes, (byte)0);
        if (len < 0) len = bytes.Length;
        string text = System.Text.Encoding.Default.GetString(bytes, 0, len).TrimEnd('\0');
        writer.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " [" + pid + "] " + text);
      }
    });
  }
}
'@

[DbWinListener]::Start($Out) | Out-Null
Write-Host "DbWin listener -> $Out"
while ($true) { Start-Sleep -Seconds 3600 }
