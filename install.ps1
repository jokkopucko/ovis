# Native Windows install: irm https://ovis.sh/install.ps1 | iex
# Installs herdr when missing, then the release's compiled server into %LOCALAPPDATA%\ovis: ovis-server.exe and the
# built client, taken only once the release's ovis-server.json carries a valid signature by the key pinned below
# ($releasePublicKey) and each file has the size and SHA-256 it names, linked into herdr as a plugin that runs it.
# No Bun is installed. OVIS_FROM_SOURCE=1, a branch (-Ref / OVIS_REF), a plugin installed from source, or a release
# from before the compiled server install from source instead (Bun, and herdr's plugin checkout).
# OVIS_RELEASES_URL names another place for releases: https://, or a file:// folder laid out as GitHub's.
# Where herdr is not running, it starts herdr's server with no window, and the app with it, in this account's signed-in
# desktop, and has the account's sign-in start it again (Set-SignInStart); -NoService sets up no sign-in start. -Add ends
# the install with `ovis add`, and -Account <id> names the account, so nothing is asked and a script or an agent can run
# it: the installer then fails when the PC was not added. Each also has a variable, for `irm | iex`, which takes no
# arguments: OVIS_ADD=1, OVIS_ADD_ACCOUNT=<id>, OVIS_NO_SERVICE=1, OVIS_HEADLESS=1 (-Headless: with nobody of this account
# signed in at this PC, start herdr without a desktop). Or the PC joins the account with an invite a device signed in to it
# made (one line, ovis-join:1:...), with no sign-in here: -JoinFile <path> (or the line in OVIS_JOIN; -Join <line> too, though
# a command line that holds it shows in the process list) ends the install with `ovis join`, given the line in its
# environment, never on a command line; -Account then names the account the invite must be for, and the installer fails
# unless the PC joined. -Help lists them.
param(
    [string]$Ref = $(if ($env:OVIS_REF) { $env:OVIS_REF } else { $env:HERDR_WEB_UI_REF }),
    [switch]$Add,
    [string]$Account = $env:OVIS_ADD_ACCOUNT,
    [switch]$NoService,
    [switch]$Headless,
    [string]$Join,
    [string]$JoinFile,
    [switch]$Help
)

& {
$ErrorActionPreference = 'Stop'
$usage = 'usage: & ([scriptblock]::Create((irm https://ovis.sh/install.ps1))) [-Add | -JoinFile <path>] [-Account <id>] [-NoService] [-Headless] [-Help]'
if ($Help) {
    Write-Host $usage
    Write-Host @'

Installs Ovis for this Windows account (and herdr where it is missing), and leaves it running.

  -Add               end with `ovis add`: this PC signs in to your Ovis account, at a terminal you answer at
  -Account <id>      your Ovis account's id (ovis status on a PC already in it shows it): the add asks nothing
                     (alone, it means -Add), and a join checks the invite is for that account
  -JoinFile <path>   join your Ovis account with an invite a device signed in to it made: a file holding its one
                     line (ovis-join:1:...). Nothing is signed in to on this PC
  -Join <line>       the same with the line itself: a command line that holds it shows in the process list to
                     every user of this PC, so use -JoinFile or OVIS_JOIN instead
  -NoService         where herdr is not running, start it once and set up no sign-in start
  -Headless          with nobody of this account signed in at this PC, start herdr without a desktop
  -Help              this text

irm https://ovis.sh/install.ps1 | iex passes no arguments: set the variables instead, OVIS_ADD=1,
OVIS_ADD_ACCOUNT=<id>, OVIS_JOIN=<line> (taken out of this session once read), OVIS_NO_SERVICE=1,
OVIS_HEADLESS=1, OVIS_REF=<branch or tag>. More: https://github.com/devswha/ovis/blob/main/INSTALL.md
'@
    return
}
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Ovis supports Windows x64. Use install.sh on Linux or macOS.'
}
# before anything is installed: a misspelt account must not install without the add it asked for. The shape is the one
# `ovis add --account` takes (scripts/plugin-link.ts, ACCOUNT_SHAPE), never starting with '-', as install.sh refuses it
if ($Account -and $Account -cnotmatch '^(?!-)[A-Za-z0-9_-]{1,64}\z') {
    throw "-Account (or OVIS_ADD_ACCOUNT) takes your Ovis account's id: ovis status on a PC already in it shows it. $usage"
}
# Whether someone can answer at this console: a script's or an agent's run has its input or output redirected, or CI set
function Test-Terminal { -not ($env:CI -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) }
# An invite's line (-JoinFile, -Join, or OVIS_JOIN where neither is given), as install.sh reads it: trimmed as `ovis join`
# trims it, and refused before anything is installed unless it has a join line's shape (shared/account-list-join.ts: its
# prefix, then base64url, at most 1024 characters). Never printed, nor a path that may be the line put where a path goes:
# it holds the invite's key. Once the line passes, OVIS_JOIN leaves this session, so nothing the installer starts (herdr,
# and every terminal in it) is given it; a run refused here leaves it for the run that follows.
$joinGiven = ''
$joinLine = ''
$joinPath = ''
$noFile = "-JoinFile names no file you can read (a file holding the invite's line). Nothing was installed. $usage"
if ($Join -and $JoinFile) { throw "Give the invite one way only: -JoinFile <path>, OVIS_JOIN, or -Join <line>. $usage" }
if ($JoinFile) { $joinGiven = 'file' }
elseif ($Join) { $joinGiven = 'argument'; $joinLine = $Join }
elseif ($env:OVIS_JOIN) { $joinGiven = 'env'; $joinLine = $env:OVIS_JOIN }
if ($joinGiven -and ($Add -or $env:OVIS_ADD -eq '1')) { throw "A join adds this PC with an invite, and -Add (OVIS_ADD=1) with a sign-in: give one of them. $usage" }
if ($joinGiven -eq 'file') {
    $joinPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($JoinFile)
    $joinItem = Get-Item -LiteralPath $joinPath -Force -ErrorAction SilentlyContinue
    if (-not $joinItem -or $joinItem.PSIsContainer) { throw $noFile }
    # read whole only when it can be a line: anything longer is refused below as no invite
    try { $joinLine = if ($joinItem.Length -gt 4096) { 'not a line' } else { [IO.File]::ReadAllText($joinPath) } } catch { throw $noFile }
}
if ($joinGiven) {
    $joinLine = @("$joinLine" -split "`n" | ForEach-Object { $_.Trim([char[]]" `t`r") } | Where-Object { $_ }) -join "`n"
    if ($joinLine.Length -gt 1024 -or $joinLine -cnotmatch '^ovis-join:1:[A-Za-z0-9_-]+\z') {
        throw "That is not an Ovis invite: an invite is one line that starts with ovis-join:1:, made on a device signed in to your account. Nothing was installed. $usage"
    }
    # with no account named, the person at this terminal confirms the invite's account: where nobody can answer, the join
    # is refused now, not after the install
    if (-not $Account -and (-not (Test-Terminal) -or $env:OVIS_NO_OPEN -or $env:HERDR_WEB_NO_OPEN)) {
        throw "A join where nobody can answer needs the account the invite is for: add -Account <id> (the id shown with the invite, or ovis status --json on a PC already in it; OVIS_ADD_ACCOUNT=<id> for irm | iex). Nothing was installed. $usage"
    }
}
Remove-Item Env:\OVIS_JOIN -ErrorAction SilentlyContinue
# the account named is the add asked for, or with an invite, the account the invite must be for
$addAccount = $Account
$wantAdd = $Add -or $env:OVIS_ADD -eq '1' -or ([bool]$addAccount -and -not $joinGiven)
$skipService = $NoService -or $env:OVIS_NO_SERVICE -eq '1'
$allowHeadless = $Headless -or $env:OVIS_HEADLESS -eq '1'
# what the add step needs, set by whichever install below runs: the Ovis command line, whether it runs now, the command a
# person types for it, and whether the add of the release that runs checks --account and reads answers safely
$ovisCli = $null
$ovisRunning = $false
$ovisCommand = ''
$addCommand = ''
$takesAccount = $false
$readsAnswers = $false
$takesJoin = $false

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

# The official installers keep these user-local directories on PATH for future terminals. Put first once: a rerun in
# the same session that prepended them again would grow PATH each time, and past 8191 characters cmd.exe (gh's .cmd
# shims, herdr's installer) fails without a word.
$userBins = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin"
if (-not "$env:PATH;".StartsWith("$userBins;")) { $env:PATH = "$userBins;$env:PATH" }
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

