# It replaces an installed Ovis and leaves the one it installed (with herdr's sign-in start, where this commit's installer
# sets one). A herdr server it or the installer had to start is stopped again; one that was already running is left
# alone, unless -StopHerdr: then it, a process an earlier step left on Ovis's port and a sign-in start named Ovis go
# first, so this commit's installer has to start and set them (CI's Native Windows install only: its runner is reset
# after the job). On a person's PC those are their live sessions, so -StopHerdr refuses to run anywhere but on a CI
# runner (GITHUB_ACTIONS=true or CI set), before it does anything.
param(
    [string]$Installer = (Join-Path $PSScriptRoot '..\install.ps1'),
    [string]$Ref = '',
    [switch]$Update,
    [switch]$Fresh,
    [switch]$StopHerdr
)
$ErrorActionPreference = 'Stop'
if ($StopHerdr -and $env:GITHUB_ACTIONS -ne 'true' -and -not $env:CI) {
    throw '-StopHerdr stops the herdr that runs, what holds port 7317 and a sign-in start named Ovis: on a CI runner only (GITHUB_ACTIONS=true or CI set), never on a PC whose herdr holds someone''s sessions. Nothing was stopped.'
}
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
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
# Ovis, then herdr, stopped: the action only queues Ovis's stop, which a herdr stopped at once can cut off half done,
# leaving a server that answers no health, so herdr is stopped once Ovis's port is closed
function Stop-OvisAndHerdr {
    if (Find-Plugin) { herdr plugin action invoke "$pluginId.stop-windows" | Out-Null }
    Wait-Until { -not (Get-NetTCPConnection -LocalPort 7317 -State Listen -ErrorAction SilentlyContinue) } 30 'Ovis to stop' | Out-Null
    herdr server stop | Out-Null
    Wait-Until { -not (Test-ServerRunning) } 30 'herdr to stop' | Out-Null
}
# herdr's server: the herdr process that started first (a command's herdr comes and goes)
function Get-HerdrServer { Get-Process herdr -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1 }
# what the installer leaves where it started herdr: its own sign-in start (the Run value Ovis, its launcher) and no task
function Assert-SignInStart([string]$After) {
    $signIn = "$((Get-ItemProperty $runKey -Name Ovis -ErrorAction SilentlyContinue).Ovis)"
    Assert ($signIn -like '*\ovis\start-herdr.ps1"') "After $After herdr must start at sign-in with the installer's launcher, not: $signIn"
    Assert (-not (Get-ScheduledTask -TaskName 'Ovis herdr start*' -ErrorAction SilentlyContinue)) "After $After the task that started herdr must be gone"
}
# The installer as it runs over SSH, in session 0 outside this desktop: a task of this account's that runs whether it is
# signed in or not (S4U: no password kept), its output in a file. What it said, whether it threw, and the session it ran
# in; nothing where this PC runs no such task.
function Invoke-InSession0([string]$Arguments) {
    $script = Join-Path (Find-Plugin).plugin_root 'scripts\plugin.ts'
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('ovis-e2e-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $log = Join-Path $dir 'out.log'; $done = Join-Path $dir 'exit.txt'; $runner = Join-Path $dir 'run.ps1'
    # with this run's PATH (Bun, herdr), which a task does not get, as a login's PATH would have them
    Set-Content -LiteralPath $runner -Encoding UTF8 -Value @"
`$ProgressPreference = 'SilentlyContinue'
`$env:PATH = '$($env:PATH -replace "'", "''")'
"session `$([Diagnostics.Process]::GetCurrentProcess().SessionId)" | Out-File -LiteralPath '$log' -Encoding utf8
try { & '$Installer' $Arguments *>&1 | Out-File -Append -LiteralPath '$log' -Encoding utf8 -Width 4096; `$code = 0 }
catch { `$_ | Out-String -Width 4096 | Out-File -Append -LiteralPath '$log' -Encoding utf8; `$code = 1 }
# what this session sees of the app, for a failure's message: the plugin's own status, and the app's port
& {
    "--- seen from this session (`$([Security.Principal.WindowsIdentity]::GetCurrent().AuthenticationType) logon)"
    try { "status: `$(& bun '$($script -replace "'", "''")' status 2>&1 | Out-String)" } catch { "status threw: `$_" }
    try { "health: `$((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:7317/api/health).StatusCode)" } catch { "health failed: `$(`$_.Exception.Message)" }
} *>&1 | Out-File -Append -LiteralPath '$log' -Encoding utf8 -Width 4096
Set-Content -LiteralPath '$done' -Value `$code
"@
    $task = 'Ovis e2e session 0 ' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    try {
        $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType S4U -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -Priority 4
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
        $null = Start-ScheduledTask -TaskName $task -ErrorAction Stop
    } catch {
        Write-Host "e2e: this PC runs no task without a sign-in ($($_.Exception.Message))"
        Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        return $null
    }
    # its end: the file it writes last, or the task no longer running without it (PowerShell did not start there)
    $ended = { (Test-Path -LiteralPath $done) -or ((Get-ScheduledTaskInfo -TaskName $task).LastTaskResult -notin 267009, 267011 -and (Get-ScheduledTask -TaskName $task).State -ne 'Running') }
    try { Wait-Until $ended 300 'the installer run in session 0 to end' | Out-Null }
    finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
    if (-not (Test-Path -LiteralPath $done)) {
        Write-Host "e2e: the task that runs the installer in session 0 ended without running it"
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        return $null
    }
    $said = Get-Content -Raw -LiteralPath $log
    $result = @{ Said = $said; Threw = (Get-Content -Raw -LiteralPath $done).Trim() -ne '0'; Session = [regex]::Match($said, 'session (\d+)').Groups[1].Value }
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    $result
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

if ($StopHerdr) {
    if (Test-ServerRunning) {
        Write-Host 'e2e: stopping the herdr that runs, so the installer has to start it'
        if (Find-Plugin) { herdr plugin action invoke "$pluginId.stop-windows" | Out-Null }
        herdr server stop | Out-Null
        Wait-Until { -not (Test-ServerRunning) } 30 'herdr to stop' | Out-Null
    }
    # an Ovis an earlier step of the runner's job left on the app's port, which the installed one could not take; by id
    foreach ($id in @(Get-NetTCPConnection -LocalPort 7317 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)) {
        Write-Host "e2e: stopping process $id ($((Get-Process -Id $id -ErrorAction SilentlyContinue).ProcessName)), which holds port 7317"
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    Wait-Until { -not (Get-NetTCPConnection -LocalPort 7317 -State Listen -ErrorAction SilentlyContinue) } 30 'port 7317 to close' | Out-Null
    # and a sign-in start the runner's image carries (the Ovis app's, say), which the installer would rightly leave as it is
    $carried = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Ovis -ErrorAction SilentlyContinue).Ovis
    if ($null -ne $carried) {
        Write-Host "e2e: removing the sign-in start this runner had: $carried"
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name Ovis
    }
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
    $herdrRan = Test-ServerRunning
    Invoke-Installer $Ref
    if ($Installer -notmatch '^https://' -and -not $herdrRan) {
        # this commit's installer, where herdr was not running: it leaves herdr running, and Ovis answering, set to start at
        # sign-in, and no task behind (INSTALL.md)
        $startedServer = Test-ServerRunning
        Assert $startedServer 'The installer must leave herdr running where it was not'
        Assert-SignInStart 'the install line'
        Wait-Until { (Get-Json '/api/health').ok } 60 'the app to answer after the install line' | Out-Null
        $server = Get-HerdrServer
        # at normal priority: a task's default would leave herdr, and every terminal it starts, below normal
        Assert ("$($server.PriorityClass)" -eq 'Normal') "herdr the installer started must run at normal priority, not $($server.PriorityClass)"
        # -NoService takes the sign-in start away again, and leaves the herdr that runs as it is
        Write-Host 'e2e: installing again with -NoService'
        & $Installer -Ref $Ref -NoService
        Assert ($null -eq (Get-ItemProperty $runKey -Name Ovis -ErrorAction SilentlyContinue)) '-NoService must remove the sign-in start an earlier run set up'
        Assert ((Test-ServerRunning) -and (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) "-NoService must leave the herdr that runs as it is (pid $($server.Id))"
        # -Account of another shape is refused before anything is installed or started; with no account service the add
        # cannot run, says so itself, and the install fails
        $refused = ''
        try { & $Installer -Ref $Ref -Account '-not-an-id' } catch { $refused = $_.Exception.Message }
        Assert ($refused -match "^-Account \(or OVIS_ADD_ACCOUNT\) takes your Ovis account's id") "-Account of another shape must be refused at once: $refused"
        $said = New-Object Collections.Generic.List[string]; $failed = ''
        $env:OVIS_ACCOUNT_SERVICE_URL = 'off'
        try { & $Installer -Ref $Ref -NoService -Account 'acct_e2e' *>&1 | ForEach-Object { $said.Add("$_") } }
        catch { $failed = $_.Exception.Message } finally { Remove-Item Env:\OVIS_ACCOUNT_SERVICE_URL }
        Assert ($failed -match 'was not added to your Ovis account' -and ($said -join "`n") -match 'The account service is off on this PC') "-Account must fail the install with the add's own words when the add cannot run: $failed $($said -join ' / ')"
        # an invite's line of another shape is refused at once; a line in OVIS_JOIN reaches this release's own `ovis join`,
        # which with no account service says so itself, and the install fails without ever saying the line
        $refused = ''
        try { & $Installer -Ref $Ref -Join 'not-an-invite' } catch { $refused = $_.Exception.Message }
        Assert ($refused -match '^That is not an Ovis invite') "-Join of another shape must be refused at once: $refused"
        $said = New-Object Collections.Generic.List[string]; $failed = ''
        $env:OVIS_ACCOUNT_SERVICE_URL = 'off'; $env:OVIS_JOIN = 'ovis-join:1:eyJ2IjoxLCJlMmUiOiJub3QtYS1rZXkifQ'
        try { & $Installer -Ref $Ref -NoService -Account 'acct_e2e' *>&1 | ForEach-Object { $said.Add("$_") } }
        catch { $failed = $_.Exception.Message } finally { Remove-Item Env:\OVIS_ACCOUNT_SERVICE_URL; Remove-Item Env:\OVIS_JOIN -ErrorAction SilentlyContinue }
        $joined = $said -join "`n"
        Assert ($failed -match 'did not join your Ovis account' -and $joined -match 'The account service is off on this PC' -and $joined -match 'the relay or the account service is off on this PC, so it did not join' -and -not $joined.Contains('eyJ2IjoxLCJlMmUi')) "An invite must reach ovis join, and the install fail with its words when the join cannot run: $failed $($said -join ' / ')"
        # over SSH (session 0) with this account signed in at the desktop, as here: herdr starts in the desktop session
        Write-Host 'e2e: installing again from session 0, as over SSH, with herdr stopped'
        Stop-OvisAndHerdr
        $run = Invoke-InSession0 "-Ref '$Ref'"
        if ($null -eq $run -or $run.Session -ne '0') {
            # what runs the installer here, not the installer, kept it out of session 0: said, and not counted
            Write-Host "e2e: SKIP the run from session 0: $(if ($run) { "the task ran in session $($run.Session)" } else { 'no task could run it' })"
        } else {
            Assert (-not $run.Threw -and $run.Said -match 'herdr was started in your desktop' -and $run.Said -notmatch 'Task Scheduler did not') "From session 0 the installer must start herdr in the desktop through its task: $($run.Said)"
            $server = Get-HerdrServer
            Assert ((Test-ServerRunning) -and $server -and $server.SessionId -ne 0 -and "$($server.PriorityClass)" -eq 'Normal') "herdr started from session 0 must run in a desktop session at normal priority, not session $($server.SessionId), $($server.PriorityClass)"
            Assert-SignInStart 'the install line from session 0'
            Wait-Until { (Get-Json '/api/health').ok } 60 'the app to answer after the install line from session 0' | Out-Null
            Write-Host "e2e: from session 0 the installer started herdr in desktop session $($server.SessionId)"
        }
    }
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
