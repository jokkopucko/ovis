$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$originalPath = $env:PATH
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserProfile = $env:USERPROFILE
$originalFromSource = $env:OVIS_FROM_SOURCE
$env:OVIS_FROM_SOURCE = '1'
$originalStateHome = $env:XDG_STATE_HOME
$state = @{ installed = $false; installs = 0; uninstalls = 0; ref = ''; running = $true; started = $false; failInstall = $false; bunVersion = '1.4.2'; failBun = $false; windowsRelease = $true; refId = 'devswha.ovis'; installedId = ''; manifestBlocked = $false; startedLegacy = $false; legacyInstalled = $false; stopStateDirs = @(); handStarted = $false; pluginSource = ''; launcherCalls = @(); failBuild = $false; cutBuild = $null; annotated = @(); moved = @(); offline = $false; releaseDown = $false; noGit = $false; serverRecord = ''; builtUnderServer = $false; gitPrefix = ''; badBinary = $false; headMoves = $false; gitFails = $false }
$global:herdrInstallOpened = @()
$star = @{ asked = 0; answer = ''; failAsk = $false }
$ghStandIn = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-gh-$PID"
$pluginRoot = Join-Path ([IO.Path]::GetTempPath()) "herdr plugin with spaces $PID"
$launcher = Join-Path $pluginRoot 'scripts\plugin.ps1'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
# a browser opened (the app's address), or herdr's server started by the installer itself where Task Scheduler took no task
function Start-Process {
    if ($args -contains 'server') {
        $state.herdrStarts += 'here'
        # it gets this process's environment: an invite's line must not be in it
        if ($env:OVIS_JOIN -or $env:OVIS_INVITE) { $state.leaked += 'herdr started here' }
        if (-not $state.herdrDies) { $state.running = $true }
        return
    }
    $global:herdrInstallOpened += ($args -join ' ')
}

# Tool boundaries only: no downloads, installed plugins, processes or user settings are changed.
# The commit a ref names: a commit id itself, or a stand-in id for a branch or tag
function Get-TestCommit {
    param([string]$Ref)
    if ($Ref -match '^[0-9a-f]{7,40}$') { return $Ref.PadRight(40, '0') }
    -join ([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Ref)) | ForEach-Object { $_.ToString('x2') })
}
function git {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '-C' -and $args[2] -eq 'rev-parse') {
        if ($state.noGit) { Write-Error 'fatal: not a git repository (or any of the parent directories): .git' -ErrorAction Continue; $global:LASTEXITCODE = 128; return }
        # git failing at the checkout's top level ($state.gitFails): as Git for Windows does, on every call, for a folder
        # another account owns (its lines as it prints them, the empty one included, and the command quoted for a POSIX
        # shell where the folder has a space or a quote), or ('other') as for a broken repository
        if ('other' -eq $state.gitFails) { Write-Error 'fatal: bad object HEAD' -ErrorAction Continue; $global:LASTEXITCODE = 128; return }
        if ($state.gitFails) {
            $folder = $args[1] -replace '\\', '/'
            $quoted = if ($folder -match "[ ']") { "'$($folder -replace "'", "'\''")'" } else { $folder }
            foreach ($line in "fatal: detected dubious ownership in repository at '$folder'", "'$folder' is owned by:", "`tNT AUTHORITY/SYSTEM (S-1-5-18)", 'but the current user is:', "`tWINVM/someone (S-1-5-21-1-2-3-1000)", 'To add an exception for this directory, call:', '', "`tgit config --global --add safe.directory $quoted") { Write-Error $line -ErrorAction Continue }
            $global:LASTEXITCODE = 128; return
        }
        # a plugin folder inside another repository ($state.gitPrefix: its path there): git reads the repository around it
        if ($args[3] -eq '--show-prefix') { return $state.gitPrefix }
        $head = if ($state.gitPrefix) { Get-TestCommit 'the repository around it' } else { Get-TestCommit $state.ref }
        if ($args[-1] -eq 'HEAD') { return $head }
        $id = $args[-1] -replace '\^\{commit\}$' -replace '^--disambiguate='
        if ($args[-1] -like '--disambiguate=*' -and -not $head.StartsWith($id)) { return }
        if ($id -match '^[0-9a-f]{4,40}$' -and $head.StartsWith($id)) { return $head }
        $global:LASTEXITCODE = 1; return
    }
    # GitHub's refs by name: a branch at its tip ($state.moved: a commit after the one installed), an annotated tag as its
    # tag object and, asked for <name>^{}, its commit; nothing for a commit id, and exit 128 offline
    if ($args[0] -eq 'ls-remote' -and $args[1] -ne '--tags') {
        if ($state.offline) { $global:LASTEXITCODE = 128; return }
        foreach ($pattern in $args[2..($args.Count - 1)] | Where-Object { $_ -ne '--' }) {
            $name = $pattern -replace '\^\{\}$'
            if ($state.annotated -contains $name) {
                if ($pattern -ne $name) { "$(Get-TestCommit $name)`trefs/tags/$name^{}" } else { "$(Get-TestCommit "tag object $name")`trefs/tags/$name" }
            } elseif ($pattern -eq $name -and $name -notmatch '^[0-9a-f]{4,40}$') {
                "$(Get-TestCommit $(if ($state.moved -contains $name) { "$name, moved" } else { $name }))`trefs/heads/$name"
            }
        }
        return
    }
    "aaa`trefs/tags/v1.9.0"
    "bbb`trefs/tags/v1.10.0"
    "ccc`trefs/tags/v2.0.0-rc.1"
    "ddd`trefs/tags/remote-v99"
}
function bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { $state.bunVersion }
    # the add (`bun <plugin.ts> add`, or the binary's run as `bun <exe> add` by a copy of the installer): what it was given,
    # and whether it was given a pipe for its input (a native program then reads a closed, empty input: the add with
    # --account) or the terminal's (the add a person answers)
    elseif ($args[1] -eq 'add') {
        $state.adds += "$($args[1..($args.Count - 1)] -join ' ') <$(if ($MyInvocation.ExpectingInput) { "piped $(@($input).Count)" } else { 'terminal' })>"
        if ($state.addFails) { $global:LASTEXITCODE = 1; $state.addSays } else { 'Added. Open (this PC) from My PCs.' }
    }
    # `ovis join` (`bun <plugin.ts> join`): what it was given, whether its input was a pipe or the terminal's, and the line its
    # environment held; it ends with $state.joinExit (scripts/plugin-join.ts, JOIN_EXIT)
    elseif ($args[1] -eq 'join') {
        $state.joins += "$($args[1..($args.Count - 1)] -join ' ') <$(if ($MyInvocation.ExpectingInput) { "piped $(@($input).Count)" } else { 'terminal' })>"
        $state.joinInvites += "$env:OVIS_INVITE"
        $global:LASTEXITCODE = $state.joinExit
        if ($state.joinExit -eq 0) { 'Added. Open (this PC) from My PCs.' } else { 'This PC was not added.' }
    }
    # `status --json` as the release that runs answers it ($state.statusJson): one line of JSON, or a release from before it
    # that takes the flag for plain `status`
    elseif ($args[-1] -eq '--json' -and $args[-2] -eq 'status') { $state.statusJson }
    elseif ($args[-1] -eq 'status') { 'running http://127.0.0.1:7317 (pid 1234)'; 'config: none' }
    elseif ($args[-1] -eq 'stop' -and $args[0] -like '*legacy root*') {
        $state.stopStateDirs += "$env:HERDR_PLUGIN_STATE_DIR"
        if ($state.handStarted -and $env:HERDR_PLUGIN_STATE_DIR) { 'herdr web ui is not running' } else { 'stopped herdr web ui (pid 1234)' }
    }
    # the plugin's launcher: its command, and whether it was told to build from source. As scripts/plugin-launch.ts does,
    # a stop runs the release's binary of this version kept in .ovis/server/bin once it passes its check, unless
    # OVIS_FROM_SOURCE=1 or a marker naming this version chose the sources; under either, or with no such binary for any
    # reason (none kept, another version's, one failing its check, the release out of reach: a branch's sources are not
    # the release's, and a stop only works with the server that runs), it goes to scripts/plugin.ts, which fails without all
    # the packages (node_modules\all-installed stands for bun install's end). As scripts/plugin.ts's stop on Windows, it
    # stops a recorded server it identifies by the creation time its start recorded, takes its record away and says so,
    # fails on a live pid it cannot identify (another creation time, or none recorded: this process is no Ovis) and keeps
    # its record, and says it is not running without a record. An install under it says `started` in .ovis/server/source-build and names the version
    # in .ovis/server/from-source before it builds the packages and the client, and the version and commit in
    # source-build once they are built; it notes when a server's pid record is still there as it builds
    elseif ($args[0] -like '*\scripts\plugin-launch.ts') {
        $state.launcherCalls += if ($args[-1] -eq 'stop') { 'stop' } else { "$($args[-1]) $env:OVIS_FROM_SOURCE".Trim() }
        $root = Split-Path (Split-Path $args[0])
        $serverDir = Join-Path $root '.ovis\server'
        $marked = (Test-Path -LiteralPath (Join-Path $serverDir 'from-source')) -and (Get-Content -Raw -LiteralPath (Join-Path $serverDir 'from-source')).Trim() -eq '1.2.3'
        $keptJson = Join-Path $serverDir 'bin\ovis-server.json'
        $keptVersion = if (Test-Path -LiteralPath $keptJson) { (Get-Content -Raw -LiteralPath $keptJson | ConvertFrom-Json).version }
        $toSource = $marked -or -not (Test-Path -LiteralPath (Join-Path $serverDir 'bin\ovis-server.exe')) -or $keptVersion -ne '1.2.3'
        if ($args[-1] -eq 'stop') {
            # a kept binary of this version that fails its check ($state.badBinary: signature, executable or client), with no
            # release to fetch it again (out of reach, or a folder without it): no binary can be had, so the stop goes to the sources
            if ($state.badBinary) { $toSource = $true }
            if (($env:OVIS_FROM_SOURCE -eq '1' -or $toSource) -and -not (Test-Path -LiteralPath (Join-Path $root 'node_modules\all-installed'))) { $global:LASTEXITCODE = 1; return }
            $handDir = Join-Path $env:USERPROFILE '.local\state\ovis'
            $live = { param($Dir) $recorded = "$(Get-Content -Raw -LiteralPath (Join-Path $Dir 'server.pid') -ErrorAction SilentlyContinue)".Trim(); $recorded -match '^\d+$' -and [bool](Get-Process -Id $recorded -ErrorAction SilentlyContinue) }
            $readDir = if ($env:HERDR_PLUGIN_STATE_DIR) { $env:HERDR_PLUGIN_STATE_DIR } elseif (Test-Path -LiteralPath (Join-Path $handDir 'server.pid')) { $handDir } else { Join-Path $env:XDG_STATE_HOME 'herdr\plugins\devswha.ovis' }
            $legacyDir = Join-Path (Split-Path $readDir) 'devswha.herdr-web-ui'
            if ((Split-Path -Leaf $readDir) -eq 'devswha.ovis' -and -not (& $live $readDir) -and (& $live $legacyDir)) { $readDir = $legacyDir }
            if ($state.serverRecord -and (Split-Path $state.serverRecord) -eq $readDir -and (& $live $readDir)) {
                $owner = try { Get-Content -Raw -LiteralPath (Join-Path (Split-Path $state.serverRecord) 'server.owner') -ErrorAction Stop | ConvertFrom-Json } catch { $null }
                if ("$($owner.birth.value)" -ne "$(([DateTimeOffset](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").CreationDate).ToUnixTimeMilliseconds())") { $global:LASTEXITCODE = 1; return }
                Remove-Item -LiteralPath $state.serverRecord -Force
                "stopped Ovis (pid $PID)"
            } else { 'Ovis is not running' }
        }
        if ($env:OVIS_FROM_SOURCE -eq '1' -and $args[-1] -eq 'install') {
            if ($state.serverRecord -and (Test-Path -LiteralPath $state.serverRecord)) { $state.builtUnderServer = $true }
            New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
            Set-Content -LiteralPath (Join-Path $serverDir 'source-build') -Value 'started'
            Set-Content -LiteralPath (Join-Path $serverDir 'from-source') -Value '1.2.3'
            if ($state.failBuild) { $global:LASTEXITCODE = 1; return }
            if ($state.cutBuild) { $null = $state.cutBuild.Set(); Start-Sleep -Seconds 60 }
            New-Item -ItemType Directory -Force -Path (Join-Path $root 'node_modules'), (Join-Path $root 'dist') | Out-Null
            Set-Content -LiteralPath (Join-Path $root 'node_modules\all-installed'), (Join-Path $root 'dist\index.html') -Value ''
            if ($state.versionMoves) { Set-Content -LiteralPath (Join-Path $root 'package.json') -Value '{ "version": "1.2.4" }' }
            if (-not $state.headMoves -and -not $state.gitFails -and -not $state.versionMoves) {
                Set-Content -LiteralPath (Join-Path $serverDir 'source-build') -Value $(if ($state.noGit -or $state.gitPrefix) { '1.2.3' } else { "1.2.3 $(Get-TestCommit $state.ref)" })
            }
        }
    }
    else { throw "Unexpected Bun command: $args" }
}
function herdr {
    $global:LASTEXITCODE = 0
    switch ($args -join ' ') {
        '--version' { 'herdr 0.9.3' }
        'plugin list --json' {
            $plugins = @()
            if ($state.installed) { $plugins = @(@{ plugin_id = $state.installedId; plugin_root = $pluginRoot }) }
            if ($state.linkedRoot) { $plugins = @(@{ plugin_id = 'devswha.ovis'; plugin_root = $state.linkedRoot }) }
            if ($state.legacyInstalled) { $plugins += @{ plugin_id = 'devswha.herdr-web-ui'; plugin_root = (Join-Path $ghStandIn 'legacy root') } }
            @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 4 -Compress
        }
        'status server --json' { @{ running = $state.running } | ConvertTo-Json -Compress }
        'plugin action invoke devswha.ovis.start-windows' { $state.started = $true; '{}' }
        'plugin action invoke devswha.herdr-web-ui.start-windows' { $state.started = $true; $state.startedLegacy = $true; '{}' }
        'plugin uninstall devswha.ovis' { $state.installed = $false; $state.uninstalls++; 'Uninstalled' }
        'plugin uninstall devswha.herdr-web-ui' { $state.legacyInstalled = $false; 'Uninstalled' }
        'plugin config-dir devswha.ovis' { Join-Path $ghStandIn 'config\devswha.ovis' }
        'plugin config-dir devswha.herdr-web-ui' { Join-Path $ghStandIn 'config\devswha.herdr-web-ui' }
        default {
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'link') { $state.linkedRoot = $args[2]; return 'Linked' }
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'install') {
                if ($state.failInstall) { $global:LASTEXITCODE = 1; return }
                $state.installed = $true; $state.installs++; $state.ref = $args[4]; $state.installedId = $state.refId
                $state.pluginSource = "$env:OVIS_FROM_SOURCE"
                Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
                if ($state.windowsRelease) { Set-Content -LiteralPath $launcher -Value '' }
                'Installed Ovis'
            } else { throw "Unexpected herdr command: $args" }
        }
    }
}
# herdr's start and its sign-in start at their Windows boundaries: Task Scheduler, WMI and the Run key. A start makes the
# stand-in herdr answer ($state.running) unless it dies at once ($state.herdrDies); nothing reaches the real Task
# Scheduler, WMI or registry. The processes of desktop sessions (explorer, this account's or another's, and a service's)
# answer a run in session 0.
$state.herdrStarts = @(); $state.tasks = @(); $state.taskCalls = @(); $state.runValue = $null; $state.taskRefused = $false; $state.herdrDies = $false
$state.joins = @(); $state.joinInvites = @(); $state.joinExit = 0; $state.leaked = @()
$state.adds = @(); $state.addFails = $false; $state.addSays = 'Could not link this PC: the sign-in ended'; $state.statusJson = 'running http://127.0.0.1:7317 (pid 1234)'; $state.explorerOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
function New-ScheduledTaskAction { [CmdletBinding()] param($Execute, $Argument) @{ Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskPrincipal { [CmdletBinding()] param($UserId, $LogonType, $RunLevel) @{ UserId = $UserId; LogonType = "$LogonType"; RunLevel = "$RunLevel" } }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit, $Priority) @{ Limit = $ExecutionTimeLimit; Priority = $Priority } }
function Register-ScheduledTask {
    [CmdletBinding()] param($TaskName, $Action, $Principal, $Settings)
    if ($state.taskRefused) { throw 'Access is denied.' }
    $state.tasks += $TaskName
    $state.taskCalls += "register $($Action.Execute) $($Action.Argument) as $($Principal.UserId) $($Principal.LogonType) $($Principal.RunLevel), limit $($Settings.Limit), priority $($Settings.Priority)"
}
function Start-ScheduledTask {
    [CmdletBinding()] param($TaskName)
    if ($state.tasks -notcontains $TaskName) { throw "No task $TaskName" }
    $state.herdrStarts += 'desktop'
    if (-not $state.herdrDies) { $state.running = $true }
}
function Unregister-ScheduledTask { [CmdletBinding()] param($TaskName, [switch]$Confirm) $state.tasks = @($state.tasks | Where-Object { $_ -ne $TaskName }) }
function Get-CimInstance {
    [CmdletBinding()] param([Parameter(Position = 0)]$ClassName, $Filter)
    if ("$Filter" -eq 'SessionId <> 0') { return @([pscustomobject]@{ Name = 'svchost.exe'; SessionId = 1; Owner = 'S-1-5-18' }, [pscustomobject]@{ Name = 'explorer.exe'; SessionId = 1; Owner = $state.explorerOwner }) }
    CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter $Filter
}
function Invoke-CimMethod {
    [CmdletBinding()] param($ClassName, $MethodName, $Arguments, $InputObject)
    if ($MethodName -eq 'GetOwnerSid') { return @{ Sid = $InputObject.Owner } }
    if ($ClassName -eq 'Win32_Process' -and $MethodName -eq 'Create') {
        $state.herdrStarts += 'headless'; $state.headlessLine = $Arguments.CommandLine
        # the installer hands it this run's environment: an invite's line must not be in it
        if ($env:OVIS_JOIN -or $env:OVIS_INVITE) { $state.leaked += 'herdr started without a desktop' }
        if (-not $state.herdrDies) { $state.running = $true }
        return @{ ReturnValue = 0 }
    }
    throw "Unexpected CIM method: $ClassName $MethodName"
}
function Get-ItemProperty {
    [CmdletBinding()] param($Path, $Name)
    if ($Path -ne $runKey -or $Name -ne 'Ovis') { throw "Unexpected registry read: $Path $Name" }
    if ($null -ne $state.runValue) { [pscustomobject]@{ Ovis = $state.runValue } }
}
function Set-ItemProperty {
    [CmdletBinding()] param($Path, $Name, $Value)
    if ($Path -ne $runKey -or $Name -ne 'Ovis') { throw "Unexpected registry write: $Path $Name" }
    $state.runValue = $Value
}
function Remove-ItemProperty {
    [CmdletBinding()] param($Path, $Name)
    if ($Path -ne $runKey -or $Name -ne 'Ovis') { throw "Unexpected registry removal: $Path $Name" }
    $state.runValue = $null
}