$pluginId = 'devswha.ovis'
$legacyId = 'devswha.herdr-web-ui'
function Find-Plugin([string]$Id = $pluginId) {
    (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins |
        Where-Object { $_.plugin_id -eq $Id } | Select-Object -First 1
}
function Get-LatestRef {
    $latest = Run-Tool git @('ls-remote', '--tags', '--refs', 'https://github.com/devswha/ovis.git', 'v*') |
        ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
        Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
    if (-not $latest) { throw 'Could not find the latest app release on GitHub. Check your connection and run this again.' }
    $latest
}

# The release's compiled server: %LOCALAPPDATA%\ovis\bin is the release that runs (ovis-server.exe, dist\, and the
# manifest and signature it was checked against), and plugin\ is the herdr plugin that runs it.
$ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
# The public half of the key every release's ovis-server.json is signed with: scripts/server-manifest.ts
# RELEASE_PUBLIC_KEY, which the release jobs check against too. Nothing else can stand in for it.
$releasePublicKey = 'C8+dOD0gpFHoy008ZqHO89vXutaLqlt5uWyIh250OiY='

# Ed25519 verification (RFC 8032, section 5.1.7), which neither Windows PowerShell nor .NET has built in: compiled
# once with Add-Type. It is used only after it accepts RFC 8032's test vector 2 and refuses that signature over
# another message (Test-Ed25519), as install.sh does with the checker it finds.
function Initialize-Ed25519 {
    if ('Ovis.Ed25519' -as [type]) { return }
    $source = @'
using System;
using System.Numerics;
using System.Security.Cryptography;
namespace Ovis {
    public static class Ed25519 {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        static readonly BigInteger Q = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
        static readonly BigInteger D = Mod(-121665 * Inv(121666));
        static readonly BigInteger I = BigInteger.ModPow(2, (P - 1) / 4, P);
        static BigInteger Mod(BigInteger x) { BigInteger r = x % P; return r.Sign < 0 ? r + P : r; }
        static BigInteger Inv(BigInteger x) { return BigInteger.ModPow(Mod(x), P - 2, P); }
        // a little-endian unsigned number: the extra zero byte keeps BigInteger from reading it as negative
        static BigInteger Number(byte[] bytes, int offset, int length) {
            byte[] copy = new byte[length + 1];
            Array.Copy(bytes, offset, copy, 0, length);
            return new BigInteger(copy);
        }
        static BigInteger[] Add(BigInteger[] a, BigInteger[] b) {
            BigInteger A = Mod((a[1] - a[0]) * (b[1] - b[0])), B = Mod((a[1] + a[0]) * (b[1] + b[0]));
            BigInteger C = Mod(2 * a[3] * b[3] * D), E = Mod(2 * a[2] * b[2]);
            BigInteger F = B - A, G = E - C, H = E + C, K = B + A;
            return new BigInteger[] { Mod(F * G), Mod(H * K), Mod(G * H), Mod(F * K) };
        }
        static BigInteger[] Multiply(BigInteger s, BigInteger[] point) {
            BigInteger[] result = { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
            while (s > 0) {
                if (!s.IsEven) result = Add(result, point);
                point = Add(point, point);
                s >>= 1;
            }
            return result;
        }
        static BigInteger[] Decode(byte[] bytes, int offset) {
            byte[] copy = new byte[32];
            Array.Copy(bytes, offset, copy, 0, 32);
            int sign = copy[31] >> 7;
            copy[31] &= 0x7f;
            BigInteger y = Number(copy, 0, 32);
            if (y >= P) return null;
            BigInteger y2 = Mod(y * y), x2 = Mod((y2 - 1) * Inv(D * y2 + 1));
            if (x2.IsZero) return sign == 1 ? null : new BigInteger[] { BigInteger.Zero, y, BigInteger.One, BigInteger.Zero };
            BigInteger x = BigInteger.ModPow(x2, (P + 3) / 8, P);
            if (!Mod(x * x - x2).IsZero) x = Mod(x * I);
            if (!Mod(x * x - x2).IsZero) return null;
            if ((x.IsEven ? 0 : 1) != sign) x = P - x;
            return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
        }
        public static bool Verify(byte[] publicKey, byte[] message, byte[] signature) {
            if (publicKey == null || message == null || signature == null || publicKey.Length != 32 || signature.Length != 64) return false;
            BigInteger[] a = Decode(publicKey, 0), r = Decode(signature, 0);
            if (a == null || r == null) return false;
            BigInteger s = Number(signature, 32, 32);
            if (s >= Q) return false;
            byte[] encodedBase = new byte[32];
            encodedBase[0] = 0x58;
            for (int i = 1; i < 32; i++) encodedBase[i] = 0x66;
            byte[] input = new byte[64 + message.Length];
            Array.Copy(signature, 0, input, 0, 32);
            Array.Copy(publicKey, 0, input, 32, 32);
            Array.Copy(message, 0, input, 64, message.Length);
            byte[] hash;
            using (SHA512 sha = SHA512.Create()) { hash = sha.ComputeHash(input); }
            BigInteger k = Number(hash, 0, 64) % Q;
            BigInteger[] left = Multiply(s, Decode(encodedBase, 0)), right = Add(r, Multiply(k, a));
            return Mod(left[0] * right[2] - right[0] * left[2]).IsZero && Mod(left[1] * right[2] - right[1] * left[2]).IsZero;
        }
    }
}
'@
    try { Add-Type -TypeDefinition $source -ReferencedAssemblies System.Numerics }
    catch { Add-Type -TypeDefinition $source }
}
function Test-Ed25519([byte[]]$PublicKey, [byte[]]$Message, [byte[]]$Signature) {
    Initialize-Ed25519
    $vectorKey = [Convert]::FromBase64String('PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=')
    $vectorSignature = [Convert]::FromBase64String('kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==')
    if (-not [Ovis.Ed25519]::Verify($vectorKey, [byte[]](0x72), $vectorSignature) -or [Ovis.Ed25519]::Verify($vectorKey, [byte[]](0x73), $vectorSignature)) {
        throw 'the signature check does not work in this PowerShell'
    }
    [Ovis.Ed25519]::Verify($PublicKey, $Message, $Signature)
}

# Where releases come from: OVIS_RELEASES_URL (https://, or a file:// folder for tests), else GitHub's downloads.
function Get-ReleasesBase {
    $base = if ($env:OVIS_RELEASES_URL) { $env:OVIS_RELEASES_URL.TrimEnd('/') } else { 'https://github.com/devswha/ovis/releases/download' }
    if ($base -notmatch '^https://[^/]' -and $base -notmatch '^file:///') {
        throw "OVIS_RELEASES_URL must be an https:// address or a file:// folder (file:///C:/path); $base is neither"
    }
    $base
}
# The file at $Url into $Path, refused past $Limit bytes and on a redirect off https; $false where there is none.
function Save-ReleaseFile([string]$Url, [string]$Path, [long]$Limit, [string]$Name) {
    $tooLarge = "$Name is larger than the $Limit bytes ovis-server.json names"
    if ($Url -like 'file://*') {
        $source = ([Uri]$Url).LocalPath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $source).Length -gt $Limit) { throw $tooLarge }
        Copy-Item -LiteralPath $source -Destination $Path
        return $true
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.UserAgent = 'ovis-install'
    try { $response = $request.GetResponse() }
    catch {
        $failure = $_.Exception
        while ($failure -and -not ($failure -is [Net.WebException])) { $failure = $failure.InnerException }
        if ($failure -and $failure.Response -and [int]$failure.Response.StatusCode -eq 404) { return $false }
        throw "could not download $Url ($($_.Exception.Message))"
    }
    try {
        if ($response.ResponseUri.Scheme -ne 'https') { throw "$Url redirected to $($response.ResponseUri), which is not https" }
        $stream = $response.GetResponseStream()
        $file = [IO.File]::Create($Path)
        try {
            $buffer = New-Object byte[] 65536
            $total = 0
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read
                if ($total -gt $Limit) { throw $tooLarge }
                $file.Write($buffer, 0, $read)
            }
        } finally { $file.Dispose() }
    } finally { $response.Close() }
    $true
}
# The release's file $Name into $Path, kept only with the name, size and SHA-256 the checked manifest's $Entry gives it
function Save-CheckedFile([string]$At, $Entry, [string]$Name, [string]$Path) {
    if (-not $Entry -or $Entry.file -cne $Name -or "$($Entry.sha256)" -cnotmatch '^[0-9a-f]{64}$' -or -not ($Entry.size -is [int] -or $Entry.size -is [long])) {
        throw "ovis-server.json names no $Name with its SHA-256 and size"
    }
    if (-not (Save-ReleaseFile "$At/$Name" $Path ([long]$Entry.size) $Name)) { throw "$At/$Name does not exist" }
    $size = (Get-Item -LiteralPath $Path).Length
    if ($size -ne $Entry.size) { throw "$Name is $size bytes, not the $($Entry.size) ovis-server.json names" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($hash -ne $Entry.sha256) { throw "$Name does not match its SHA-256 in ovis-server.json (got $hash)" }
}
# The client archive into $Into, after its listing shows only plain files and folders inside it
function Expand-Client([string]$Archive, [string]$Into) {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar' }
    $names = @(& $tar -tzf $Archive)
    if ($LASTEXITCODE -ne 0) { throw 'could not read ovis-dist.tar.gz' }
    foreach ($name in $names) {
        if ($name -match '^([/\\]|[A-Za-z]:)' -or ($name -split '[/\\]') -contains '..') { throw "ovis-dist.tar.gz holds $name, a path outside its folder" }
    }
    foreach ($line in @(& $tar -tzvf $Archive)) {
        if ($line -and $line -notmatch '^[-d]') { throw 'ovis-dist.tar.gz holds something other than files and folders' }
    }
    New-Item -ItemType Directory -Path $Into | Out-Null
    & $tar -xzf $Archive -C $Into
    if ($LASTEXITCODE -ne 0) { throw 'could not unpack ovis-dist.tar.gz' }
    if (Get-ChildItem -LiteralPath $Into -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'ovis-dist.tar.gz unpacked a link' }
    if (-not (Test-Path -LiteralPath (Join-Path $Into 'index.html'))) { throw 'ovis-dist.tar.gz holds no index.html' }
}
# One install at a time in $ovisHome: .install.lock, a folder whose pid file, created only where none is, holds this
# process's id.
# With three or more installs started at the same instant a narrow race remains (a follow-up).
function Enter-InstallLock([string]$Lock, [int]$WaitSeconds = 600) {
    $breaker = "$Lock.break"
    $waited = 0
    while ($true) {
        # the claim is the pid file, created only where none is (New-Item makes a folder that is there already no
        # error to every caller at once): the folder alone does not exclude
        New-Item -ItemType Directory -Force -Path $Lock -ErrorAction SilentlyContinue | Out-Null
        if (New-ExclusiveFile (Join-Path $Lock 'pid') "$PID") { break }
        $broke = $false
        if (New-ExclusiveFile $breaker "$PID") {
            try {
                $holder = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
                $stale = if ($holder -match '^\d+$') { -not (Get-Process -Id ([int]$holder) -ErrorAction SilentlyContinue) }
                    else { ((Get-Date) - (Get-Item -LiteralPath $Lock -ErrorAction SilentlyContinue).LastWriteTime).TotalSeconds -gt 60 }
                # removed only while it still holds the record judged stale: a fresh holder's lock is never taken
                $now = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($stale -and "$now" -eq "$holder") { Remove-Item -LiteralPath $Lock -Recurse -Force -ErrorAction SilentlyContinue; $broke = $true }
            } finally { Remove-Item -LiteralPath $breaker -Recurse -Force -ErrorAction SilentlyContinue }
        } elseif (((Get-Date) - (Get-Item -LiteralPath $breaker -ErrorAction SilentlyContinue).LastWriteTime).TotalSeconds -gt 60) {
            Remove-Item -LiteralPath $breaker -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($broke) { continue }
        if ($waited -ge $WaitSeconds) {
            $holder = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
            throw "another install is running in $ovisHome (pid $holder); run this again once it ends. Nothing was changed"
        }
        if ($waited -eq 0) { Write-Host "Ovis: another install is running in $ovisHome; waiting for it" }
        Start-Sleep -Seconds 1
        $waited++
    }
}
# Creates $Path holding $Text only where no file is (CreateNew, one winner); $false when one is there, or it cannot
function New-ExclusiveFile([string]$Path, [string]$Text) {
    try { $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write) } catch { return $false }
    try { $bytes = [Text.Encoding]::ASCII.GetBytes("$Text`r`n"); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
    return $true
}
function Exit-InstallLock([string]$Lock) {
    $holder = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
    if ("$holder" -eq "$PID") { Remove-Item -LiteralPath $Lock -Recurse -Force -ErrorAction SilentlyContinue }
}
function Install-OvisBinary([string]$Version) {
    New-Item -ItemType Directory -Force -Path $ovisHome | Out-Null
    $lock = Join-Path $ovisHome '.install.lock'
    Enter-InstallLock $lock
    try { Install-OvisBinaryLocked $Version } finally { Exit-InstallLock $lock }
}
# Nothing in bin changes before the manifest's signature (by $releasePublicKey), its version, and the size and
# SHA-256 of the binary and the client archive have been checked, except that a missing bin is first taken back
# from the newest bin.old-* a stopped run left; then the old bin is moved aside and the checked release moved in.
function Install-OvisBinaryLocked([string]$Version) {
    $at = "$(Get-ReleasesBase)/v$Version"
    $bin = Join-Path $ovisHome 'bin'
    $releases = Join-Path $ovisHome 'releases'
    New-Item -ItemType Directory -Force -Path $releases | Out-Null
    if (-not (Test-Path -LiteralPath $bin)) {
        $aside = Get-ChildItem -LiteralPath $ovisHome -Directory -Filter 'bin.old-*' | Sort-Object Name | Select-Object -Last 1
        if ($aside) { Rename-Item -LiteralPath $aside.FullName -NewName 'bin' }
    }
    Get-ChildItem -LiteralPath $releases -Directory -Force -Filter '.stage-*' | Remove-Item -Recurse -Force
    $exe = Join-Path $bin 'ovis-server.exe'
    try {
        $running = Get-Content -Raw -LiteralPath (Join-Path $bin 'ovis-server.json') | ConvertFrom-Json
        if ($running.version -eq $Version -and (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -eq $running.assets.'windows-x64'.sha256 -and (Test-Path -LiteralPath (Join-Path $bin 'dist\index.html'))) {
            Write-Host "Ovis: Ovis $Version is installed already in $ovisHome; nothing to do"
            return $false
        }
    } catch { }
    $stage = Join-Path $releases ('.stage-' + [IO.Path]::GetRandomFileName().Replace('.', ''))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $manifestFile = Join-Path $stage 'ovis-server.json'
        $signatureFile = Join-Path $stage 'ovis-server.json.sig'
        if (-not (Save-ReleaseFile "$at/ovis-server.json" $manifestFile 65536 'ovis-server.json')) { throw "$at/ovis-server.json does not exist" }
        if (-not (Save-ReleaseFile "$at/ovis-server.json.sig" $signatureFile 1024 'ovis-server.json.sig')) { throw "$at/ovis-server.json.sig does not exist" }
        $signature = [IO.File]::ReadAllText($signatureFile)
        if ($signature -cnotmatch '^[A-Za-z0-9+/]{86}==\n$') { throw 'ovis-server.json.sig is not one line of base64 holding a signature' }
        if (-not (Test-Ed25519 ([Convert]::FromBase64String($releasePublicKey)) ([IO.File]::ReadAllBytes($manifestFile)) ([Convert]::FromBase64String($signature.TrimEnd("`n"))))) {
            throw "ovis-server.json.sig is not a valid signature of the release's ovis-server.json by the key $releasePublicKey"
        }
        $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
        if ($manifest.version -cne $Version) { throw "ovis-server.json is for version $($manifest.version), not $Version" }
        if ($manifest.schema -ne 1) { throw 'ovis-server.json is of a schema this installer does not know; a newer install.ps1 reads it' }
        Save-CheckedFile $at $manifest.assets.'windows-x64' 'ovis-server-windows-x64.exe' (Join-Path $stage 'ovis-server.exe')
        $archive = Join-Path $stage 'ovis-dist.tar.gz'
        Save-CheckedFile $at $manifest.dist 'ovis-dist.tar.gz' $archive
        Expand-Client $archive (Join-Path $stage 'dist')
        Remove-Item -LiteralPath $archive
        # checked: the server the old release runs is stopped, since Windows keeps a running program's folder in place
        if (Test-Path -LiteralPath $exe) { try { & $exe plugin stop *> $null } catch { } }
        $aside = 'bin.old-' + [IO.Path]::GetRandomFileName().Replace('.', '')
        if (Test-Path -LiteralPath $bin) { Rename-Item -LiteralPath $bin -NewName $aside }
        try { Move-Item -LiteralPath $stage -Destination $bin }
        catch {
            if (Test-Path -LiteralPath (Join-Path $ovisHome $aside)) { Rename-Item -LiteralPath (Join-Path $ovisHome $aside) -NewName 'bin' }
            throw
        }
        Remove-Item -LiteralPath (Join-Path $ovisHome $aside) -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw "$($_.Exception.Message); nothing was changed"
    }
    Write-Host "Ovis: installed Ovis $Version (ovis-server-windows-x64.exe, checked against the signed ovis-server.json) in $ovisHome"
    $true
}
# The plugin herdr links for the binary: run.ps1 hands each command to bin\ovis-server.exe, a start in a hidden
# console of its own, as scripts/plugin.ps1 does, so PowerShell's pipes stay out of the detached server
function Write-OvisPlugin([string]$Version) {
    $dir = Join-Path $ovisHome 'plugin'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $run = @'
# herdr's way into the Ovis that install.ps1 installed: the release's server, as `ovis-server plugin <command>`
param([string]$Command = 'status', [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\bin\ovis-server.exe'
if ($Command -eq 'start') {
    $child = Start-Process -FilePath $exe -ArgumentList 'plugin', 'start' -WindowStyle Hidden -PassThru
    $null = $child.Handle
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) {
        $log = Join-Path $env:HERDR_PLUGIN_STATE_DIR 'server.log'
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 15) -join "`n" } else { '(no log)' }
        throw "Could not start Ovis. $log ends with:`n$tail"
    }
    Write-Output 'Ovis started'
    exit 0
}
& $exe plugin $Command @Rest
exit $LASTEXITCODE
'@
    $command = '"powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "run.ps1"'
    $manifest = @"
id = "$pluginId"
name = "Ovis"
version = "$Version"
min_herdr_version = "0.9.0"
description = "Ovis, the browser and phone client for herdr, installed by install.ps1 as the release's compiled server"
platforms = ["windows"]

[[startup]]
command = [$command, "start"]

[[actions]]
id = "start-windows"
title = "Start Ovis"
contexts = ["workspace"]
command = [$command, "start"]

[[actions]]
id = "stop-windows"
title = "Stop Ovis"
contexts = ["workspace"]
command = [$command, "stop"]

[[actions]]
id = "status-windows"
title = "Ovis status"
contexts = ["workspace"]
command = [$command, "status"]

[[panes]]
id = "phone-windows"
title = "Phone setup"
placement = "zoomed"
command = [$command, "phone-setup"]

[[actions]]
id = "phone-windows"
title = "Phone setup"
contexts = ["workspace"]
command = ["herdr", "plugin", "pane", "open", "--plugin", "$pluginId", "--entrypoint", "phone-windows", "--placement", "zoomed", "--focus"]
"@
    Set-Content -LiteralPath (Join-Path $dir 'run.ps1.new') -Value $run -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $dir 'herdr-plugin.toml.new') -Value $manifest -Encoding UTF8
    Move-Item -Force -LiteralPath (Join-Path $dir 'run.ps1.new') -Destination (Join-Path $dir 'run.ps1')
    Move-Item -Force -LiteralPath (Join-Path $dir 'herdr-plugin.toml.new') -Destination (Join-Path $dir 'herdr-plugin.toml')
}

