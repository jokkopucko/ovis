import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { chromium, type CDPSession } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const repo = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "ovis-pwa-"));
const app = join(root, "app");
const baseline = join(root, "baseline");
const current = join(repo, "dist");
const evidence = process.env.UI_EVIDENCE_DIR;
const thread = "01a12d00-0000-7000-9000-000000000001";
const codexHome = join(root, "codex-home");
const transcript = join(codexHome, "sessions", `rollout-pwa-${thread}.jsonl`);
let workspace: string | undefined;
let server: ReturnType<typeof import("../server/index.ts").createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

function entryScript(html: string): string {
  const entry = html.match(/<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"/)?.[1];
  assert.ok(entry, "the real built shell has a module entry");
  return entry;
}

function cachedBuild(cdp: CDPSession, origin: string, entry: string) {
  let stopped = false;
  let checking = false;
  let changedWhileChecking = false;
  const required = new Map([[`${origin}/`, entry], [new URL(entry, origin).href, ""]]);
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const stop = () => {
    stopped = true;
    clearTimeout(deadline);
    cdp.off("Storage.cacheStorageContentUpdated", changed);
  };
  const changed = () => {
    if (stopped) return;
    if (checking) { changedWhileChecking = true; return; }
    checking = true;
    void (async () => {
      try {
        do {
          changedWhileChecking = false;
          const { caches } = await cdp.send("CacheStorage.requestCacheNames", { securityOrigin: origin });
          const found = new Set<string>();
          for (const cache of caches) {
            const { cacheDataEntries } = await cdp.send("CacheStorage.requestEntries", { cacheId: cache.cacheId });
            for (const item of cacheDataEntries) {
              const marker = required.get(item.requestURL);
              if (marker === undefined) continue;
              const { response } = await cdp.send("CacheStorage.requestCachedResponse", {
                cacheId: cache.cacheId, requestURL: item.requestURL, requestHeaders: [],
              });
              const body = Buffer.from(response.body, "base64").toString("utf8");
              if (body.length && body.includes(marker)) found.add(item.requestURL);
            }
          }
          if (found.size === required.size) { stop(); resolveReady(); return; }
        } while (changedWhileChecking && !stopped);
      } catch (error) {
        if (!stopped) { stop(); rejectReady(error instanceof Error ? error : new Error(String(error))); }
      } finally { checking = false; }
    })();
  };
  const deadline = setTimeout(() => {
    stop();
    rejectReady(new Error(`the worker did not cache the shell and entry ${entry}`));
  }, 15_000);
  cdp.on("Storage.cacheStorageContentUpdated", changed);
  return { ready, stop };
}

try {
  assert.notEqual(process.env.HERDR_TEST_LIVE, "1", "PWA QA requires an isolated herdr session");
  assert.ok(process.env.HERDR_SOCKET, "the test-herdr preload must select the test socket before any workspace is created");
  console.log(`PWA isolated socket: ${process.env.HERDR_SOCKET}`);
  mkdirSync(app);
  for (const folder of ["server", "shared", "telemetry"]) {
    cpSync(join(repo, folder), join(app, folder), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
  }
  for (const file of ["package.json", "tsconfig.json"]) copyFileSync(join(repo, file), join(app, file));
  symlinkSync(join(repo, "node_modules"), join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  cpSync(process.env.PWA_BASELINE_DIR ? resolve(process.env.PWA_BASELINE_DIR) : current, baseline, { recursive: true });
  const newEntry = entryScript(readFileSync(join(current, "index.html"), "utf8"));
  if (!process.env.PWA_BASELINE_DIR) {
    const html = readFileSync(join(baseline, "index.html"), "utf8");
    const entry = entryScript(html);
    writeFileSync(join(baseline, "assets", "pwa-previous-entry.js"), `import "./${basename(entry)}";\n`);
    writeFileSync(join(baseline, "index.html"), html.replace(entry, "/assets/pwa-previous-entry.js"));
  }
  const oldEntry = entryScript(readFileSync(join(baseline, "index.html"), "utf8"));
  assert.notEqual(oldEntry, newEntry, "the two real app shells select distinct entry URLs");
  console.log(`PWA baseline ${process.env.PWA_BASELINE_DIR ?? "current app behind a previous entry"}: ${oldEntry} -> ${newEntry}`);

  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(transcript, [
    { type: "session_meta", payload: { id: thread, cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Check the PWA update." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "PWA update fixture is ready." }] } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Check the PWA update.");
  db.close();
  const standIn = join(root, "codex");
  writeFileSync(standIn, `#!/bin/sh\nprintf ready > "${join(root, "ready")}"\nwhile IFS= read -r line; do :; done\n`);
  chmodSync(standIn, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-pwa" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  const processReady = new Promise<void>((resolveReady, reject) => {
    const watcher = watch(root, (_event, file) => {
      if (file === "ready") { clearTimeout(deadline); watcher.close(); resolveReady(); }
    });
    const deadline = setTimeout(() => { watcher.close(); reject(new Error("the test Codex process did not start")); }, 10_000);
  });
  await Promise.all([processReady, herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${thread}\n` })]);
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
  const application: typeof import("../server/index.ts") = await import(pathToFileURL(join(app, "server", "index.ts")).href);
  server = application.createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  for (const width of [1440, 390]) {
    cpSync(baseline, join(app, "dist"), { recursive: true });
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      isMobile: width === 390, hasTouch: width === 390, colorScheme: "dark", serviceWorkers: "allow",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: { phase: string; url: string; status: number; fromWorker: boolean }[] = [];
    let phase = "baseline";
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.request().resourceType() === "document" || response.url().includes("/assets/")) {
        requests.push({ phase, url: response.url(), status: response.status(), fromWorker: response.fromServiceWorker() });
      }
    });
    const capture = async (name: string) => {
      if (!evidence) return;
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `pwa-${width}-${name}.png`) });
    };
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&view=chat`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".composer-text").waitFor();
    await page.evaluate(() => new Promise<void>((resolveControlled, reject) => {
      const controlled = () => {
        clearTimeout(deadline);
        navigator.serviceWorker.removeEventListener("controllerchange", controlled);
        resolveControlled();
      };
      const deadline = setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", controlled);
        reject(new Error("the real app did not register and activate its worker"));
      }, 15_000);
      navigator.serviceWorker.addEventListener("controllerchange", controlled);
      if (navigator.serviceWorker.controller) controlled();
    }));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Storage.trackCacheStorageForOrigin", { origin });
    const cachedOld = cachedBuild(cdp, origin, oldEntry);
    try { await Promise.all([cachedOld.ready, page.reload()]); } finally { cachedOld.stop(); }
    await page.locator(".composer-text").waitFor();
    await page.getByText("PWA update fixture is ready.", { exact: true }).waitFor();
    const draft = `Unsent PWA draft ${width} 한글`;
    await page.locator(".composer-text").fill(draft);
    assert.equal(await page.locator(".composer-text").inputValue(), draft);
    await capture("baseline");
    const offlineShell = async (entry: string) => {
      await context.setOffline(true);
      assert.equal(await page.evaluate(async () => {
        try {
          await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
          return false;
        } catch (error) { return error instanceof TypeError; }
      }), true, "uncached API requests really fail while offline");
      await page.reload();
      // App intentionally waits for the server's auth state before mounting any terminal
      // or composer. Offline boot must show that shell, not bypass the auth boundary.
      await page.locator(".app-header").waitFor();
      const placeholder = page.locator(".terminal-placeholder-inner span");
      await placeholder.waitFor();
      assert.ok((await placeholder.textContent())?.trim(), "the cached app draws its connection state, not a blank root");
      assert.equal(await page.locator('script[type="module"][src]').getAttribute("src"), entry);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), `ovis:composer-draft:${pane}`), draft,
        "the draft survives while the offline composer is unmounted");
      assert.ok(requests.some((request) => request.phase === phase && request.url === new URL(entry, origin).href && request.status === 200 && request.fromWorker),
        "the entry really loads from the service worker while offline");
    };

    phase = "baseline-offline";
    await offlineShell(oldEntry);
    await capture("baseline-offline");
    await context.setOffline(false);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.locator(".composer-text").waitFor();
    assert.equal(await page.locator(".composer-text").inputValue(), draft, "the baseline also restores the draft when online");
    await page.getByText("PWA update fixture is ready.", { exact: true }).waitFor();

    renameSync(join(app, "dist"), join(app, "old-dist"));
    cpSync(current, join(app, "dist"), { recursive: true });
    assert.equal(await page.locator(".composer-text").inputValue(), draft, "changing the served build does not reload the open draft");
    phase = "updated";
    const cachedNew = cachedBuild(cdp, origin, newEntry);
    try { await Promise.all([cachedNew.ready, page.reload()]); } finally { cachedNew.stop(); }
    await page.locator(".conn-live").waitFor();
    await page.locator(".composer-text").waitFor();
    assert.equal(await page.locator('script[type="module"][src]').getAttribute("src"), newEntry);
    assert.equal(await page.locator(".composer-text").inputValue(), draft, "online update preserves the draft");
    await page.getByText("PWA update fixture is ready.", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await capture("updated");
    console.log(`PASS PWA ${width}: old build -> new build, actual cached shell/entry and unsent draft`);

    phase = "offline";
    await offlineShell(newEntry);
    await capture("offline");
    phase = "recovered";
    await context.setOffline(false);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.locator(".composer-text").waitFor();
    assert.equal(await page.locator(".composer-text").inputValue(), draft);
    await page.getByText("PWA update fixture is ready.", { exact: true }).waitFor();
    await capture("recovered");
    assert.deepEqual(errors, [], "the app never raises a page error during the transition");
    if (evidence) writeFileSync(join(evidence, `pwa-${width}-network.json`), JSON.stringify({ oldEntry, newEntry, requests, errors }, null, 2));
    console.log(`PASS PWA ${width}: offline cached app and online recovery retain the unsent draft`);
    await context.close();
    rmSync(join(app, "dist"), { recursive: true, force: true });
    rmSync(join(app, "old-dist"), { recursive: true, force: true });
  }
} catch (error) {
  if (evidence && browser) {
    const page = browser.contexts().flatMap((context) => context.pages()).at(-1);
    if (page) {
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, "pwa-failure.png") });
      writeFileSync(join(evidence, "pwa-failure.json"), JSON.stringify(await page.evaluate(() => ({
        url: location.href,
        text: document.body.innerText,
        online: navigator.onLine,
        controlled: !!navigator.serviceWorker.controller,
        scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
        drafts: Object.fromEntries(Object.keys(localStorage).filter((key) => key.includes("draft")).map((key) => [key, localStorage.getItem(key)])),
      })), null, 2));
    }
  }
  throw error;
} finally {
  await browser?.close();
  server?.stop();
  try { if (workspace) await workspaceClose(workspace); }
  finally { rmSync(root, { recursive: true, force: true }); }
  console.log("CLEANUP PWA browser, server, owned workspace and temporary app removed");
}