function Invoke-WebRequest {
    if ("$($args[-1])" -like 'https://raw.githubusercontent.com/devswha/ovis/*/herdr-plugin.toml') {
        if ($state.manifestBlocked) { throw 'Unable to connect to the remote server' }
        return @{ Content = "name = `"Ovis`"`nid = `"$($state.refId)`"" }
    }
    if ($args[0] -eq 'https://herdr.dev/install.cmd') { Set-Content -LiteralPath $args[-1] -Value $state.herdrInstaller -Encoding Ascii; return }
    if ($args[0] -ne 'https://bun.sh/install.ps1') { throw "Unexpected download: $args" }
    if ($state.failBun) { return @{ Content = 'param($Version)' } }
    # as Bun's installer does: the session is left with the user's PATH and nothing of the machine's
    @{ Content = 'param($Version) $state.bunVersion = $Version; $env:PATH = "C:\Users\someone\.bun\bin"' }
}

try {
    New-Item -ItemType Directory -Force -Path $ghStandIn | Out-Null
    Set-Content -LiteralPath (Join-Path $ghStandIn 'gh.cmd') -Encoding Ascii -Value @'
@echo off
echo %*>>"%~dp0calls.txt"
set /p mode=<"%~dp0mode.txt"
echo %* | findstr /C:"--method PUT" >nul
if not errorlevel 1 goto star
if "%mode%"=="starred" goto starred
if "%mode%"=="hangs" goto hangs
if "%mode%"=="signed-out" goto signedout
if "%mode%"=="upstream" goto upstream
if "%mode%"=="lingering" goto lingering
echo HTTP/2.0 404 Not Found
echo gh: Not Found (HTTP 404) 1>&2
exit /b 1
:starred
echo HTTP/2.0 204 No Content
exit /b 0
:hangs
ping -n 16 127.0.0.1 >nul
exit /b 0
:signedout
echo To get started with GitHub CLI, please run:  gh auth login 1>&2
exit /b 4
:lingering
powershell -NoProfile -Command "(Start-Process ping -ArgumentList '-n','47','127.0.0.1' -NoNewWindow -PassThru).Id | Set-Content -Encoding Ascii '%~dp0child.txt'"
echo HTTP/2.0 404 Not Found
exit /b 1
:upstream
echo HTTP/2.0 500 Internal Server Error
echo gh: upstream answered HTTP 404 (HTTP 500) 1>&2
exit /b 1
:star
if "%mode%"=="refuses" goto refused
echo HTTP/2.0 204 No Content
exit /b 0
:refused
echo HTTP/2.0 404 Not Found
echo gh: Not Found (HTTP 404) 1>&2
exit /b 1
'@
    $env:PATH = "$ghStandIn;$env:PATH"
    # herdr's state dir is the test's own (a section that needs another sets it and puts this back): the installer reads
    # a server a start recorded there (scripts/plugin.ts's server.pid and server.owner), and none of this PC's
    $env:XDG_STATE_HOME = Join-Path $ghStandIn 'state home'
    # and so is %LOCALAPPDATA%, where the installer writes the launcher of herdr's sign-in start (ovis\start-herdr.ps1)
    $testLocalAppData = Join-Path $ghStandIn 'local app data'
    $env:LOCALAPPDATA = $testLocalAppData
    $herdrLauncherFile = Join-Path $testLocalAppData 'ovis\start-herdr.ps1'
    $ghCalls = Join-Path $ghStandIn 'calls.txt'
    $firstInstall = {
        param([string]$Gh, [string]$Source)
        $state.installed = $false; $star.asked = 0
        Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value $Gh
        Remove-Item -LiteralPath $ghCalls -Force -ErrorAction SilentlyContinue
        if ($Source) { Invoke-Expression $Source 6>&1 | Out-String } else { & $installer -Ref '' 6>&1 | Out-String }
    }
    $given = { @(Get-Content -LiteralPath $ghCalls -ErrorAction SilentlyContinue | Where-Object { $_ -match '--method PUT' }).Count }
    # the status read: the installer's own launcher must reach the stand-in, or a wrong launcher would pass as "already starred"
    $read = { @(Get-Content -LiteralPath $ghCalls -ErrorAction SilentlyContinue | Where-Object { $_ -match 'user/starred' -and $_ -notmatch '--method PUT' }).Count }
    Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value 'signed-out'

    & $installer -Ref ''
    Assert ($state.installed -and $state.ref -eq 'v1.10.0' -and $state.started) 'Install must choose the highest stable release and start a running server'
    & $installer -Ref ''
    Assert ($state.installs -eq 1) 'Rerun must preserve the installed plugin'
    & {
        $ErrorActionPreference = 'Continue'
        Invoke-Expression (Get-Content -Raw $installer)
        Assert ($ErrorActionPreference -eq 'Continue') 'The one-line installer must preserve the caller error preference'
        Assert (-not (Test-Path Function:\Run-Tool)) 'The one-line installer must keep helper functions in its own scope'
    }

    $state.bunVersion = '1.3.0'
    & $installer -Ref ''
    Assert ($state.bunVersion -eq '1.4.4') 'An old Bun must be updated through its installer'
    Assert ($env:PATH.EndsWith($originalPath)) "Bun's installer must not leave the session without the machine PATH"
    $state.bunVersion = '1.3.0'; $state.failBun = $true
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'Needs Bun' }
    Assert $failed 'An unsuccessful Bun bootstrap must stop installation'
    $state.bunVersion = '1.4.2'; $state.failBun = $false

    $state.installed = $false; $state.running = $false; $state.started = $false; $state.herdrStarts = @()
    & $installer -Ref 'feat/windows-install'
    Assert ($state.ref -eq 'feat/windows-install' -and ($state.herdrStarts -join ',') -eq 'desktop' -and -not $state.started) "Explicit ref with herdr stopped must install, then start herdr once, which starts the app itself (herdr starts: $($state.herdrStarts -join ','))"
    $state.installed = $false; $env:OVIS_FROM_SOURCE = ''
    & $installer -Ref 'feat/windows-install'
    Assert ($state.pluginSource -eq '1' -and -not $env:OVIS_FROM_SOURCE) "A branch must be built from its own sources (herdr's build was told '$($state.pluginSource)')"
    $state.running = $true; $state.started = $false; $state.launcherCalls = @(); $installs = $state.installs
    $noReleases = Join-Path $ghStandIn 'no releases'
    New-Item -ItemType Directory -Force -Path $noReleases | Out-Null
    $noReleases = ([Uri]$noReleases).AbsoluteUri
    $releaseDown = 'https://127.0.0.1:1'
    $env:OVIS_RELEASES_URL = $noReleases
    Set-Content -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts') -Value ''
    Set-Content -LiteralPath (Join-Path $pluginRoot 'package.json') -Value '{ "version": "1.2.3" }'
    $fromSource = Join-Path $pluginRoot '.ovis\server\from-source'
    $sourceBuild = Join-Path $pluginRoot '.ovis\server\source-build'
    $state.serverRecord = Join-Path $env:XDG_STATE_HOME 'herdr\plugins\devswha.ovis\server.pid'
    # a server of this plugin running as this very process, recorded as start records it: its pid, and its creation time
    # (or another, for a record whose pid another process has taken since; or none, 'none', as a start before server.owner),
    # or as process $Id, recorded without its creation time
    $serverRuns = {
        param([string]$Birth, [int]$Id = $PID)
        New-Item -ItemType Directory -Force -Path (Split-Path $state.serverRecord) | Out-Null
        Set-Content -LiteralPath $state.serverRecord -Value $Id
        if ($Birth -eq 'none') { return }
        if (-not $Birth) { $Birth = "$(([DateTimeOffset](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").CreationDate).ToUnixTimeMilliseconds())" }
        Set-Content -LiteralPath (Join-Path (Split-Path $state.serverRecord) 'server.owner') -Value (@{ pid = $PID; birth = @{ platform = 'win32'; value = $Birth } } | ConvertTo-Json -Compress)
    }
    $unbuilt = {
        foreach ($name in '.ovis', 'node_modules', 'dist') { Remove-Item -LiteralPath (Join-Path $pluginRoot $name) -Recurse -Force -ErrorAction SilentlyContinue }
        if ($state.serverRecord) { Remove-Item -LiteralPath (Split-Path $state.serverRecord) -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $readBuild = {
        param([string]$Line)
        $parseErrors = $null
        $parsed = [System.Management.Automation.Language.Parser]::ParseInput($Line, [ref]$null, [ref]$parseErrors)
        if ($parseErrors -or $parsed.EndBlock.Statements.Count -ne 2) { return "not two statements: $Line" }
        $set = $parsed.EndBlock.Statements[0]
        (@("$($set.Left.VariablePath.UserPath)=$($set.Right.Expression.Value)") + @($parsed.EndBlock.Statements[1].PipelineElements[0].CommandElements | ForEach-Object { $_.Value })) -join '|'
    }
    # a checkout on the release's binary: unbuilt, with that version's binary and client kept in .ovis/server/bin, the
    # binary of the SHA-256 its manifest names ($Version: another's; $Bad: another SHA-256, as one failing its check)
    $onBinary = {
        param([string]$Version = '1.2.3', [switch]$Bad)
        & $unbuilt
        $exe = Join-Path $pluginRoot '.ovis\server\bin\ovis-server.exe'
        New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server\bin\dist') | Out-Null
        Set-Content -LiteralPath $exe, (Join-Path $pluginRoot '.ovis\server\bin\dist\index.html') -Value ''
        $sha = if ($Bad) { '0' * 64 } else { (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() }
        Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.json') -Value (@{ version = $Version; assets = @{ 'windows-x64' = @{ sha256 = $sha } } } | ConvertTo-Json -Compress -Depth 3)
    }
    & $onBinary
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and $state.installs -eq $installs -and $state.started -and -not $env:OVIS_FROM_SOURCE) "A rerun over a branch on the release's binary must stop it and build it from source in place (launcher: $($state.launcherCalls -join ','))"
    & $onBinary; $state.launcherCalls = @(); $env:OVIS_FROM_SOURCE = '1'
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and $env:OVIS_FROM_SOURCE -eq '1' -and (Test-Path -LiteralPath $fromSource)) "With OVIS_FROM_SOURCE=1 set, a rerun must stop the binary and build from source (launcher: $($state.launcherCalls -join ','))"
    & $onBinary; $state.launcherCalls = @(); $env:OVIS_FROM_SOURCE = ''; $state.failBuild = $true
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'bun failed' -and -not (Test-Path -LiteralPath $fromSource) -and -not $env:OVIS_FROM_SOURCE) "A failed build must stop the install and leave no from-source marker: $message"
    Assert ($message.Contains('OVIS_REF=feat/windows-install') -and $message.Contains('herdr plugin action invoke devswha.ovis.start-windows')) "A failed build must hand over the rerun and the start of the release's binary: $message"
    Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.json') -Value '{ "version": "1.2.2" }'
    New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot 'node_modules') | Out-Null
    Set-Content -LiteralPath (Join-Path $pluginRoot 'node_modules\all-installed') -Value ''
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'bun failed' -and -not $message.Contains('start-windows')) "A failed build must not hand over the start of a kept binary of another version: $message"
    Set-Content -LiteralPath (Join-Path $pluginRoot '.ovis\server\bin\ovis-server.json') -Value '{ "version": "1.2.3" }'
    $state.failBuild = $false; $state.launcherCalls = @()
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath $fromSource)) "A rerun after a failed build must build again (launcher: $($state.launcherCalls -join ','))"
    # a build cut off after the launcher wrote the marker (Ctrl+C stops the pipeline: finally runs, catch does not): the
    # installer runs in a pipeline of its own, which is stopped as the console's Ctrl+C stops it
    & $onBinary; $state.launcherCalls = @()
    $state.cutBuild = New-Object Threading.ManualResetEvent($false)
    $runspace = [RunspaceFactory]::CreateRunspace(); $runspace.Open()
    foreach ($name in 'state', 'pluginRoot', 'ghStandIn', 'launcher', 'runKey') { $runspace.SessionStateProxy.SetVariable($name, (Get-Variable $name -ValueOnly)) }
    $stubs = [PowerShell]::Create(); $stubs.Runspace = $runspace
    # every stand-in, those of herdr's start too: an installer that got past the build there must reach no real Task
    # Scheduler, WMI or registry either
    $standIns = 'Get-TestCommit', 'git', 'bun', 'herdr', 'Start-Process', 'New-ScheduledTaskAction', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask', 'Start-ScheduledTask', 'Unregister-ScheduledTask', 'Get-CimInstance', 'Invoke-CimMethod', 'Get-ItemProperty', 'Set-ItemProperty', 'Remove-ItemProperty'
    $null = $stubs.AddScript((@(foreach ($name in $standIns) { "function global:$name {$((Get-Item "Function:\$name").Definition)}" }) -join "`n")).Invoke()
    $stubs.Dispose()
    $cut = [PowerShell]::Create(); $cut.Runspace = $runspace
    $null = $cut.AddScript((Get-Content -Raw $installer)).AddParameter('Ref', 'feat/windows-install')
    try {
        $running = $cut.BeginInvoke()
        Assert ($state.cutBuild.WaitOne(30000)) "control: the installer must reach the build (launcher: $($state.launcherCalls -join ','))"
        $cut.Stop()
        Assert ($running.IsCompleted -and $cut.InvocationStateInfo.State -eq 'Stopped') "control: the installer must have been stopped: $($cut.InvocationStateInfo.State) $($cut.InvocationStateInfo.Reason)"
    } finally { $cut.Dispose(); $runspace.Dispose(); $state.cutBuild.Dispose(); $state.cutBuild = $null }
    Assert (-not (Test-Path -LiteralPath $fromSource) -and -not $env:OVIS_FROM_SOURCE) "A build cut off must leave no from-source marker and the caller's OVIS_FROM_SOURCE (launcher: $($state.launcherCalls -join ','))"
    $state.launcherCalls = @()
    & $installer -Ref 'feat/windows-install'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath $fromSource)) "A rerun after a build cut off must build again (launcher: $($state.launcherCalls -join ','))"
    & $onBinary; $state.launcherCalls = @()
    New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null
    Set-Content -LiteralPath $fromSource -Value '1.2.3'
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath (Join-Path $pluginRoot 'dist\index.html'))) "A marker without the packages and the client must be built again (launcher: $($state.launcherCalls -join ',')): $message"
    & $unbuilt; $state.launcherCalls = @()
    New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null
    Set-Content -LiteralPath $fromSource -Value '1.2.3'
    $message = ''
    try { & $installer -Ref 'feat/windows-install' } catch { $message = $_.Exception.Message }
    Assert (($state.launcherCalls -join ',') -eq 'install 1' -and (Test-Path -LiteralPath (Join-Path $pluginRoot 'dist\index.html'))) "A cut-off build with no release binary kept must be built again without a stop (launcher: $($state.launcherCalls -join ',')): $message"
    # the ref must name the installed commit: another branch, a branch that moved since, or another commit is said, with the
    # commits, and nothing is stopped or built; offline, nothing is either
    $installedAt = (Get-TestCommit 'feat/windows-install').Substring(0, 12)
    foreach ($case in @(
        @{ name = 'another branch'; ref = 'other-branch'; at = (Get-TestCommit 'other-branch').Substring(0, 12) },
        @{ name = 'a branch that moved'; ref = 'feat/windows-install'; at = (Get-TestCommit 'feat/windows-install, moved').Substring(0, 12); moved = $true },
        @{ name = 'another commit'; ref = 'abcdef1'; at = 'abcdef1' },
        @{ name = 'GitHub out of reach'; ref = 'feat/windows-install'; offline = $true }
    )) {
        & $onBinary; $state.launcherCalls = @()
        $state.moved = @(if ($case.moved) { 'feat/windows-install' }); $state.offline = [bool]$case.offline
        $message = ''
        try { & $installer -Ref $case.ref } catch { $message = $_.Exception.Message }
        $state.moved = @(); $state.offline = $false
        Assert ($message -and $state.launcherCalls.Count -eq 0) "$($case.name): nothing must be stopped or built (launcher: $($state.launcherCalls -join ',')): $message"
        if ($case.at) { Assert ($message.Contains($installedAt) -and $message.Contains($case.at)) "$($case.name) must be said with both commits ($installedAt, $($case.at)): $message" }
    }
    foreach ($case in @(@{ ref = $installedAt }, @{ ref = $installedAt.Substring(0, 5) }, @{ ref = 'tag/annotated'; tag = $true })) {
        & $onBinary; $state.launcherCalls = @()
        if ($case.tag) { $state.annotated = @($case.ref); $state.ref = $case.ref }
        & $installer -Ref $case.ref
        $state.annotated = @(); $state.ref = 'feat/windows-install'
        Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and (Test-Path -LiteralPath $fromSource)) "$($case.ref) names the installed commit and must build that checkout (launcher: $($state.launcherCalls -join ','))"
    }
    $state.launcherCalls = @()
    & $installer -Ref 'v1.10.0'
    Assert ($state.launcherCalls.Count -eq 0 -and $state.installs -eq $installs) "Nothing must be rebuilt for a release tag (launcher: $($state.launcherCalls -join ','))"
    # what a source build left, the marker naming this version: only all the packages and the client, under a stamp that
    # says the build finished at the installed commit (or the version alone, where git could not tell it), or under none
    # (an older launcher), need no build, and the installed commit is said. With no release binary the stop goes to the
    # sources at once, not asking the release; a stop that fails is passed over only with neither a release binary nor a
    # server recorded as running (an earlier build's, here this process), whose process is named, with how to stop it
    # only when its creation time matched. A refusal that would repeat on every rerun names what to remove (recover: doing
    # that lets the next run build), and a failed build names the checkout to find a server by only where no stop stopped one.
    $finished = "1.2.3 $(Get-TestCommit 'feat/windows-install')"
    $keptBin = Join-Path $pluginRoot '.ovis\server\bin'
    foreach ($case in @(
        @{ name = 'a build cut off in bun install'; packages = 'some'; stamp = 'started'; calls = 'stop,install 1' },
        @{ name = 'a build cut off over the packages and client of an earlier one'; packages = 'all'; client = $true; stamp = 'started'; calls = 'stop,install 1' },
        @{ name = 'a finished build of another commit'; packages = 'all'; client = $true; stamp = "1.2.3 $(Get-TestCommit 'earlier')"; calls = 'stop,install 1' },
        @{ name = 'a build cut off in bun install over the client of an earlier one'; packages = 'some'; client = $true; stamp = 'started'; calls = 'stop,install 1' },
        @{ name = 'a build cut off in bun install over the client of an earlier one, its server running'; packages = 'some'; client = $true; stamp = 'started'; server = 'alive'; calls = 'stop'; refused = $true },
        @{ name = 'the same, the server recorded without its creation time'; packages = 'some'; client = $true; stamp = 'started'; server = 'unverified'; calls = 'stop'; refused = $true; names = { $state.serverRecord }; recover = { Remove-Item -LiteralPath $state.serverRecord } },
        @{ name = 'the same, the process it names being Ovis'; packages = 'some'; client = $true; stamp = 'started'; server = 'unverified'; serverProcess = $true; calls = 'stop'; refused = $true; names = { $state.serverRecord }; recover = { Stop-Process -Id $serverChild.Id; $serverChild.WaitForExit() } },
        @{ name = 'a hand-started Ovis recorded in ~\.local\state, maybe of another checkout'; packages = 'some'; stamp = 'started'; server = 'alive'; byHand = $true; calls = 'stop'; refused = $true; names = { Split-Path $state.serverRecord } },
        @{ name = 'the same, with packages that load the stop: it is left running'; packages = 'all'; stamp = 'started'; server = 'alive'; byHand = $true; calls = 'stop'; refused = $true; names = { Split-Path $state.serverRecord } },
        @{ name = 'a kept release binary of another version over broken packages'; binary = '1.2.2'; packages = 'some'; stamp = 'started'; calls = 'stop'; refused = $true; names = { $keptBin }; recover = { Remove-Item -LiteralPath $keptBin -Recurse -Force } },
        @{ name = "a kept release binary of this version whose stop cannot verify a record another process's pid holds"; binary = $true; server = 'gone'; calls = 'stop'; refused = $true; names = { $state.serverRecord }; recover = { Remove-Item -LiteralPath $state.serverRecord } },
        @{ name = 'a kept release binary of this version whose stop cannot verify a record without its creation time, the process being Ovis'; binary = $true; server = 'unverified'; serverProcess = $true; calls = 'stop'; refused = $true; names = { $state.serverRecord }; recover = { Stop-Process -Id $serverChild.Id; $serverChild.WaitForExit() } },
        @{ name = 'a finished build of an older launcher'; packages = 'all'; client = $true; calls = '' },
        @{ name = 'a finished build'; packages = 'all'; client = $true; stamp = $finished; calls = '' },
        @{ name = 'a finished build whose packages or client were removed since'; packages = 'all'; stamp = $finished; calls = 'stop,install 1' },
        @{ name = 'a finished build git could not tell the commit of, which this installer can'; packages = 'all'; client = $true; stamp = '1.2.3'; calls = 'stop,install 1' },
        @{ name = 'a finished build git could not tell the commit of, nor can this installer'; packages = 'all'; client = $true; stamp = '1.2.3'; noGit = $true; calls = '' },
        @{ name = 'a finished build in a folder that is no git checkout'; packages = 'all'; client = $true; noGit = $true; calls = '' },
        @{ name = 'an earlier server running, and dist emptied by a build cut off'; packages = 'all'; stamp = 'started'; server = 'alive'; calls = 'stop,install 1' },
        @{ name = 'an earlier server running over a build cut off after vite emptied dist, then another in bun install'; packages = 'some'; stamp = 'started'; server = 'alive'; calls = 'stop'; refused = $true },
        @{ name = 'a server record whose pid another process has taken since'; packages = 'some'; stamp = 'started'; server = 'gone'; calls = 'stop,install 1' },
        @{ name = 'a server recorded as running with nothing here to stop it with (no packages, no release binary)'; stamp = 'started'; server = 'alive'; calls = ''; refused = $true },
        @{ name = "a release binary's server recorded as running, stopped by its stop"; binary = $true; server = 'alive'; calls = 'stop,install 1' },
        @{ name = 'a finished build in a folder inside another git checkout'; packages = 'all'; client = $true; nested = $true; calls = '' },
        @{ name = 'the same, stamped with the version alone by the launcher'; packages = 'all'; client = $true; stamp = '1.2.3'; nested = $true; calls = '' },
        @{ name = "the same, stamped by an earlier launcher with the commit of the repository around it"; packages = 'all'; client = $true; stamp = "1.2.3 $(Get-TestCommit 'the repository around it')"; nested = $true; calls = '' },
        @{ name = 'a build cut off in a folder inside another git checkout'; packages = 'some'; stamp = 'started'; nested = $true; calls = ''; refused = $true; untouched = $true; names = { Join-Path $pluginRoot 'scripts\plugin-launch.ts' }; recover = {
            $given = $env:OVIS_FROM_SOURCE; $env:OVIS_FROM_SOURCE = '1'
            try { bun (Join-Path $pluginRoot 'scripts\plugin-launch.ts') install } finally { $env:OVIS_FROM_SOURCE = $given }
        } },
        @{ name = 'a kept release binary of this version that fails its check, the release out of reach'; binary = $true; badBinary = $true; packages = 'some'; stamp = 'started'; releaseDown = $true; calls = ''; refused = $true; untouched = $true; names = { $keptBin }; recover = { Remove-Item -LiteralPath $keptBin -Recurse -Force } },
        @{ name = 'the same, an Ovis started by hand recorded as running too'; binary = $true; badBinary = $true; packages = 'some'; stamp = 'started'; server = 'alive'; byHand = $true; calls = 'stop'; refused = $true; names = { $keptBin; Split-Path $state.serverRecord }; recover = { Remove-Item -LiteralPath $keptBin -Recurse -Force } },
        @{ name = 'a finished build of another commit, git failing at the checkout this once'; packages = 'all'; client = $true; stamp = "1.2.3 $(Get-TestCommit 'earlier')"; gitFails = 'other'; calls = ''; refused = $true; untouched = $true; names = { 'bad object HEAD'; 'nothing was stopped or changed' }; recover = { <# git answers again #> } },
        @{ name = 'a build cut off, git failing at the checkout this once'; packages = 'some'; stamp = 'started'; gitFails = 'other'; calls = ''; refused = $true; untouched = $true; names = { 'bad object HEAD' }; recover = { <# git answers again #> } },
        # a working install git distrusts every time (a folder another account owns), stamped with the version alone by a
        # launcher that read no commit there: refused, naming the command that trusts the folder; once it is run (the
        # stand-in answering again), the next run rebuilds once and stamps the commit
        @{ name = 'a finished build stamped with the version alone, in a folder git does not trust'; packages = 'all'; client = $true; stamp = '1.2.3'; gitFails = $true; trust = $true; calls = ''; refused = $true; untouched = $true; names = { 'dubious ownership' }; recover = { <# git trusts the folder #> } },
        @{ name = 'a finished build of another commit, in a folder git does not trust'; packages = 'all'; client = $true; stamp = "1.2.3 $(Get-TestCommit 'earlier')"; gitFails = $true; trust = $true; calls = ''; refused = $true; untouched = $true; names = { 'dubious ownership' }; recover = { <# git trusts the folder #> } },
        @{ name = 'the same, the old id installed too and its server stopped for the move'; packages = 'all'; client = $true; stamp = "1.2.3 $(Get-TestCommit 'earlier')"; gitFails = $true; trust = $true; legacy = $true; calls = ''; refused = $true; untouched = $true; names = { 'dubious ownership'; 'server of the old id was stopped'; 'herdr plugin action invoke devswha.herdr-web-ui.start-windows' } },
        @{ name = 'a failed build, the old id installed too and its server stopped for the move'; packages = 'some'; stamp = 'started'; failBuild = $true; legacy = $true; calls = 'stop,install 1'; hint = $true },
        @{ name = 'a finished build of an older launcher (no stamp), git failing at the checkout'; packages = 'all'; client = $true; gitFails = $true; trust = $true; calls = '' },
        @{ name = 'a live server recorded under the old id only, with packages that load the stop'; packages = 'all'; stamp = 'started'; server = 'alive'; legacyRecord = $true; calls = 'stop,install 1' },
        @{ name = 'a build during which the checkout moved to another commit'; packages = 'some'; stamp = 'started'; headMoves = $true; calls = 'stop,install 1' },
        @{ name = 'a build during which the checkout moved to another version'; packages = 'some'; stamp = 'started'; versionMoves = $true; calls = 'stop,install 1' },
        @{ name = 'a failed build after a stop that could not run, a server no record names maybe running'; packages = 'some'; stamp = 'started'; failBuild = $true; calls = 'stop,install 1'; hint = $true },
        @{ name = 'a failed build after a stop that found no server to stop, a server no record names maybe running'; binary = $true; failBuild = $true; calls = 'stop,install 1'; hint = $true },
        @{ name = 'a failed build after a stop that stopped the recorded server'; binary = $true; server = 'alive'; failBuild = $true; calls = 'stop,install 1' },
        @{ name = 'a failed build with nothing here to run a stop with, and no server recorded'; stamp = 'started'; failBuild = $true; calls = 'install 1' }
    )) {
        & $unbuilt; $state.launcherCalls = @(); $state.builtUnderServer = $false
        $state.releaseDown = [bool]$case.releaseDown; $env:OVIS_RELEASES_URL = if ($case.releaseDown) { $releaseDown } else { $noReleases }; $state.noGit = [bool]$case.noGit; $state.gitPrefix = if ($case.nested) { 'plugin/' } else { '' }
        $state.badBinary = [bool]$case.badBinary; $state.headMoves = [bool]$case.headMoves; $state.versionMoves = [bool]$case.versionMoves; $state.gitFails = if ($case.gitFails) { $case.gitFails } else { $false }; $state.legacyInstalled = [bool]$case.legacy
        $herdrRecord = $state.serverRecord; $givenProfile = $env:USERPROFILE; $givenPath = $env:PATH
        if ($case.byHand) {
            $env:USERPROFILE = Join-Path $ghStandIn 'profile'
            $state.serverRecord = Join-Path $env:USERPROFILE '.local\state\ovis\server.pid'
        }
        if ($case.legacyRecord) { $state.serverRecord = Join-Path $env:XDG_STATE_HOME 'herdr\plugins\devswha.herdr-web-ui\server.pid' }
        $serverChild = if ($case.serverProcess) { [Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo -Property @{ FileName = "$env:SystemRoot\System32\PING.EXE"; Arguments = '-n 120 127.0.0.1'; UseShellExecute = $false; CreateNoWindow = $true })) }
        $serverPid = if ($serverChild) { $serverChild.Id } else { $PID }
        if ($case.server) {
            $birth = switch ($case.server) { 'gone' { '1' } 'unverified' { 'none' } default { '' } }
            & $serverRuns -Birth $birth -Id $serverPid
        }
        New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null
        Set-Content -LiteralPath $fromSource -Value '1.2.3'
        if ($case.stamp) { Set-Content -LiteralPath $sourceBuild -Value $case.stamp }
        if ($case.packages) { New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot 'node_modules') | Out-Null }
        if ($case.binary) {
            New-Item -ItemType Directory -Force -Path $keptBin | Out-Null
            Set-Content -LiteralPath (Join-Path $keptBin 'ovis-server.exe') -Value ''
            Set-Content -LiteralPath (Join-Path $keptBin 'ovis-server.json') -Value "{ `"version`": `"$(if ($case.binary -is [string]) { $case.binary } else { '1.2.3' })`" }"
        }
        $state.failBuild = [bool]$case.failBuild
        if ($case.packages -eq 'all') { Set-Content -LiteralPath (Join-Path $pluginRoot 'node_modules\all-installed') -Value '' }
        if ($case.client) {
            New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot 'dist') | Out-Null
            Set-Content -LiteralPath (Join-Path $pluginRoot 'dist\index.html') -Value ''
        }
        $message = ''; $said = ''
        # each line said whole: Out-String would wrap it at the console's width
        try { $said = & $installer -Ref 'feat/windows-install' 6>&1 | Out-String -Width 4096 } catch { $message = $_.Exception.Message }
        $state.releaseDown = $false; $env:OVIS_RELEASES_URL = $noReleases; $state.noGit = $false; $state.failBuild = $false; $state.badBinary = $false; $state.headMoves = $false; $state.versionMoves = $false; $state.gitFails = $false; $state.legacyInstalled = $false
        $versionAfter = (Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'package.json') | ConvertFrom-Json).version
        Set-Content -LiteralPath (Join-Path $pluginRoot 'package.json') -Value '{ "version": "1.2.3" }'
        $named = @(if ($case.names) { & $case.names }) + @(if ($case.server -and $case.refused) { "process $serverPid" })
        $order = @($named | ForEach-Object { $message.IndexOf($_) })
        $inOrder = -not @(for ($i = 1; $i -lt $order.Count; $i++) { if ($order[$i] -lt $order[$i - 1]) { $i } })
        $recordLeft = -not $case.server -or -not $case.refused -or (Test-Path -LiteralPath $state.serverRecord)
        if ($case.byHand) {
            Remove-Item -LiteralPath $env:USERPROFILE -Recurse -Force
            $env:USERPROFILE = $givenProfile; $env:PATH = $givenPath; $state.serverRecord = $herdrRecord
        }
        if ($case.legacyRecord) {
            Remove-Item -LiteralPath (Split-Path $state.serverRecord) -Recurse -Force -ErrorAction SilentlyContinue
            $state.serverRecord = $herdrRecord
        }
        Assert (($state.launcherCalls -join ',') -eq $case.calls) "$($case.name): the launcher must get '$($case.calls)', not '$($state.launcherCalls -join ',')': $message"
        if ($case.trust) {
            # the command the refusal ends with (or, kept, the line said alone), read as PowerShell reads it: git config with
            # the folder as one argument, never git's own command, quoted for a POSIX shell
            $command = if ($message) { ($message -split "`n")[-1] } else { @($said -split "`r?`n" | Where-Object { $_ -like 'git config *' })[0] }
            Assert (-not "$message$said".Contains('To add an exception')) "$($case.name): git's own lines after its first must not be said: $message $said"
            $parseErrors = $null
            $parsed = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$null, [ref]$parseErrors)
            $words = @($parsed.EndBlock.Statements[0].PipelineElements[0].CommandElements | ForEach-Object { $_.Value })
            Assert (-not $parseErrors -and ($words -join '|') -eq "git|config|--global|--add|safe.directory|$($pluginRoot -replace '\\', '/')") "$($case.name): the refusal must end with a git config command that trusts the folder, as PowerShell reads it: $command"
        }
        if ($case.legacy) { Assert ($message.Contains('herdr plugin action invoke devswha.herdr-web-ui.start-windows')) "$($case.name): the old id's server, stopped for the move, must be said with its start: $message" }
        if ($case.failBuild) { Assert ($message -match 'bun failed' -and $message.Contains($pluginRoot) -eq [bool]$case.hint -and -not (Test-Path -LiteralPath $fromSource)) "$($case.name): a failed build must take the marker back, and name the checkout to find a server by only where a server no stop stopped may run ($([bool]$case.hint)): $message" }
        elseif ($case.refused) {
            Assert ($message -and $recordLeft -and (Test-Path -LiteralPath $fromSource) -eq [bool]$case.untouched -and -not @($named | Where-Object { -not $message.Contains($_) }) -and $inOrder -and $message.Contains("Stop-Process -Id $serverPid") -eq ($case.server -in 'alive', 'unverified')) "$($case.name): the run must be refused, naming $($named -join ' and ') in that order, with Stop-Process for a verified server, or for one that could not be verified if it is Ovis: $message"
            if ($case.recover) {
                & $case.recover; $state.launcherCalls = @(); $message = ''
                try { $null = & $installer -Ref 'feat/windows-install' 6>&1 } catch { $message = $_.Exception.Message }
                $expected = if ($case.nested) { '1.2.3' } else { $finished }
                Assert (-not $message -and (Get-Content -Raw -LiteralPath $sourceBuild).Trim() -eq $expected) "$($case.name): doing what the refusal says must let the next run build, or take the folder as built (launcher: $($state.launcherCalls -join ',')): $message"
            }
        }
        elseif ($case.headMoves) { Assert (-not $message -and (Get-Content -Raw -LiteralPath $sourceBuild).Trim() -eq 'started' -and (Test-Path -LiteralPath $fromSource) -and $said -match 'moved to another commit' -and $said -match 'still runs it') "$($case.name): the build must stay unfinished, kept, and said: $message $said" }
        elseif ($case.versionMoves) {
            $lines = @($said -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            $at = @(for ($n = 0; $n -lt $lines.Count; $n++) { if ($lines[$n] -like '*not marked finished*') { $n } })
            $line = if ($at) { $lines[$at[0]] } else { '' }
            $steps = if ($at) { @($lines[($at[0] + 1)..($at[0] + 3)]) } else { @() }
            Assert (-not $message -and $versionAfter -eq '1.2.4' -and (Get-Content -Raw -LiteralPath $sourceBuild).Trim() -eq 'started' -and "$line".Contains('1.2.3') -and "$line".IndexOf('1.2.4') -gt "$line".IndexOf('1.2.3') -and "$line" -notmatch 'still runs it' -and
                $steps.Count -eq 3 -and $steps[0] -eq 'herdr plugin action invoke devswha.ovis.stop-windows' -and (& $readBuild $steps[1]) -eq "env:OVIS_FROM_SOURCE=1|bun|$(Join-Path $pluginRoot 'scripts\plugin-launch.ts')|install" -and
                $steps[2] -eq 'herdr plugin action invoke devswha.ovis.start-windows') "$($case.name): the build must stay unfinished and be said not to run, with both versions, then the stop, the build command and the start, one per line: $message $said"
        }
        elseif ($case.calls) { Assert (-not $message -and (Get-Content -Raw -LiteralPath $sourceBuild).Trim() -eq $finished -and -not ($case.server -eq 'alive' -and $state.builtUnderServer)) "$($case.name): must be built and stamped, with no server left running under the build: $message" }
        elseif ($case.nested) { Assert (-not $message -and -not $said.Contains((Get-TestCommit 'the repository around it').Substring(0, 12))) "$($case.name): must be kept, without the commit of the repository around the plugin's folder: $message $said" }
        elseif ($case.gitFails) { Assert (-not $message -and $said.Contains('dubious ownership')) "$($case.name): must be kept, saying what git said: $message $said" }
        else { Assert (-not $message -and ($case.noGit -or $said.Contains($finished.Substring(6, 12)))) "$($case.name): must be kept, saying the installed commit: $message $said" }
        if ($serverChild) { Stop-Process -Id $serverChild.Id -Force -ErrorAction SilentlyContinue; $serverChild = $null }
    }
    # The release out of reach, with no kept release binary the launcher runs without it (none, another version's, or this
    # version's failing its check) and packages that load the stop: the stop would stop the server through the sources,
    # and herdr's start, the marker taken back, would have to ask the release, so it could not start it again if the build
    # then failed (offline: bun install fetching nothing). So the release is asked first, and nothing is stopped or built:
    # the server recorded as running, the marker that sends herdr's start to its build and that build's stamp stay as they
    # were, whether the build would fail or not; an old id's server stopped for the move is said, with its start. With the
    # release in reach, or a kept binary that runs (its stop and its start need no release), the repair stops and builds as
    # before, and a failed build points to the start only where that binary may run.
    $earlier = "1.2.3 $(Get-TestCommit 'earlier')"
    foreach ($case in @(
        @{ name = 'no kept release binary, the build failing'; binary = 'none'; down = $true },
        @{ name = 'no kept release binary, the build succeeding'; binary = 'none'; down = $true; succeeds = $true },
        @{ name = 'no kept release binary, the old id installed too and its server stopped for the move'; binary = 'none'; down = $true; legacy = $true },
        @{ name = 'a kept release binary of another version'; version = '1.2.2'; down = $true },
        @{ name = 'a kept release binary of this version that fails its check'; bad = $true; down = $true },
        @{ name = 'no kept release binary, the release in reach'; binary = 'none'; built = $true },
        @{ name = 'a kept release binary of another version, the release in reach'; version = '1.2.2'; built = $true },
        @{ name = 'a kept release binary of this version that runs, the release out of reach'; down = $true; built = $true; start = $true }
    )) {
        if ($case.binary -eq 'none') { & $unbuilt; New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot '.ovis\server') | Out-Null }
        else { & $onBinary -Version $(if ($case.version) { $case.version } else { '1.2.3' }) -Bad:([bool]$case.bad) }
        & $serverRuns
        Set-Content -LiteralPath $fromSource -Value '1.2.3'
        Set-Content -LiteralPath $sourceBuild -Value $earlier
        New-Item -ItemType Directory -Force -Path (Join-Path $pluginRoot 'node_modules'), (Join-Path $pluginRoot 'dist') | Out-Null
        Set-Content -LiteralPath (Join-Path $pluginRoot 'node_modules\all-installed'), (Join-Path $pluginRoot 'dist\index.html') -Value ''
        $state.launcherCalls = @(); $state.badBinary = [bool]$case.bad; $state.failBuild = -not $case.succeeds; $state.legacyInstalled = [bool]$case.legacy; $state.started = $false
        $env:OVIS_RELEASES_URL = if ($case.down) { $releaseDown } else { $noReleases }
        $message = ''
        try { $null = & $installer -Ref 'feat/windows-install' 6>&1 } catch { $message = $_.Exception.Message }
        $env:OVIS_RELEASES_URL = $noReleases; $state.badBinary = $false; $state.failBuild = $false; $state.legacyInstalled = $false
        $calls = $state.launcherCalls -join ','
        $left = "server record: $(Test-Path -LiteralPath $state.serverRecord), marker: $(Test-Path -LiteralPath $fromSource), stamp: $("$(Get-Content -Raw -LiteralPath $sourceBuild -ErrorAction SilentlyContinue)".Trim()), herdr start: $($state.started)"
        if ($case.built) {
            Assert ($calls -eq 'stop,install 1' -and $message -match 'bun failed' -and $message -match 'Ovis is stopped' -and -not (Test-Path -LiteralPath $state.serverRecord) -and $message.Contains('devswha.ovis.start-windows') -eq [bool]$case.start) "$($case.name): the repair must stop and build as before, pointing to the start only where the kept binary may run (launcher: $calls; $left): $message"
        } else {
            $said = if ($case.legacy) { 'the server of the old id was stopped for the move: herdr plugin action invoke devswha.herdr-web-ui.start-windows starts it again' } else { 'nothing was stopped or changed' }
            Assert ($calls -eq '' -and $message.Contains('could not be reached') -and $message.Contains($said) -and ($case.binary -eq 'none' -or $message.Contains($keptBin)) -and (Test-Path -LiteralPath $state.serverRecord) -and (Test-Path -LiteralPath $fromSource) -and (Get-Content -Raw -LiteralPath $sourceBuild).Trim() -eq $earlier) "$($case.name), the release out of reach: nothing must be stopped or built, the server, the marker and the stamp left as they were (launcher: $calls; $left): $message"
        }
    }
    # The "may still run" hint after a failed build finds the server by its checkout's folder: a folder whose name has
    # brackets (wildcard characters to -like) and an apostrophe, read as PowerShell reads the hint, matches that folder only
    $bracketed = Join-Path $ghStandIn "[x] it's a plugin"
    foreach ($name in 'scripts\plugin.ps1', 'scripts\plugin-launch.ts', 'node_modules\some', '.ovis\server\source-build') {
        New-Item -ItemType Directory -Force -Path (Split-Path (Join-Path $bracketed $name)) | Out-Null
        Set-Content -LiteralPath (Join-Path $bracketed $name) -Value 'started'
    }
    Set-Content -LiteralPath (Join-Path $bracketed 'package.json') -Value '{ "version": "1.2.3" }'
    & $unbuilt; $state.linkedRoot = $bracketed; $state.failBuild = $true; $state.launcherCalls = @()
    $message = ''
    try { $null = & $installer -Ref 'feat/windows-install' 6>&1 } catch { $message = $_.Exception.Message }
    $state.linkedRoot = ''; $state.failBuild = $false
    $literal = [regex]::Match($message, "-like ('(?:[^']|'')*')").Groups[1].Value
    $pattern = [System.Management.Automation.Language.Parser]::ParseInput($literal, [ref]$null, [ref]$null).EndBlock.Statements[0].PipelineElements[0].Expression.Value
    Assert ($literal -and "bun $bracketed\scripts\plugin.ts start" -like $pattern -and -not ("bun $(Join-Path $ghStandIn "x it's a plugin")\scripts\plugin.ts start" -like $pattern)) "The hint after a failed build must find the server by its folder's name, brackets and apostrophe as they are (launcher: $($state.launcherCalls -join ',')): $literal $message"
    Remove-Item -LiteralPath $bracketed -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts'), (Join-Path $pluginRoot 'package.json') -Force; & $unbuilt
    Remove-Item Env:\OVIS_RELEASES_URL
    $state.serverRecord = ''; $state.gitPrefix = ''
    # the trust command for folders with a space and with an apostrophe (git prints its own with '\'' for a quote, which
    # PowerShell reads otherwise), from the installer's own text: read as PowerShell reads it, it names the folder whole
    $trustAst = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer).Path, [ref]$null, [ref]$null).Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-TrustCommand' }, $true)
    Invoke-Expression $trustAst.Extent.Text
    foreach ($folder in 'C:/Users/John Doe/AppData/Local/herdr/plugins/devswha.ovis', "C:/Users/John O'Brien/plugin", "C:/it's/a ''quoted'' one") {
        $parseErrors = $null
        $parsed = [System.Management.Automation.Language.Parser]::ParseInput((Get-TrustCommand $folder), [ref]$null, [ref]$parseErrors)
        $words = @($parsed.EndBlock.Statements[0].PipelineElements[0].CommandElements | ForEach-Object { $_.Value })
        Assert (-not $parseErrors -and $words.Count -eq 6 -and $words[5] -eq $folder) "The trust command for $folder must name it as one PowerShell argument: $(Get-TrustCommand $folder)"
    }
    $buildAst = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer).Path, [ref]$null, [ref]$null).Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-BuildCommand' }, $true)
    Assert ($null -ne $buildAst) 'The installer must define Get-BuildCommand'
    Invoke-Expression $buildAst.Extent.Text
    foreach ($script in 'C:\Users\John Doe\AppData\Local\herdr\plugins\devswha.ovis\scripts\plugin-launch.ts', "C:\Users\John O'Brien\plugin\scripts\plugin-launch.ts", "C:\it's\a ''quoted'' one\scripts\plugin-launch.ts") {
        Assert ((& $readBuild (Get-BuildCommand $script)) -eq "env:OVIS_FROM_SOURCE=1|bun|$script|install") "The build command for $script must name it as one PowerShell argument: $(Get-BuildCommand $script)"
    }
    $state.running = $false
    $env:OVIS_FROM_SOURCE = '1'

    $state.installed = $false; $state.failInstall = $true; $state.started = $false
    $failed = $false
    try { & $installer -Ref 'broken' } catch { $failed = $_.Exception.Message -match 'herdr failed' }
    Assert ($failed -and -not $state.started) 'A failed native command must stop installation'

    $state.failInstall = $false; $state.running = $true; $state.installed = $false; $state.windowsRelease = $false
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'does not support Windows yet' }
    Assert ($failed -and -not $state.started) 'A release without Windows support must not be reported as installed'
    $state.windowsRelease = $true; $installs = $state.installs
    & $installer -Ref ''
    Assert ($state.uninstalls -eq 1 -and $state.installs -eq $installs + 1 -and $state.started) 'A copy without Windows support must be replaced and started'
    $env:OVIS_FROM_SOURCE = ''; $state.launcherCalls = @()
    Remove-Item -LiteralPath $launcher
    & $installer -Ref 'V1.2.3'
    Assert ($state.ref -eq 'V1.2.3' -and $state.pluginSource -eq '1') "V1.2.3 is no release tag and must be built from source (herdr's build was told '$($state.pluginSource)')"
    Set-Content -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts') -Value ''
    Set-Content -LiteralPath (Join-Path $pluginRoot 'package.json') -Value '{ "version": "1.2.3" }'
    & $onBinary
    & $installer -Ref 'V1.2.3'
    Assert (($state.launcherCalls -join ',') -eq 'stop,install 1' -and -not $env:OVIS_FROM_SOURCE) "A rerun at V1.2.3 must build the checkout from source (launcher: $($state.launcherCalls -join ','))"
    Remove-Item -LiteralPath (Join-Path $pluginRoot 'scripts\plugin-launch.ts'), (Join-Path $pluginRoot 'package.json') -Force; & $unbuilt
    $env:OVIS_FROM_SOURCE = '1'
    Write-Host 'PASS native installer release selection, rerun, Bun bootstrap, explicit ref, stopped herdr, install failure and a copy without Windows support'

    foreach ($blocked in $false, $true) {
        $state.installed = $false; $state.started = $false; $state.startedLegacy = $false
        $state.refId = 'devswha.herdr-web-ui'; $state.manifestBlocked = $blocked
        & $installer -Ref 'v0.4.13'
        Assert ($state.installedId -eq 'devswha.herdr-web-ui' -and $state.startedLegacy) "A release that names the old id must install and start under it (manifest blocked: $blocked)"
    }
    $state.installed = $false; $state.started = $false; $state.refId = 'devswha.ovis'; $state.manifestBlocked = $false
    Write-Host 'PASS a release from before the rename installs under its old id'

    # An install under the old id moves to the new one. Its server is stopped with the state dir herdr hands the
    # plugin, where a release from before 0.4.13 keeps its pid: told nothing, that stop looks in ~/.local/state,
    # finds no server, and the one that outlived herdr keeps the old checkout open for the uninstall.
    $savedXdg = $env:XDG_STATE_HOME; $savedPluginState = $env:HERDR_PLUGIN_STATE_DIR
    try {
        Remove-Item Env:\HERDR_PLUGIN_STATE_DIR -ErrorAction SilentlyContinue
        $xdgState = Join-Path $ghStandIn 'xdg state'
        foreach ($xdg in $null, $xdgState) {
            if ($xdg) { $env:XDG_STATE_HOME = $xdg } else { Remove-Item Env:\XDG_STATE_HOME -ErrorAction SilentlyContinue }
            $state.installed = $false; $state.legacyInstalled = $true; $state.stopStateDirs = @(); $state.started = $false
            & $installer -Ref ''
            $expected = Join-Path $(if ($xdg) { $xdg } else { $env:LOCALAPPDATA }) 'herdr\plugins\devswha.herdr-web-ui'
            Assert ($state.stopStateDirs.Count -eq 1 -and $state.stopStateDirs[0] -eq $expected) "The old id's stop must look for its pid where herdr keeps the plugin's state ($expected), not: $($state.stopStateDirs -join ', ')"
            Assert (-not $state.legacyInstalled -and $state.installedId -eq 'devswha.ovis' -and $state.started) 'An install under the old id must move to the new id and start'
            Assert ($null -eq $env:HERDR_PLUGIN_STATE_DIR) 'The state dir given to the old stop must not stay set for later commands'
        }
        $state.installed = $false; $state.legacyInstalled = $true; $state.stopStateDirs = @(); $state.handStarted = $true
        & $installer -Ref ''
        Assert ($state.stopStateDirs.Count -eq 2 -and $state.stopStateDirs[0] -and -not $state.stopStateDirs[1]) "A stop that found no server through herdr's dir must ask once more without it: $($state.stopStateDirs -join ' | ')"
        $state.handStarted = $false
    } finally {
        foreach ($pair in @(@('XDG_STATE_HOME', $savedXdg), @('HERDR_PLUGIN_STATE_DIR', $savedPluginState))) {
            if ($null -eq $pair[1]) { Remove-Item "Env:$($pair[0])" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$($pair[0])" $pair[1] }
        }
        $state.legacyInstalled = $false
    }
    Write-Host 'PASS an install under the old id stops its server through the state dir herdr gives it, and moves'

    $savedCi = $env:CI; $savedNoOpen = $env:OVIS_NO_OPEN; $savedSsh = $env:SSH_CONNECTION
    try {
        Remove-Item Env:\CI, Env:\OVIS_NO_OPEN, Env:\SSH_CONNECTION -ErrorAction SilentlyContinue
        $state.installed = $false; $state.running = $true; $global:herdrInstallOpened = @()
        $freshOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 1 -and $global:herdrInstallOpened[0] -eq 'http://127.0.0.1:7317') 'A fresh install must open the loopback origin exactly once'
        Assert ($freshOutput -match 'opened http://127\.0\.0\.1:7317.*click Install') 'A fresh install must explain where to click Install'

        $global:herdrInstallOpened = @()
        $rerunOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 0 -and $rerunOutput -notmatch 'opened ') 'A rerun must not open the app'

        foreach ($gate in 'OVIS_NO_OPEN', 'CI', 'SSH_CONNECTION') {
            $state.installed = $false; $global:herdrInstallOpened = @()
            Set-Item "Env:$gate" '1'
            $output = & $installer -Ref 'test' 6>&1 | Out-String
            Assert ($global:herdrInstallOpened.Count -eq 0) "$gate must prevent opening"
            if ($gate -eq 'SSH_CONNECTION') {
                Assert ($output -match 'ssh -L 7317:127\.0\.0\.1:7317' -and $output -match 'Tailscale') 'SSH guidance must include the tunnel command and Tailscale pointer'
            }
            Remove-Item "Env:$gate" -ErrorAction SilentlyContinue
        }
        $state.installed = $false; $state.running = $false; $global:herdrInstallOpened = @(); $state.herdrStarts = @()
        $stoppedOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 1 -and ($state.herdrStarts -join ',') -eq 'desktop') "A fresh install where herdr was stopped must start herdr, then open the app once: $stoppedOutput"
        # run in session 0 (SSH) with nobody of this account signed in, herdr is not started, so nothing opens
        $desktopSession = 'function Test-DesktopSession { [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0 }'
        Assert ((Get-Content -Raw $installer).Contains($desktopSession)) 'control: whether the installer runs in a desktop session is one function'
        $inSession0 = (Get-Content -Raw $installer).Replace($desktopSession, 'function Test-DesktopSession { $false }')
        $state.installed = $false; $state.running = $false; $global:herdrInstallOpened = @(); $state.explorerOwner = 'S-1-5-21-1-2-3-1001'
        try { $nobodyOutput = & ([scriptblock]::Create($inSession0)) -Ref 'test' 6>&1 | Out-String }
        finally { $state.explorerOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
        Assert ($global:herdrInstallOpened.Count -eq 0 -and $nobodyOutput -notmatch 'opened ' -and -not $state.running) "A fresh install whose herdr was not started must not open the app: $nobodyOutput"
        $state.running = $true
        Write-Host 'PASS Windows app opening: fresh install, rerun, OVIS_NO_OPEN, SSH tunnel and Tailscale, and CI'
    } finally {
        foreach ($pair in @(@('CI', $savedCi), @('OVIS_NO_OPEN', $savedNoOpen), @('SSH_CONNECTION', $savedSsh))) {
            if ($null -eq $pair[1]) { Remove-Item "Env:$($pair[0])" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$($pair[0])" $pair[1] }
        }
        $global:herdrInstallOpened = @()
    }

    # herdr where it was not running, as install.sh leaves Linux and macOS (INSTALL.md, method C): started once in this
    # account's desktop by a one-shot task that is removed again, which runs the launcher herdr's sign-in start runs too
    # (the value Ovis under HKCU's Run key), unless -NoService; a herdr that runs is left as it is. `irm | iex` takes no
    # arguments, so the installer runs here as a script block, the way INSTALL.md gives them.
    $source = Get-Content -Raw $installer
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $launcherArguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$herdrLauncherFile`""
    $ourSignIn = "`"$powershellExe`" $launcherArguments"
    $appSignIn = '"C:\Users\someone\AppData\Local\Programs\Ovis\Ovis.exe" --start'
    $run = {
        param([hashtable]$Options = @{}, [string]$Text = $source)
        $state.herdrStarts = @(); $state.taskCalls = @(); $state.adds = @(); $state.started = $false
        $message = ''; $said = ''
        try { $said = & ([scriptblock]::Create($Text)) -Ref 'test' @Options 6>&1 | Out-String -Width 4096 } catch { $message = $_.Exception.Message }
        @{ Said = $said; Message = $message; Starts = $state.herdrStarts -join ',' }
    }
    $state.installed = $false; $state.running = $false; $state.runValue = $null
    Remove-Item -LiteralPath $herdrLauncherFile -Force -ErrorAction SilentlyContinue
    $out = & $run
    Assert (-not $out.Message -and $out.Starts -eq 'desktop' -and -not $state.started -and $state.tasks.Count -eq 0) "herdr stopped: it must be started once, by a task that is removed again, and start the app itself (starts: $($out.Starts); tasks left: $($state.tasks -join ',')): $($out.Message)"
    Assert (@($state.taskCalls).Count -eq 1 -and $state.taskCalls[0] -eq "register $powershellExe $launcherArguments as $($me.User.Value) Interactive Limited, limit 00:00:00, priority 4") "The task must run the launcher hidden, as this account (its SID) with its ordinary rights and its interactive token, with no time limit, at normal priority: $($state.taskCalls -join ' | ')"
    Assert ($state.runValue -eq $ourSignIn -and (Test-Path -LiteralPath $herdrLauncherFile)) "herdr's sign-in start must run the launcher: $($state.runValue)"
    Assert ($out.Said -match 'herdr was started in your desktop for Ovis, and it starts at your sign-in' -and $out.Said -match 'signing out of Windows ends herdr' -and $out.Said -match "see them: bun '[^']+' status, herdr status server") "The closing lines must say what runs and what starts it again: $($out.Said)"
    $out = & $run
    Assert (-not $out.Message -and -not $out.Starts -and $state.started -and $state.runValue -eq $ourSignIn -and $out.Said -notmatch 'was started in your desktop') "A herdr that runs must be left as it is, the app started by its action and the sign-in start kept: $($out.Message) $($out.Said)"
    # while herdr runs, the launcher of the installer's own sign-in start is written again, so a fix in a later installer
    # reaches it
    Remove-Item -LiteralPath $herdrLauncherFile -Force
    $out = & $run
    Assert (-not $out.Message -and -not $out.Starts -and (Test-Path -LiteralPath $herdrLauncherFile)) "With herdr running, the launcher of the installer's own sign-in start must be written again: $($out.Message) $($out.Said)"
    $out = & $run @{ NoService = $true }
    Assert (-not $out.Message -and -not $out.Starts -and $null -eq $state.runValue -and $out.Said -match 'removed the sign-in start an earlier run set up, as -NoService asks') "-NoService must remove the sign-in start an earlier run set up, starting or stopping nothing: $($out.Message) $($out.Said)"
    $state.runValue = $ourSignIn; $state.running = $false; $env:OVIS_NO_SERVICE = '1'
    try { $out = & $run } finally { Remove-Item Env:\OVIS_NO_SERVICE }
    Assert (-not $out.Message -and $out.Starts -eq 'desktop' -and $null -eq $state.runValue -and $out.Said -match 'started in your desktop for now, with no sign-in start \(-NoService\)') "OVIS_NO_SERVICE=1 with herdr stopped must start herdr once and leave no sign-in start: $($out.Message) $($out.Said)"
    # an OVIS_TOKEN of this run's own does not reach a herdr the desktop starts: said, with where it goes, never printed
    $givenToken = $env:OVIS_TOKEN; $env:OVIS_TOKEN = 'a-token-of-this-run'; $state.running = $false
    try { $out = & $run } finally { if ($null -eq $givenToken) { Remove-Item Env:\OVIS_TOKEN } else { $env:OVIS_TOKEN = $givenToken } }
    Assert (-not $out.Message -and $out.Starts -eq 'desktop' -and $out.Said -match 'the OVIS_TOKEN set for this run does not reach the herdr started in your desktop or at your sign-in, so Ovis runs without it: put OVIS_TOKEN=<token> in the file env' -and $out.Said -notmatch 'a-token-of-this-run') "An OVIS_TOKEN of this run must be said not to reach the desktop's herdr, with where it goes: $($out.Message) $($out.Said)"
    foreach ($case in @(
        @{ value = $appSignIn; said = 'herdr was started in your desktop for Ovis, and the Ovis app starts it at your sign-in' },
        @{ value = $appSignIn; noService = $true; said = "the Ovis app's sign-in start is still there.*Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name Ovis" },
        @{ value = 'C:\tools\other.exe --ovis'; said = "a Run value named Ovis that is not Ovis's own is there" },
        @{ value = 'C:\tools\other.exe --ovis'; noService = $true; said = "a Run value named Ovis that is not Ovis's own is there" }
    )) {
        $state.runValue = $case.value; $state.running = $false
        $out = & $run $(if ($case.noService) { @{ NoService = $true } } else { @{} })
        Assert (-not $out.Message -and $out.Starts -eq 'desktop' -and $state.runValue -eq $case.value -and $out.Said -match $case.said) "A sign-in start not this installer's ($($case.value), -NoService: $([bool]$case.noService)) must be left as it is, and said: $($out.Message) $($out.Said)"
    }
    # a task Task Scheduler refuses (a policy can forbid them): in its own desktop the installer starts herdr itself, and
    # from session 0 it cannot
    $inDesktop = $source.Replace($desktopSession, 'function Test-DesktopSession { $true }')
    $state.runValue = $null; $state.running = $false; $state.taskRefused = $true
    try { $out = & $run @{} $inDesktop } finally { $state.taskRefused = $false }
    Assert (-not $out.Message -and $out.Starts -eq 'here' -and $state.running -and $out.Said -match 'Task Scheduler did not take the task' -and $out.Said -match 'herdr was started in your desktop for Ovis') "A task Task Scheduler refuses must be said, and herdr started by the installer in its own desktop: $($out.Starts) $($out.Message) $($out.Said)"
    $state.running = $false; $state.taskRefused = $true
    try { $out = & $run @{} ($source.Replace($desktopSession, 'function Test-DesktopSession { $false }')) } finally { $state.taskRefused = $false }
    Assert (-not $out.Message -and -not $out.Starts -and -not $state.running -and $out.Said -match 'Task Scheduler did not take the task' -and $out.Said -match 'herdr did not start, so neither did the app; to see why, run: herdr server') "From session 0, a task Task Scheduler refuses must be said, and herdr not started: $($out.Starts) $($out.Message) $($out.Said)"
    $quick = $source.Replace('$herdrWaitSeconds = 20', '$herdrWaitSeconds = 1')
    Assert ($quick -ne $source) 'control: how long herdr has to answer is one line'
    $state.herdrDies = $true
    try { $out = & $run @{} $quick } finally { $state.herdrDies = $false }
    Assert (-not $out.Message -and $out.Starts -eq 'desktop' -and $state.tasks.Count -eq 0 -and $out.Said -match 'herdr did not start') "A herdr that never answers must be said, its task removed: $($out.Message) $($out.Said)"
    # run in session 0 (SSH, remoting): herdr starts in the desktop this account is signed in to; with nobody of it signed in,
    # only given -Headless (or OVIS_HEADLESS=1), through WMI, without a desktop, and otherwise not, the sign-in start set up
    $inSession0 = $source.Replace($desktopSession, 'function Test-DesktopSession { $false }')
    $state.running = $false
    $out = & $run @{} $inSession0
    Assert (-not $out.Message -and $out.Starts -eq 'desktop') "From session 0 with this account signed in, herdr must start in its desktop: $($out.Message) $($out.Said)"
    $state.explorerOwner = 'S-1-5-21-1-2-3-1001'
    try {
        $state.running = $false; $state.runValue = $null
        $out = & $run @{} $inSession0
        Assert (-not $out.Message -and -not $out.Starts -and $state.runValue -eq $ourSignIn -and $out.Said -match 'nobody of this account is signed in at this PC, so herdr was not started, nor the app with it; it starts at your sign-in' -and $out.Said -match 'run this again with -Headless') "From session 0 with nobody signed in, herdr must not start, the sign-in start set up and -Headless named: $($out.Message) $($out.Said)"
        foreach ($way in 'switch', 'variable') {
            $state.running = $false
            if ($way -eq 'variable') { $env:OVIS_HEADLESS = '1' }
            try { $out = & $run $(if ($way -eq 'switch') { @{ Headless = $true } } else { @{} }) $inSession0 } finally { Remove-Item Env:\OVIS_HEADLESS -ErrorAction SilentlyContinue }
            Assert (-not $out.Message -and $out.Starts -eq 'headless' -and $state.headlessLine -match '^"[^"]+" server$' -and $out.Said -match 'herdr was started without a desktop') "-Headless ($way) from session 0 with nobody signed in must start herdr through WMI: $($state.headlessLine) $($out.Message) $($out.Said)"
        }
    } finally { $state.explorerOwner = $me.User.Value }
    Write-Host 'PASS herdr where it was not running: started once in the desktop by a task removed again, the sign-in start set up, kept, removed by -NoService, or left when it is not ours; from session 0 only into a signed-in desktop, or with -Headless'

    # The add, after the install: with -Account (or OVIS_ADD_ACCOUNT) run with that account and no input, failing the
    # install when the PC was not added, and only on a release whose add checks it; -Add alone runs `ovis add` at a
    # terminal and otherwise says what to run; an account id of another shape is refused before anything is installed
    $linkScript = Join-Path $pluginRoot 'scripts\plugin-link.ts'
    $bothReads = @('const pinned = flagValue(args, "--account");', 'export function answerOf(input) {}')
    Set-Content -LiteralPath $linkScript -Value $bothReads
    $state.running = $true
    $out = & $run @{ Account = 'acct_1-A' }
    Assert (-not $out.Message -and ($state.adds -join '|') -eq 'add --account acct_1-A <piped 0>' -and $out.Said -match 'set OVIS_TOKEN first') "-Account must run the add with that account and no input: $($state.adds -join '|') $($out.Message)"
    $env:OVIS_ADD_ACCOUNT = 'acct_2'
    try { $out = & $run } finally { Remove-Item Env:\OVIS_ADD_ACCOUNT }
    Assert (-not $out.Message -and ($state.adds -join '|') -eq 'add --account acct_2 <piped 0>') "OVIS_ADD_ACCOUNT must do what -Account does: $($state.adds -join '|') $($out.Message)"
    $state.addFails = $true
    try { $out = & $run @{ Account = 'acct_1' } } finally { $state.addFails = $false }
    Assert ($out.Message -match 'was not added to your Ovis account' -and ($state.adds -join '|') -eq 'add --account acct_1 <piped 0>') "An add with -Account that fails must fail the install: $($out.Message)"
    # a PC in another account: the add refuses it itself (since `ovis join`'s release), and where an add said done anyway,
    # `ovis status --json` naming another account fails the install; the account named, or a release whose status answers
    # no JSON or does not tell the account, passes on the add's word. What is said is read even when the install throws.
    $runSaying = {
        param([hashtable]$Options)
        $state.adds = @(); $lines = New-Object Collections.Generic.List[string]; $message = ''
        try { & ([scriptblock]::Create($source)) -Ref 'test' @Options 6>&1 | ForEach-Object { $lines.Add("$_") } } catch { $message = $_.Exception.Message }
        @{ Said = $lines -join "`n"; Message = $message }
    }
    $state.addFails = $true; $state.addSays = 'This PC is in another Ovis account (acctB_012345...), not the one --account names.'
    try { $out = & $runSaying @{ Account = 'acct_1' } } finally { $state.addFails = $false; $state.addSays = 'Could not link this PC: the sign-in ended' }
    Assert ($out.Message -match 'was not added to your Ovis account' -and $out.Said.Contains('This PC is in another Ovis account (acctB_012345...)') -and $out.Said.Contains('what the add said is above')) "An add that refuses another account must fail the install with its words: $($out.Message) $($out.Said)"
    foreach ($case in @(
        @{ json = '{"version":"0.5.10","running":true,"account":"acctB_0123456789","account_known":true}'; account = 'acct_1'; other = $true },
        @{ json = '{"version":"0.5.10","running":true,"account":"acct_1-A_0123456789","account_known":true}'; account = 'acct_1-A_0123456789' },
        @{ json = '{"version":"0.5.10","running":true,"account":"acct_1-A_0123456789","account_known":true}'; account = 'acct_1-A_012' },
        @{ json = '{"version":"0.5.10","running":true,"account":"acct_1-A_0123456789","account_known":true}'; account = 'acct_1-A_01'; other = $true },
        @{ json = '{"version":"0.5.10","running":true,"account":null,"account_known":false}'; account = 'acct_1' },
        @{ json = 'running http://127.0.0.1:7317 (pid 1234)'; account = 'acct_1' }
    )) {
        $state.statusJson = $case.json
        try { $out = & $runSaying @{ Account = $case.account } } finally { $state.statusJson = 'running http://127.0.0.1:7317 (pid 1234)' }
        if ($case.other) { Assert ($out.Message -match 'was not added' -and $out.Said -match 'this PC is in another Ovis account \([^)]*\.\.\.\) than -Account names') "An add that said done in another account ($($case.json), -Account $($case.account)) must fail the install: $($out.Message) $($out.Said)" }
        else { Assert (-not $out.Message -and $out.Said -notmatch 'another Ovis account') "An add in the account named, or with no account to compare ($($case.json), -Account $($case.account)), must pass: $($out.Message) $($out.Said)" }
    }
    Set-Content -LiteralPath $linkScript -Value $bothReads[1]
    $out = & $run @{ Account = 'acct_1' }
    Assert ($out.Message -match 'was not added' -and $state.adds.Count -eq 0) "An add that does not check --account must not be run with it, and the install fail: $($state.adds -join '|') $($out.Message)"
    Set-Content -LiteralPath $linkScript -Value $bothReads
    $state.explorerOwner = 'S-1-5-21-1-2-3-1001'; $state.running = $false
    try { $out = & $run @{ Account = 'acct_1' } $inSession0 } finally { $state.explorerOwner = $me.User.Value }
    Assert ($out.Message -match 'was not added' -and $state.adds.Count -eq 0) "With the app not running, -Account must add nothing and fail the install: $($out.Message)"
    $state.running = $true
    $givenCi = $env:CI; $env:CI = 'true'
    try { $out = & $run @{ Add = $true } } finally { $env:CI = $givenCi }
    Assert (-not $out.Message -and $state.adds.Count -eq 0 -and $out.Said -match "to add this PC to your Ovis account, run in a terminal on this PC: bun '[^']+' add\. Where nobody can answer") "-Add with no terminal must say what to run: $($out.Message) $($out.Said)"
    $atTerminal = $source.Replace('function Test-Terminal { -not ($env:CI -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) }', 'function Test-Terminal { $true }')
    Assert ($atTerminal -ne $source) 'control: whether a terminal is there is one function'
    $givenNoOpen = $env:OVIS_NO_OPEN; Remove-Item Env:\OVIS_NO_OPEN -ErrorAction SilentlyContinue
    try {
        $out = & $run @{ Add = $true } $atTerminal
        Assert (-not $out.Message -and ($state.adds -join '|') -eq 'add <terminal>') "-Add at a terminal must run the add, which asks there: $($state.adds -join '|') $($out.Message)"
        Set-Content -LiteralPath $linkScript -Value $bothReads[0]
        $out = & $run @{ Add = $true } $atTerminal
        Assert (-not $out.Message -and $state.adds.Count -eq 0 -and $out.Said -match 'would take a line typed ahead as its answer') "-Add must not run an add that takes a line typed ahead: $($out.Message) $($out.Said)"
    } finally { if ($null -ne $givenNoOpen) { $env:OVIS_NO_OPEN = $givenNoOpen } }
    $installs = $state.installs
    foreach ($bad in '-x', 'a b', ('a' * 65), 'acct;x', "acct`n") {
        $state.installed = $false; $state.running = $false
        $out = & $run @{ Account = $bad }
        Assert ($out.Message -match '-Account \(or OVIS_ADD_ACCOUNT\) takes your Ovis account' -and $state.installs -eq $installs -and -not $out.Starts) "An account id of another shape ($bad) must be refused before anything is installed: $($out.Message)"
    }
    $env:OVIS_ADD_ACCOUNT = '-x'
    try { $out = & $run } finally { Remove-Item Env:\OVIS_ADD_ACCOUNT }
    Assert ($out.Message -match 'takes your Ovis account' -and $state.installs -eq $installs) "OVIS_ADD_ACCOUNT of another shape must be refused before anything is installed: $($out.Message)"
    Remove-Item -LiteralPath $linkScript -Force
    $state.running = $true
    Write-Host 'PASS the add: -Account and OVIS_ADD_ACCOUNT run it with no input and fail the install when not added, never on an add that does not check the account; -Add asks at a terminal only; other ids refused before installing'

    # The join, after the install: an invite's line (-JoinFile, -Join, or OVIS_JOIN where neither is given) is refused before
    # anything is installed unless it has a join line's shape, and given to `ovis join` alone, in its environment (never its
    # arguments, never said), with -Account and no input, or at a terminal; the install fails unless the PC joined
    $joinScript = Join-Path $pluginRoot 'scripts\plugin-join.ts'
    $joinPayload = 'eyJ2IjoxLCJzZXJ2aWNlIjoiaHR0cHM6Ly9hY2NvdW50cy5vdmlzLnRlc3QiLCJhY2NvdW50IjoiVEVTVC1PTkxZLWFjY291bnQifQ'
    $joinLine = "ovis-join:1:$joinPayload"
    $shown = $joinPayload.Substring(0, 24)
    # as a phone's copy or an editor leaves it: blank lines, spaces, Windows line ends; in a folder with a space and an apostrophe
    $inviteFile = Join-Path $ghStandIn "ovis invite's.txt"
    [IO.File]::WriteAllText($inviteFile, "`r`n  $joinLine`r`n`r`n")
    $runJoin = {
        param([hashtable]$Options = @{}, [string]$Text = $source)
        $state.joins = @(); $state.joinInvites = @(); $state.herdrStarts = @(); $state.adds = @(); $state.leaked = @()
        $lines = New-Object Collections.Generic.List[string]; $message = ''
        try { & ([scriptblock]::Create($Text)) -Ref 'test' @Options 6>&1 | ForEach-Object { $lines.Add("$_") } } catch { $message = $_.Exception.Message }
        @{ Said = $lines -join "`n"; Message = $message; Starts = $state.herdrStarts -join ',' }
    }
    # installed as before first, so the runs below keep the plugin's folder and the file that says its release has ovis join
    $state.running = $true; $state.joinExit = 0
    $null = & $run
    Set-Content -LiteralPath $joinScript -Value 'export async function join() {}'
    foreach ($case in @(
        @{ name = '-JoinFile'; options = @{ JoinFile = $inviteFile; Account = 'acct_1' }; account = 'acct_1' },
        @{ name = '-Join'; options = @{ Join = $joinLine; Account = 'acct_1' }; account = 'acct_1' },
        @{ name = 'OVIS_JOIN'; options = @{}; given = " $joinLine`n"; addAccount = 'acct_2'; account = 'acct_2' }
    )) {
        if ($case.given) { $env:OVIS_JOIN = $case.given; $env:OVIS_ADD_ACCOUNT = $case.addAccount }
        try { $out = & $runJoin $case.options } finally { Remove-Item Env:\OVIS_ADD_ACCOUNT -ErrorAction SilentlyContinue }
        Assert (-not $out.Message -and ($state.joins -join '|') -eq "join --account $($case.account) <piped 0>" -and ($state.joinInvites -join '|') -eq $joinLine -and $state.adds.Count -eq 0) "$($case.name) must run ovis join with that account and no input, the line in its environment: $($state.joins -join '|') $($out.Message)"
        Assert ($out.Said -match "this PC is in the Ovis account the invite is for\. Check: bun '[^']+' status --json" -and -not $out.Said.Contains($shown) -and -not $env:OVIS_INVITE -and -not $env:OVIS_JOIN) "$($case.name): the PC joined must be said, the line never, and neither variable left set: $($out.Said)"
    }
    # herdr the installer starts itself (Task Scheduler refusing its task) or without a desktop (-Headless) gets this run's
    # environment, and so no invite
    $env:OVIS_JOIN = $joinLine
    $state.running = $false; $state.taskRefused = $true
    try { $out = & $runJoin @{ Account = 'acct_1' } $inDesktop } finally { $state.taskRefused = $false; Remove-Item Env:\OVIS_JOIN -ErrorAction SilentlyContinue }
    Assert (-not $out.Message -and $out.Starts -eq 'here' -and $state.leaked.Count -eq 0 -and $state.joins.Count -eq 1) "herdr the installer starts itself must not be given the invite: $($state.leaked -join ',') $($out.Starts) $($out.Message)"
    $env:OVIS_JOIN = $joinLine
    $state.explorerOwner = 'S-1-5-21-1-2-3-1001'; $state.running = $false
    try { $out = & $runJoin @{ Account = 'acct_1'; Headless = $true } $inSession0 } finally { $state.explorerOwner = $me.User.Value; Remove-Item Env:\OVIS_JOIN -ErrorAction SilentlyContinue }
    Assert (-not $out.Message -and $out.Starts -eq 'headless' -and $state.leaked.Count -eq 0 -and $state.joins.Count -eq 1) "herdr started without a desktop must not be given the invite: $($state.leaked -join ',') $($out.Starts) $($out.Message)"
    # each way ovis join fails: one line for it, the line of the invite never said, and the install fails
    foreach ($case in @(
        @{ code = 3; said = 'the invite did not work: it is mistyped, used or expired \(an invite works once, for 15 minutes\)' },
        @{ code = 5; said = 'the invite is for another Ovis account than -Account names, so this PC did not join it' },
        @{ code = 6; said = "this PC is in another Ovis account, so it did not join the invite's, and the invite was not used\. To move it: bun '[^']+' logout" },
        @{ code = 10; said = "the account service did not answer, so this PC did not join your Ovis account\. Try again in a moment \(the invite works for 15 minutes\): bun '[^']+' join --invite-file '[^']*ovis invite''s\.txt' --account acct_1" },
        @{ code = 14; said = 'nobody pressed Add for this PC while its card showed' },
        @{ code = 1; said = 'this PC did not join your Ovis account; what ovis join said is above' }
    )) {
        $state.running = $true; $state.joinExit = $case.code
        try { $out = & $runJoin @{ JoinFile = $inviteFile; Account = 'acct_1' } } finally { $state.joinExit = 0 }
        Assert ($out.Message -match 'did not join your Ovis account' -and $state.joins.Count -eq 1 -and $out.Said -match $case.said -and -not $out.Said.Contains($shown)) "ovis join ending $($case.code) must fail the install with its line: $($out.Message) $($out.Said)"
    }
    # with no account named, at a terminal: run there, where it asks (where nobody can answer it is refused before installing, below)
    $givenNoOpen = $env:OVIS_NO_OPEN; Remove-Item Env:\OVIS_NO_OPEN -ErrorAction SilentlyContinue
    try { $out = & $runJoin @{ JoinFile = $inviteFile } $atTerminal } finally { if ($null -ne $givenNoOpen) { $env:OVIS_NO_OPEN = $givenNoOpen } }
    Assert (-not $out.Message -and ($state.joins -join '|') -eq 'join <terminal>' -and ($state.joinInvites -join '|') -eq $joinLine) "A join with no account at a terminal must run there, the line in its environment: $($state.joins -join '|') $($out.Message)"
    # a release without ovis join, and an app that is not running: not run, said, and the install fails
    Remove-Item -LiteralPath $joinScript -Force
    $out = & $runJoin @{ JoinFile = $inviteFile; Account = 'acct_1' }
    Assert ($out.Message -match 'did not join' -and $state.joins.Count -eq 0 -and $out.Said -match 'this Ovis release has no ovis join \(it came in 0\.5\.10\)') "A release without ovis join must not be asked to join: $($out.Message) $($out.Said)"
    Set-Content -LiteralPath $joinScript -Value 'export async function join() {}'
    $state.explorerOwner = 'S-1-5-21-1-2-3-1001'; $state.running = $false
    try { $out = & $runJoin @{ JoinFile = $inviteFile; Account = 'acct_1' } $inSession0 } finally { $state.explorerOwner = $me.User.Value }
    Assert ($out.Message -match 'did not join' -and $state.joins.Count -eq 0 -and $out.Said -match 'the app is not running, so this PC did not join your Ovis account') "With the app not running, the join must not run: $($out.Message) $($out.Said)"
    # refused before anything is installed or started, never naming the line; with no terminal (CI), a join with no account
    # names the flag to add
    $installs = $state.installs
    $givenCi = $env:CI; $env:CI = 'true'
    $nobodyToAnswer = 'A join where nobody can answer needs the account the invite is for: add -Account <id> (the id shown with the invite, or ovis status --json on a PC already in it; OVIS_ADD_ACCOUNT=<id> for irm | iex). Nothing was installed.'
    try { foreach ($case in @(
        @{ options = @{ JoinFile = $inviteFile }; said = $nobodyToAnswer },
        @{ options = @{ Join = $joinLine; NoService = $true }; said = $nobodyToAnswer },
        @{ options = @{ Join = 'not-an-invite' }; said = 'That is not an Ovis invite' },
        @{ options = @{ Join = 'ovis-join:1:' }; said = 'That is not an Ovis invite' },
        @{ options = @{ Join = "ovis-join:1:$joinPayload==" }; said = 'That is not an Ovis invite' },
        @{ options = @{ Join = "ovis-join:2:$joinPayload" }; said = 'That is not an Ovis invite' },
        @{ options = @{ Join = 'ovis-join:1:' + ('a' * 1100) }; said = 'That is not an Ovis invite' },
        @{ options = @{ Join = "ovis-join:1:$joinPayload $joinPayload" }; said = 'That is not an Ovis invite' },
        @{ options = @{ Join = $joinLine; JoinFile = $inviteFile }; said = 'Give the invite one way only' },
        @{ options = @{ Join = $joinLine; Add = $true }; said = 'A join adds this PC with an invite, and -Add' },
        @{ options = @{ JoinFile = (Join-Path $ghStandIn 'no such invite.txt') }; said = '-JoinFile names no file you can read' },
        @{ options = @{ JoinFile = $ghStandIn }; said = '-JoinFile names no file you can read' }
    )) {
        $state.installed = $false; $state.running = $false
        $out = & $runJoin $case.options
        Assert ($out.Message.Contains($case.said) -and -not $out.Message.Contains($shown) -and $state.installs -eq $installs -and -not $out.Starts -and $state.joins.Count -eq 0) "An invite refused before installing ($($case.said)): $($out.Message)"
    } } finally { $env:CI = $givenCi }
    # the same under OVIS_NO_OPEN (an install run for someone else, as the app's SSH installer runs it), even at a terminal
    $givenNoOpen = $env:OVIS_NO_OPEN; $env:OVIS_NO_OPEN = '1'
    try { $out = & $runJoin @{ JoinFile = $inviteFile } $atTerminal } finally { if ($null -eq $givenNoOpen) { Remove-Item Env:\OVIS_NO_OPEN } else { $env:OVIS_NO_OPEN = $givenNoOpen } }
    Assert ($out.Message.StartsWith($nobodyToAnswer) -and $state.installs -eq $installs -and -not $out.Starts -and $state.joins.Count -eq 0) "A join with no account under OVIS_NO_OPEN must be refused before installing: $($out.Message)"
    # a run refused with OVIS_ADD=1 leaves OVIS_JOIN for the run that follows; OVIS_JOIN of another shape is refused too
    $env:OVIS_ADD = '1'; $env:OVIS_JOIN = $joinLine
    try { $out = & $runJoin } finally { Remove-Item Env:\OVIS_ADD }
    Assert ($out.Message.Contains('A join adds this PC with an invite') -and $env:OVIS_JOIN -eq $joinLine -and $state.installs -eq $installs) "OVIS_ADD=1 with OVIS_JOIN must be refused before installing, leaving OVIS_JOIN: $($out.Message)"
    $env:OVIS_JOIN = "x$joinLine"
    try { $out = & $runJoin } finally { Remove-Item Env:\OVIS_JOIN -ErrorAction SilentlyContinue }
    Assert ($out.Message.Contains('That is not an Ovis invite') -and -not $out.Message.Contains($shown) -and $state.installs -eq $installs) "OVIS_JOIN of another shape must be refused before installing: $($out.Message)"
    $out = & $runJoin @{ Help = $true }
    Assert (-not $out.Message -and $out.Said.StartsWith('usage: & ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) [-Add | -JoinFile <path>]') -and ($out.Said -replace '\s+', ' ').Contains('shows in the process list to every user of this PC, so use -JoinFile or OVIS_JOIN instead') -and $state.installs -eq $installs -and -not $out.Starts) "-Help must say each option and install nothing: $($out.Message) $($out.Said)"
    Remove-Item -LiteralPath $joinScript, $inviteFile -Force -ErrorAction SilentlyContinue
    $state.running = $true
    Write-Host 'PASS the join: -JoinFile, -Join and OVIS_JOIN give ovis join the line in its environment alone, with -Account and no input or at a terminal; each failure said and failing the install; herdr never given the line; lines of another shape, two ways, a join with -Add, and one with no account where nobody can answer refused before installing; -Help'

    # The launcher herdr's sign-in start and the task run, as Windows PowerShell runs it: written for a herdr in a folder
    # with an apostrophe, into a user folder outside ASCII (read whole only with its byte order mark), it starts herdr's
    # server only while herdr lists Ovis's plugin and no server runs, and finds herdr by name once that one is gone
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer).Path, [ref]$null, [ref]$null)
    Invoke-Expression $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-HerdrLauncher' }, $true).Extent.Text
    $fakeHerdrDir = Join-Path $ghStandIn ("herdr's " + [char]0x2019 + 'bin ' + [char]0x6771 + [char]0x4eac)
    New-Item -ItemType Directory -Force -Path $fakeHerdrDir | Out-Null
    Set-Content -LiteralPath (Join-Path $fakeHerdrDir 'herdr.cmd') -Encoding Ascii -Value @'
