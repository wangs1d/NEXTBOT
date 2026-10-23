# Probe 8 (DEFINITIVE): same as probe 7 but CreateFontW now marshals the
# face name as Unicode (probe 7 passed ANSI bytes into the W function, so
# every family silently fell back - YaHei==SimSun==garbage was the tell).
# Matrix: system controls + shipped OTFs (mem + disk-private) + lab TTFs.
$ErrorActionPreference = 'Stop'

$src = @"
using System;
using System.Runtime.InteropServices;

public class FinalProbe {
  [DllImport("gdi32.dll")] public static extern IntPtr AddFontMemResourceEx(byte[] pbFont, uint cbFont, IntPtr pdv, ref uint pcFonts);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern int AddFontResourceExW(string lpszFilename, uint fl, IntPtr pdv);

  // CharSet.Unicode IS THE WHOLE POINT OF THIS PROBE.
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFontW(int h, int w, int esc, int orient, int weight, uint italic, uint underline, uint strikeout, uint charset, uint outprec, uint clipprec, uint quality, uint pitchfamily, string face);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr hSection, uint offset);
  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)] public static extern bool TextOutW(IntPtr hdc, int x, int y, string s, int c);
  [DllImport("gdi32.dll")] public static extern bool SetBkMode(IntPtr hdc, int mode);
  [DllImport("gdi32.dll")] public static extern bool PatBlt(IntPtr hdc, int x, int y, int w, int h, uint rop);
  [DllImport("gdi32.dll")] public static extern uint SetTextColor(IntPtr hdc, uint color);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes;
    public ushort biBitCount; public uint biCompression; public uint biSizeImage;
    public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO {
    public BITMAPINFOHEADER bmiHeader; public uint bmiColors;
  }

  public static string Draw(string family, int weight) {
    IntPtr sdc = GetDC(IntPtr.Zero);
    IntPtr mdc = CreateCompatibleDC(sdc);
    BITMAPINFO bmi = new BITMAPINFO();
    bmi.bmiHeader.biSize = 40; bmi.bmiHeader.biWidth = 300; bmi.bmiHeader.biHeight = -80;
    bmi.bmiHeader.biPlanes = 1; bmi.bmiHeader.biBitCount = 32;
    IntPtr bits; IntPtr dib = CreateDIBSection(mdc, ref bmi, 0, out bits, IntPtr.Zero, 0);
    IntPtr oldBmp = SelectObject(mdc, dib);
    PatBlt(mdc, 0, 0, 300, 80, 0x00FF00FF);
    IntPtr font = CreateFontW(-48, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 5, 0x21, family);
    IntPtr oldFont = SelectObject(mdc, font);
    SetBkMode(mdc, 1);
    SetTextColor(mdc, 0);
    TextOutW(mdc, 4, 8, "\u8BFB\u53D6", 2);

    int[] px = new int[300 * 80];
    Marshal.Copy(bits, px, 0, px.Length);
    SelectObject(mdc, oldFont); DeleteObject(font);
    SelectObject(mdc, oldBmp); DeleteObject(dib);
    DeleteDC(mdc); ReleaseDC(IntPtr.Zero, sdc);

    long sum = 0; int ink = 0;
    for (int i = 0; i < px.Length; i++) { int g = px[i] & 0xFF; sum += 255 - g; if (g < 128) ink++; }
    int hash = 17;
    for (int i = 0; i < px.Length; i += 7) hash = hash * 31 + (px[i] & 0xFF);
    return "dark=" + (sum / (double)px.Length).ToString("F2") + " ink=" + ink + " hash=" + hash.ToString("X8");
  }

  public static void LoadMemOtf() {
    string dir = @"E:\ws-project\NextBot\client\flutter_app\assets\fonts\noto";
    foreach (string f in new string[]{"NotoSansSC-Regular.otf","NotoSansSC-Medium.otf","NotoSansSC-Bold.otf"}) {
      byte[] b = System.IO.File.ReadAllBytes(System.IO.Path.Combine(dir, f));
      uint c = 0; AddFontMemResourceEx(b, (uint)b.Length, IntPtr.Zero, ref c);
    }
  }
  public static void LoadPrivateOtf() {
    string dir = @"E:\ws-project\NextBot\client\flutter_app\assets\fonts\noto";
    foreach (string f in new string[]{"NotoSansSC-Regular.otf","NotoSansSC-Medium.otf","NotoSansSC-Bold.otf"}) {
      AddFontResourceExW(System.IO.Path.Combine(dir, f), 0x10, IntPtr.Zero);
    }
  }
  public static void LoadLabTtf() {
    string lab = @"E:\ws-project\NextBot\build\font-lab2";
    foreach (string f in new string[]{"X-Reg.ttf","X-Med.ttf","X-Bold.ttf","Y-Med.ttf","Y-Bold.ttf"}) {
      AddFontResourceExW(System.IO.Path.Combine(lab, f), 0x10, IntPtr.Zero);
    }
  }
}
"@
Add-Type -TypeDefinition $src

Write-Host '=== controls (system fonts, valid probe) ==='
Write-Host ("garbage w400            -> {0}" -f [FinalProbe]::Draw('NoSuchFontXYZ', 400))
Write-Host ("YaHei w400              -> {0}" -f [FinalProbe]::Draw('Microsoft YaHei', 400))
Write-Host ("YaHei w700              -> {0}" -f [FinalProbe]::Draw('Microsoft YaHei', 700))
Write-Host ("SimSun w400             -> {0}" -f [FinalProbe]::Draw('SimSun', 400))
Write-Host ("sys 'Noto Sans SC' w400 -> {0}" -f [FinalProbe]::Draw('Noto Sans SC', 400))
Write-Host ("sys 'Noto Sans SC' w700 -> {0}" -f [FinalProbe]::Draw('Noto Sans SC', 700))
Write-Host ("sys 'SC Medium' w500    -> {0}" -f [FinalProbe]::Draw('Noto Sans SC Medium', 500))

Write-Host ''
Write-Host '=== shipped OTFs via AddFontMemResourceEx (island current path) ==='
[void][FinalProbe]::LoadMemOtf()
Write-Host ("mem 'CJK SC' w400       -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC', 400))
Write-Host ("mem 'CJK SC' w500       -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC', 500))
Write-Host ("mem 'CJK SC' w700       -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC', 700))
Write-Host ("mem 'CJK SC Medium' w500-> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC Medium', 500))

Write-Host ''
Write-Host '=== shipped OTFs via AddFontResourceExW(FR_PRIVATE) ==='
[void][FinalProbe]::LoadPrivateOtf()
Write-Host ("disk 'CJK SC' w400      -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC', 400))
Write-Host ("disk 'CJK SC' w500      -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC', 500))
Write-Host ("disk 'CJK SC' w700      -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC', 700))
Write-Host ("disk 'CJK Medium' w500  -> {0}" -f [FinalProbe]::Draw('Noto Sans CJK SC Medium', 500))

Write-Host ''
Write-Host '=== lab static TTFs via FR_PRIVATE ==='
[void][FinalProbe]::LoadLabTtf()
Write-Host ("lab X w400              -> {0}" -f [FinalProbe]::Draw('Lab Sans X', 400))
Write-Host ("lab X w500              -> {0}" -f [FinalProbe]::Draw('Lab Sans X', 500))
Write-Host ("lab X w700              -> {0}" -f [FinalProbe]::Draw('Lab Sans X', 700))
Write-Host ("lab Y Medium w500       -> {0}" -f [FinalProbe]::Draw('Lab Sans Y Medium', 500))
