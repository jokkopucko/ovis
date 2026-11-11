import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { SetupJob, SetupRequest } from "../shared/machines.ts";

// Render the real dialog against synthetic setup responses. No SSH host or herdr is used.
const repo = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "herdr-machine-dialog-"));
try {
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const entry = join(root, "entry.tsx");
  writeFileSync(entry, `
    import React, { useState } from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
    import ${JSON.stringify(join(repo, "src/styles.css"))};
    import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
    import { MachineDialog } from ${JSON.stringify(join(repo, "src/components/MachineDialog.tsx"))};
    function Fixture() {
      const [connected, setConnected] = useState("");
      return <SettingsProvider>{connected ? <p>Connected: {connected}</p> :
        <MachineDialog onClose={() => setConnected("closed")} onConnected={setConnected} />}</SettingsProvider>;
    }
    createRoot(document.getElementById("root")).render(<Fixture />);
  `);
  const out = join(root, "dist");
  const build = await Bun.build({ entrypoints: [entry], outdir: out, target: "browser", define: { __APP_REVISION__: JSON.stringify("fixture"), __APP_VERSION__: JSON.stringify("fixture") } });
  assert.ok(build.success, build.logs.map(String).join("\n"));
  writeFileSync(join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (!["/", "/entry.js", "/entry.css"].includes(path)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(out, path === "/" ? "index.html" : path.slice(1))));
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const requests: SetupRequest[] = [];
          let approvals = 0;
          let job: SetupJob;
          await page.route("**/api/machines/setup**", async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (request.method() === "POST" && path === "/api/machines/setup") {
              requests.push(request.postDataJSON());
              job = { id: "setup", machine_id: "fixture", target: { destination: "fixture-only" },
                phase: requests.length === 1 ? "failed" : "approval", step: requests.length === 1 ? "Connection failed" : "Review the changes on this PC",
                error: requests.length === 1 ? "Bridge version mismatch" : null, action_required: requests.length === 1 ? "update_bridge" : null,
                installations: ["Download and verify the bridge runtime, then restart this bridge"], challenge: null, ssh_output: null, progress: null };
            } else if (request.method() === "POST" && path === "/api/machines/setup/setup") {
              assert.deepEqual(request.postDataJSON(), { action: "approve" });
              approvals++;
              job = { ...job!, phase: "connected", step: "Connected" };
            } else assert.equal(request.method(), "GET");
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
          });
          await page.goto(`http://127.0.0.1:${server.port}/`);
          const dialog = page.getByRole("dialog", { name: "Add PC", exact: true });
          const destination = dialog.getByRole("textbox", { name: "SSH alias or user@address", exact: true });
          await destination.fill("fixture-only");
          await destination.press("Enter");
          const update = dialog.getByRole("button", { name: "Update bridge and connect", exact: true });
          await update.waitFor();
          assert.deepEqual(requests, [{ destination: "fixture-only" }]);
          assert.equal(await dialog.getByRole("button", { name: "Retry connection", exact: true }).count(), 0);
          const settled = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          await destination.fill("");
          await update.click();
          await settled();
          assert.equal(await destination.evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
          assert.equal(requests.length, 1, "update click obeys the required destination");
          await destination.fill("fixture-only");
          await dialog.locator("summary").click();
          const port = dialog.getByRole("spinbutton", { name: "SSH port", exact: true });
          await port.fill("70000");
          await update.click();
          await settled();
          assert.equal(await port.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow), true);
          assert.equal(requests.length, 1, "update click obeys the SSH port range");
          await port.fill("2222");
          await destination.press("Enter");
          const approve = dialog.getByRole("button", { name: "Install and connect", exact: true });
          await approve.waitFor();
          assert.deepEqual(requests, [{ destination: "fixture-only" }, { destination: "fixture-only", port: 2222, update_remote: true }]);
          assert.equal(approvals, 0, "Enter requests an update but does not approve it");
          await approve.click();
          await dialog.getByRole("button", { name: "Open PC", exact: true }).click();
          await page.getByText("Connected: fixture", { exact: true }).waitFor();
          assert.equal(approvals, 1);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: version failure → validated update by Enter → separate approval → Open PC`);

          await page.unroute("**/api/machines/setup**");
          for (const choice of ["Use work", "Start a new herdr here", "Use Ovis on this PC (herdr-core)"] as const) {
            const selected: SetupRequest[] = [];
            const socket = "/home/fixture/desktop/herdr/sessions/work/herdr.sock";
            await page.route("**/api/machines/setup**", async (route) => {
              if (route.request().method() === "POST") {
                selected.push(route.request().postDataJSON());
                // what the server sends for a PC that runs both its own Ovis and herdr sessions (server/machines.ts)
                job = { id: "found", machine_id: "fixture", target: { destination: "fixture-only" },
                  phase: selected.length === 1 ? "failed" : "connected", step: selected.length === 1 ? "Connection failed" : "Connected",
                  action_required: selected.length === 1 ? "choose_herdr" : null,
                  found_herdr_sessions: [{ socket_path: socket, session: "work", label: "work" }, { socket_path: "/home/fixture/.config/herdr/herdr.sock", label: "Default session" }],
                  found_ovis: [{ socket_path: "/home/fixture/.config/ovis/hc-adapter.sock", runtime: "herdr-core" }],
                  installations: [], challenge: null, error: selected.length === 1 ? "Choose this PC's Ovis server or a running herdr session." : null, ssh_output: null };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await page.reload();
            await destination.fill("fixture-only");
            await destination.press("Enter");
            await dialog.getByRole("button", { name: choice, exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const shots = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "found-herdr"); mkdirSync(shots, { recursive: true });
            for (const theme of ["light", "dark"]) {
              await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
              // the picture is taken once the buttons' colours have settled, not mid-transition
              await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
              await page.screenshot({ path: join(shots, `choice-${width}-${theme}.png`) });
            }
            // a choice to make is not a failure: the dialog asks, and this PC's own Ovis is its first, main answer
            assert.equal(await dialog.getByText("Connection failed").count(), 0, "a needed choice does not read as a failed connection");
            await dialog.getByText("Choose this PC's Ovis server or a running herdr session.", { exact: true }).waitFor();
            const answers = dialog.locator(".machine-action button");
            assert.deepEqual(await answers.allTextContents(), ["Use Ovis on this PC (herdr-core)", "Use work", "Use Default session", "Start a new herdr here"]);
            assert.equal(await answers.first().evaluate((button) => button.classList.contains("btn-primary")), true);
            await dialog.getByRole("button", { name: choice, exact: true }).click();
            await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
            assert.deepEqual(selected, [{ destination: "fixture-only" }, choice === "Use work"
              ? { destination: "fixture-only", session: "work", herdr_socket: socket }
              : choice === "Use Ovis on this PC (herdr-core)" ? { destination: "fixture-only", own_ovis: "/home/fixture/.config/ovis/hc-adapter.sock" }
              : { destination: "fixture-only", start_new_herdr: true }]);
            await page.unroute("**/api/machines/setup**");
          }
          console.log(`PASS ${width}px: found session offers reuse or explicit new start and sends the chosen identity`);
          for (const choice of ["Start a new herdr here", "Use work", "Use Ovis on this PC (herdr-core)"] as const) for (const changed of ["address", "port", "session"] as const) {
            const selected: SetupRequest[] = [];
            await page.route("**/api/machines/setup**", async (route) => {
              if (route.request().method() === "POST") {
                const target = route.request().postDataJSON() as SetupRequest;
                selected.push(target);
                job = { id: "bound", machine_id: "fixture", target, phase: "failed", step: selected.length === 1 ? "Choose a session" : "Attempt failed",
                  action_required: selected.length === 1 ? "choose_herdr" : null,
                  found_herdr_sessions: [{ socket_path: "/home/fixture/desktop/herdr/sessions/work/herdr.sock", session: "work", label: "work" }],
                  found_ovis: [{ socket_path: "/home/fixture/.config/ovis/hc-adapter.sock", runtime: "herdr-core" }],
                  installations: [], challenge: null, error: null, ssh_output: null };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await page.reload(); await destination.fill("fixture-only"); await destination.press("Enter");
            await dialog.getByRole("button", { name: choice, exact: true }).click();
            await dialog.getByText("Attempt failed", { exact: true }).waitFor();
            assert.equal(selected.length, 2);
            if (changed === "address") await destination.fill("another-pc");
            else {
              await dialog.locator("summary").click();
              if (changed === "port") await dialog.getByRole("spinbutton", { name: "SSH port", exact: true }).fill("2222");
              else await dialog.getByRole("textbox", { name: "herdr session name", exact: true }).fill("different");
            }
            await Promise.all([
              page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/machines/setup"),
              dialog.getByRole("button", { name: "Retry connection", exact: true }).click(),
            ]);
            assert.equal(selected[2]?.start_new_herdr, undefined, `${choice}: ${changed} edit clears new-start consent`);
            assert.equal(selected[2]?.herdr_socket, undefined, `${choice}: ${changed} edit clears chosen socket`);
            assert.equal(selected[2]?.own_ovis, undefined, `${choice}: ${changed} edit clears chosen Ovis`);
            await page.unroute("**/api/machines/setup**");
          }
          console.log(`PASS ${width}px: failed choices lose consent and socket on address, port or session edits`);
          {
            const selected: SetupRequest[] = [];
            await page.route("**/api/machines/setup**", async (route) => {
              if (route.request().method() === "POST") {
                const target = route.request().postDataJSON() as SetupRequest;
                selected.push(target);
                job = { id: "core-stopped", machine_id: "fixture", target, phase: selected.length === 3 ? "connected" : "failed", step: "Choose a runtime",
                  action_required: selected.length === 3 ? null : "choose_herdr",
                  found_herdr_sessions: [], found_ovis: selected.length === 1 ? [{ socket_path: "/home/fixture/.config/ovis/hc-adapter.sock", runtime: "herdr-core" }] : [],
                  installations: [], challenge: null, error: selected.length === 2 ? "Start Ovis on that PC, or start a new herdr here" : null, ssh_output: null };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await page.reload(); await destination.fill("fixture-only"); await destination.press("Enter");
            await dialog.getByRole("button", { name: "Use Ovis on this PC (herdr-core)", exact: true }).click();
            await dialog.locator(".machine-action strong").filter({ hasText: "Start Ovis on that PC, or start a new herdr here" }).waitFor();
            const shots = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "found-herdr"); mkdirSync(shots, { recursive: true });
            for (const theme of ["light", "dark"]) {
              await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
              await page.screenshot({ path: join(shots, `core-stopped-${width}-${theme}.png`) });
            }
            await dialog.getByRole("button", { name: "Start a new herdr here", exact: true }).click();
            await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
            assert.deepEqual(selected[2], { destination: "fixture-only", start_new_herdr: true });
            await page.unroute("**/api/machines/setup**");
            console.log(`PASS ${width}px: stopped core offers explicit new herdr and clears its chosen Ovis`);
          }
          {
            // an address edited while the first request is still in flight: its answer never offers that PC's sessions here
            let release!: () => void;
            const held = new Promise<void>((resolve) => { release = resolve; });
            const sent: SetupRequest[] = [];
            await page.route("**/api/machines/setup**", async (route) => {
              if (route.request().method() === "POST") {
                const target = route.request().postDataJSON() as SetupRequest;
                sent.push(target);
                if (sent.length === 1) await held;
                job = { id: "inflight", machine_id: "fixture", target, phase: "failed", step: sent.length === 1 ? "Choose a session" : "Attempt failed",
                  action_required: sent.length === 1 ? "choose_herdr" : null,
                  found_herdr_sessions: [{ socket_path: "/home/fixture/desktop/herdr/sessions/work/herdr.sock", session: "work", label: "work" }],
                  installations: [], challenge: null, error: null, ssh_output: null };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await page.reload(); await destination.fill("fixture-only");
            const requested = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/machines/setup");
            const answered = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/machines/setup");
            await destination.press("Enter");
            await requested;
            await destination.fill("another-pc");
            release();
            await answered;
            await dialog.getByText("Choose a session", { exact: true }).waitFor();
            assert.equal(await dialog.getByRole("button", { name: "Use work", exact: true }).count(), 0, "in-flight edit: no sessions of the PC it was sent for");
            assert.equal(await dialog.getByRole("button", { name: "Start a new herdr here", exact: true }).count(), 0, "in-flight edit: no new-start choice for the edited PC");
            await page.unroute("**/api/machines/setup**");
          }
          console.log(`PASS ${width}px: an address edited in flight never receives the choices of the PC it was sent for`);
          {
            let release!: () => void;
            const held = new Promise<void>((resolve) => { release = resolve; });
            await page.route("**/api/machines/setup**", async (route) => {
              if (route.request().method() === "POST") {
                const target = route.request().postDataJSON() as SetupRequest;
                await held;
                job = { id: "polled", machine_id: "fixture", target, phase: "checking", step: "Checking the old PC", action_required: null, installations: [], challenge: null, error: null, ssh_output: null };
              } else job = { ...job!, phase: "failed", step: "Polled session choices", action_required: "choose_herdr", found_herdr_sessions: [{ socket_path: "/home/fixture/.config/herdr/herdr.sock", label: "Default session" }] };
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await page.reload(); await destination.fill("fixture-only");
            const requested = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/machines/setup");
            await destination.press("Enter"); await requested;
            await destination.fill("another-pc"); release();
            await dialog.getByText("Polled session choices", { exact: true }).waitFor();
            assert.equal(await dialog.getByRole("button", { name: "Use Default session", exact: true }).count(), 0, "poll: old PC sessions never appear for the edited identity");
            assert.equal(await dialog.getByRole("button", { name: "Start a new herdr here", exact: true }).count(), 0, "poll: old PC never grants new-start consent");
            await page.unroute("**/api/machines/setup**");
          }
          console.log(`PASS ${width}px: polling never restores session choices for a different form identity`);
          for (const decision of ["early_close", "cancel", "close", "start_headless"] as const) {
            const actions: unknown[] = [];
            await page.route("**/api/machines/setup**", async (route) => {
              const request = route.request();
              if (request.method() === "POST" && new URL(request.url()).pathname === "/api/machines/setup") {
                assert.deepEqual(request.postDataJSON(), { destination: "fixture-only" });
                job = { id: "login", machine_id: "fixture", target: { destination: "fixture-only" }, windows_startup: true, phase: decision === "early_close" ? "installing" : "starting", step: decision === "early_close" ? "Installing verified Windows bundle…" : "Waiting for Windows sign-in on this PC.", action_required: decision === "early_close" ? null : "windows_login", installations: [], challenge: null, error: null, ssh_output: null };
              } else if (request.method() === "POST") {
                actions.push(request.postDataJSON());
                job = { ...job!, action_required: null, phase: decision === "start_headless" ? "connected" : "cancelled", step: decision === "start_headless" ? "Connected" : "Cancelled" };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await page.reload();
            await destination.fill("fixture-only");
            await destination.press("Enter");
            if (decision === "early_close") await dialog.getByText("Keep this dialog open until the PC connects.", { exact: true }).waitFor();
            else {
              await dialog.getByText("Waiting for Windows sign-in", { exact: true }).waitFor();
              await dialog.getByText(/Starting without Windows sign-in can break Codex sandbox commands/).waitFor();
            }
            assert.deepEqual(actions, [], "waiting and polling never authorize a headless start");
            assert.equal(await dialog.getByRole("button", { name: "Continue in background", exact: true }).count(), 0, "an unsaved waiting PC must not become unreachable in the background");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (decision === "start_headless") {
              const shots = join(repo, "evidence/windows-startup"); mkdirSync(shots, { recursive: true });
              await page.screenshot({ path: join(shots, `waiting-${width}.png`) });
            }
            await Promise.all([
              page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/machines/setup/login"),
              dialog.getByRole("button", { name: decision === "cancel" ? "Cancel connection" : decision === "close" || decision === "early_close" ? "Close PC setup" : "Start without Windows sign-in", exact: true }).click(),
            ]);
            assert.deepEqual(actions, [{ action: decision === "close" || decision === "early_close" ? "cancel" : decision }]);
            if (decision === "start_headless") await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
            await page.unroute("**/api/machines/setup**");
          }
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: Windows login waits without consent → cancel or explicit headless start`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
