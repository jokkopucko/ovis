import "./test-herdr.ts";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { systemUsageContext, UsageService } from "../server/usage.ts";
import { checkPushSettings } from "./push-settings-regression.ts";
import { checkWakeLock } from "./wake-lock-regression.ts";
import { checkSecretInput } from "./secret-input-regression.ts";
import { checkTerminalCopy } from "./terminal-copy-regression.ts";
import { checkTerminalCopyOff } from "./terminal-copy-off-regression.ts";
import { checkPaneFind } from "./pane-find-regression.ts";
import { checkUsageMeters, checkUsageSignInAgain } from "./usage-regression.ts";
import { checkNotificationStartup } from "./notification-startup-regression.ts";
import { checkNotificationView } from "./notification-view-regression.ts";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { checkTerminalPinch } from "./terminal-pinch-regression.ts";
import { checkKeyBarKeepsKeyboardDown } from "./keybar-focus-regression.ts";
import { checkMobileTabs } from "./mobile-tabs-regression.ts";
import { checkHeaderLensSwitch } from "./header-lens-switch-regression.ts";
import { checkTerminalComposition } from "./terminal-composition-regression.ts";
import { checkTabMenu } from "./tab-menu-regression.ts";
import { checkDefaultView } from "./default-view-regression.ts";
import { checkSettingSurvivesReload } from "./settings-unload-regression.ts";
import { checkSettingsAcrossTabs } from "./settings-tabs-regression.ts";
import { checkTerminalInputSpacing } from "./terminal-input-spacing-regression.ts";
import { checkComposerReconnect } from "./composer-reconnect-regression.ts";
import { checkDroplet } from "./droplet-regression.ts";
import { checkTerminalKeyboardSuggestions } from "./terminal-keyboard-suggestions-regression.ts";
import { checkSplitView } from "./split-view-regression.ts";
import { checkTakeOver } from "./take-over-regression.ts";
import { checkTabOverflow } from "./tab-overflow-regression.ts";
import { checkAlertSound } from "./alert-sound-regression.ts";
import { checkBackgroundTabKeepsTerminalSize, checkChatKeepsTerminalSize, checkFocusedWindowReclaimsTerminalSize, checkPaneSwitchKeepsTerminalSize } from "./chat-size-regression.ts";
import { checkUpdateNotice } from "./update-notice-regression.ts";
import { checkTelemetrySettings } from "./telemetry-regression.ts";
import { chromePath } from "./chrome-path.ts";
// machine events stay on SSE here: these checks hold or watch /api/machines/events (the socket transport has its own checks)
process.env["OVIS_MACHINE_EVENTS_WS"] = "0";

