# Takes Ovis for Windows (app/windows, the one-file setup app) off the PC once the desktop app that
# replaces it is installed; installer.nsh runs it. That app has no uninstaller, and its Remove button
# also takes the Ovis server off the PC, so it is never run. What it leaves (app/windows/src/LoginItem.cs)
# is its copy at %LOCALAPPDATA%\Programs\Ovis\Ovis.exe, a Start menu Ovis.lnk to that copy, and an HKCU
# Run value "Ovis" that starts the copy with --start. That sign-in start is what starts herdr's server
# when the Ovis plugin is installed (app/windows/src/Program.cs StartAtLogin), so while herdr says the
# plugin is installed the copy and its sign-in start stay, and only its windows and shortcuts go. Without
# the plugin all of it goes. herdr, the Ovis server it installed and their state stay. Anything that is
# not provably that app's is left alone.
param([Parameter(Mandatory = $true)][string]$NewExe, [string]$Herdr = '')
$ErrorActionPreference = 'Stop'
$failed = 0
function Step([string]$What, [scriptblock]$Body) {
    try { & $Body } catch { Write-Output "could not $What`: $($_.Exception.Message)"; $script:failed++ }
}

$dir = Join-Path $env:LOCALAPPDATA 'Programs\Ovis'
$exe = Join-Path $dir 'Ovis.exe'
$newPath = [IO.Path]::GetFullPath($NewExe)
if ($newPath -ieq [IO.Path]::GetFullPath($exe)) { exit 0 }

# that app's build names itself so (app/windows/Ovis.csproj; the 0.4.22 release reads Ovis, Ovis,
# Ovis contributors, Ovis.exe); this app's own exe says otherwise, and is never matched by path either
function IsOldSetup([string]$Path) {
    if (-not $Path -or [IO.Path]::GetFullPath($Path) -ieq $newPath -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $info = (Get-Item -LiteralPath $Path).VersionInfo
    return $info.CompanyName -eq 'Ovis' -and $info.ProductName -eq 'Ovis' -and $info.LegalCopyright -eq 'Ovis contributors' -and $info.OriginalFilename -eq 'Ovis.exe'
}

$present = Test-Path -LiteralPath $exe -PathType Leaf
if ($present -and -not (IsOldSetup $exe)) {
    Write-Output "left $exe alone: it is not Ovis for Windows"
    exit 0
}

# herdr as that app finds it (Paths.RefreshPath, Paths.Which): its installers' folders first, then the
# machine's and the user's PATH, each folder's herdr.exe, .cmd or .bat; a PATH entry no path can be is skipped
function FindHerdr {
    $dirs = @((Join-Path $env:USERPROFILE '.bun\bin'), (Join-Path $env:LOCALAPPDATA 'Programs\Herdr\bin')) +
        ([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') + ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')
    foreach ($dir in $dirs) {
        if (-not $dir.Trim()) { continue }
        foreach ($extension in '.exe', '.cmd', '.bat') {
            try {
                $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($dir.Trim())) ('herdr' + $extension)
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            } catch { }
        }
    }
    return $null
}

# herdr's own answer, as that app reads it (Model.FindPlugin, Setup.ParsePlugin): 'present' for the
# Ovis plugin under its id or the one releases up to 0.4.13 used, 'absent' when herdr is not on the PC or
# answers without it, 'unknown' when herdr does not answer cleanly within 15 s. Only 'absent' lets the
# sign-in start go: a herdr that did not answer may still have the plugin.
function OvisPluginState {
    $herdr = if ($Herdr) { $Herdr } else { FindHerdr }
    if (-not $herdr) { return 'absent' }
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo $herdr
        $start.Arguments = 'plugin list --json'
        $start.UseShellExecute = $false
        $start.RedirectStandardOutput = $true
        $start.CreateNoWindow = $true
        $process = [System.Diagnostics.Process]::Start($start)
        $output = $process.StandardOutput.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); return 'unknown' }
        if ($process.ExitCode -ne 0) { return 'unknown' }
        # the answer is the JSON line; anything printed before it is not
        $json = @($output.Result -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') })[0]
        $plugins = (ConvertFrom-Json $json).result.plugins
        if ($null -eq $plugins) { return 'unknown' }
        $listed = @($plugins | Where-Object { ($_.plugin_id -eq 'devswha.ovis' -or $_.plugin_id -eq 'devswha.herdr-web-ui') -and $_.plugin_root })
        return $(if ($listed.Count -gt 0) { 'present' } else { 'absent' })
    } catch {
        return 'unknown'
    }
}
$plugin = OvisPluginState
$keepStart = $plugin -ne 'absent'

# every open window of it, the installed copy's or one opened from a download: an open one could set
# its shortcut and sign-in start up again, or run its Remove.
Step 'close its windows' {
    # a second download saves as Ovis (1).exe
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name LIKE 'Ovis%.exe'")) {
        if (IsOldSetup $process.ExecutablePath) {
            # asked to close first, as its own close button would; ended when that request fails or it still runs 10 s later
            $running = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
            if ($running -and $running.CloseMainWindow()) { Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
            if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
            }
            Write-Output "closed its window $($process.ExecutablePath) (pid $($process.ProcessId))"
        }
    }
}

# the sign-in start it writes, word for word (also when its copy is already gone); a value the user
# pointed elsewhere is theirs. With the Ovis plugin installed it stays: it starts herdr's server at sign-in.
if ($plugin -eq 'present') {
    Write-Output "kept its sign-in start and $exe`: they start herdr's server at sign-in for the Ovis plugin"
} elseif ($plugin -eq 'unknown') {
    Write-Output "kept its sign-in start and $exe`: herdr did not say whether the Ovis plugin is installed"
} else {
    Step 'remove its sign-in start' {
        $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $value = (Get-ItemProperty -Path $runKey -Name Ovis -ErrorAction SilentlyContinue).Ovis
        if ($value -ieq ('"' + $exe + '" --start')) {
            Remove-ItemProperty -Path $runKey -Name Ovis
            Write-Output 'removed its sign-in start'
        }
    }
}

Step 'remove its shortcuts' {
    $shell = New-Object -ComObject WScript.Shell
    $links = @()
    foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        if (-not $folder) { continue }
        $links += @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse:($folder -eq [Environment]::GetFolderPath('Programs')) -ErrorAction SilentlyContinue)
    }
    foreach ($file in $links) {
        if ($shell.CreateShortcut($file.FullName).TargetPath -ieq $exe) {
            # Explorer may hold a shortcut open for a moment
            for ($try = 1; ; $try++) {
                try { Remove-Item -LiteralPath $file.FullName -Force; break }
                catch { if ($try -ge 5) { throw }; Start-Sleep -Milliseconds 500 }
            }
            Write-Output "removed its shortcut $($file.FullName)"
        }
    }
}

if ($present -and -not $keepStart) {
    Step "remove $exe" {
        Remove-Item -LiteralPath $exe -Force
        Write-Output "removed $exe"
        if (-not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
    }
}
exit $failed
