#!/usr/bin/env bash
# The browser lane of CI: the lockfile's Playwright Chromium, then the scripts that drive it.
# BROWSER_PARALLEL=1: run scripts concurrently (see ci-browser-parallel.ts)
# BROWSER_WORKERS: worker count for parallel mode (default: min(cores/2, 6))
set -euo pipefail

if [ "${BROWSER_PARALLEL:-}" = "1" ]; then
  exec bun scripts/ci-browser-parallel.ts
fi
timings=""
HERDR_DEMO_BUILD=""
finish() {
  local code=$?
  # Reporting or cleanup must not replace the lane's exit code.
  set +e
  printf '\nBrowser script summary\n%-60s %7s %5s\n' "script" "seconds" "exit"
  printf '%s' "$timings"
  printf 'Browser lane total: seconds=%s exit=%s\n' "$SECONDS" "$code"
  if [ -n "$HERDR_DEMO_BUILD" ]; then rm -rf "$HERDR_DEMO_BUILD"; fi
  exit "$code"
}
trap finish EXIT

run_script() {
  local started=$SECONDS code=0 evidence="${UI_EVIDENCE_DIR:-}" line
  if [ -n "${CI:-}${CHECK_DIR:-}" ]; then
    # These evidence branches add viewport changes, assertions or font waits, not just captures.
    case "$1" in
      scripts/ui-regression.ts|scripts/ui-contexts-regression.ts|scripts/key-bar-customization-demo-regression.ts) evidence="";;
    esac
  fi
  UI_EVIDENCE_DIR="$evidence" bun "$@" 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      PASS\ *|FAIL\ *) printf '%s\n' "$line";;
      *) printf '[%s] %s\n' "$(date -Is)" "$line";;
    esac
  done || code=$?
  local seconds=$((SECONDS - started))
  printf 'TIMING %s seconds=%s exit=%s\n' "$1" "$seconds" "$code"
  timings="${timings}$(printf '%-60s %7s %5s' "$1" "$seconds" "$code")"$'\n'
  return "$code"
}

if [ -n "${CI:-}${CHECK_DIR:-}" ]; then
  export UI_EVIDENCE_DIR="${CHECK_DIR:-.ci}/browser-evidence"
  export CHECK_BROWSER_EVIDENCE_DIR="${CHECK_DIR:-.ci}/browser-evidence"
  mkdir -p "$UI_EVIDENCE_DIR" "$CHECK_BROWSER_EVIDENCE_DIR"