@echo off
echo %*>>"%~dp0calls.txt"
if "%1"=="plugin" type "%~dp0plugins.json"
if "%1"=="status" type "%~dp0status.json"
exit /b 0
'@
    $ovisHome = Join-Path $ghStandIn ('user ' + [char]0x6771 + [char]0x4eac + '\ovis')
    $herdrLauncher = Join-Path $ovisHome 'start-herdr.ps1'
    $launcherCalls = Join-Path $fakeHerdrDir 'calls.txt'
    $listed = '{"result":{"plugins":[{"plugin_id":"devswha.ovis"}]}}'
    $launch = {
        param([string]$Plugins, [bool]$Running)
        Set-Content -LiteralPath (Join-Path $fakeHerdrDir 'plugins.json') -Encoding Ascii -Value $Plugins
        Set-Content -LiteralPath (Join-Path $fakeHerdrDir 'status.json') -Encoding Ascii -Value "{`"running`":$("$Running".ToLowerInvariant())}"
        Remove-Item -LiteralPath $launcherCalls -Force -ErrorAction SilentlyContinue
        & $powershellExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $herdrLauncher
        # the server's start is a process of its own: its line comes within the bound, or never
        for ($i = 0; $i -lt 30 -and @(Get-Content -LiteralPath $launcherCalls -ErrorAction SilentlyContinue) -notcontains 'server'; $i++) { Start-Sleep -Milliseconds 100 }
        @(Get-Content -LiteralPath $launcherCalls -ErrorAction SilentlyContinue | ForEach-Object { "$_".Trim() }) -join ','
    }
    Write-HerdrLauncher (Join-Path $fakeHerdrDir 'herdr.cmd')
    Assert ((Get-Content -LiteralPath $herdrLauncher -Encoding UTF8 -Raw).Contains([Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($fakeHerdrDir))) 'control: the launcher must name the herdr it was written for, both apostrophes doubled'
    $calls = & $launch $listed $false
    Assert ($calls -eq 'plugin list --json,status server --json,server') "The launcher must start herdr's server where Ovis is installed and none runs: $calls"
    $calls = & $launch $listed $true
    Assert ($calls -eq 'plugin list --json,status server --json') "The launcher must leave a herdr that runs alone: $calls"
    $calls = & $launch '{"result":{"plugins":[]}}' $false
    Assert ($calls -eq 'plugin list --json') "The launcher must start nothing once Ovis is not installed: $calls"
    Write-HerdrLauncher (Join-Path $ghStandIn 'gone\herdr.exe')
    $givenPath = $env:PATH; $env:PATH = "$fakeHerdrDir;$env:PATH"
    try { $calls = & $launch $listed $false } finally { $env:PATH = $givenPath }
    Assert ($calls -eq 'plugin list --json,status server --json,server') "The launcher must find herdr by name once the one it names is gone: $calls"
    Remove-Item -LiteralPath (Split-Path $ovisHome), $fakeHerdrDir -Recurse -Force
    Write-Host 'PASS the launcher of the sign-in start: starts herdr only with Ovis installed and none running, in a user folder outside ASCII, finding herdr by name once its path is gone'

    # INSTALL.md's background command for agents, as Windows PowerShell runs it, the installer replaced: Start-Process
    # joins its arguments unquoted, so the command holds no double quote, and the log ends with install-exit=0 when the
    # installer ends, or with install-exit=1 after what it said when it throws
    $recipe = [regex]::Match((Get-Content -Raw (Join-Path $PSScriptRoot '..\INSTALL.md')), "(?m)^Start-Process powershell .* -ArgumentList '([^']*)'\r?$").Groups[1].Value
    Assert ($recipe.Contains('irm https://ovis.sh/install.ps1 | iex') -and -not $recipe.Contains('"')) "control: INSTALL.md's recipe must run the installer, in one argument with no double quote: $recipe"
    foreach ($case in @(@{ installer = 'Write-Output installed'; ends = 'install-exit=0' }, @{ installer = "throw 'the installer failed'"; ends = 'install-exit=1'; said = 'the installer failed' })) {
        $log = Join-Path $ghStandIn 'recipe.log'
        Remove-Item -LiteralPath $log, "$log.err" -Force -ErrorAction SilentlyContinue
        $child = Microsoft.PowerShell.Management\Start-Process powershell -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -ArgumentList $recipe.Replace('irm https://ovis.sh/install.ps1 | iex', $case.installer) -PassThru
        Assert ($child.WaitForExit(60000)) "INSTALL.md's recipe must end ($($case.ends))"
        $lines = @(Get-Content -LiteralPath $log | Where-Object { "$_".Trim() })
        Assert ($lines.Count -and "$($lines[-1])".Trim() -eq $case.ends -and (-not $case.said -or ($lines -join "`n").Contains($case.said))) "INSTALL.md's recipe must end its log with $($case.ends): $($lines -join ' / ') / err: $(Get-Content -Raw -LiteralPath "$log.err" -ErrorAction SilentlyContinue)"
    }
    Write-Host 'PASS the agent recipe in INSTALL.md ends its log with install-exit=0 or install-exit=1'

    # The e2e's -StopHerdr stops what runs (herdr, Ovis's port, the sign-in start): off a CI runner it refuses, at once
    $givenCi = $env:CI; $givenActions = $env:GITHUB_ACTIONS
    Remove-Item Env:\CI, Env:\GITHUB_ACTIONS -ErrorAction SilentlyContinue
    # its error stream read as text: under Stop, Windows PowerShell would end this test at the child's first stderr line
    try { $refusal = & { $ErrorActionPreference = 'Continue'; @(& $powershellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'windows-install-e2e.ps1') -StopHerdr 2>&1 | ForEach-Object { "$_" }) -join "`n" }; $code = $LASTEXITCODE }
    finally { if ($null -ne $givenCi) { $env:CI = $givenCi }; if ($null -ne $givenActions) { $env:GITHUB_ACTIONS = $givenActions } }
    Assert ($code -ne 0 -and $refusal.Contains('-StopHerdr stops the herdr that runs') -and $refusal.Contains('on a CI runner only') -and $refusal -notmatch 'e2e:') "The e2e's -StopHerdr must refuse off a CI runner before doing anything: exit $code, $refusal"
    Write-Host 'PASS the e2e refuses -StopHerdr off a CI runner'

    # The star: mentioned once on a first install, asked only at a terminal, given only on "y".
    $mention = 'a GitHub star helps other herdr users find it'
    $question = 'star it now with the GitHub account'
    $said = & $firstInstall 'starred'
    Assert ($said -notmatch $mention -and $star.asked -eq 0 -and (& $read) -eq 1 -and (& $given) -eq 0) "An account that already starred must hear nothing of it, after one status read: $said"
    $said = & $firstInstall 'signed-out'
    Assert ($said -match $mention -and $said -notmatch $question -and (& $given) -eq 0) "Without a gh sign-in the link is all there is: $said"
    $newInstall = $true
    $said = & $installer -Ref '' 6>&1 | Out-String
    Remove-Variable newInstall
    Assert ($said -notmatch $mention) "A rerun must not mention the star, whatever the caller's variables hold: $said"
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $said = & $firstInstall 'hangs'
    Assert ($said -match $mention -and $said -notmatch $question -and $clock.Elapsed.TotalSeconds -lt 14) "A gh that does not answer must be left after 10 seconds, with the link: $($clock.Elapsed.TotalSeconds) s, $said"

    # The installer as it is, where this test runs: CI has no terminal, and a developer's terminal is told it is CI.
    $ci = $env:CI; $env:CI = 'true'
    try { $said = & $firstInstall 'not' } finally { $env:CI = $ci }
    Assert ($said -match $mention -and $said -notmatch $question -and $star.asked -eq 0 -and (& $given) -eq 0) "An agent or a script must get the link and no question: $said"

    # Whether somebody is at a terminal is what a test host cannot be: the installer's own text, with those two answers given.
    $source = Get-Content -Raw $installer
    $decision = 'if ($newInstall) {'
    Assert (($source -split [regex]::Escape($decision)).Count -eq 2) 'The installer must decide once, after its helpers, whether this was a first install'
    # The installer defines its own Read-Answer above the decision, so the test's stands in after it: the answer
    # given here, or null where nobody is at the terminal and the installer's own wait is what ended.
    $answering = 'function Read-Answer { $star.asked++; if ($star.failAsk) { throw "Read-Answer has no console to read from" }; $star.answer }'
    $atTerminal = $source.Replace($decision, "function Test-Terminal { `$true }; $answering; $decision")
    $nobodyThere = $source.Replace($decision, "function Test-Terminal { `$true }; function Read-Answer { `$null }; $decision")
    $star.answer = 'y'
    $said = & $firstInstall 'not' $nobodyThere
    Assert ($said -match $question -and $star.asked -eq 0 -and (& $given) -eq 0) "A question nobody answers must be left without a star: $said"
    foreach ($gh in 'upstream', 'signed-out') {
        $said = & $firstInstall $gh $atTerminal
        Assert ($said -match $mention -and $said -notmatch $question -and $star.asked -eq 0) "Only GitHub's own 404 is a reason to ask, not ${gh}: $said"
    }
    foreach ($answer in '', 'n', 'yy') {
        $star.answer = $answer
        $said = & $firstInstall 'not' $atTerminal
        Assert ($said -match $question -and $star.asked -eq 1 -and (& $given) -eq 0) "The answer '$answer' must not star: $said"
    }
    $star.answer = 'y'
    $said = & $firstInstall 'not' $atTerminal
    Assert ($star.asked -eq 1 -and (& $given) -eq 1 -and $said -match 'starred\. Thank you') "A yes must star once: $said"
    $said = & $firstInstall 'refuses' $atTerminal
    Assert ($said -match 'could not star it' -and $state.installed) "A star gh refuses must be said, not thrown: $said"
    $star.failAsk = $true
    $said = & $firstInstall 'not' $atTerminal
    $star.failAsk = $false
    Assert ($state.installed -and $star.asked -eq 1 -and (& $given) -eq 0) "A question that cannot be asked must not fail the install: $said"
    & $firstInstall 'signed-out' | Out-Null
    Write-Host 'PASS star: silent when starred or on a rerun, a link without gh, an answer or a terminal, asked once at a terminal and given only on yes'

    # A gh that leaves a child holding its output: the call ends on its deadline and the child ends with it.
    $parsed = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer).Path, [ref]$null, [ref]$null)
    $ghApi = $parsed.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-GhApi' }, $true)
    Assert ($null -ne $ghApi) 'The installer must define Invoke-GhApi'
    Invoke-Expression $ghApi.Extent.Text
    Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value 'lingering'
    $childFile = Join-Path $ghStandIn 'child.txt'
    Remove-Item -LiteralPath $childFile -Force -ErrorAction SilentlyContinue
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $answer = Invoke-GhApi 'user/starred/devswha/ovis'
    $elapsed = $clock.Elapsed.TotalSeconds
    $childPid = [int](Get-Content -LiteralPath $childFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    Assert ($childPid -gt 0) 'control: the lingering stand-in must have started its child and named its PID'
    Assert ($null -eq $answer -and $elapsed -lt 15) "control: a gh whose output stays open must be left after its deadline, with no answer: $elapsed s"
    $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'PING'
    $left = $child -and -not $child.WaitForExit(5000)
    if ($left) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
    Assert (-not $left) "regression (fails on main): the child gh left holding its output (PID $childPid) must not outlive the call"
    Write-Host "PASS gh deadline: a child of gh that holds its output ends with the call (PID $childPid, $([math]::Round($elapsed, 1)) s)"

    $immediate = Join-Path $ghStandIn 'immediate shim'
    New-Item -ItemType Directory -Path $immediate | Out-Null
    Add-Type -OutputAssembly (Join-Path $immediate 'gh.exe') -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class ImmediateGh {
    public static void Main() {
        Process child = Process.Start(new ProcessStartInfo("ping.exe", "-n 47 127.0.0.1") { UseShellExecute = false });
        File.WriteAllText(Environment.GetEnvironmentVariable("HERDR_TEST_GH_CHILD"), child.Id.ToString());
        using (EventWaitHandle ready = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("HERDR_TEST_GH_READY"))) ready.Set();
        Console.WriteLine("HTTP/2.0 404 Not Found");
        Console.Error.WriteLine("gh: Not Found (HTTP 404)");
        Environment.ExitCode = 1;
    }
}
'@
    $assignment = '[Ovis.GhJob]::Assign($job, $process.Handle)'
    $orderedSource = $ghApi.Extent.Text.Replace("`r`n", "`n").Replace($assignment, '(Assign-TestGhJob $job $process)')
    Assert ($orderedSource -ne $ghApi.Extent.Text) 'control: interpose at the real job assignment boundary'
    function Assign-TestGhJob($Job, $Process) {
        if ($Process -is [Diagnostics.Process]) {
            Assert ($ready.WaitOne(5000)) 'control: the runnable shim must reach child-ready before assignment'
        }
        Assert (-not $ready.WaitOne(0)) 'regression: shim ran before job assignment'
        [Ovis.GhJob]::Assign($Job, $Process.Handle)
    }
    $suspendedLaunch = @'
        if ($job -ne [IntPtr]::Zero) {
            $process = [Ovis.GhJob]::StartSuspended($start.FileName, $start.Arguments)
            if (-not (Assign-TestGhJob $job $process)) {
                $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
            }
            $process.Resume()
        } else {
            $process = [Diagnostics.Process]::Start($start)
        }
