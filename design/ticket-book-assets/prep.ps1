Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"
$dir = "E:\ws-project\NextBot\design\ticket-book-assets"
function Resize-Jpeg([string]$inPath, [string]$outPath, [int]$maxW, [long]$quality) {
  $img = [System.Drawing.Image]::FromFile($inPath)
  try {
    $scale = [Math]::Min(1.0, $maxW / $img.Width)
    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $w, $h)
    $g.Dispose()
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)
    $bmp.Save($outPath, $codec, $ep)
    $bmp.Dispose()
    Write-Output "$outPath $w x $h"
  } finally { $img.Dispose() }
}
Resize-Jpeg "$dir\sanya.jpg" "$dir\sanya-s.jpg" 720 80
Resize-Jpeg "$dir\chongqing.jpg" "$dir\chongqing-s.jpg" 720 80
Resize-Jpeg "$dir\dali.jpg" "$dir\dali-s.jpg" 720 80