fi
CHROME_PATH="$(bash scripts/ci-chromium.sh)"
export CHROME_PATH
# The demo scripts below all show the same client: it is built once here and each copies it
# (scripts/demo-build.ts), instead of each building it again.
HERDR_DEMO_BUILD="$(mktemp -d)"
export HERDR_DEMO_BUILD
run_script scripts/demo-build.ts "$HERDR_DEMO_BUILD"
run_script scripts/ui-regression.ts
run_script scripts/ui-contexts-regression.ts
run_script scripts/workspace-rows-regression.ts
run_script scripts/pending-pane-switch-regression.ts
run_script scripts/lan-exposure-notice-regression.ts
run_script scripts/terminal-dispose-browser-qa.ts
run_script scripts/herdr-restart-regression.ts
run_script scripts/sticky-modifiers-regression.ts
run_script scripts/pane-lifetime-regression.ts
run_script scripts/terminal-arrows-clicks-regression.ts
run_script scripts/terminal-viewport-regression.ts
run_script scripts/terminal-touch-burst-regression.ts
run_script scripts/omo-question-wheel-regression.ts
run_script scripts/mirror-scroll-demo-regression.ts
run_script scripts/mirror-fold-demo-regression.ts
run_script scripts/terminal-cjk-punctuation-regression.ts
run_script scripts/terminal-late-faces-regression.ts
run_script scripts/terminal-hangul-seam-regression.ts
run_script scripts/terminal-sync-output-regression.ts
run_script scripts/terminal-bundled-mono-regression.ts
run_script scripts/application-paging-regression.ts
run_script scripts/pane-paging-demo-regression.ts
run_script scripts/link-menu-demo-regression.ts
run_script scripts/key-bar-customization-demo-regression.ts
run_script scripts/key-bar-hold-repeat-regression.ts
run_script scripts/settings-pages-demo-regression.ts
run_script scripts/interface-font-demo-regression.ts
run_script scripts/theme-first-paint-demo-regression.ts
run_script scripts/security-summary-demo-regression.ts
run_script scripts/push-health-demo-regression.ts
run_script scripts/device-security-demo-regression.ts
run_script scripts/cliproxy-settings-regression.ts
run_script scripts/pane-input-focus-demo-regression.ts
run_script scripts/terminal-keyboard-demo-regression.ts
run_script scripts/shortcut-exact-modifiers-demo-regression.ts
run_script scripts/portal-regression.ts
run_script scripts/deep-link-demo-regression.ts
run_script scripts/chat-history-browser-qa.ts
run_script scripts/session-history-browser-qa.ts
run_script scripts/new-session-skills-browser-qa.ts
run_script scripts/chat-virtual-browser-qa.ts
run_script scripts/chat-gjc-streaming-browser-qa.ts
run_script scripts/chat-scroll-padding-regression.ts
run_script scripts/chat-selection-copy-regression.ts
run_script scripts/chat-fallback-browser-qa.ts
run_script scripts/grok-chat-browser-qa.ts
run_script scripts/copilot-chat-browser-qa.ts
run_script scripts/omo-chat-browser-qa.ts
run_script scripts/omo-plan-browser-regression.ts
run_script scripts/plan-chip-demo-regression.ts
run_script scripts/agent-skill-menu-demo-regression.ts
run_script scripts/terminal-autoswitch-demo-regression.ts
run_script scripts/agy-chat-browser-qa.ts
run_script scripts/gjc-status-browser-regression.ts
run_script scripts/math-browser-qa.ts
run_script scripts/claude-image-browser-qa.ts
run_script scripts/pi-image-browser-qa.ts
run_script scripts/omp-codex-image-browser-qa.ts
run_script scripts/file-viewer-regression.ts
run_script scripts/pwa-update-browser-qa.ts
run_script scripts/install-state-demo-regression.ts
run_script scripts/revision-bound-update-demo-regression.ts
run_script scripts/file-preview-text-browser-qa.ts
run_script scripts/virtual-source-browser-qa.ts
run_script scripts/repo-diff-browser-qa.ts
run_script scripts/diff-find-demo-regression.ts
run_script scripts/keyboard-viewport-regression.ts
run_script scripts/file-viewer-mobile-regression.ts
run_script scripts/droplet-demo-regression.ts
run_script scripts/phone-glass-header-demo-regression.ts
run_script scripts/chat-greeting-demo-regression.ts
run_script scripts/restored-draft-demo-regression.ts
run_script scripts/chat-local-send-follow-demo-regression.ts
run_script scripts/reply-comments-demo-regression.ts
run_script scripts/chat-tool-paths-demo-regression.ts
run_script scripts/chat-list-markers-demo-regression.ts
run_script scripts/terminal-paste-insert-demo-regression.ts
run_script scripts/composer-fit-demo-regression.ts
run_script scripts/held-rows-demo-regression.ts
run_script scripts/replay-clipboard-demo-regression.ts
run_script scripts/todo-snapshots-demo-regression.ts
run_script scripts/command-outcome-demo-regression.ts
run_script scripts/chat-outcome-note-browser-qa.ts
run_script scripts/sidebar-activity-demo-regression.ts
run_script scripts/sidebar-filter-demo-regression.ts
run_script scripts/sidebar-declutter-demo-regression.ts
run_script scripts/sidebar-spacing-demo-regression.ts
run_script scripts/sidebar-machine-layout-demo-regression.ts
run_script scripts/sidebar-machine-removal-demo-regression.ts
run_script scripts/hide-pc-demo-regression.ts
run_script scripts/sidebar-branch-line-demo-regression.ts
run_script scripts/sidebar-tokens-demo-regression.ts
run_script scripts/pane-mute-demo-regression.ts
run_script scripts/workspace-touch-reorder-demo-regression.ts
run_script scripts/prompt-dock-demo-regression.ts
run_script scripts/opencode-prompt-regression.ts
run_script scripts/pi-questionnaire-browser-regression.ts
run_script scripts/files-prompt-regression.ts
run_script scripts/plugin-actions-demo-regression.ts
run_script scripts/background-agent-detail-demo-regression.ts
run_script scripts/palette-machines-demo-regression.ts
run_script scripts/health-flap-demo-regression.ts
run_script scripts/narrow-pane-demo-regression.ts
run_script scripts/touch-long-press-demo-regression.ts
run_script scripts/context-menu-inputs-demo-regression.ts
run_script scripts/render-crash-demo-regression.ts
run_script scripts/phone-split-grid-demo-regression.ts
run_script scripts/recent-folders-regression.ts
run_script scripts/phone-worktree-sheet-regression.ts
run_script scripts/preferences-sync-regression.ts
run_script scripts/machine-dialog-regression.ts
run_script scripts/machine-conflict-regression.ts
run_script scripts/machine-own-ovis-regression.ts
run_script scripts/herdr-profiles-browser-qa.ts