'@
    $runnableLaunch = @'
        $process = [Diagnostics.Process]::Start($start)
        if ($job -ne [IntPtr]::Zero -and -not (Assign-TestGhJob $job $process)) {
            $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
        }
'@
    $runnableSource = $orderedSource.Replace($suspendedLaunch.Replace("`r`n", "`n"), $runnableLaunch)
    $path = $env:PATH
    $oldReady = $env:HERDR_TEST_GH_READY; $oldChild = $env:HERDR_TEST_GH_CHILD
    try {
        $env:PATH = "$immediate;$path"
        foreach ($case in @(
            @{ name = 'reverted'; source = $runnableSource },
            @{ name = 'fixed'; source = $orderedSource }
        )) {
            $env:HERDR_TEST_GH_READY = "Local\herdr-gh-ready-$([Guid]::NewGuid())"
            $env:HERDR_TEST_GH_CHILD = Join-Path $immediate 'child.txt'
            Remove-Item -LiteralPath $env:HERDR_TEST_GH_CHILD -Force -ErrorAction SilentlyContinue
            $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $env:HERDR_TEST_GH_READY)
            $failure = ''
            try {
                Invoke-Expression $case.source
                $clock = [Diagnostics.Stopwatch]::StartNew()
                $answer = Invoke-GhApi 'user/starred/devswha/ovis'
                Assert ($null -eq $answer -and $clock.Elapsed.TotalSeconds -lt 15) 'regression: immediate child must not keep the call waiting past its deadline'
                Assert ($ready.WaitOne(0)) 'control: the resumed shim must have started its child'
                $childPid = [int](Get-Content -LiteralPath $env:HERDR_TEST_GH_CHILD)
                $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue
                Assert (-not $child -or $child.WaitForExit(5000)) 'regression: immediate child must end with the assigned job'
            } catch { $failure = $_.Exception.Message } finally {
                $childPid = [int](Get-Content -LiteralPath $env:HERDR_TEST_GH_CHILD -ErrorAction SilentlyContinue | Select-Object -First 1)
                if ($childPid -gt 0) {
                    Get-Process -Id $childPid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'PING' |
                        Stop-Process -Force -ErrorAction SilentlyContinue
                }
                $ready.Dispose()
            }
            if ($case.name -eq 'reverted') {
                Assert ($failure -eq 'regression: shim ran before job assignment') "The reverted launch must fail the ordering assertion, not another error: $failure"
                Write-Host "PASS gh ordering negative control: reverted launch 0 pass, 1 fail ($failure)"
            } else {
                Assert (-not $failure) "The suspended launch must pass the same ordering and child cleanup test: $failure"
                Write-Host 'PASS gh ordering: suspended launch 1 pass, 0 fail; immediate child ends with its job'
            }
        }
    } finally {
        $env:PATH = $path
        $env:HERDR_TEST_GH_READY = $oldReady; $env:HERDR_TEST_GH_CHILD = $oldChild
    }

    # The release's binary, from a local release folder signed by a key made for this test. The installer trusts only
    # the key on its $releasePublicKey line, so the test runs a copy whose line names the test's key: nothing in the
    # shipped script reads a key from anywhere else.
    $binaryScratch = Join-Path ([IO.Path]::GetTempPath()) "ovis-binary-install-$PID"
    New-Item -ItemType Directory -Force -Path $binaryScratch | Out-Null
    $realBun = (Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    Assert ([bool]$realBun) 'The binary cases make their release folder with Bun (ci.yml sets it up before this test)'
    $fixture = Join-Path $binaryScratch 'fixture.ts'
    Set-Content -LiteralPath $fixture -Encoding UTF8 -Value @'
// <release folder> <scripts/server-manifest.ts>: v1.2.3 to v1.2.7 signed by one key, v1.2.5 then again by another,
// v1.2.6 with a manifest for 1.2.2; prints the first key's public half
const [releases, module] = process.argv.slice(2);
const { generateKeyPair, releaseFile, SERVER_PLATFORMS, DIST_ARCHIVE, PTY_ASSETS, ptyFile, signManifest, writeManifest } = await import(module);
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const key = generateKeyPair();
for (const version of ["1.2.3", "1.2.4", "1.2.5", "1.2.6", "1.2.7"]) {
  const dir = join(releases, `v${version}`);
  const client = join(releases, `client-${version}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(client, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `ovis-server ${version} for ${platform}\n`);
  for (const build of PTY_ASSETS) writeFileSync(join(dir, ptyFile(build)), `pty host ${build}\n`);
  writeFileSync(join(client, "index.html"), `<!doctype html><title>${version}</title>`);
  if (Bun.spawnSync(["tar", "-czf", join(dir, DIST_ARCHIVE), "-C", client, "."]).exitCode !== 0) throw new Error("tar failed");
  writeManifest(dir, { version: version === "1.2.6" ? "1.2.2" : version, sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
  signManifest(dir, version === "1.2.5" ? generateKeyPair().privateKeyPem : key.privateKeyPem);
}
// v1.2.8 to v1.3.0 as main's release step (todo 5) writes them: version, sources and assets only; v1.2.9 signed by
// another key, v1.3.0 with "schema": 2
const { createHash, createPrivateKey, sign } = await import("node:crypto");
for (const [version, signer, schema] of [["1.2.8", key.privateKeyPem, null], ["1.2.9", generateKeyPair().privateKeyPem, null], ["1.3.0", key.privateKeyPem, 2]]) {
  const dir = join(releases, `v${version}`);
  mkdirSync(dir, { recursive: true });
  const assets = {};
  for (const platform of SERVER_PLATFORMS) {
    writeFileSync(join(dir, releaseFile(platform)), `old binary ${platform}\n`);
    assets[platform] = { file: releaseFile(platform), sha256: createHash("sha256").update(`old binary ${platform}\n`).digest("hex") };
  }
  const manifest = schema === null ? { version, sources: { server: "a".repeat(40), shared: "b".repeat(40) }, assets } : { schema, version, sources: { server: "a".repeat(40), shared: "b".repeat(40) }, assets };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "ovis-server.json"), bytes);
  writeFileSync(join(dir, "ovis-server.json.sig"), `${sign(null, bytes, createPrivateKey(signer)).toString("base64")}\n`);
}
console.log(key.publicKey);
'@
    $releaseDir = Join-Path $binaryScratch 'release'
    $testKey = "$(& $realBun $fixture $releaseDir (Join-Path $PSScriptRoot 'server-manifest.ts') | Select-Object -Last 1)".Trim()
    Assert ($LASTEXITCODE -eq 0 -and $testKey -match '^[A-Za-z0-9+/]{43}=$') "The release fixture must be made: $testKey"
    # v1.2.4's binary with one byte changed, the same size: only its SHA-256 can tell
    $corrupt = Join-Path $releaseDir 'v1.2.4\ovis-server-windows-x64.exe'
    $bytes = [IO.File]::ReadAllBytes($corrupt); $bytes[3] = $bytes[3] -bxor 1; [IO.File]::WriteAllBytes($corrupt, $bytes)
    $shipped = Get-Content -Raw $installer
    $keyLine = [regex]::Match($shipped, '(?m)^\$releasePublicKey = ''[^'']+''(?=\r?$)').Value
    Assert ([bool]$keyLine) 'install.ps1 must pin its key on one $releasePublicKey line'
    $copy = Join-Path $binaryScratch 'install.ps1'
    # and whose release binary (a stand-in file here) is run as the stand-in bun runs a script: its status and its add
    $binaryCli = '$ovisCli = @($exe, ''plugin'')'
    Assert ($shipped.Contains($binaryCli)) 'control: the release binary is run through one command line'
    Set-Content -LiteralPath $copy -Encoding UTF8 -Value $shipped.Replace($keyLine, "`$releasePublicKey = '$testKey'").Replace('[int]$WaitSeconds = 600', '[int]$WaitSeconds = 2').Replace($binaryCli, '$ovisCli = @(''bun'', $exe)')
    $env:OVIS_FROM_SOURCE = ''
    $env:OVIS_RELEASES_URL = ([Uri]$releaseDir).AbsoluteUri
    $env:LOCALAPPDATA = Join-Path $binaryScratch 'local app data'
    $state.installed = $false; $state.running = $false; $state.linkedRoot = ''; $state.herdrStarts = @()
    $ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
    $exe = Join-Path $ovisHome 'bin\ovis-server.exe'
    & $copy -Ref 'v1.2.3'
    Assert ((Get-FileHash $exe).Hash -eq (Get-FileHash (Join-Path $releaseDir 'v1.2.3\ovis-server-windows-x64.exe')).Hash) 'The checked binary must be installed in bin'
    Assert ((Get-Content -Raw (Join-Path $ovisHome 'bin\dist\index.html')) -match '1\.2\.3') 'The client must be unpacked beside it'
    Assert ($state.linkedRoot -eq (Join-Path $ovisHome 'plugin') -and (Test-Path (Join-Path $ovisHome 'plugin\herdr-plugin.toml'))) 'The plugin that runs it must be linked into herdr'
    Assert (($state.herdrStarts -join ',') -eq 'desktop' -and $state.runValue -eq "`"$powershellExe`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $ovisHome 'start-herdr.ps1')`"") "The release's binary must start herdr where it was stopped, with its sign-in start: $($state.herdrStarts -join ',') $($state.runValue)"
    $state.adds = @()
    $again = & $copy -Ref 'v1.2.3' -Account 'acct_bin' 6>&1 | Out-String
    Assert ($again -match 'nothing to do') "A second run must have nothing to do: $again"
    Assert (($state.adds -join '|') -eq 'add --account acct_bin <piped 0>') "On the release's binary, -Account must run its add: $($state.adds -join '|') $again"
    Remove-Item -LiteralPath (Join-Path $ovisHome 'bin\dist\index.html')
    $restored = & $copy -Ref 'v1.2.3' 6>&1 | Out-String
    Assert ($restored -notmatch 'nothing to do' -and ((Get-Content -Raw (Join-Path $ovisHome 'bin\dist\index.html')) -match '1\.2\.3')) "A missing client must be installed again: $restored"
    $kept = (Get-FileHash $exe).Hash
    foreach ($case in @(@('v1.2.4', 'does not match its SHA-256'), @('v1.2.5', 'not a valid signature'), @('v1.2.6', 'is for version 1\.2\.2, not 1\.2\.6'))) {
        $message = ''
        try { & $copy -Ref $case[0] } catch { $message = $_.Exception.Message }
        Assert ($message -match $case[1] -and $message -match 'nothing was changed') "$($case[0]) must be refused, saying why: $message"
        Assert ((Get-FileHash $exe).Hash -eq $kept) "$($case[0]) must leave the installed binary as it was"
    }
    $env:OVIS_RELEASES_URL = 'http://mirror.example/ovis'
    $message = ''
    try { & $copy -Ref 'v1.2.3' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'OVIS_RELEASES_URL') "Plain http must be refused: $message"
    $env:OVIS_RELEASES_URL = ([Uri]$releaseDir).AbsoluteUri
    $message = ''
    try { & $installer -Ref 'v1.2.4' 6>&1 | Out-Null } catch { $message = $_.Exception.Message }
    Assert ($message -match 'not a valid signature') "The shipped installer must refuse a release its pinned key did not sign: $message"
    $kept = (Get-FileHash $exe).Hash
    $before = @($state.installed, $state.running, $state.linkedRoot)
    $state.installed = $false; $state.running = $false; $state.linkedRoot = ''
    $old = & { try { & $copy -Ref 'v1.2.8' } catch { "THREW $($_.Exception.Message)" } } *>&1 | Out-String
    Assert ($old -match "v1\.2\.8's signed ovis-server\.json has the shape from before this installer" -and $old -match 'ships no compiled server, so it is installed from source') "An old-shape release must go to source: $old"
    Assert ((Get-FileHash $exe).Hash -eq $kept) 'An old-shape release must not touch the installed binary'
    Assert ($state.ref -eq 'v1.2.8' -and $state.pluginSource -eq '') "A release tag must be built as its release says, not forced to source (herdr's build was told '$($state.pluginSource)')"
    $message = ''; $state.installed = $false; $state.linkedRoot = ''
    try { & $copy -Ref 'v1.2.9' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'is not signed by the key') "An old-shape release signed by another key must be refused: $message"
    $message = ''; $state.installed = $false; $state.linkedRoot = ''
    try { & $copy -Ref 'v1.3.0' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'schema this installer does not know') "A manifest of schema 2 must be refused: $message"
    $state.installed, $state.running, $state.linkedRoot = $before
    $env:OVIS_FROM_SOURCE = '1'; $env:LOCALAPPDATA = $testLocalAppData; Remove-Item Env:\OVIS_RELEASES_URL
    $state.linkedRoot = ''; $state.running = $true
    Write-Host 'PASS the release binary: installed and linked once checked, nothing to do again; a release of the old manifest shape goes to source; a corrupt binary, another key, another version and plain http refused, leaving the install as it was'

    $env:OVIS_FROM_SOURCE = ''
    $env:OVIS_RELEASES_URL = ([Uri]$releaseDir).AbsoluteUri
    $env:LOCALAPPDATA = Join-Path $binaryScratch 'lock app data'
    $state.installed = $false; $state.running = $false; $state.linkedRoot = ''
    $ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
    $lock = Join-Path $ovisHome '.install.lock'
    New-Item -ItemType Directory -Force -Path $lock | Out-Null
    Set-Content -LiteralPath (Join-Path $lock 'pid') -Value $PID -Encoding Ascii
    $message = ''
    try { & $copy -Ref 'v1.2.3' } catch { $message = $_.Exception.Message }
    Assert ($message -match "another install is running in .* \(pid $PID\)" -and -not (Test-Path (Join-Path $ovisHome 'bin'))) "A live holder's lock must be waited out and named: $message"
    Assert ((Get-Content -LiteralPath (Join-Path $lock 'pid')) -eq "$PID") 'A live holder keeps its lock'
    $gone = [Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo -Property @{ FileName = "$env:SystemRoot\System32\cmd.exe"; Arguments = '/c exit'; UseShellExecute = $false; CreateNoWindow = $true }))
    $gone.WaitForExit()
    Set-Content -LiteralPath (Join-Path $lock 'pid') -Value $gone.Id -Encoding Ascii
    & $copy -Ref 'v1.2.3'
    Assert ((Test-Path (Join-Path $ovisHome 'bin\ovis-server.exe')) -and -not (Test-Path $lock)) 'A dead holder''s lock must be taken over'
    $runner = Join-Path $binaryScratch 'install-runner.ps1'
    Set-Content -LiteralPath $runner -Encoding UTF8 -Value @'
param([string]$Installer, [string]$Version, [string]$Barrier)
$ErrorActionPreference = 'Stop'
$source = Get-Content -Raw -LiteralPath $Installer
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($definition.Extent.Text)) }
$ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
$releasePublicKey = [regex]::Match($source, "(?m)^\`$releasePublicKey = '([^']+)'").Groups[1].Value
while (-not (Test-Path -LiteralPath $Barrier)) { Start-Sleep -Milliseconds 10 }
try { $null = Install-OvisBinary $Version; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }
'@
    $hashes = @{}
    foreach ($version in '1.2.3', '1.2.7') { $hashes[(Get-FileHash (Join-Path $releaseDir "v$version\ovis-server-windows-x64.exe")).Hash] = $version }
    for ($pair = 0; $pair -lt 6; $pair++) {
        $barrier = Join-Path $binaryScratch "barrier-$pair"
        $versions = if ($pair % 2) { '1.2.3', '1.2.7' } else { '1.2.7', '1.2.3' }
        $children = foreach ($version in $versions) {
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = (Get-Command powershell).Source
            $info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Installer `"$copy`" -Version $version -Barrier `"$barrier`""
            $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true
            [Diagnostics.Process]::Start($info)
        }
        Set-Content -LiteralPath $barrier -Value ''
        $said = foreach ($child in $children) { $child.StandardOutput.ReadToEnd(); $child.WaitForExit() }
        Assert (@($children | Where-Object { $_.ExitCode -eq 0 }).Count -ge 1) "Pair ${pair}: at least one install must succeed: $said"
        $running = $hashes[(Get-FileHash (Join-Path $ovisHome 'bin\ovis-server.exe')).Hash]
        Assert ($running -and ((Get-Content -Raw (Join-Path $ovisHome 'bin\dist\index.html')) -match [regex]::Escape($running))) "Pair ${pair}: bin must hold one whole release: $said"
        Assert (-not (Test-Path $lock)) "Pair ${pair}: the lock must be released"
    }
    $state.linkedRoot = ''; $state.running = $true
    $env:OVIS_FROM_SOURCE = '1'; $env:LOCALAPPDATA = $testLocalAppData; Remove-Item Env:\OVIS_RELEASES_URL
    Write-Host 'PASS one install at a time: a live holder waited out and named, a dead holder''s lock taken over, overlapping installs in two processes leave one whole release'

    $scratch = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-test-$PID"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $runs = Join-Path $scratch 'runs.txt'
    $marker = Join-Path $scratch 'second-run'
    $herdrStandIn = ${function:herdr}
    Remove-Item Function:\herdr
    $env:PATH = "$env:SystemRoot\System32"; $env:LOCALAPPDATA = $scratch; $env:USERPROFILE = $scratch
    Assert (-not (Get-Command herdr -ErrorAction SilentlyContinue)) 'The herdr installer cases need a session without herdr'
    $slow = 'echo curl: (28) Operation too slow. Less than 1024 bytes/sec transferred the last 30 seconds 1>&2'
    $attempts = { @(Get-Content -LiteralPath $runs -ErrorAction SilentlyContinue).Count }

    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'could not be downloaded' -and (& $attempts) -eq 2) "A download that fails twice must be tried twice and named as a download: $message"

    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'security software' -and (& $attempts) -eq 1) "A stop without a download error must not be retried: $message"

    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nif exist `"$marker`" exit /b 0`r`necho.>`"$marker`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -and $message -notmatch 'could not be downloaded|did not finish' -and (& $attempts) -eq 2) "A download that succeeds on the second try must carry on: $message"
    Write-Host 'PASS herdr installer: a failed download is retried once and named, a silent stop is not retried'
} finally {
    $env:PATH = $originalPath
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:USERPROFILE = $originalUserProfile
    $env:OVIS_FROM_SOURCE = $originalFromSource
    if ($null -eq $originalStateHome) { Remove-Item Env:\XDG_STATE_HOME -ErrorAction SilentlyContinue } else { $env:XDG_STATE_HOME = $originalStateHome }
    Remove-Item Env:\OVIS_RELEASES_URL -ErrorAction SilentlyContinue
    if ($binaryScratch) { Remove-Item -LiteralPath $binaryScratch -Recurse -Force -ErrorAction SilentlyContinue }
    if ($herdrStandIn) { Set-Item Function:\herdr $herdrStandIn }
    if ($serverChild) { Stop-Process -Id $serverChild.Id -Force -ErrorAction SilentlyContinue }
    if ($scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $ghStandIn -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
}
