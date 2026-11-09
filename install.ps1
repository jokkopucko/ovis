# Native Windows install: irm https://ovis.sh/install.ps1 | iex
param([string]$Ref = $(if ($env:OVIS_REF) { $env:OVIS_REF } else { $env:HERDR_WEB_UI_REF }))

& {
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Ovis supports Windows x64. Use install.sh on Linux or macOS.'
}

function Run-Tool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed (exit $LASTEXITCODE). Fix the error above and run this again." }
}
function Run-HerdrInstaller([string]$Installer) {
    # Its errors join its output, so a failed download can be told from a silent stop. Under Stop,
    # Windows PowerShell would end this script at the first line curl writes to stderr.
    $ErrorActionPreference = 'Continue'
    & $Installer 2>&1 | ForEach-Object { $line = "$_"; Write-Host $line; $line }
}

# The official installers keep these user-local directories on PATH for future terminals.
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
    # install.sh runs Ovis on herdr-core where there is no herdr; here the plugin runs under herdr,
    # and Settings switches the server to herdr-core afterwards
    if (Get-Command herdr-core, hc -CommandType Application -ErrorAction SilentlyContinue) {
        Write-Host 'Ovis: found herdr-core (hc). Ovis starts on herdr; to show the Herdr app''s terminals, switch in Settings > About > Terminals'
    }
    Write-Host 'Ovis: installing herdr for your user'
    $installer = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName() + '.cmd')
    try {
        Invoke-WebRequest 'https://herdr.dev/install.cmd' -UseBasicParsing -OutFile $installer
        # herdr's installer gives up on a download that stays under 1 KB/s for 30 seconds.
        $download = 'curl: \(\d+\)|Failed to download'
        $output = @(Run-HerdrInstaller $installer)
        if ($LASTEXITCODE -ne 0 -and ($output -match $download)) {
            Write-Host "Ovis: herdr's download did not finish; trying once more"
            $output = @(Run-HerdrInstaller $installer)
        }
        if ($LASTEXITCODE -ne 0) {
            if ($output -match $download) { throw "herdr could not be downloaded: the connection was too slow or was cut off (curl's message is above). Run this again, on another network if it keeps failing, or install herdr from https://herdr.dev first." }
            # Seen stopping without a message of its own on a PC with banking security software.
            throw "herdr's installer did not finish. If it showed no error, security software may have stopped it: install herdr from https://herdr.dev, then run this again."
        }
    } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
}
$herdrVersion = (Run-Tool herdr @('--version')) -replace '^herdr\s+', '' -replace '-.*$', ''
if ([version]$herdrVersion -lt [version]'0.9.0') {
    throw "Needs herdr 0.9.0 or newer; this is $herdrVersion. Update herdr, restart it, and run this again."
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -or [version]((Run-Tool bun @('--version')) -replace '-.*$', '') -lt [version]'1.4.0') {
    Write-Host 'Ovis: installing Bun 1.4.2 for your user'
    # The same stable runtime as CI; use Bun's official installer rather than a second downloader.
    # It leaves this session with the user's PATH alone: without the machine's, neither this script nor herdr finds git.
    $path = $env:PATH
    & ([scriptblock]::Create((Invoke-WebRequest 'https://bun.sh/install.ps1' -UseBasicParsing).Content)) -Version '1.4.2'
    $env:PATH = $path
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Bun did not install. See https://bun.sh.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

$pluginId = 'devswha.ovis'
# the id before the rename: an install under it moves to $pluginId, keeping its config
$legacyId = 'devswha.herdr-web-ui'
function Find-Plugin([string]$Id = $pluginId) {
    (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins |
        Where-Object { $_.plugin_id -eq $Id } | Select-Object -First 1
}
# the highest vX.Y.Z tag, as the updater picks it
function Get-LatestRef {
    $latest = Run-Tool git @('ls-remote', '--tags', '--refs', 'https://github.com/devswha/ovis.git', 'v*') |
        ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
        Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
    if (-not $latest) { throw 'Could not find the latest app release on GitHub. Check your connection and run this again.' }
    $latest
}
# The ref to install is settled before anything moves: a release from before the rename still names
# the plugin by its old id, and installing it cannot move an install to the new one
$move = $true
if (-not (Find-Plugin)) {
    if (-not $Ref) { $Ref = Get-LatestRef }
    # the id the manifest at $Ref names
    $refId = try {
        $manifest = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "https://raw.githubusercontent.com/devswha/ovis/$Ref/herdr-plugin.toml").Content
        if ($manifest -match '(?m)^id\s*=\s*"([^"]+)"') { $Matches[1] }
    } catch { $null }
    # raw.githubusercontent.com can be blocked where github.com is not: a release tag's version tells it too
    if (-not $refId -and $Ref -match '^v(\d+\.\d+\.\d+)$') {
        $refId = if ([version]$Matches[1] -ge [version]'0.4.14') { $pluginId } else { $legacyId }
    }
    # That release (0.4.13 and older) installs, runs and updates under the old id: the move waits for
    # a release that names the new one. With the id unknown (a branch whose manifest cannot be read),
    # an install under the old id is left running, since the ref may not be able to move it.
    if ($refId -eq $legacyId) { $pluginId = $legacyId } elseif (-not $refId) { $move = $false }
}
$legacy = if ($pluginId -ne $legacyId -and $move) { Find-Plugin $legacyId } else { $null }
if (-not $move -and (Find-Plugin $legacyId)) {
    Write-Host "Ovis: could not read the plugin id at $Ref, so the install under $legacyId is left as it is; run this again to move it"
}
if ($legacy) {
    Write-Host "Ovis: moving the installed plugin to its Ovis id; its settings and token come along"
    # stopped first: under both ids, each would start a server on herdr's next start. Its stop is told the
    # state dir herdr hands it (as scripts/plugin-state.ts finds herdr's): run from here without it, a
    # release from before 0.4.13 looks for its pid in ~/.local/state, says it is not running, and its
    # server, which can outlive herdr, keeps the old checkout's files open for the uninstall below
    $herdrState = if ($null -ne $env:XDG_STATE_HOME) { [IO.Path]::Combine($env:XDG_STATE_HOME, 'herdr') }
        elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'herdr' }
        else { Join-Path $env:USERPROFILE 'AppData\Local\herdr' }
    $givenState = $env:HERDR_PLUGIN_STATE_DIR
    $env:HERDR_PLUGIN_STATE_DIR = Join-Path $herdrState "plugins\$legacyId"
    try { $stopped = & bun (Join-Path $legacy.plugin_root 'scripts\plugin.ts') stop }
    finally { $env:HERDR_PLUGIN_STATE_DIR = $givenState }
    # a server started by hand from the checkout keeps its pid in its own dir, which the given one hides
    if ($LASTEXITCODE -eq 0 -and -not ($stopped -match '^stopped ')) { & bun (Join-Path $legacy.plugin_root 'scripts\plugin.ts') stop | Out-Null }
    # removed with its server up, the old checkout would keep serving, and the new id's start would
    # find the port answering and leave it
    if ($LASTEXITCODE -ne 0) { throw "Could not stop the server of the old id, so nothing was moved. Stop it (herdr plugin action invoke $legacyId.stop, or restart herdr), then run this again." }
}
function Test-WindowsPlugin($Plugin) {
    $Plugin.plugin_root -and (Test-Path -LiteralPath (Join-Path $Plugin.plugin_root 'scripts\plugin.ps1'))
}
$plugin = Find-Plugin $pluginId
$newInstall = $false
if ($plugin -and -not (Test-WindowsPlugin $plugin)) {
    # A copy from a release older than Windows support never starts here, so no in-app update reaches it.
    Write-Host 'Ovis: replacing an installed copy that has no Windows support'
    Run-Tool herdr @('plugin', 'uninstall', $pluginId) | Out-Null
    $plugin = $null
}
if (-not $plugin) {
    if (-not $Ref) { $Ref = Get-LatestRef }
    Write-Host "Ovis: installing the plugin at $Ref"
    Run-Tool herdr @('plugin', 'install', 'devswha/ovis', '--ref', $Ref, '--yes')
    $newInstall = $true
    $plugin = Find-Plugin $pluginId
    # the id unknown before the install: the ref may have named the old one
    if (-not $plugin -and -not $move) {
        $pluginId = $legacyId
        $plugin = Find-Plugin $pluginId
    }
    if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }
    # herdr installs a release without Windows build steps as a success that cannot start.
    if (-not (Test-WindowsPlugin $plugin)) { throw "Ovis $Ref does not support Windows yet. Run this again after the next release." }
} else { Write-Host 'Ovis: already installed; Settings > Updates keeps it current' }
if ($legacy) {
    # herdr keeps a plugin's config by its id: the old id's env files (the token among them) go to the new id's dir unless it has its own
    $oldConfig = Run-Tool herdr @('plugin', 'config-dir', $legacyId)
    $newConfig = Run-Tool herdr @('plugin', 'config-dir', $pluginId)
    if (-not (Test-Path -LiteralPath (Join-Path $newConfig 'env')) -and -not (Test-Path -LiteralPath (Join-Path $newConfig '.env'))) {
        foreach ($name in 'env', '.env') {
            $from = Join-Path $oldConfig $name
            if (Test-Path -LiteralPath $from) {
                New-Item -ItemType Directory -Force -Path $newConfig | Out-Null
                Copy-Item -LiteralPath $from -Destination (Join-Path $newConfig $name)
            }
        }
    }
    Run-Tool herdr @('plugin', 'uninstall', $legacyId) | Out-Null
}