# herdr's start at this account's sign-in, Windows' counterpart of the LaunchAgent install.sh sets up on a Mac: the value
# Ovis under HKCU's Run key, the one the Ovis app sets (app/windows/src/LoginItem.cs), so there is one start whichever of
# the two wrote it. It needs no administrator, runs inside the signed-in desktop, so herdr's terminals have it, and shows
# in Task Manager's Startup apps, where it can be turned off. Ours runs start-herdr.ps1 (Write-HerdrLauncher) in a hidden
# Windows PowerShell; the app's runs Ovis.exe --start, which does the same with no console, and is left as it is.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$signInName = 'Ovis'
$herdrLauncher = Join-Path $ovisHome 'start-herdr.ps1'
$windowsPowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
# how long a herdr just started has to answer
$herdrWaitSeconds = 20
function Get-LauncherArguments { "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$herdrLauncher`"" }
# The launcher the sign-in start and Start-HerdrInDesktop run, written again wherever the installer starts herdr or keeps
# its own sign-in start, so it names the herdr found now (read again by name when that one is gone). It starts herdr only while herdr lists Ovis's plugin and no herdr server
# runs, as Ovis.exe --start does, and never stops one. With a byte order mark, so Windows PowerShell reads a user folder
# outside ASCII as it is.
function Write-HerdrLauncher([string]$Herdr) {
    New-Item -ItemType Directory -Force -Path $ovisHome | Out-Null
    $text = @'
# herdr's server with no window, written by install.ps1 (and again on every run): run at this account's sign-in by the
# value Ovis under HKCU\Software\Microsoft\Windows\CurrentVersion\Run, and by the installer to start herdr. It starts herdr
# only while herdr lists Ovis's plugin and no herdr server runs, and never stops one.
$herdr = '__HERDR__'
if (-not (Test-Path -LiteralPath $herdr)) { $herdr = (Get-Command herdr -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
if (-not $herdr) { exit 0 }
$plugins = try { @((& $herdr plugin list --json | ConvertFrom-Json).result.plugins) } catch { @() }
if (-not ($plugins | Where-Object { $_.plugin_id -in 'devswha.ovis', 'devswha.herdr-web-ui' })) { exit 0 }
$running = try { (& $herdr status server --json | ConvertFrom-Json).running } catch { $false }
if ($running) { exit 0 }
Start-Process -FilePath $herdr -ArgumentList 'server' -WindowStyle Hidden -WorkingDirectory $HOME
'@.Replace('__HERDR__', [Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($Herdr))
    $staged = "$herdrLauncher.new"
    [IO.File]::WriteAllText($staged, $text.Replace("`r`n", "`n").Replace("`n", "`r`n"), (New-Object Text.UTF8Encoding $true))
    Move-Item -Force -LiteralPath $staged -Destination $herdrLauncher
}
# What the value Ovis under the Run key is: 'ours' (it runs our launcher), 'app' (the Ovis app's), 'other' (anything else,
# never touched), or 'none'
function Get-SignInStart {
    $value = (Get-ItemProperty -Path $runKey -Name $signInName -ErrorAction SilentlyContinue).$signInName
    if ($null -eq $value) { return 'none' }
    if ("$value" -match '(?i)[\\/]powershell\.exe" .*-File "[^"]*[\\/]ovis[\\/]start-herdr\.ps1"$') { return 'ours' }
    if ("$value" -match '(?i)\\Ovis\.exe"? --start$') { return 'app' }
    'other'
}
# The sign-in start, ours unless one is there already: 'ours', 'app' or 'other' (left as they are), or 'failed'
function Set-SignInStart([string]$Herdr) {
    $kind = Get-SignInStart
    if ($kind -in 'app', 'other') { return $kind }
    try {
        Write-HerdrLauncher $Herdr
        # every profile has the key; one made without it is given it
        if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
        Set-ItemProperty -Path $runKey -Name $signInName -Value "`"$windowsPowerShell`" $(Get-LauncherArguments)" -ErrorAction Stop
        'ours'
    } catch {
        Write-Host "Ovis: could not set herdr to start at your sign-in: $($_.Exception.Message)"
        'failed'
    }
}
# -NoService: the sign-in start an earlier run wrote goes ('removed'), never stopping herdr; the Ovis app's ('app') and
# anyone else's ('other') stay, as install.sh leaves a Mac's LaunchAgent, which the Mac app shares
function Clear-SignInStart {
    $kind = Get-SignInStart
    if ($kind -ne 'ours') { return $kind }
    Remove-ItemProperty -Path $runKey -Name $signInName -ErrorAction SilentlyContinue
    'removed'
}
function Test-HerdrRunning {
    try { [bool](Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json).running } catch { $false }
}
function Wait-Herdr {
    for ($second = 0; $second -lt $herdrWaitSeconds; $second++) {
        if (Test-HerdrRunning) { return $true }
        Start-Sleep -Seconds 1
    }
    Test-HerdrRunning
}
# Whether this process runs in a desktop session: an SSH or remoting session, as a service, runs in session 0
function Test-DesktopSession { [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0 }
# Where herdr can start for this account: 'desktop' where it is signed in at this PC (this process runs in its desktop
# session, or a process of its own runs in one: a locked desktop counts), else 'none' (nobody of it signed in). The
# shell, explorer, is asked first, so mostly one owner is read.
function Get-HerdrStartPlace {
    if (Test-DesktopSession) { return 'desktop' }
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $desktop = @(Get-CimInstance Win32_Process -Filter 'SessionId <> 0' -ErrorAction SilentlyContinue)
    foreach ($process in @($desktop | Where-Object { $_.Name -eq 'explorer.exe' }) + @($desktop | Where-Object { $_.Name -ne 'explorer.exe' })) {
        if ($process.SessionId -eq 0) { continue }
        if ("$((Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid)" -eq $me) { return 'desktop' }
    }
    'none'
}
# herdr in this account's signed-in desktop session, out of this process's tree and of any job it is in (an SSH session
# ends its processes with it, and an agent's tool may end what its command started): a task of this account's, with its
# ordinary rights and its interactive token (no password kept), runs the launcher once and is removed, as Ovis's SSH setup
# starts herdr (server/windows-herdr-start.ts); removing it leaves what it started running. 'started', 'refused' (Task
# Scheduler did not take or start it, so nothing ran) or 'silent' (herdr did not answer).
function Start-HerdrInDesktop([string]$Herdr) {
    $task = 'Ovis herdr start ' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    try {
        Write-HerdrLauncher $Herdr
        $action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument (Get-LauncherArguments)
        # by SID, which every account has, as server/windows-herdr-start.ts registers its task; Priority 4 is normal (a
        # task's default, 7, would run herdr and all it starts below normal)
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 4
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "Ovis: Task Scheduler did not take the task that starts herdr: $($_.Exception.Message)"
        return 'refused'
    }
    try {
        try { $null = Start-ScheduledTask -TaskName $task -ErrorAction Stop }
        catch {
            Write-Host "Ovis: Task Scheduler did not start herdr: $($_.Exception.Message)"
            return 'refused'
        }
        if (Wait-Herdr) { 'started' } else { 'silent' }
    } finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
}
# herdr started by this process, where Task Scheduler takes no task and this process runs in the desktop itself
function Start-HerdrHere([string]$Herdr) {
    Start-Process -FilePath $Herdr -ArgumentList 'server' -WindowStyle Hidden -WorkingDirectory $HOME
    Wait-Herdr
}
# -Headless, with nobody of this account signed in: herdr through WMI, outside the session's job, in no desktop, as Ovis's
# SSH setup starts it on a "Start without Windows sign-in" (server/windows-herdr-start.ts), with this run's environment
function Start-HerdrHeadless([string]$Herdr) {
    $environment = [string[]]@(Get-ChildItem Env: | Where-Object { $_.Name -notmatch '[=\r\n\0]' -and "$($_.Value)" -notmatch '[\r\n\0]' } | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $environment }
    $made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$Herdr`" server"; CurrentDirectory = $HOME; ProcessStartupInformation = $startup }
    if ($made.ReturnValue -ne 0) {
        Write-Host "Ovis: Windows did not start herdr (Win32_Process.Create answered $($made.ReturnValue))"
        return $false
    }
    Wait-Herdr
}
# herdr, running for Ovis, as install.sh leaves it on Linux and macOS (INSTALL.md, method C): a herdr that runs is left as
# it is (-NoService takes away only the sign-in start an earlier run wrote). Where none runs, the sign-in start is set up
# (none with -NoService), and herdr's server is started with no window in this account's desktop, or with nobody signed
# in, given -Headless, without one; the plugin's startup hook then starts Ovis. Started: '' (herdr ran already), 'desktop',
# 'headless', 'nobody' (not started: nobody signed in) or 'failed'. SignIn: what Get-SignInStart, Set-SignInStart or
# Clear-SignInStart said. Wait: how long Ovis has to answer.
function Start-HerdrForOvis {
    $result = @{ Running = $false; Started = ''; SignIn = ''; Wait = 25 }
    $herdr = (Get-Command herdr -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $herdr) { $herdr = 'herdr' }
    if (Test-HerdrRunning) {
        $result.Running = $true
        $result.SignIn = if ($skipService) { Clear-SignInStart } else { Get-SignInStart }
        # the sign-in start that is ours runs this installer's launcher, not the one an earlier installer wrote
        if ($result.SignIn -eq 'ours') {
            try { Write-HerdrLauncher $herdr } catch { Write-Host "Ovis: could not write $herdrLauncher, which herdr's sign-in start runs: $($_.Exception.Message)" }
        }
        return $result
    }
    $result.SignIn = if ($skipService) { Clear-SignInStart } else { Set-SignInStart $herdr }
    $place = Get-HerdrStartPlace
    $result.Started = if ($place -eq 'desktop') {
            $task = Start-HerdrInDesktop $herdr
            if ($task -eq 'started' -or ($task -eq 'refused' -and (Test-DesktopSession) -and (Start-HerdrHere $herdr))) { 'desktop' } else { 'failed' }
        }
        elseif ($allowHeadless) { if (Start-HerdrHeadless $herdr) { 'headless' } else { 'failed' } }
        else { 'nobody' }
    $result.Running = $result.Started -in 'desktop', 'headless'
    $result.Wait = 60
    $result
}
# What runs now and what starts herdr again, as install.sh's closing lines say it; $Ovis is the command that runs Ovis
function Write-HerdrLines($Herdr, [string]$Ovis) {
    $signIn = switch ($Herdr.SignIn) {
        'ours' { 'it starts at your sign-in (Ovis in Task Manager''s Startup apps)' }
        'app' { 'the Ovis app starts it at your sign-in' }
        default { '' }
    }
    $leftOther = "a Run value named Ovis that is not Ovis's own is there, so nothing else was set to start herdr at your sign-in"
    switch ($Herdr.Started) {
        'desktop' {
            if ($signIn) { Write-Host "Ovis: herdr was started in your desktop for Ovis, and $signIn" }
            elseif ($skipService) { Write-Host 'Ovis: herdr was started in your desktop for now, with no sign-in start (-NoService): after a restart herdr starts when you open it' }
            else { Write-Host 'Ovis: herdr was started in your desktop for now' }
        }
        'headless' {
            Write-Host "Ovis: herdr was started without a desktop (-Headless; nobody of this account is signed in at this PC), until this PC restarts: programs in its terminals cannot use the desktop, and Codex commands that need their sandbox's own desktop can fail there. Signing in later does not move it into your desktop$(if ($signIn) { "; after a restart, $signIn" })"
        }
        'nobody' {
            Write-Host "Ovis: nobody of this account is signed in at this PC, so herdr was not started, nor the app with it$(if ($signIn) { "; $signIn" })"
            Write-Host 'Ovis: to start it now without a desktop, run this again with -Headless (OVIS_HEADLESS=1): programs in its terminals then cannot use the desktop, and Codex commands that need their sandbox''s own desktop can fail there'
        }
        'failed' { Write-Host "Ovis: herdr did not start, so neither did the app; to see why, run: herdr server" }
    }
    if ($Herdr.SignIn -eq 'other') { Write-Host "Ovis: $leftOther" }
    if ($Herdr.SignIn -eq 'removed') { Write-Host 'Ovis: removed the sign-in start an earlier run set up, as -NoService asks: nothing starts herdr at your sign-in now; herdr runs on until you stop it' }
    if ($skipService -and $Herdr.SignIn -eq 'app') { Write-Host "Ovis: the Ovis app's sign-in start is still there and starts herdr at your sign-in: -NoService leaves it, since the app sets up the same one. To have none: Remove-ItemProperty -Path '$runKey' -Name $signInName" }
    if ($Herdr.Running) {
        Write-Host "Ovis: see them: $Ovis status, herdr status server. Stop Ovis: $Ovis stop (it starts again with herdr). Stop herdr and every terminal in it: herdr server stop"
    }
    if ($Herdr.Started -eq 'desktop') {
        Write-Host "Ovis: signing out of Windows ends herdr and every terminal in it (lock the PC instead); a herdr that stops or crashes is not started again until $(if ($signIn) { 'your next sign-in, or ' })this installer runs again"
        # herdr in the desktop gets this account's environment, not this run's, and hands it to Ovis
        if ($env:OVIS_TOKEN) { Write-Host "Ovis: the OVIS_TOKEN set for this run does not reach the herdr started in your desktop$(if ($signIn) { ' or at your sign-in' }), so Ovis runs without it: $tokenWhere" }
    }
}
# where Ovis reads OVIS_TOKEN at every start, whatever started herdr
$tokenWhere = 'put OVIS_TOKEN=<token> in the file env in the folder `herdr plugin config-dir devswha.ovis` prints, then restart Ovis (herdr plugin action invoke devswha.ovis.stop-windows, then devswha.ovis.start-windows)'

# `ovis` in any new terminal, as install.sh's launcher gives Linux and macOS: cmd\ovis.cmd runs the release's server as
# `ovis-server plugin <command>`. It is kept beside bin\, not in it, since an update replaces bin\ whole; its folder is
# put on the user's PATH once. The shim names the server relative to itself (%~dp0), so a user folder outside ASCII
# stays intact, and it replaces only a shim of its own: an `ovis.cmd` it did not write, or a link, stays as it is.
function Write-OvisCommand {
    $dir = Join-Path $ovisHome 'cmd'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $shim = Join-Path $dir 'ovis.cmd'
    $text = "@echo off`r`n`"%~dp0..\bin\ovis-server.exe`" plugin %*`r`n"
    $existing = Get-Item -LiteralPath $shim -Force -ErrorAction SilentlyContinue
    if ($existing -and (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        [IO.File]::ReadAllText($shim) -notmatch '^@echo off\r?\n"[^"\r\n]*\\bin\\ovis-server\.exe" plugin %\*\r?\n?$')) {
        Write-Host "Ovis: $shim is not Ovis's own command, so it was left as it is"
        return
    }
    $staged = Join-Path $dir ([IO.Path]::GetRandomFileName())
    [IO.File]::WriteAllText($staged, $text, [Text.Encoding]::ASCII)
    try {
        if ($existing) { [IO.File]::Copy($staged, $shim, $true) }
        # nothing was there: a file another installer writes meanwhile is not replaced
        else { [IO.File]::Move($staged, $shim) }
    } catch {
        Write-Host "Ovis: $shim appeared while Ovis was writing it, so it was left as it is"
        return
    } finally { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { return }
    # the user's Path as stored: GetEnvironmentVariable expands %VAR% entries, and writing that back would flatten them
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (-not (($userPath -split ';') -contains $dir)) {
            $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $key.SetValue('Path', ((@($userPath -split ';' | Where-Object { $_ }) + $dir) -join ';'), $kind)
            # setting and removing a variable through .NET announces the changed environment to Explorer and new terminals
            [Environment]::SetEnvironmentVariable('OVIS_PATH_CHANGED', '1', 'User')
            [Environment]::SetEnvironmentVariable('OVIS_PATH_CHANGED', $null, 'User')
            Write-Host "Ovis: added $dir to your PATH: open a new terminal to run ovis"
        }
    } finally { $key.Dispose() }
}

$newInstall = $false
$binaryDone = $false
$ovisPlugin = Join-Path $ovisHome 'plugin'
$listed = Find-Plugin
$fromSource = $env:OVIS_FROM_SOURCE -eq '1' -or (Find-Plugin $legacyId) -or
    ($listed -and -not ($listed.plugin_root -and [IO.Path]::GetFullPath($listed.plugin_root).TrimEnd('\') -ieq [IO.Path]::GetFullPath($ovisPlugin).TrimEnd('\')))
if (-not $fromSource) {
    $releases = Get-ReleasesBase
    $wanted = $Ref
    if (-not $wanted -and $releases -like 'file://*') {
        $wanted = Get-ChildItem -LiteralPath ([Uri]$releases).LocalPath -Directory | Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } |
            Sort-Object { [version]$_.Name.Substring(1) } | Select-Object -Last 1 -ExpandProperty Name
    } elseif (-not $wanted) { $wanted = Get-LatestRef }
    if ($wanted -match '^v(\d+\.\d+\.\d+)$') {
        $version = $Matches[1]
        $probe = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
        try {
            $shipped = Save-ReleaseFile "$releases/$wanted/ovis-server.json" $probe 65536 'ovis-server.json'
            # a manifest without a schema is of the shape releases had before this installer (todo 5's): signed, for this
            # version, it ships no compiled server this installer runs, as a release without one; the signature comes first
            if ($shipped -and -not (([IO.File]::ReadAllText($probe) | ConvertFrom-Json).PSObject.Properties.Name -contains 'schema')) {
                $sigFile = "$probe.sig"
                $signature = if (Save-ReleaseFile "$releases/$wanted/ovis-server.json.sig" $sigFile 1024 'ovis-server.json.sig') { [IO.File]::ReadAllText($sigFile) } else { '' }
                Remove-Item -LiteralPath $sigFile -Force -ErrorAction SilentlyContinue
                if ($signature -cnotmatch '^[A-Za-z0-9+/]{86}==\n$' -or -not (Test-Ed25519 ([Convert]::FromBase64String($releasePublicKey)) ([IO.File]::ReadAllBytes($probe)) ([Convert]::FromBase64String($signature.TrimEnd("`n")))) -or
                    (([IO.File]::ReadAllText($probe) | ConvertFrom-Json).version -cne $version)) {
                    throw "$releases/$wanted/ovis-server.json is not signed by the key $releasePublicKey for version $version; nothing was changed"
                }
                Write-Host "Ovis: Ovis $wanted's signed ovis-server.json has the shape from before this installer"
                $shipped = $false
            }
        }
        finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
        if ($shipped) {
            $changed = Install-OvisBinary $version
            Write-OvisPlugin $version
            Write-OvisCommand
            if (-not (Find-Plugin)) {
                Run-Tool herdr @('plugin', 'link', $ovisPlugin) | Out-Null
                $newInstall = $true
            }
            $exe = Join-Path $ovisHome 'bin\ovis-server.exe'
            $ovisCli = @($exe, 'plugin')
            $ovisCommand = 'ovis'
            $addCommand = 'ovis add'
            $takesAccount = [version]$version -ge [version]'0.5.10'
            $readsAnswers = $true
            # the release's `ovis join` (scripts/plugin-join.ts) came with 0.5.10
            $takesJoin = [version]$version -ge [version]'0.5.10'
            $herdrNow = Start-HerdrForOvis
            if ($herdrNow.Running) {
                # a herdr started just now starts the app itself (the plugin's startup hook)
                if (-not $herdrNow.Started) { Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null }
                $status = $null
                for ($attempt = 0; $attempt -lt $herdrNow.Wait; $attempt++) {
                    $status = & $ovisCli[0] $ovisCli[1] status | Where-Object { $_ -match '^running ' } | Select-Object -First 1
                    if ($status) { break }
                    Start-Sleep -Seconds 1
                }
                if (-not $status) { throw "The app did not start within $($herdrNow.Wait) seconds.`nSee: herdr plugin log list" }
                $ovisRunning = $true
                Write-Host $status
                if ($newInstall -and $status) { Write-Host "Ovis: open $([regex]::Match($status, '^running (\S+)').Groups[1].Value) in your browser and click Install in the address bar" }
            }
            Write-HerdrLines $herdrNow 'ovis'
            Write-Host 'Ovis: open Phone setup in herdr for phone access.'
            $binaryDone = $true
        } else {
            Write-Host "Ovis: Ovis $wanted ships no compiled server, so it is installed from source"
            $Ref = $wanted
        }
    }
}
if (-not $binaryDone) {
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -or [version]((Run-Tool bun @('--version')) -replace '-.*$', '') -lt [version]'1.4.0') {
    Write-Host 'Ovis: installing Bun 1.4.4 for your user'
    # The same stable runtime as CI; use Bun's official installer rather than a second downloader.
    # It leaves this session with the user's PATH alone: without the machine's, neither this script nor herdr finds git.
    $path = $env:PATH
    & ([scriptblock]::Create((Invoke-WebRequest 'https://bun.sh/install.ps1' -UseBasicParsing).Content)) -Version '1.4.4'
    $env:PATH = $path
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Bun did not install. See https://bun.sh.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

$move = $true
if (-not (Find-Plugin)) {
    if (-not $Ref) { $Ref = Get-LatestRef }
    $refId = try {
        $manifest = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "https://raw.githubusercontent.com/devswha/ovis/$Ref/herdr-plugin.toml").Content
        if ($manifest -match '(?m)^id\s*=\s*"([^"]+)"') { $Matches[1] }
    } catch { $null }
    # raw.githubusercontent.com can be blocked where github.com is not: a release tag's version tells it too
    if (-not $refId -and $Ref -match '^v(\d+\.\d+\.\d+)$') {
        $refId = if ([version]$Matches[1] -ge [version]'0.4.14') { $pluginId } else { $legacyId }
    }
    if ($refId -eq $legacyId) { $pluginId = $legacyId } elseif (-not $refId) { $move = $false }
}
$legacy = if ($pluginId -ne $legacyId -and $move) { Find-Plugin $legacyId } else { $null }
if (-not $move -and (Find-Plugin $legacyId)) {
    Write-Host "Ovis: could not read the plugin id at $Ref, so the install under $legacyId is left as it is; run this again to move it"
}
# herdr's state dir, as scripts/plugin-state.ts finds it: under it, each plugin's (plugins\<id>)
$herdrState = if ($null -ne $env:XDG_STATE_HOME) { [IO.Path]::Combine($env:XDG_STATE_HOME, 'herdr') }
    elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'herdr' }
    else { Join-Path $env:USERPROFILE 'AppData\Local\herdr' }