async function timed(name: string, check: () => Promise<void>): Promise<void> {
  const started = performance.now();
  let checkFailed = false;
  try {
    await check();
  } catch (error) {
    checkFailed = true;
    throw error;
  } finally {
    try {
      console.log(`TIMING ${name} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    } catch (error) {
      if (!checkFailed) throw error;
    }
  }
}

function isWorkspaceMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "workspace_not_found";
}

export async function runUiContextChecks(): Promise<void> {
  const tempBase = existsSync("/tmp") ? "/tmp" : tmpdir();
  const root = realpathSync(mkdtempSync(join(tempBase, "hwc-")));
  const workspaces: string[] = [];
  const cleanupErrors: unknown[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  let failed = false;
  let failure: unknown;

  try {
    const cwdA = join(root, "a");
    const cwdB = join(root, "b");
    mkdirSync(cwdA);
    mkdirSync(cwdB);
    const createdA = await workspaceCreate({ cwd: cwdA, label: "ovis-contexts-a" });
    workspaces.push(createdA.workspace.workspace_id);
    const createdB = await workspaceCreate({ cwd: cwdB, label: "ovis-contexts-b" });
    workspaces.push(createdB.workspace.workspace_id);
    const paneA = createdA.root_pane.pane_id;
    const paneB = createdB.root_pane.pane_id;
    await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });

    // herdr's config is none here, whatever HERDR_CONFIG_PATH the shell passed on: checkTerminalCopy asserts herdr's default
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root, usage: new UsageService({ ...systemUsageContext(), home: root, env: {} }, []), herdrConfigPath: join(root, "no-herdr-config.toml") });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox", "--accept-lang=en-US"],
    });

    await timed("checkPushSettings", () => checkPushSettings(browser!, origin));
    await timed("checkWakeLock", () => checkWakeLock(browser!, origin, paneA));
    await timed("checkSecretInput", () => checkSecretInput(browser!, origin));
    await timed("checkTerminalCopy", () => checkTerminalCopy(browser!, origin));
    await timed("checkTerminalCopyOff", () => checkTerminalCopyOff(browser!));
    await timed("checkPaneFind", () => checkPaneFind(browser!, origin));
    await timed("checkUsageMeters", () => checkUsageMeters(browser!, origin));
    await timed("checkUsageSignInAgain", () => checkUsageSignInAgain(browser!, origin));
    await timed("checkNotificationStartup", () => checkNotificationStartup(browser!, origin, paneA, paneB));
    await timed("checkNotificationView", () => checkNotificationView(browser!, origin));
    await timed("checkMobileViewport", () => checkMobileViewport(browser!, origin, paneB));
    await timed("checkTerminalPinch", () => checkTerminalPinch(browser!, origin, paneB));
    await timed("checkKeyBarKeepsKeyboardDown", () => checkKeyBarKeepsKeyboardDown(browser!, origin));
    await timed("checkMobileTabs", () => checkMobileTabs(browser!, origin));
    await timed("checkHeaderLensSwitch", () => checkHeaderLensSwitch(browser!, origin));
    await timed("checkTerminalComposition", () => checkTerminalComposition(browser!, origin));
    await timed("checkTabMenu", () => checkTabMenu(browser!, origin));
    await timed("checkDefaultView", () => checkDefaultView(browser!, origin));
    await timed("checkSettingSurvivesReload", () => checkSettingSurvivesReload(browser!, origin));
    await timed("checkSettingsAcrossTabs", () => checkSettingsAcrossTabs(browser!, origin));
    await timed("checkTerminalInputSpacing", () => checkTerminalInputSpacing(browser!, origin));
    await timed("checkComposerReconnect", () => checkComposerReconnect(browser!, origin, paneB));
    await timed("checkDroplet", () => checkDroplet(browser!, origin));
    await timed("checkTerminalKeyboardSuggestions", () => checkTerminalKeyboardSuggestions(browser!, origin));
    await timed("checkSplitView", () => checkSplitView(browser!, origin));
    await timed("checkTakeOver", () => checkTakeOver(browser!, origin));
    await timed("checkTabOverflow", () => checkTabOverflow(browser!, origin));
    await timed("checkAlertSound", () => checkAlertSound(browser!, origin));
    await timed("checkChatKeepsTerminalSize", () => checkChatKeepsTerminalSize(browser!, origin));
    await timed("checkPaneSwitchKeepsTerminalSize", () => checkPaneSwitchKeepsTerminalSize(browser!, origin));
    await timed("checkBackgroundTabKeepsTerminalSize", () => checkBackgroundTabKeepsTerminalSize(browser!, origin));
    await timed("checkFocusedWindowReclaimsTerminalSize", () => checkFocusedWindowReclaimsTerminalSize(browser!, origin));
    await timed("checkUpdateNotice", () => checkUpdateNotice(browser!, origin));
    await timed("checkTelemetrySettings", () => checkTelemetrySettings(browser!));
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (browser) {
    try { await browser.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (server) {
    try { server.stop(); } catch (error) { cleanupErrors.push(error); }
  }
  for (const workspace of workspaces) {
    try { await workspaceClose(workspace); } catch (error) { if (!isWorkspaceMissing(error)) cleanupErrors.push(error); }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }

  if (failed) {
    if (cleanupErrors.length) console.error(new AggregateError(cleanupErrors, "UI context fixture cleanup failed after the check failed"));
    throw failure;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "UI context fixture cleanup failed");
}