$server = Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json
if ($server.running) {
    Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null
    $script = Join-Path $plugin.plugin_root 'scripts\plugin.ts'
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        $status = Run-Tool bun @($script, 'status')
        if ($status -match '^running ') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        # The start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal.
        $why = ''
        try {
            $failed = (& herdr plugin log list | ConvertFrom-Json).result.logs |
                Where-Object { $_.plugin_id -eq $pluginId -and $_.stderr } | Select-Object -Last 1
            if ($failed) { $why = "`n" + $failed.stderr.Trim() }
        } catch { $why = '' } # the reason is a help, not a step: without it the pointer below still stands
        throw "The app did not start within 25 seconds.$why`nSee: herdr plugin log list"
    }
    Write-Host ($status | Where-Object { $_ -match '^running ' })
    $origin = [regex]::Match(($status | Where-Object { $_ -match '^running ' } | Select-Object -First 1), '^running (\S+)').Groups[1].Value
    $opened = $false
    if ($newInstall -and $origin -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)' -and
        -not $env:CI -and -not $env:OVIS_NO_OPEN -and -not $env:HERDR_WEB_NO_OPEN -and -not $env:SSH_CONNECTION -and
        [Environment]::UserInteractive) {
        try {
            Start-Process $origin
            $opened = $true
            Write-Host "Ovis: opened $origin in your browser: click Install in the address bar to add the app"
        } catch { }
    }
    if ($newInstall -and -not $opened) {
        if ($env:SSH_CONNECTION) {
            $port = [regex]::Match($origin, ':(\d+)(?:/|$)').Groups[1].Value
            if (-not $port) {
                $scheme = [regex]::Match($origin, '^https?://').Value
                $port = if ($scheme -eq 'https://') { '443' } else { '80' }
            }
            Write-Host "Ovis: from your own computer, run: ssh -L ${port}:127.0.0.1:${port} <this-pc>, then open http://127.0.0.1:${port} and click Install in the address bar"
            Write-Host 'Ovis: Phone setup in herdr shows the Tailscale address when there is one'
        } elseif ($origin -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)') {
            Write-Host "Ovis: open $origin in your browser and click Install in the address bar"
        } else {
            Write-Host "Ovis: open $origin in your browser"
        }
    }
} else { Write-Host 'Ovis: starts with herdr. Open a new terminal and run: herdr' }
Write-Host 'Ovis: open Phone setup in herdr for phone access.'