# A server a start of this plugin recorded that still runs, read without the checkout's packages: its pid in server.pid
# and the creation time Windows gave it in server.owner (scripts/plugin.ts writes both, and its stop reads them), in the
# state dir herdr gives the plugin under either id, or in ~\.local\state when it was started by hand (ByHand: by any
# checkout). Each record of a live pid is given back with its file: Reused where that process has another creation time
# (it is not the server, but a stop that cannot verify it fails on it), unverified where none could be compared (no
# server.owner, or none read now).
function Get-RecordedServer {
    $handDirs = @('ovis', 'herdr-web-ui' | ForEach-Object { Join-Path $env:USERPROFILE ".local\state\$_" })
    $dirs = @($env:HERDR_PLUGIN_STATE_DIR) + @($pluginId, $legacyId | ForEach-Object { Join-Path $herdrState "plugins\$_" }) + $handDirs
    foreach ($dir in $dirs | Where-Object { $_ }) {
        $file = Join-Path $dir 'server.pid'
        $recorded = "$(Get-Content -Raw -LiteralPath $file -ErrorAction SilentlyContinue)".Trim()
        if ($recorded -notmatch '^\d+$' -or -not (Get-Process -Id $recorded -ErrorAction SilentlyContinue)) { continue }
        $owner = try { Get-Content -Raw -LiteralPath (Join-Path $dir 'server.owner') -ErrorAction Stop | ConvertFrom-Json } catch { $null }
        $verified = $false; $reused = $false
        if ($owner -and "$($owner.pid)" -eq $recorded -and $owner.birth.platform -eq 'win32') {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$recorded" -ErrorAction SilentlyContinue
            if ($process.CreationDate) {
                $reused = "$(([DateTimeOffset]$process.CreationDate).ToUnixTimeMilliseconds())" -ne "$($owner.birth.value)"
                $verified = -not $reused
            }
        }
        [pscustomobject]@{ Id = [int]$recorded; Verified = $verified; Reused = $reused; File = $file; ByHand = $dir -in $handDirs }
    }
}
# What a refusal says of one live record Get-RecordedServer found, by what is known of it: its process verified as the
# server by the creation time its start recorded; a process whose creation time differs from the one recorded, so not
# the server recorded there, whatever it is; or one nothing recorded can verify (no server.owner, or none
# read now), which the herdr stop action cannot stop either, since it stops only a server it verifies. A record in
# ~\.local\state is of an Ovis started by hand, from any checkout.
function Get-RecordAdvice($Record) {
    $id = $Record.Id
    if ($Record.Verified) { return "It runs as process $id (Stop-Process -Id $id stops it)." }
    if ($Record.Reused) { return "Its record $($Record.File) names process $id, whose creation time differs from the one recorded for the server, so it is not the server recorded there, whatever it is: delete that file, then run this again." }
    $whose = if ($Record.ByHand) { '; its command line names the checkout it runs from, which may be another than this one' } else { '' }
    "Its record $($Record.File) names process $id, which could not be verified as the Ovis server. Get-CimInstance Win32_Process -Filter 'ProcessId=$id' | Select-Object Name, CommandLine shows what it is: if it is Ovis (ovis-server, or bun running Ovis's server$whose), Stop-Process -Id $id stops it; if it is not, delete that file. Then run this again."
}
# git's command that trusts a folder, as one PowerShell literal (git prints its own for a POSIX shell, with '\'' for a
# quote, which PowerShell reads otherwise)
function Get-TrustCommand([string]$Path) {
    "git config --global --add safe.directory '$($Path -replace "'", "''")'"
}
function Get-BuildCommand([string]$Launcher) {
    "`$env:OVIS_FROM_SOURCE = '1'; bun '$($Launcher -replace "'", "''")' install"
}
$legacyStopped = $false
if ($legacy) {
    Write-Host "Ovis: moving the installed plugin to its Ovis id; its settings and token come along"
    # stopped first: under both ids, each would start a server on herdr's next start. Its stop is told the
    # state dir herdr hands it: run from here without it, a
    # release from before 0.4.13 looks for its pid in ~/.local/state, says it is not running, and its
    # server, which can outlive herdr, keeps the old checkout's files open for the uninstall below
    $givenState = $env:HERDR_PLUGIN_STATE_DIR
    $env:HERDR_PLUGIN_STATE_DIR = Join-Path $herdrState "plugins\$legacyId"
    try { $stopped = & bun (Join-Path $legacy.plugin_root 'scripts\plugin.ts') stop }
    finally { $env:HERDR_PLUGIN_STATE_DIR = $givenState }
    $legacyStopped = $LASTEXITCODE -eq 0 -and [bool]($stopped -match '^stopped ')
    if ($LASTEXITCODE -eq 0 -and -not $legacyStopped) {
        $stopped = & bun (Join-Path $legacy.plugin_root 'scripts\plugin.ts') stop
        $legacyStopped = $LASTEXITCODE -eq 0 -and [bool]($stopped -match '^stopped ')
    }
    # removed with its server up, the old checkout would keep serving, and the new id's start would
    # find the port answering and leave it
    if ($LASTEXITCODE -ne 0) { throw "Could not stop the server of the old id, so nothing was moved. Stop it (herdr plugin action invoke $legacyId.stop, or restart herdr), then run this again." }
}
$unchanged = if ($legacyStopped) { "nothing of the installed plugin was changed by this run, but the server of the old id was stopped for the move: herdr plugin action invoke $legacyId.start-windows starts it again" } else { 'nothing was stopped or changed by this run' }
$legacyNote = if ($legacyStopped) { " The server of the old id was stopped for the move as well: herdr plugin action invoke $legacyId.start-windows starts it again." } else { '' }
function Test-WindowsPlugin($Plugin) {
    $Plugin.plugin_root -and (Test-Path -LiteralPath (Join-Path $Plugin.plugin_root 'scripts\plugin.ps1'))
}
$plugin = Find-Plugin $pluginId
$newInstall = $false
if ($plugin -and -not (Test-WindowsPlugin $plugin)) {
    Write-Host 'Ovis: replacing an installed copy that has no Windows support'
    Run-Tool herdr @('plugin', 'uninstall', $pluginId) | Out-Null
    $plugin = $null
}
if (-not $plugin) {
    if (-not $Ref) { $Ref = Get-LatestRef }
    Write-Host "Ovis: installing the plugin at $Ref"
    # a branch builds its own sources, as install.sh has it: the plugin's launcher (scripts/plugin-launch.ts) would
    # otherwise run the release binary of the branch's package.json version, and the status read below would find a
    # checkout without its packages; a release tag takes its binary, or its sources without one
    $givenSource = $env:OVIS_FROM_SOURCE
    if ($Ref -cnotmatch '^v\d+\.\d+\.\d+$') { $env:OVIS_FROM_SOURCE = '1' }
    try { Run-Tool herdr @('plugin', 'install', 'devswha/ovis', '--ref', $Ref, '--yes') }
    finally { $env:OVIS_FROM_SOURCE = $givenSource }
    $newInstall = $true
    $plugin = Find-Plugin $pluginId
    if (-not $plugin -and -not $move) {
        $pluginId = $legacyId
        $plugin = Find-Plugin $pluginId
    }
    if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }
    # herdr installs a release without Windows build steps as a success that cannot start.
    if (-not (Test-WindowsPlugin $plugin)) { throw "Ovis $Ref does not support Windows yet. Run this again after the next release." }
} else {
    Write-Host 'Ovis: already installed; Settings > Updates keeps it current'
    $launcherScript = Join-Path $plugin.plugin_root 'scripts\plugin-launch.ts'
    $repairing = $false
    # The installed checkout's commit, by what git answers, by the rule scripts/plugin-launch.ts (checkoutCommit) and
    # install.sh (ref_not_moved) read it by: at a checkout's top level its commit; none in a folder inside another
    # repository (--show-prefix names its path there: git would read that repository's commit, not the plugin's) or one
    # git says is no repository (a plugin linked from such a folder); anything else is git failing ($gitFailed: what it
    # said), and nothing is decided on it below. git runs untranslated (LC_ALL=C), so its "not a git repository" can be
    # told by its words, and so can a folder it distrusts ($distrusted: the folder as git names it on its first line); what
    # it says is kept off the console, and from the error stream a host under Stop could turn native stderr into (as
    # Run-HerdrInstaller does). Each stderr line is its exception's message: an empty one prints as the exception's type.
    $installedCommit = ''
    $gitFailed = ''
    $distrusted = ''
    if ($Ref) {
        $read = & {
            $ErrorActionPreference = 'Continue'
            $givenLocale = $env:LC_ALL; $env:LC_ALL = 'C'
            try {
                foreach ($question in '--show-prefix', 'HEAD') {
                    $said = @(& git -C $plugin.plugin_root rev-parse $question 2>&1)
                    $out = "$($said | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] })".Trim()
                    $lines = @($said | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$($_.Exception.Message)".Trim() } | Where-Object { $_ })
                    $err = $lines -join ' '
                    if ($LASTEXITCODE -ne 0 -or ($question -eq 'HEAD' -and -not $out)) {
                        if ($question -eq '--show-prefix' -and $err -match 'not a git repository') { return @{} }
                        $owned = if ("$($lines[0])" -match "^fatal: detected dubious ownership in repository at '(.*)'$") { $Matches[1] }
                        return @{ Failed = $(if ($err) { $err } else { "git exited with $LASTEXITCODE" }); Distrusted = $owned; First = "$($lines[0])" }
                    }
                    if ($question -eq '--show-prefix' -and $out) { return @{} }
                }
                @{ Commit = $out }
            } finally { $env:LC_ALL = $givenLocale }
        }
        $installedCommit = "$($read.Commit)"
        $gitFailed = "$($read.Failed)"
        $distrusted = "$($read.Distrusted)"
    }
    if ($Ref -and $Ref -cnotmatch '^v\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath $launcherScript)) {
        $checkoutVersion = (Get-Content -Raw -LiteralPath (Join-Path $plugin.plugin_root 'package.json') | ConvertFrom-Json).version
        $marker = Join-Path $plugin.plugin_root '.ovis\server\from-source'
        $chosen = if (Test-Path -LiteralPath $marker) { (Get-Content -Raw -LiteralPath $marker).Trim() } else { '' }
        $stamp = Join-Path $plugin.plugin_root '.ovis\server\source-build'
        $stamped = if (Test-Path -LiteralPath $stamp) { (Get-Content -Raw -LiteralPath $stamp).Trim() }
        $sourceBuilt = $chosen -eq $checkoutVersion -and (Test-Path -LiteralPath (Join-Path $plugin.plugin_root 'node_modules')) -and
            (Test-Path -LiteralPath (Join-Path $plugin.plugin_root 'dist\index.html')) -and
            ($null -eq $stamped -or ($installedCommit -and $stamped -eq "$checkoutVersion $installedCommit") -or
                (-not $installedCommit -and -not $gitFailed -and "$stamped".Split(' ')[0] -eq $checkoutVersion))
        $repairing = -not $sourceBuilt
        if ($repairing) {
            # git distrusting a folder another account owns (installed from an elevated prompt, a network drive) answers so
            # on every run, its first line naming the folder as it wants it trusted
            if ($distrusted) {
                throw "git does not trust the folder of the installed plugin, $($plugin.plugin_root): it belongs to another account (git said: $($read.First)). So this installer cannot read its commit, nor tell whether its build is the one of that commit; $unchanged. To trust the folder, run this, then run the installer again:`n$(Get-TrustCommand $distrusted)"
            }
            if ($gitFailed) { throw "git could not read the commit of the installed plugin in $($plugin.plugin_root) (git said: $gitFailed), so this installer cannot tell whether its build is the one of that commit; $unchanged. Run this again; if git says the same, fix what it says first." }
            if (-not $installedCommit) { throw "git could not read the commit of the installed plugin in $($plugin.plugin_root) (it is no git checkout, or not one's top level), so this installer cannot tell whether it is $Ref; $unchanged. To build that folder as it is, stop Ovis (herdr plugin action invoke $pluginId.stop-windows), run $(Get-BuildCommand $launcherScript), then run this again." }
            # herdr checks the ref out detached, so the checkout knows its commit, not the branch: the ref is the installed
            # checkout only when it names that commit (a commit id, short ones too, among the checkout's objects, never a ref
            # of that name there, or a branch or tag whose commit on GitHub is it).
            $commitId = $Ref -match '^[0-9a-fA-F]{4,40}$'
            $objects = if ($commitId) { @(& git -C $plugin.plugin_root rev-parse "--disambiguate=$($Ref.ToLowerInvariant())") } else { @() }
            if ($installedCommit -notin $objects) {
                # an annotated tag lists its tag object under its name and its commit under <name>^{}
                $listed = & git ls-remote 'https://github.com/devswha/ovis.git' -- $Ref "$Ref^{}"
                if ($LASTEXITCODE -ne 0) { throw "Could not ask GitHub which commit $Ref is, so $unchanged. Check your connection and run this again." }
                $refs = @{}
                foreach ($line in $listed) { $commit, $name = "$line" -split "`t"; $refs[$name] = $commit }
                $tag = if ($refs.ContainsKey("refs/tags/$Ref^{}")) { $refs["refs/tags/$Ref^{}"] } else { $refs["refs/tags/$Ref"] }
                $tips = @(@($refs["refs/heads/$Ref"], $tag) | Where-Object { $_ })
                if ($installedCommit -notin $tips) {
                    $at = if ($tips) { "and $Ref is at $($tips[0].Substring(0, 12))" } elseif ($commitId) { "not $Ref" } else { "and GitHub has no branch or tag $Ref" }
                    throw "The installed plugin is at commit $($installedCommit.Substring(0, 12)), $at. This installer does not move an installed plugin to another branch or commit, or to where its branch has moved since, so $unchanged. To install $Ref, stop Ovis (herdr plugin action invoke $pluginId.stop-windows), run `$env:OVIS_FROM_SOURCE = '1'; herdr plugin install devswha/ovis --ref $Ref --yes (INSTALL.md, Update: it replaces the checkout), then run this again."
                }
            }
            $kept = Join-Path $plugin.plugin_root '.ovis\server\bin'
            $keptBinary = Test-Path -LiteralPath (Join-Path $kept 'ovis-server.exe')
            $keptManifest = Join-Path $kept 'ovis-server.json'
            $keptVersion = if (Test-Path -LiteralPath $keptManifest) { try { (Get-Content -Raw -LiteralPath $keptManifest | ConvertFrom-Json).version } catch { '' } } else { '' }
            # Whether the launcher runs the release's binary kept in $kept without asking the release: one of this version
            # whose executable has the SHA-256 its manifest names, with its client (scripts/server-install.ts
            # verifiedInstall, but for the signature, checked when it was installed). Any other it fetches again.
            $keptRuns = {
                $release = try { Get-Content -Raw -LiteralPath $keptManifest -ErrorAction Stop | ConvertFrom-Json } catch { $null }
                $sha = "$($release.assets.'windows-x64'.sha256)"
                $release.version -eq $checkoutVersion -and $sha -cmatch '^[0-9a-f]{64}$' -and (Test-Path -LiteralPath (Join-Path $kept 'dist\index.html')) -and
                    "$(try { (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $kept 'ovis-server.exe') -ErrorAction Stop).Hash } catch { '' })".ToLowerInvariant() -ceq $sha
            }
            # The release is asked first whenever the launcher's stop or herdr's next start would have to ask it: no kept
            # binary the launcher runs without it. Out of reach, the stop below would stop a server (through the binary's
            # absence, the sources) that herdr's start, with the marker taken back, could not start again if the build then
            # failed (offline, bun install fetches nothing): nothing is stopped or changed then.
            if (-not (& $keptRuns)) {
                $probe = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
                $unreachable = try { $null = Save-ReleaseFile "$(Get-ReleasesBase)/v$checkoutVersion/ovis-server.json" $probe 65536 'ovis-server.json'; '' }
                    catch { "$($_.Exception.Message)" } finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
                if ($unreachable) {
                    $without = if ($keptBinary) { "the release's binary kept in $kept is not one the launcher runs without it" } else { 'this checkout keeps no release binary' }
                    throw "The release of version $checkoutVersion could not be reached ($unreachable), and $without`: Ovis would be stopped for the build, and if the build failed too, herdr could not start it again until the release can be reached. So the branch was not built, and $unchanged. Run this again once the release can be reached."
                }
            }
            Write-Host "Ovis: the installed branch was not built from its own sources; building it"
            $givenSource = $env:OVIS_FROM_SOURCE
            $built = $false
            try {
                # a marker a build cut off left would send the stop below to the sources it never built
                Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
                # Succeeded is not stopped: scripts/plugin.ts's stop says "stopped Ovis (pid N)" for a server it stopped,
                # and also exits 0 for none.
                $stopped = $null
                $stoppedOne = $false
                if ($keptBinary -or (Test-Path -LiteralPath (Join-Path $plugin.plugin_root 'node_modules'))) {
                    $env:OVIS_FROM_SOURCE = if ($keptBinary) { $null } else { '1' }
                    # told herdr's state dir for the plugin, as herdr's own stop is: run by hand without it, scripts/plugin.ts takes
                    # a live record in ~\.local\state first, and would stop a server started by hand, of any checkout.
                    $givenState = $env:HERDR_PLUGIN_STATE_DIR
                    if (-not $givenState) { $env:HERDR_PLUGIN_STATE_DIR = Join-Path $herdrState "plugins\$pluginId" }
                    try { $said = & bun $launcherScript stop } finally { $env:HERDR_PLUGIN_STATE_DIR = $givenState }
                    $stopped = $LASTEXITCODE -eq 0
                    $stoppedOne = $stopped -and [bool]($said -match '^stopped ')
                    if (-not $stopped -and $keptBinary) {
                        # The launcher runs a kept binary only of this version, checked: another (or one it cannot check)
                        # sends the stop to the sources, which fail without their packages on every rerun. A record of
                        # a live pid the stop cannot verify as its server is kept by it, and fails it on every rerun. With no
                        # live record, the stop reached no server: the binary of this version failed its check (signature,
                        # executable or client, scripts/server-install.ts verifiedInstall) and the release could not be had again.
                        $records = @(Get-RecordedServer)
                        $herdrRecords = @($records | Where-Object { -not $_.ByHand })
                        $suspect = @($herdrRecords | Where-Object { -not $_.Verified })[0]
                        $byHand = @($records | Where-Object { $_.ByHand -and -not $_.Reused })[0]
                        $recovery = if ($keptVersion -ne $checkoutVersion) { "The release's binary kept in $kept is not this checkout's version ($checkoutVersion), so its stop cannot run: remove that folder, then run this again." }
                            elseif ($suspect) { Get-RecordAdvice $suspect }
                            elseif (-not $herdrRecords) {
                                "No server of herdr's start is recorded as running: the release's binary kept in $kept did not pass its check, and the release could not be fetched again. Remove that folder, then run this again." +
                                $(if ($byHand) { " An Ovis started by hand is also recorded as running in $(Split-Path $byHand.File), and the next run refuses for it while it runs. $(Get-RecordAdvice $byHand)" })
                            }
                            else { "Stop it (herdr plugin action invoke $pluginId.stop-windows, or restart herdr), then run this again. $(Get-RecordAdvice $herdrRecords[0])" }
                        throw "Could not stop the Ovis the release's binary runs, so the branch was not built. $recovery$legacyNote"
                    }
                }
                # Whether the stop ran, failed or had nothing to run: a server recorded as running would be left serving
                # under the build (on Windows bun install fails on the files it holds open).
                $running = @(Get-RecordedServer | Where-Object { -not $_.Reused })[0]
                if ($running) {
                    $what = if ($running.ByHand) { "An Ovis started by hand is recorded as running in $(Split-Path $running.File), so the branch was not built. Stop it, then run this again." }
                        else { "Ovis still runs from this checkout, so the branch was not built. Stop it (herdr plugin action invoke $pluginId.stop-windows, or restart herdr), then run this again." }
                    throw "$what $(Get-RecordAdvice $running)$legacyNote"
                }
                if ($stopped -eq $false) { Write-Host 'Ovis: the stop failed; with no release binary and no server recorded as running here, the checkout is built' }
                $env:OVIS_FROM_SOURCE = '1'
                & bun $launcherScript install
                if ($LASTEXITCODE -ne 0) {
                    $code = $LASTEXITCODE
                    # without the marker (taken back below), the launcher's start runs the release's binary the checkout keeps
                    # once it accepts it without the release, which $keptRuns tells but for the manifest's signature: said as
                    # what may be, not promised
                    $back = if (& $keptRuns) {
                        " Until then, herdr plugin action invoke $pluginId.start-windows may start the release's binary this checkout keeps, if the launcher still accepts it (its signature, which this installer does not check, included)."
                    } else { '' }
                    $how = if ($stoppedOne) { 'and Ovis is stopped' }
                        elseif ($null -eq $stopped) { 'with no server recorded as running, nor packages or a release binary here to run one' }
                        else { "and an Ovis no stop reached may still run from this checkout, holding its files open: Get-CimInstance Win32_Process | Where-Object CommandLine -like '*$([WildcardPattern]::Escape($plugin.plugin_root) -replace "'", "''")*' finds it, and Stop-Process -Id <its ProcessId> stops it" }
                    throw "bun failed (exit $code) building the installed branch, $how. Fix the error above, then run this again with OVIS_REF=$Ref to build it and start Ovis.$back$legacyNote"
                }
                $built = $true
                if ("$(Get-Content -Raw -LiteralPath $stamp -ErrorAction SilentlyContinue)".Trim() -eq 'started') {
                    $versionNow = (Get-Content -Raw -LiteralPath (Join-Path $plugin.plugin_root 'package.json') | ConvertFrom-Json).version
                    $builtFor = "$(Get-Content -Raw -LiteralPath $marker -ErrorAction SilentlyContinue)".Trim()
                    if ($builtFor -ne $versionNow) {
                        Write-Host "Ovis: the build is not marked finished: the installed checkout moved from version $builtFor to $versionNow while it was built, so herdr's next start does not run it. To build it, stop Ovis, build it, then start it:`nherdr plugin action invoke $pluginId.stop-windows`n$(Get-BuildCommand $launcherScript)`nherdr plugin action invoke $pluginId.start-windows"
                    } else {
                    Write-Host "Ovis: the build is not marked finished (the installed checkout moved to another commit while it was built, or git could not read its commit: the launcher's line above says which), though herdr's next start still runs it as it is; run this again with OVIS_REF naming the commit it is at now to build that one"
                    }
                }
            } finally {
                $env:OVIS_FROM_SOURCE = $givenSource
                # the launcher names this version in the marker before it builds: a build that did not finish, failed or
                # cut off (Ctrl+C reaches finally, not catch), takes it back, so the launcher's start does not run sources
                # that were never built, and the next run builds again also where the launcher writes no stamp
                if (-not $built) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }
            }
        }
    }
    if ($Ref -and -not $repairing) {
        $at = if ($installedCommit.Length -ge 12) { "the installed plugin is at commit $($installedCommit.Substring(0, 12)); " }
            elseif ($distrusted) { "git does not trust the installed plugin's folder: it belongs to another account (git said: $($read.First)); " }
            elseif ($gitFailed) { "git could not read the installed plugin's commit (git said: $gitFailed); " } else { '' }
        Write-Host "Ovis: ${at}OVIS_REF does not move an installed plugin (INSTALL.md, Update)"
        # git's own command for it is quoted for a POSIX shell: the one for PowerShell instead, on a line of its own
        if ($distrusted) { Write-Host "Ovis: to trust the folder, run:`n$(Get-TrustCommand $distrusted)" }
    }
}
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

$script = Join-Path $plugin.plugin_root 'scripts\plugin.ts'
$ovisCli = @('bun', $script)
$ovisCommand = "bun '$([Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($script))'"
$addCommand = "$ovisCommand add"
# the add a checkout runs is its own or a newer release's (Settings -> Updates), which reads at least what the checkout's does
$linkScript = Join-Path $plugin.plugin_root 'scripts\plugin-link.ts'
$takesAccount = [bool](Select-String -LiteralPath $linkScript -SimpleMatch '"--account"' -Quiet -ErrorAction SilentlyContinue)
$readsAnswers = [bool](Select-String -LiteralPath $linkScript -SimpleMatch 'export function answerOf' -Quiet -ErrorAction SilentlyContinue)
# the checkout's own script runs `ovis join`: one from before it has no scripts/plugin-join.ts
$takesJoin = Test-Path -LiteralPath (Join-Path $plugin.plugin_root 'scripts\plugin-join.ts')
$herdrNow = Start-HerdrForOvis
if ($herdrNow.Running) {
    # a herdr started just now starts the app itself (the plugin's startup hook)
    if (-not $herdrNow.Started) { Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null }
    $ready = $false
    for ($attempt = 0; $attempt -lt $herdrNow.Wait; $attempt++) {
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
        } catch { $why = '' }
        throw "The app did not start within $($herdrNow.Wait) seconds.$why`nSee: herdr plugin log list"
    }
    $ovisRunning = $true
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
}
Write-HerdrLines $herdrNow "bun '$([Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($script))'"
Write-Host 'Ovis: open Phone setup in herdr for phone access.'
}

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
# The add, with the account named (-Account): run with no terminal and an empty input, as install.sh runs it, only where
# the add of the release that runs checks that account (an older one would not); at a terminal without it, `ovis add`
# itself, whose answers are read only once its question shows (scripts/plugin-link.ts, askLine); anywhere else, the
# command to run. $addResult: done, failed, old (a release whose add does not do it), waits (Ovis is not running), the
# terminal it lacks (terminal), or other: the add said done, yet the PC is in another account than -Account names (the
# add refuses that itself since `ovis join`'s release; `ovis status --json` is asked once more where it answers, and a
# release without it, answering plain lines, is taken at the add's word).
$addResult = 'none'
$tokenLine = "Ovis: on a PC other people sign in to, set OVIS_TOKEN first, where Ovis reads it at every start: without it any local user counts as this PC (https://github.com/devswha/ovis/blob/main/docs/relay.md#a-pc-with-no-screen); $tokenWhere"
if ($wantAdd) {
    if (-not $ovisRunning) { $addResult = 'waits' }
    elseif ($addAccount) {
        if (-not $takesAccount) { $addResult = 'old' }
        else {
            Write-Host ''
            Write-Host $tokenLine
            @() | & $ovisCli[0] $ovisCli[1] add --account $addAccount
            $addResult = if ($LASTEXITCODE -eq 0) { 'done' } else { 'failed' }
            $inAccount = if ($addResult -eq 'done') { try { @(& $ovisCli[0] $ovisCli[1] status --json 2>$null) | Select-Object -Last 1 | ConvertFrom-Json } catch { $null } }
            # an id as `ovis add --account` takes it (scripts/plugin-link.ts, pins): the whole id, or its start of 12 or more
            if ($inAccount.account_known -eq $true -and $inAccount.account -is [string] -and -not ($inAccount.account -ceq $addAccount -or
                ($addAccount.Length -ge 12 -and $inAccount.account.StartsWith($addAccount, [StringComparison]::Ordinal)))) {
                $addResult = 'other'
                $otherAccount = $inAccount.account.Substring(0, [Math]::Min(12, $inAccount.account.Length))
            }
        }
    }
    elseif (-not (Test-Terminal) -or $env:OVIS_NO_OPEN -or $env:HERDR_WEB_NO_OPEN) { $addResult = 'terminal' }
    elseif (-not $readsAnswers) { $addResult = 'old' }
    else {
        Write-Host ''
        # what was typed while the installer worked answers nothing
        try { $Host.UI.RawUI.FlushInputBuffer() } catch { }
        & $ovisCli[0] $ovisCli[1] add
        $addResult = if ($LASTEXITCODE -eq 0) { 'done' } else { 'failed' }
    }
    $retry = if ($addAccount) { "$addCommand --account $addAccount" } else { $addCommand }
    switch ($addResult) {
        'waits' { Write-Host "Ovis: the app is not running, so this PC was not added to your Ovis account. Once it runs, run on this PC: $retry" }
        'old' {
            if ($addAccount) { Write-Host "Ovis: this Ovis release does not check the account -Account names, so the installer does not add this PC with it. Update Ovis in Settings -> Updates, then run on this PC: $retry" }
            else { Write-Host "Ovis: this Ovis release would take a line typed ahead as its answer about the device that adds this PC, so the installer does not start that step for it. Update Ovis in Settings -> Updates, then run in a terminal on this PC: $retry" }
        }
        'failed' { Write-Host "Ovis: this PC was not added to your Ovis account; what the add said is above. To try again, run on this PC: $retry" }
        'other' { Write-Host "Ovis: this PC is in another Ovis account ($otherAccount...) than -Account names, so it was not added to that one. To move it, take it out of that account first (ovis logout), then run on this PC: $retry" }
        'terminal' { Write-Host "Ovis: to add this PC to your Ovis account, run in a terminal on this PC: $retry. Where nobody can answer, as in a script or for a coding agent, name the account: -Account <id> (OVIS_ADD_ACCOUNT)" }
    }
}

