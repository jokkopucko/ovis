# It replaces an installed Ovis and leaves the one it installed. A herdr server it had to
# start is stopped again; one that was already running is left alone.
param(
    [string]$Installer = (Join-Path $PSScriptRoot '..\install.ps1'),
    [string]$Ref = '',
    [switch]$Update,
    [switch]$Fresh
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:OVIS_NO_OPEN = '1'
$origin = 'http://127.0.0.1:7317'
$pluginId = 'devswha.ovis'
# where the official installers put both tools; a terminal opened before them has neither on PATH
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-Json([string]$Path) { (Invoke-WebRequest "$origin$Path" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json }
# The app and herdr report their state only when asked; an unanswered question is asked again.
function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try { $value = & $Test; if ($value) { return $value } } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Timed out after $Seconds s: $What"
}
function Test-Herdr { [bool](Get-Command herdr -ErrorAction SilentlyContinue) }
function Test-ServerRunning { (Test-Herdr) -and [bool](herdr status server --json | ConvertFrom-Json).running }
function Find-Plugin {
    if (-not (Test-Herdr)) { return $null }
    (herdr plugin list --json | ConvertFrom-Json).result.plugins | Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
}
function Get-ReleaseTags {
    $tags = @(git ls-remote --tags --refs 'https://github.com/devswha/ovis.git' 'v*' |
        ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
        Sort-Object { [version]$_.Substring(1) })
    Assert ($tags.Count -ge 2) 'Could not read the release tags from GitHub'
    $tags
}
function Invoke-Installer([string]$InstallRef) {
    if ($Installer -match '^https://') {
        $env:OVIS_REF = $InstallRef
        try { Invoke-RestMethod $Installer | Invoke-Expression }
        finally { Remove-Item Env:\OVIS_REF -ErrorAction SilentlyContinue }
    } else { & $Installer -Ref $InstallRef }
}
function Assert-App([string]$Expected) {
    $health = Wait-Until { $answer = Get-Json '/api/health'; if ($answer.ok) { $answer } } 60 'the app to answer'
    $updates = Get-Json '/api/updates'
    if ($Expected -match '^[0-9a-f]{40}$') {
        Assert ($health.web_ui.revision -eq $Expected) "The app runs $($health.web_ui.revision), not $Expected"
    } else {
        Assert ("v$($updates.current_version)" -eq $Expected) "The app runs $($updates.current_version), not $Expected"
    }
    $page = Invoke-WebRequest "$origin/" -UseBasicParsing -TimeoutSec 10
    $bundle = [regex]::Match($page.Content, 'assets/index-[^"]+\.js').Value
    Assert ($page.StatusCode -eq 200 -and $bundle) 'The app page is not the built app'
    Assert ((Invoke-WebRequest "$origin/$bundle" -UseBasicParsing -TimeoutSec 30).StatusCode -eq 200) 'The app page cannot load its script'
    $session = Get-Json '/api/session'
    Assert ([bool]$session.snapshot.version) 'The app does not reach herdr'
    Write-Host "PASS Ovis $($updates.current_version) ($($health.web_ui.revision)) runs with herdr $($session.snapshot.version)"
}

if ($Fresh) {
    Assert (-not (Test-Herdr)) '-Fresh: herdr is already installed'
    Assert (-not (Get-Command bun -ErrorAction SilentlyContinue)) '-Fresh: Bun is already installed'
}
$tags = Get-ReleaseTags
$latest = $tags[-1]
if ($Update -and -not $Ref) { $Ref = $tags[-2] }
$expected = if ($Ref) { $Ref } else { $latest }
$startedServer = $false
try {
    $plugin = Find-Plugin
    if ($plugin) {
        Write-Host "e2e: removing the installed Ovis $($plugin.version)"
        if (Test-ServerRunning) { herdr plugin action invoke "$pluginId.stop-windows" | Out-Null }
        Wait-Until { -not (Get-NetTCPConnection -LocalPort 7317 -State Listen -ErrorAction SilentlyContinue) } 30 'the installed app to stop' | Out-Null
        herdr plugin uninstall $pluginId | Out-Null
        Assert ($LASTEXITCODE -eq 0) 'herdr plugin uninstall failed'
    }

    Write-Host "e2e: installing $expected with $Installer"
    Invoke-Installer $Ref
    if (-not (Test-ServerRunning)) {
        Write-Host 'e2e: starting herdr'
        Start-Process -FilePath (Get-Command herdr).Source -ArgumentList 'server' -WindowStyle Hidden
        $startedServer = $true
        Wait-Until { Test-ServerRunning } 30 'herdr to start' | Out-Null
        Wait-Until { (Get-Json '/api/health').ok } 60 'the app to start with herdr' | Out-Null
        Invoke-Installer $Ref
    }
    Assert-App $expected

    if ($Update) {
        $found = Wait-Until { $status = Get-Json '/api/updates'; if ($status.latest_version) { $status } } 90 'the app to find the latest release'
        Assert ($found.available -and "v$($found.latest_version)" -eq $latest) "The app offers $($found.latest_version) (available: $($found.available)), not $latest"
        Write-Host "e2e: updating $expected to $latest"
        # an install names the release it was offered, as the app's Update does; a release older
        # than that contract ignores the body
        $install = @{ expected_revision = $found.latest_revision } | ConvertTo-Json -Compress
        Invoke-WebRequest "$origin/api/updates/install" -Method POST -Headers @{ 'x-herdr-update' = '1' } -ContentType 'application/json' -Body $install -UseBasicParsing -TimeoutSec 30 | Out-Null
        # the app restarts in the middle of this, so some of these questions go unanswered
        $after = Wait-Until {
            $status = Get-Json '/api/updates'
            if ($status.phase -eq 'error' -or ($status.phase -eq 'idle' -and "v$($status.current_version)" -eq $latest)) { $status }
        } 600 "the update to $latest"
        Assert ($after.phase -ne 'error') "The update failed: $($after.error)"
        Assert ((Get-Json '/api/health').web_ui.revision -eq $found.latest_revision) 'The updated app does not run the latest release'
        Assert-App $latest
    }
} catch {
    Write-Host "FAIL $($_.Exception.Message)"
    if (Test-Herdr) { herdr plugin log list | Out-String | Write-Host }
    $logs = @("$env:APPDATA\herdr\herdr-server.log") + @(Get-ChildItem "$env:APPDATA\herdr", "$env:LOCALAPPDATA\herdr" -Recurse -Filter server.log -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($log in $logs) {
        if (Test-Path -LiteralPath $log) { Write-Host "--- $log"; Get-Content -LiteralPath $log -Tail 40 | Out-String | Write-Host }
    }
    throw
} finally {
    if ($startedServer) {
        herdr plugin action invoke "$pluginId.stop-windows" | Out-Null
        herdr server stop | Out-Null
    }
}
