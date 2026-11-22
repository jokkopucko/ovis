# Builds Ovis for Windows into app/windows/build/: Ovis.exe (the direct download) and Ovis.msix (the
# Microsoft Store package), on Windows with the .NET SDK and the Windows SDK (a GitHub windows-latest runner
# has both).
#
# The MSIX takes its identity from OVIS_MSIX_NAME, OVIS_MSIX_PUBLISHER and OVIS_MSIX_PUBLISHER_DISPLAY_NAME
# (Partner Center's Product identity page). Without them it gets a local identity, for a test install only.
param([string]$Version = '0.0.0')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be X.Y.Z, not '$Version'." }
Set-Location $PSScriptRoot
Add-Type -AssemblyName System.Drawing
$build = Join-Path $PSScriptRoot 'build'
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path $build | Out-Null
$source = [Drawing.Image]::FromFile((Resolve-Path '..\mac\Resources\AppIcon-1024.png'))

function Resize([int]$Size, [int]$Width = $Size) {
    $bitmap = New-Object Drawing.Bitmap $Width, $Size
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.DrawImage($source, [int](($Width - $Size) / 2), 0, $Size, $Size)
    $graphics.Dispose()
    $bitmap
}
function Save-Png([int]$Size, [string]$Path, [int]$Width = $Size) {
    $bitmap = Resize $Size $Width
    $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$frames = foreach ($size in $sizes) {
    $bitmap = Resize $size
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    , $stream.ToArray()
}
$ico = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter $ico
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $edge = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$edge); $writer.Write([byte]$edge); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
    $offset += $frames[$i].Length
}
foreach ($frame in $frames) { $writer.Write($frame) }
$writer.Flush()
[IO.File]::WriteAllBytes((Join-Path $build 'Ovis.ico'), $ico.ToArray())

dotnet build Ovis.csproj -c Release -nologo "-p:Version=$Version"
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed (exit $LASTEXITCODE)." }
Copy-Item 'bin\Release\net48\Ovis.exe' (Join-Path $build 'Ovis.exe')

$layout = Join-Path $build 'msix'
New-Item -ItemType Directory -Force -Path (Join-Path $layout 'Assets') | Out-Null
Copy-Item 'bin\Release\net48\Ovis.exe' $layout
Copy-Item 'NOTICE.txt' $layout
Save-Png 44 (Join-Path $layout 'Assets\Square44x44Logo.png')
Save-Png 150 (Join-Path $layout 'Assets\Square150x150Logo.png')
Save-Png 50 (Join-Path $layout 'Assets\StoreLogo.png')
$source.Dispose()
$identity = @{
    IdentityName = if ($env:OVIS_MSIX_NAME) { $env:OVIS_MSIX_NAME } else { 'Ovis.Local' }
    Publisher = if ($env:OVIS_MSIX_PUBLISHER) { $env:OVIS_MSIX_PUBLISHER } else { 'CN=Ovis Local' }
    PublisherDisplayName = if ($env:OVIS_MSIX_PUBLISHER_DISPLAY_NAME) { $env:OVIS_MSIX_PUBLISHER_DISPLAY_NAME } else { 'Ovis' }
    Version = "$Version.0"
}
$manifest = Get-Content -Raw -Encoding UTF8 'AppxManifest.xml'
foreach ($key in $identity.Keys) { $manifest = $manifest.Replace("`$$key`$", [Security.SecurityElement]::Escape($identity[$key])) }
if ($manifest -match '\$\w+\$') { throw "AppxManifest.xml still has $($Matches[0])." }
[IO.File]::WriteAllText((Join-Path $layout 'AppxManifest.xml'), $manifest, (New-Object Text.UTF8Encoding $false))

$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $makeappx) { throw 'makeappx.exe not found: install the Windows SDK.' }
& $makeappx.FullName pack /o /d $layout /p (Join-Path $build 'Ovis.msix')
if ($LASTEXITCODE -ne 0) { throw "makeappx failed (exit $LASTEXITCODE)." }
Write-Host "built $build\Ovis.exe and $build\Ovis.msix ($($identity.IdentityName), $($identity.Publisher), $($identity.Version))"