# The join (an invite's line: -JoinFile, OVIS_JOIN or -Join), once Ovis runs, as install.sh runs it: `ovis join` lists this
# PC in the invite's account on its own key's proof, with no sign-in here, and it alone is given the line, in its
# environment (OVIS_INVITE), never on a command line. Whoever handed the invite over chose the account, so it is confirmed
# first: with -Account (OVIS_ADD_ACCOUNT) and an empty, closed input, as a script or an agent runs it; or at a terminal,
# where `ovis join` asks for yes once what was typed while the installer worked is flushed (where nobody can answer, the
# join was refused before the install). $joinResult: none, old (a release without it), waits (Ovis is not running), or the
# exit code of `ovis join` (scripts/plugin-join.ts, JOIN_EXIT).
$joinResult = 'none'
if ($joinGiven) {
    $joinFrom = if ($joinGiven -eq 'file') { "'$([Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($joinPath))'" } else { '<a file holding the invite>' }
    $joinRetry = "$ovisCommand join --invite-file $joinFrom$(if ($addAccount) { " --account $addAccount" })"
    $joinArguments = @('join')
    if ($addAccount) { $joinArguments += @('--account', $addAccount) }
    if (-not $takesJoin) { $joinResult = 'old' }
    elseif (-not $ovisRunning) { $joinResult = 'waits' }
    else {
        Write-Host ''
        Write-Host $tokenLine
        $givenInvite = $env:OVIS_INVITE
        $env:OVIS_INVITE = $joinLine
        try {
            if ($addAccount) { @() | & $ovisCli[0] $ovisCli[1] @joinArguments }
            else {
                # what was typed while the installer worked answers nothing
                try { $Host.UI.RawUI.FlushInputBuffer() } catch { }
                & $ovisCli[0] $ovisCli[1] @joinArguments
            }
            $joinResult = "$LASTEXITCODE"
        } finally {
            if ($null -eq $givenInvite) { Remove-Item Env:\OVIS_INVITE -ErrorAction SilentlyContinue } else { $env:OVIS_INVITE = $givenInvite }
        }
    }
    $joinSaid = switch ("$joinResult") {
        'old' { "this Ovis release has no ovis join (it came in 0.5.10), so this PC did not join your Ovis account. Update Ovis in Settings -> Updates, then run on this PC: $joinRetry" }
        'waits' { "the app is not running, so this PC did not join your Ovis account. Once it runs, run on this PC: $joinRetry" }
        '0' { "this PC is in the Ovis account the invite is for. Check: $ovisCommand status --json" }
        '3' { 'the invite did not work: it is mistyped, used or expired (an invite works once, for 15 minutes), or for another account service. Ask for a new one on a device signed in to your account' }
        '4' { 'the account the invite is for was not confirmed, so this PC did not join it, and the invite was not used' }
        '5' { 'the invite is for another Ovis account than -Account names, so this PC did not join it, and the invite was not used' }
        '6' { "this PC is in another Ovis account, so it did not join the invite's, and the invite was not used. To move it: $ovisCommand logout, then run on this PC: $joinRetry" }
        '7' { 'the account service asks this PC to wait, so it did not join your Ovis account yet; what ovis join said is above' }
        '8' { 'your Ovis account has added as many PCs as it may for now, so this PC did not join it, and the invite was not used; what ovis join said is above' }
        '9' { 'your Ovis account holds as many PCs as it can, so this PC did not join it: remove one in the Ovis app, then try again with a new invite' }
        '10' { "the account service did not answer, so this PC did not join your Ovis account. Try again in a moment (the invite works for 15 minutes): $joinRetry" }
        '12' { 'the relay or the account service is off on this PC, so it did not join your Ovis account; what ovis join said is above' }
        '13' { "the app stopped running, so this PC did not join your Ovis account. Once it runs, run on this PC: $joinRetry" }
        '14' { 'nobody pressed Add for this PC while its card showed, so it did not join your Ovis account. Ask for a new invite' }
        default { 'this PC did not join your Ovis account; what ovis join said is above' }
    }
    Write-Host "Ovis: $joinSaid"
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
    } catch { }
}
# -Account is a script's add, or an agent's, and a join was asked for with a key: the installer fails, as install.sh exits
# 1, when this PC was not added, or did not join (a throw, not exit, which would close the PowerShell that ran irm | iex)
if ($joinGiven -and "$joinResult" -ne '0') { throw "This PC did not join your Ovis account: the lines above say why." }
if ($addAccount -and -not $joinGiven -and $addResult -ne 'done') { throw "This PC was not added to your Ovis account: the lines above say why." }
}
