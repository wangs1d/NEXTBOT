// Island font acceptance harness.
// Dropped into windows_dist\Debug\ next to the real flutter_assets, it loads
// the shipped Noto OTFs through the UNMODIFIED embedded_font.h and renders
// the island's real text slots (same sizes / weights / alphas) side by side:
//   OLD = family "Noto Sans SC" + old alphas   (what the island showed)
//   NEW = IslandFontFamily()/Medium() routing + new alphas
// Output: island-font-ab.png (PNG via GDI+).
#include <windows.h>
#include <gdiplus.h>
#include <stdio.h>
#include <vector>

#include "E:\ws-project\NextBot\client\flutter_app\windows\runner\embedded_font.h"

#pragma comment(lib, "gdiplus.lib")

namespace {

HFONT CachedFont(const wchar_t* family, int size, int weight) {
  // harness-lifetime cache; tiny set, no leak concern for a one-shot tool
  return CreateFontW(size, 0, 0, 0, weight, FALSE, FALSE, FALSE,
                     DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                     CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, family);
}

// Old resolution: everything asked family "Noto Sans SC".
HFONT OldFont(int size, int weight) { return CachedFont(L"Noto Sans SC", size, weight); }
// New routing (mirrors MakeIslandFont in dynamic_island_window.cpp).
HFONT NewFont(int size, int weight) {
  return CachedFont(weight < 600 ? IslandFontFamilyMedium() : IslandFontFamily(),
                    size, weight);
}

struct Row {
  const wchar_t* text;
  int size;
  int weight;
  BYTE old_alpha;
  BYTE new_alpha;
  const wchar_t* caption;
};

}  // namespace

int main() {
  printf("[harness] stage: enter\n"); fflush(stdout);
  ULONG_PTR token = 0;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&token, &input, nullptr);
  printf("[harness] stage: gdiplus up\n"); fflush(stdout);

  LoadIslandNotoFonts();  // real loader, real assets
  printf("[harness] stage: fonts loaded ready=%d medium=%d\n", g_noto_ready ? 1 : 0,
         g_noto_medium_ready ? 1 : 0);
  fflush(stdout);
  wprintf(L"[harness] base='%s' medium='%s'\n", IslandFontFamily(),
          IslandFontFamilyMedium());
  fflush(stdout);

  const Row rows[] = {
      {L"更新下载中 64%", 17, 600, 236, 255, L"pill title 17 w600"},
      {L"还剩 2 分钟", 14, 600, 107, 150, L"pill trailing 14 w600"},
      {L"下一个：14:00 会议", 14, 500, 158, 184, L"hover line 14 w500"},
      {L"接下来", 13, 700, 97, 122, L"section label 13 w700"},
      {L"产品评审", 18, 600, 235, 255, L"agenda title 18 w600"},
      {L"腾讯会议", 14, 500, 71, 97, L"agenda hint 14 w500"},
      {L"正在查询快递信息…", 14, 500, 140, 173, L"agent step 14 w500"},
      {L"创建日程", 15, 600, 133, 168, L"action button 15 w600"},
  };

  const int W = 1160, H = 560;
  BITMAPINFO bmi = {};
  bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bmi.bmiHeader.biWidth = W;
  bmi.bmiHeader.biHeight = -H;
  bmi.bmiHeader.biPlanes = 1;
  bmi.bmiHeader.biBitCount = 32;
  HDC screen = GetDC(nullptr);
  HDC mem = CreateCompatibleDC(screen);
  void* bits = nullptr;
  HBITMAP dib = CreateDIBSection(mem, &bmi, DIB_RGB_COLORS, &bits, nullptr, 0);
  HBITMAP old_bmp = (HBITMAP)SelectObject(mem, dib);

  {
    Gdiplus::Graphics g(mem);
    g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
    g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);
    g.Clear(Gdiplus::Color(255, 24, 24, 26));

    // panel headers
    Gdiplus::Font head_font(mem, CachedFont(L"Segoe UI", 16, 700));
    Gdiplus::SolidBrush dim(Gdiplus::Color(120, 255, 255, 255));
    Gdiplus::SolidBrush bright(Gdiplus::Color(255, 255, 255, 255));
    g.DrawString(L"OLD  (family 'Noto Sans SC' + old alphas)", -1, &head_font,
                 Gdiplus::PointF(24, 10), &dim);
    g.DrawString(L"NEW  (CJK SC family + Medium routing + brighter)", -1,
                 &head_font, Gdiplus::PointF(620, 10), &bright);

    const float x_old = 24, x_new = 620;
    float y = 52;
    for (const Row& r : rows) {
      float max_w = 520;
      // OLD panel
      {
        Gdiplus::Font f(mem, OldFont(r.size, r.weight));
        Gdiplus::SolidBrush b(Gdiplus::Color(r.old_alpha, 236, 236, 236));
        g.DrawString(r.text, -1, &f, Gdiplus::PointF(x_old, y), &b);
        Gdiplus::Font cap(mem, CachedFont(L"Segoe UI", 11, 400));
        Gdiplus::SolidBrush cb(Gdiplus::Color(70, 255, 255, 255));
        g.DrawString(r.caption, -1, &cap, Gdiplus::PointF(x_old + max_w, y + 4),
                     &cb);
      }
      // NEW panel
      {
        Gdiplus::Font f(mem, NewFont(r.size, r.weight));
        Gdiplus::SolidBrush b(Gdiplus::Color(r.new_alpha, 255, 255, 255));
        g.DrawString(r.text, -1, &f, Gdiplus::PointF(x_new, y), &b);
      }
      y += 58;
    }
  }

  printf("[harness] stage: drawn\n"); fflush(stdout);
  // save PNG
  CLSID png = {};
  UINT n = 0, sz = 0;
  Gdiplus::GetImageEncodersSize(&n, &sz);
  std::vector<BYTE> enc(sz);
  Gdiplus::ImageCodecInfo* infos = (Gdiplus::ImageCodecInfo*)enc.data();
  Gdiplus::GetImageEncoders(n, sz, infos);
  for (UINT i = 0; i < n; i++) {
    if (wcscmp(infos[i].MimeType, L"image/png") == 0) { png = infos[i].Clsid; }
  }
  Gdiplus::Bitmap bitmap(W, H, 4 * W, PixelFormat32bppARGB, (BYTE*)bits);
  bitmap.Save(L"E:\\ws-project\\NextBot\\build\\island-font-ab.png", &png);
  printf("[harness] stage: saved\n"); fflush(stdout);

  SelectObject(mem, old_bmp);
  DeleteObject(dib);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  wprintf(L"[harness] saved island-font-ab.png\n");
  Gdiplus::GdiplusShutdown(token);
  return 0;
}
