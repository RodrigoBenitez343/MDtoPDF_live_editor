# make-icon.ps1 — draws the DocMaster app icon (dark rounded square,
# cream document page, gold text lines, blue accent) at 256x256 PNG.
Add-Type -AssemblyName System.Drawing

function New-RoundedPath([System.Drawing.Rectangle]$r, [int]$radius) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $p.AddArc($r.X, $r.Y, $d, $d, 180, 90)
    $p.AddArc($r.Right - $d, $r.Y, $d, $d, 270, 90)
    $p.AddArc($r.Right - $d, $r.Bottom - $d, $d, $d, 0, 90)
    $p.AddArc($r.X, $r.Bottom - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-Icon([string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap(256, 256)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded dark-navy background (#1e1e2e)
    $bgPath = New-RoundedPath (New-Object System.Drawing.Rectangle(8, 8, 240, 240)) 52
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 30, 46))
    $g.FillPath($bgBrush, $bgPath)

    # Cream document page (#f5f5f0)
    $pageRect = New-Object System.Drawing.Rectangle(48, 40, 160, 176)
    $pagePath = New-RoundedPath $pageRect 18
    $pageBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 245, 245, 240))
    $g.FillPath($pageBrush, $pagePath)

    # Blue accent bar on the page's left edge (#89b4fa, highlight-box style)
    $blueBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 137, 180, 250))
    $g.FillRectangle($blueBrush, 48, 74, 7, 108)

    # Gold title line (#b8a97e)
    $goldBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 184, 169, 126))
    $g.FillRectangle($goldBrush, 68, 76, 96, 11)

    # Gray body lines
    $grayBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 156, 154, 136))
    $g.FillRectangle($grayBrush, 68, 104, 122, 8)
    $g.FillRectangle($grayBrush, 68, 126, 122, 8)
    $g.FillRectangle($grayBrush, 68, 148, 122, 8)
    $g.FillRectangle($grayBrush, 68, 170, 78, 8)

    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $grayBrush.Dispose(); $goldBrush.Dispose(); $blueBrush.Dispose()
    $pageBrush.Dispose(); $bgBrush.Dispose()
    $pagePath.Dispose(); $bgPath.Dispose()
    $g.Dispose(); $bmp.Dispose()
    Write-Output "Icon written: $outPath"
}

New-Icon "c:\Users\LoOper\Desktop\CIBERNETDOCS\app\resources\icons\appIcon.png"
New-Icon "c:\Users\LoOper\Desktop\CIBERNETDOCS\app\buildAssets\appIcon.png"
