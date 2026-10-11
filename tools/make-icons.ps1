# Renders icons/icon-192.png and icons/icon-512.png (same design as icons/icon.svg).
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

function RoundRect($g, $brush, $x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brush, $p)
}

foreach ($size in 192, 512) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $k = $size / 512
  $teal = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 118, 110))
  $light = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 244, 241))
  $gold = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 199, 106))
  # Full-bleed background so the maskable icon has no transparent corners.
  $g.FillRectangle($teal, 0, 0, $size, $size)
  foreach ($x in 112, 184, 256) { RoundRect $g $light ($x * $k) (112 * $k) (52 * $k) (288 * $k) (10 * $k) }
  RoundRect $g $gold (328 * $k) (112 * $k) (72 * $k) (288 * $k) (10 * $k)
  $g.Dispose()
  $bmp.Save((Join-Path $root "icons\icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
"icons written"
