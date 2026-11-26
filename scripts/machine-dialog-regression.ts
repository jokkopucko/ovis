import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { SetupJob, SetupRequest } from "../shared/machines.ts";
import { sheetEntryLeft } from "./sheets-settled.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

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
    checkChromeTmpdir();
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
          // a phone's dialog holds a history entry and steps off it a moment after it closes: a reload asked
          // for before that step lands is dropped by it (net::ERR_ABORTED)
          const reload = async (): Promise<void> => { if (await dialog.count() === 0) await sheetEntryLeft(page); await page.reload(); };
          const destination = dialog.getByRole("textbox", { name: "SSH alias or user@address", exact: true });
          await destination.fill("fixture-only");
          await destination.press("Enter");
          const update = dialog.getByRole("button", { name: "Update bridge and connect", exact: true });
          await update.waitFor();
          assert.deepEqual(requests, [{ destination: "fixture-only" }]);
          assert.equal(await dialog.getByRole("button", { name: "Retry connection", exact: true }).count(), 0);
          const settled = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const fold = dialog.locator("form details");
          const advanced = async (): Promise<void> => { if (!await fold.evaluate((details: HTMLDetailsElement) => details.open)) await fold.locator("summary").click(); };
          await destination.fill("");
          await update.click();
          await settled();
          assert.equal(await destination.evaluate((input: HTMLInputElement) => input.validity.valueMissing), true);
          assert.equal(requests.length, 1, "update click obeys the required destination");
          await destination.fill("fixture-only");
          await advanced();
          const port = dialog.getByRole("spinbutton", { name: "SSH port", exact: true });
          await port.fill("70000");
          await update.click();
          await settled();
          assert.equal(await port.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow), true);
          assert.equal(requests.length, 1, "update click obeys the SSH port range");
          await port.fill("2222");
          const herdr = dialog.getByRole("checkbox", { name: "Use the default herdr session instead of Ovis", exact: true });
          assert.equal(await herdr.isChecked(), false, "Ovis is the default");
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
                job = { id: "found", machine_id: "fixture", target: { destination: "fixture-only" },
                  phase: selected.length === 1 ? "failed" : "connected", step: selected.length === 1 ? "Connection failed" : "Connected",
                  action_required: selected.length === 1 ? "choose_herdr" : null,
                  found_herdr_sessions: [{ socket_path: socket, session: "work", label: "work" }, { socket_path: "/home/fixture/.config/herdr/herdr.sock", label: "Default session" }],
                  found_ovis: [{ socket_path: "/home/fixture/.config/ovis/hc-adapter.sock", runtime: "herdr-core" }],
                  installations: [], challenge: null, error: selected.length === 1 ? "Choose this PC's Ovis server or a running herdr session." : null, ssh_output: null };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await reload();
            await destination.fill("fixture-only");
            await destination.press("Enter");
            const ovis = dialog.getByRole("button", { name: "Use Ovis on this PC (herdr-core)", exact: true });
            await ovis.waitFor();
            // beside the PC's Ovis its herdr sessions wait, closed, in the form's Advanced settings: the card offers the Ovis alone
            assert.equal(await fold.evaluate((details: HTMLDetailsElement) => details.open), false);
            assert.equal(await dialog.getByRole("button", { name: "Use work", exact: true }).count(), 0, "a session is not offered until Advanced settings opens");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const shots = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "found-herdr"); mkdirSync(shots, { recursive: true });
            for (const theme of ["light", "dark"]) {
              await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
              await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition) || animation.playState !== "running"));
              await page.screenshot({ path: join(shots, `choice-${width}-${theme}.png`) });
            }
            assert.equal(await dialog.getByText("Connection failed").count(), 0, "a needed choice does not read as a failed connection");
            await dialog.getByText("Choose this PC's Ovis server or a running herdr session.", { exact: true }).waitFor();
            const answers = dialog.locator(".machine-action button");
            assert.deepEqual(await answers.allTextContents(), ["Use Ovis on this PC (herdr-core)"]);
            assert.equal(await answers.first().evaluate((button) => button.classList.contains("btn-primary")), true);
            await advanced();
            assert.deepEqual(await fold.locator(".machine-action-buttons button").allTextContents(), ["Use work", "Use Default session", "Start a new herdr here"]);
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
            await reload(); await destination.fill("fixture-only"); await destination.press("Enter");
            await dialog.getByRole("button", { name: "Use Ovis on this PC (herdr-core)", exact: true }).waitFor();
            if (choice !== "Use Ovis on this PC (herdr-core)") await advanced();
            await dialog.getByRole("button", { name: choice, exact: true }).click();
            await dialog.getByText("Attempt failed", { exact: true }).waitFor();
            assert.equal(selected.length, 2);
            if (changed === "address") await destination.fill("another-pc");
            else {
              await advanced();
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
            await reload(); await destination.fill("fixture-only"); await destination.press("Enter");
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
            await reload(); await destination.fill("fixture-only");
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
            await reload(); await destination.fill("fixture-only");
            const requested = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/machines/setup");
            await destination.press("Enter"); await requested;
            await destination.fill("another-pc"); release();
            await dialog.getByText("Polled session choices", { exact: true }).waitFor();
            assert.equal(await dialog.getByRole("button", { name: "Use Default session", exact: true }).count(), 0, "poll: old PC sessions never appear for the edited identity");
            assert.equal(await dialog.getByRole("button", { name: "Start a new herdr here", exact: true }).count(), 0, "poll: old PC never grants new-start consent");
            await page.unroute("**/api/machines/setup**");
          }
          console.log(`PASS ${width}px: polling never restores session choices for a different form identity`);
          {
            const sent: SetupRequest[] = [];
            await page.route("**/api/machines/setup**", async (route) => {
              if (route.request().method() === "POST") {
                sent.push(route.request().postDataJSON());
                job = { id: "herdr", machine_id: "fixture", target: sent.at(-1)!, phase: "connected", step: "Connected", action_required: null, installations: [], challenge: null, error: null, ssh_output: null };
              }
              await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job!) });
            });
            await reload(); await advanced();
            // ticked first: editing the address or port afterwards keeps it
            await dialog.getByRole("checkbox", { name: "Use the default herdr session instead of Ovis", exact: true }).check();
            await destination.fill("fixture-only");
            await dialog.getByRole("spinbutton", { name: "SSH port", exact: true }).fill("");
            await destination.press("Enter");
            await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
            assert.deepEqual(sent, [{ destination: "fixture-only", start_new_herdr: true }]);
            await page.unroute("**/api/machines/setup**");
          }
          console.log(`PASS ${width}px: Advanced settings' herdr opt-out sends the PC's herdr instead of its Ovis`);
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
            await reload();
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
      // owner test #19: a PC whose own Ovis is older, offered a prerelease, in a Korean window
      for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, locale: "ko-KR" });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko", theme: "light" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          // a step on its way until the test saw it, then the failure: each is worded from its code
          let seen = false;
          await page.route("**/api/machines/setup**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(!seen ? {
            id: "older", machine_id: "fixture", target: { destination: "old-desktop" }, phase: "installing", step: "Installing verified linux-x64 bundle…",
            step_code: { code: "install_bundle", platform: "linux-x64" }, error: null, action_required: null, installations: [], challenge: null, ssh_output: null, progress: null,
          } satisfies SetupJob : {
            id: "older", machine_id: "fixture", target: { destination: "old-desktop" }, phase: "failed", step: "Connection failed", step_code: { code: "failed" },
            error: "This PC runs its own Ovis v0.5.1, older than this app. Update it to v0.5.10-beta.2 to reconnect; it updates itself, and herdr sessions keep running.",
            error_code: { code: "own_ovis_older", version: "0.5.1", target: "0.5.10-beta.2" }, action_required: "update_bridge",
            remote_ovis: { version: "0.5.1", latest_version: "0.5.10-beta.2", updatable: true, reason: null, address: "old-desktop:7317", url: null },
            installations: [], challenge: null, ssh_output: null, progress: null,
          } satisfies SetupJob) }));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          const dialog = page.getByRole("dialog", { name: "PC 추가", exact: true });
          const destination = dialog.getByRole("textbox", { name: "SSH 별칭 또는 user@주소", exact: true });
          await destination.fill("old-desktop");
          await destination.press("Enter");
          const card = dialog.locator(".machine-progress");
          // the step on its way is a stage of four, with its bar; the failure is words alone
          await card.locator('[role="progressbar"][aria-label="검증된 linux-x64 번들을 설치하는 중…"][aria-valuenow="63"][aria-valuetext="4단계 중 3"]').waitFor();
          seen = true;
          await card.locator("strong", { hasText: "연결 실패" }).waitFor();
          assert.equal(await card.getByRole("progressbar").count(), 0, "a failed setup shows no bar");
          assert.deepEqual(await card.locator("p").allTextContents(), [
            "이 PC에서 도는 자체 Ovis(v0.5.1)가 이 앱보다 오래됐습니다. 다시 연결하려면 미리보기 버전(v0.5.10-beta.2)으로 업데이트하세요.",
            "미리보기 버전은 정식 출시 전의 테스트 빌드입니다.",
          ], "the card says the older Ovis and the preview it updates to in Korean, with the line that a preview is a test build");
          assert.equal(await card.getByText(/older than this app|Connection failed/).count(), 0, "no English is left in the card");
          await dialog.getByRole("button", { name: "이 PC의 Ovis를 미리보기 버전으로 업데이트하고 연결", exact: true }).waitFor();
          if (process.env["UI_EVIDENCE_DIR"]) { mkdirSync(process.env["UI_EVIDENCE_DIR"], { recursive: true }); await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], `fix19-after-${width}-ko.png`) }); }
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: a step on its way and an older own Ovis offered a prerelease are worded in Korean from their codes, the failure as a preview update with its test-build line and the preview button`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
