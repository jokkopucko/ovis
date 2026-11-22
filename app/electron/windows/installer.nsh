; The desktop app replaces Ovis for Windows (app/windows, the one-file setup app):
; replace-old-setup.ps1 closes that app's windows and takes its shortcuts off the PC, and its copy and
; sign-in start too unless herdr says the Ovis plugin is installed (then they keep starting herdr's server
; at sign-in). herdr, the Ovis server and their state stay as they are. customInstall runs after this app's Start
; menu shortcut is made; when that shortcut was one of that app's (an update keeps the shortcut it
; finds) and the script removed it, it is made again here. One the user deleted stays deleted.

; The one-click installer's bar follows the files it unpacks, then stands still while the template copies
; them into place with no progress of its own (tens of seconds, Defender scanning each file), which reads
; as a hang. Once the "Installing" window is up, its bars run as a marquee instead: always moving, never
; a percentage. This hook is the template's check that the app is not running, which still runs first;
; the template leaves out what that check uses when the hook is defined, so it is included here.
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ${ifNot} ${Silent}
      Push $R8
      Push $R9
      FindWindow $R8 "#32770" "" $HWNDPARENT
      ${doWhile} $R8 != 0
        FindWindow $R9 "msctls_progress32" "" $R8
        ${if} $R9 != 0
          ; GWL_STYLE |= PBS_MARQUEE, then PBM_SETMARQUEE on, a step every 30 ms
          System::Call 'user32::GetWindowLongW(p R9, i -16) i .s'
          Exch $0
          IntOp $0 $0 | 0x8
          System::Call 'user32::SetWindowLongW(p R9, i -16, i r0)'
          Pop $0
          SendMessage $R9 0x40A 1 30
        ${endIf}
        FindWindow $R8 "#32770" "" $HWNDPARENT $R8
      ${loop}
      Pop $R9
      Pop $R8
    ${endIf}
  !endif
!macroend

; Removing the app (not the old version's uninstall an update runs) stops the herdr-core server the
; app started (HC_SESSION=ovis, from its copy in the app's data folder, README.md): quitting the app
; leaves it running on purpose, but with the app gone nothing could stop or update it. Best effort,
; at most 15 seconds, and the removal goes on whatever it answers. Then the folder electron-builder
; keeps the installer's copy in for later updates (about 170 MB) goes, with any update downloaded
; there: it is named after this package (package.json name, as electron-updater names it).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$APPDATA\${PRODUCT_NAME}\bin\herdr-core.exe"
      ; the session alone names the core, as the app starts it (children.ts coreEnv drops HC_SOCKET):
      ; an HC_SOCKET left in this process's environment would point the stop at another core
      System::Call 'kernel32::SetEnvironmentVariable(t "HC_SESSION", t "ovis")'
      System::Call 'kernel32::SetEnvironmentVariable(t "HC_SOCKET", p 0)'
      nsExec::ExecToLog /TIMEOUT=15000 '"$APPDATA\${PRODUCT_NAME}\bin\herdr-core.exe" server stop'
      Pop $0
      DetailPrint "Stopping the herdr-core server: $0"
    ${endIf}
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    ; the ovis:// links the app registered for itself as it started (src/main.ts setAsDefaultProtocolClient),
    ; only when they still start this install: its command is "$INSTDIR\Ovis.exe" -- "%1". Another
    ; program's registration, or another install's, stays (NSIS compares strings without case)
    ReadRegStr $0 HKCU "Software\Classes\ovis\shell\open\command" ""
    StrCpy $1 '"$INSTDIR\'
    StrLen $2 $1
    StrCpy $0 $0 $2
    ${if} $0 == $1
      DeleteRegKey HKCU "Software\Classes\ovis"
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  StrCpy $1 "0"
  ${if} ${FileExists} "$newStartMenuLink"
    StrCpy $1 "1"
  ${endIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\replace-old-setup.ps1" "${PROJECT_DIR}\windows\replace-old-setup.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\replace-old-setup.ps1" -NewExe "$appExe"'
  Pop $0
  ; a failed step leaves that app's rest as it was: nothing of this app's depends on it
  DetailPrint "Replacing Ovis for Windows: $0"
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} $1 == "1"
    ${andIfNot} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  !endif
!macroend
