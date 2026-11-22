import type { Browser } from "playwright-core";

export async function checkHeldDraftPaneSwitch(browser: Browser, origin: string, paneA: string, paneB: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript((ids) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, terminalInputMode: "direct" }));
      for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "terminal");
    }, [paneA, paneB]);
    await context.routeWebSocket(/\/ws(?:\?|$)/, (socket) => socket.close({ code: 1000, reason: "offline for the held-input check" }));
    const page = await context.newPage();
    const held = page.locator(".pane-frame.is-current .terminal-banner-warning .draft-held");
    const select = (paneId: string) => page.locator(`.pane-select[title^="${paneId} —"]`).click();
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
    await page.locator(".pane-frame.is-current .terminal-banner-warning").waitFor();
    await page.locator(".pane-frame.is-current .xterm-helper-textarea").focus();
    await page.keyboard.type("echo held-a");
    await held.filter({ hasText: "echo held-a" }).waitFor({ timeout: 10_000 });
    await select(paneB);
    await held.waitFor({ state: "detached", timeout: 10_000 });
    await select(paneA);
    await held.filter({ hasText: "echo held-a" }).waitFor({ timeout: 10_000 });
    console.log("PASS held terminal input survives a pane switch while offline");
  } finally {
    await context.close();
  }
  const notReady = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await notReady.addInitScript((ids) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, terminalInputMode: "direct" }));
      for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "terminal");
    }, [paneA, paneB]);
    await notReady.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => { if (!String(message).includes('"input-ready"')) socket.send(message); });
    });
    const page = await notReady.newPage();
    const held = page.locator(".pane-frame.is-current .terminal-banner-draft .draft-text");
    const select = (paneId: string) => page.locator(`.pane-select[title^="${paneId} —"]`).click();
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".pane-frame.is-current .xterm-helper-textarea").focus();
    await page.keyboard.type("echo held-b");
    await held.filter({ hasText: "echo held-b" }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Control+Backspace");
    await held.filter({ hasText: /^echo\s*$/ }).waitFor({ timeout: 10_000 });
    await page.keyboard.type("held-b");
    await held.filter({ hasText: /^echo held-b$/ }).waitFor({ timeout: 10_000 });
    await page.locator(".pane-frame.is-current .terminal-banner-draft .draft-send").click();
    await held.filter({ hasText: "echo held-b" }).waitFor({ timeout: 10_000 });
    await select(paneB);
    await held.waitFor({ state: "detached", timeout: 10_000 });
    await select(paneA);
    await held.filter({ hasText: "echo held-b" }).waitFor({ timeout: 10_000 });
    console.log("PASS a held draft whose send was refused survives a pane switch");
  } finally {
    await notReady.close();
  }
}