# One gh api call: gh's exit code and the HTTP status GitHub answered with, or nothing when gh is
# not there or does not answer in 10 seconds. A gh that hangs must not hold up an install that is done:
# the deadline covers its exit and its output both (a child it handed the output to could live on),
# and, when job assignment succeeds, what outlasts it is killed with its children. The job ends with
# the call: a shim's launcher may be gone already, and taskkill /T finds no tree under a PID that exited.
function Invoke-GhApi([string]$Arguments) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { return }
    $job = [IntPtr]::Zero
    try {
        if (-not ('Ovis.GhJob' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace Ovis {
    public static class GhJob {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits {
            public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes {
            public int Length; public IntPtr Descriptor; public int Inherit;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
            ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out int code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
        // A job whose processes are all killed when its last handle closes (KILL_ON_JOB_CLOSE).
        public static IntPtr Create() {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return job;
            ExtendedLimits info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000;
            if (SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) return job;
            CloseHandle(job);
            return IntPtr.Zero;
        }
        public static bool Assign(IntPtr job, IntPtr process) { return AssignProcessToJobObject(job, process); }
        public sealed class GhProcess : IDisposable {
            public IntPtr Handle { get; private set; }
            public int Id { get; private set; }
            public StreamWriter StandardInput { get; private set; }
            public StreamReader StandardOutput { get; private set; }
            public StreamReader StandardError { get; private set; }
            IntPtr thread;
            internal GhProcess(ProcessInfo info, StreamWriter input, StreamReader output, StreamReader error) {
                Handle = info.Process; thread = info.Thread; Id = info.Id;
                StandardInput = input; StandardOutput = output; StandardError = error;
            }
            public void Resume() {
                if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception();
                CloseHandle(thread); thread = IntPtr.Zero;
            }
            public bool WaitForExit(int milliseconds) {
                uint result = WaitForSingleObject(Handle, (uint)milliseconds);
                if (result == uint.MaxValue) throw new Win32Exception();
                return result == 0;
            }
            public int ExitCode {
                get { int code; if (!GetExitCodeProcess(Handle, out code)) throw new Win32Exception(); return code; }
            }
            public void Dispose() {
                // An error before Resume must not strand a suspended process, even without a job.
                if (thread != IntPtr.Zero) { TerminateProcess(Handle, 1); CloseHandle(thread); thread = IntPtr.Zero; }
                StandardInput.Dispose();
                foreach (StreamReader reader in new[] { StandardOutput, StandardError }) {
                    try { reader.Dispose(); } catch (InvalidOperationException) { }
                }
                CloseHandle(Handle); Handle = IntPtr.Zero;
            }
        }
        public static GhProcess StartSuspended(string application, string arguments) {
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero;
            IntPtr outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
            ProcessInfo info = new ProcessInfo();
            StreamWriter input = null; StreamReader output = null, error = null;
            try {
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Inherit = 1;
                if (!CreatePipe(out inputRead, out inputWrite, ref attributes, 0) ||
                    !CreatePipe(out outputRead, out outputWrite, ref attributes, 0) ||
                    !CreatePipe(out errorRead, out errorWrite, ref attributes, 0) ||
                    !SetHandleInformation(inputWrite, 1, 0) ||
                    !SetHandleInformation(outputRead, 1, 0) ||
                    !SetHandleInformation(errorRead, 1, 0)) throw new Win32Exception();
                StartupInfo startup = new StartupInfo();
                startup.Size = Marshal.SizeOf(typeof(StartupInfo)); startup.Flags = 0x100; // STARTF_USESTDHANDLES
                startup.Input = inputRead; startup.Output = outputWrite; startup.Error = errorWrite;
                // CREATE_NO_WINDOW | CREATE_SUSPENDED: assignment happens before any shim code runs.
                if (!CreateProcess(application, new StringBuilder("\"" + application + "\" " + arguments),
                    IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out info))
                    throw new Win32Exception();
                input = new StreamWriter(new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write));
                inputWrite = IntPtr.Zero;
                output = new StreamReader(new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read), Console.OutputEncoding);
                outputRead = IntPtr.Zero;
                error = new StreamReader(new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read), Console.OutputEncoding);
                errorRead = IntPtr.Zero;
                return new GhProcess(info, input, output, error);
            } catch {
                if (info.Process != IntPtr.Zero) { TerminateProcess(info.Process, 1); CloseHandle(info.Process); }
                if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
                if (input != null) input.Dispose();
                if (output != null) output.Dispose();
                if (error != null) error.Dispose();
                throw;
            } finally {
                // Only the child keeps the inherited ends; parent ends now belong to the streams.
                foreach (IntPtr handle in new[] { inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite })
                    if (handle != IntPtr.Zero) CloseHandle(handle);
            }
        }
    }
}
'@
        }
        $job = [Ovis.GhJob]::Create()
    } catch { $job = [IntPtr]::Zero } # taskkill fallback cannot find an orphan after its launcher exits
    $start = New-Object Diagnostics.ProcessStartInfo
    $ghArguments = "api --hostname github.com --include $Arguments"
    if ($gh.Path -match '\.(cmd|bat)$') {
        # a shim: the command interpreter runs it, with the path and the arguments as one quoted command
        $start.FileName = $env:ComSpec
        $start.Arguments = "/d /c """"$($gh.Path)"" $ghArguments"""
    } else {
        $start.FileName = $gh.Path
        $start.Arguments = $ghArguments
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = $null
    try {
        if ($job -ne [IntPtr]::Zero) {
            $process = [Ovis.GhJob]::StartSuspended($start.FileName, $start.Arguments)
            if (-not [Ovis.GhJob]::Assign($job, $process.Handle)) {
                $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
            }
            $process.Resume()
        } else {
            $process = [Diagnostics.Process]::Start($start)
        }
        $process.StandardInput.Close()
        $said = $process.StandardOutput.ReadToEndAsync()
        $null = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000) -or -not $said.Wait(2000)) {
            # closing the job kills gh and every process it started, also one whose parent has exited
            if ($job -ne [IntPtr]::Zero) { $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero }
            try { & $env:ComSpec /d /c "taskkill /T /F /PID $($process.Id) >nul 2>&1" } catch { }
            return
        }
        $status = ''
        if ($said.Result -match '^HTTP\S* (\d{3})') { $status = $Matches[1] }
        @{ code = $process.ExitCode; status = $status }
    } finally {
        # what gh left running after it answered ends here too
        if ($job -ne [IntPtr]::Zero) { $null = [Ovis.GhJob]::CloseHandle($job) }
        if ($process) {
            # Dispose leaves the pipe readers open on .NET Framework; a reader still busy with its
            # ReadToEndAsync may refuse to close, and then the job has ended the writers already
            foreach ($reader in @($process.StandardOutput, $process.StandardError)) { try { $reader.Close() } catch { } }
            $process.Dispose()
        }
    }
}
# A script that runs this has nobody to answer. A terminal can have nobody at it either (an agent's),
# so the answer is read key by key within 20 seconds in all: what was typed before the question is
# discarded, and a line left unfinished when the time is up is no answer.
function Test-Terminal { -not ($env:CI -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) }
function Read-Answer {
    $Host.UI.RawUI.FlushInputBuffer()
    $until = (Get-Date).AddSeconds(20)
    $answer = ''
    while ((Get-Date) -lt $until) {
        if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 100; continue }
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter) { Write-Host ''; return $answer }
        if ($key.Key -eq [ConsoleKey]::Backspace) {
            if ($answer.Length -gt 0) { $answer = $answer.Substring(0, $answer.Length - 1); Write-Host -NoNewline "`b `b" }
        } elseif (-not [char]::IsControl($key.KeyChar)) {
            $answer += $key.KeyChar
            Write-Host -NoNewline $key.KeyChar
        }
    }
    Write-Host ''
    return $null
}
# Once, on the first install, and not to an account that already starred (204). It asks only when
# GitHub says the account has not (404), only at a terminal, and stars only on "y".
if ($newInstall) {
    try {
        $starred = Invoke-GhApi 'user/starred/devswha/ovis'
        if (-not $starred -or $starred.status -ne '204') {
            Write-Host ''
            Write-Host 'Ovis: if it helps you, a GitHub star helps other herdr users find it: https://github.com/devswha/ovis'
            if ($starred -and $starred.status -eq '404' -and (Test-Terminal)) {
                Write-Host -NoNewline 'Ovis: star it now with the GitHub account gh is signed in to? [y/N] '
                $answer = Read-Answer
                if ("$answer".Trim() -match '^(y|yes)$') {
                    $given = Invoke-GhApi '--method PUT user/starred/devswha/ovis'
                    if ($given -and $given.code -eq 0) { Write-Host 'Ovis: starred. Thank you!' }
                    else { Write-Host 'Ovis: gh could not star it; the page above can' }
                }
            }
        }
    } catch { } # the install is done by now: a question that cannot be asked must not fail it
}
}
