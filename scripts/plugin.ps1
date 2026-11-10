# Herdr may have started before Bun was installed: read the current user PATH at invocation time.
param(
    [string]$Command = 'status',
    # the command's own flags (link --code, add --google), handed on as they are
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
# Only plain flags go on: nothing that cmd.exe would need quoted, or could read as its own syntax.
foreach ($flag in $Rest) {
    if ($flag -cnotmatch '^--[a-z][a-z-]*$') { throw "Ovis does not know the argument '$flag': only flags such as --code are passed on." }
}
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = "$env:USERPROFILE\.bun\bin;$userPath;$env:PATH"
$bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $bun) { throw 'Could not find a runnable Bun application (bun.exe or bun.cmd). Install Bun and try again.' }
$batchShim = [IO.Path]::GetExtension($bun.Source) -in '.cmd', '.bat'
if ($batchShim) {
    # Expand each path once from the environment so literal %NAME% pairs are not reinterpreted.
    $env:OVIS_BUN = $bun.Source
    $env:OVIS_PLUGIN_SCRIPT = Join-Path $PSScriptRoot 'plugin.ts'
    $env:OVIS_PLUGIN_COMMAND = $Command
    # The flags are expanded once too, unquoted: the check above left nothing in them to quote.
    # Without flags the variable is left out of the command line, since cmd.exe keeps the name of one that is not set.
    $env:OVIS_PLUGIN_FLAGS = $Rest -join ' '
    $flags = if ($Rest) { ' %OVIS_PLUGIN_FLAGS%' } else { '' }
}
if ($Command -eq 'start') {
    # A fresh hidden console keeps PowerShell's output pipes out of the detached server.
    $executable = $bun.Source
    $arguments = '"{0}" start' -f (Join-Path $PSScriptRoot 'plugin.ts')
    if ($batchShim) {
        # Batch shims need a command interpreter, not ShellExecute's document association.
        $arguments = '/d /v:off /s /c ""%OVIS_BUN%" "%OVIS_PLUGIN_SCRIPT%" start"'
        $executable = $env:ComSpec
    }
    $child = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $null = $child.Handle # Keep the exit code available even when start exits quickly.
    $child.WaitForExit() # -Wait would also wait for the server's descendants.
    if ($child.ExitCode -ne 0) {
        # The hidden console took the start's own words; server.log holds them and the server's.
        $log = Join-Path $env:HERDR_PLUGIN_STATE_DIR 'server.log'
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 15) -join "`n" } else { '(no log)' }
        throw "Could not start Ovis. $log ends with:`n$tail"
    }
    Write-Output 'Ovis started'
    exit 0
}
if ($batchShim) {
    & $env:ComSpec /d /v:off /s /c ('""%OVIS_BUN%" "%OVIS_PLUGIN_SCRIPT%" "%OVIS_PLUGIN_COMMAND%"' + $flags + '"')
} else {
    & $bun.Source (Join-Path $PSScriptRoot 'plugin.ts') $Command @Rest
}
exit $LASTEXITCODE
