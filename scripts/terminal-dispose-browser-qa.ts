import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildXtermSource, xtermSourcePlugin } from "./build-xterm.ts";
import { chromePath } from "./chrome-path.ts";

const root = join(import.meta.dir, "..");
const xterm = buildXtermSource(root);
const entry = join(import.meta.dir, "terminal-dispose-fixture.ts");
const bundle = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  plugins: [xtermSourcePlugin(xterm)],
  files: {
    [entry]: `
      import { Terminal } from ${JSON.stringify(join(xterm, "browser/public/Terminal.js"))};
      import { disposeAfterPendingFrame } from "../src/lib/terminalDispose.ts";
      const host = document.querySelector("#terminal");
      const output = document.querySelector("#result");
      for (const mode of ["immediate", "deferred"]) {
        document.querySelector("#" + mode).addEventListener("click", async () => {
          const errors = [];
          const onError = (event) => { errors.push(event.message); event.preventDefault(); };
          window.addEventListener("error", onError);
          const originalFrame = window.requestAnimationFrame.bind(window);
          const originalCancelFrame = window.cancelAnimationFrame.bind(window);
          const frames = new Map();
          let nextFrameId = 0;
          window.requestAnimationFrame = (callback) => {
            // Keep these IDs disjoint from Chromium's handles while queued callbacks are flushed.
            const id = --nextFrameId;
            frames.set(id, callback);
            return id;
          };
          window.cancelAnimationFrame = (id) => { frames.delete(id); };
          const terminal = new Terminal({ cols: 80, rows: 24 });
          terminal.open(host);
          terminal.reset();
          let disposed = 0;
          const retire = { dispose() { disposed++; terminal.dispose(); } };
          let stdinDisabled = false;
          let detachedAtCleanup = false;
          if (mode === "immediate") retire.dispose();
          else {
            terminal.options.disableStdin = true;
            stdinDisabled = terminal.options.disableStdin;
            terminal.element.remove();
            detachedAtCleanup = !host.contains(terminal.element);
            disposeAfterPendingFrame(retire);
          }
          const pendingFrames = frames.size;
          const disposedBeforeFrames = disposed;
          const scheduled = Array.from(frames.entries());
          // Restore first so xterm callbacks that request another frame reach Chromium instead of
          // being stranded in this one-shot queue. Keep cancellation aware of still-pending fakes.
          window.requestAnimationFrame = originalFrame;
          window.cancelAnimationFrame = (id) => {
            if (!frames.delete(id)) originalCancelFrame(id);
          };
          for (const [id, callback] of scheduled) {
            if (!frames.delete(id)) continue;
            try { callback(performance.now()); }
            catch (error) { errors.push(String(error)); }
          }
          window.cancelAnimationFrame = originalCancelFrame;
          // the deferred disposal waits for the task after xterm's frame, not the frame itself
          const disposedAfterFrames = disposed;
          // The bug is ordering between a render frame and the task it schedules.
          // Give a frame requested by an xterm callback its own turn before removing the error hook.
          await new Promise(resolve => originalFrame(() => originalFrame(() => setTimeout(resolve, 0))));
          window.removeEventListener("error", onError);
          output.textContent = JSON.stringify({ errors, disposed, disposedBeforeFrames, disposedAfterFrames, pendingFrames, stdinDisabled, detachedAtCleanup });
          console.info("DISPOSED:" + mode);
        });
      }
    `,
  },
});
assert.equal(bundle.success, true, String(bundle.logs));
const script = bundle.outputs.find((file) => file.path.endsWith(".js"));
assert.ok(script);
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    return new Response('<!doctype html><button id="immediate">Immediate</button><button id="deferred">Deferred</button><div id="terminal"></div><pre id="result"></pre><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
  },
});
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.port}`);
  for (const mode of ["immediate", "deferred"]) {
    const finished = page.waitForEvent("console", { predicate: (message) => message.text() === `DISPOSED:${mode}`, timeout: 10_000 });
    await page.getByRole("button", { name: mode, exact: false }).click();
    await finished;
    const result: { errors: string[]; disposed: number; disposedBeforeFrames: number; disposedAfterFrames: number; pendingFrames: number; stdinDisabled: boolean; detachedAtCleanup: boolean } = JSON.parse(await page.locator("#result").innerText());
    assert.ok(result.pendingFrames > 0);
    assert.equal(result.disposed, 1);
    // xterm 5.5 threw "dimensions" from the frame of a terminal disposed at once; 6.0 does not (#1617),
    // and neither path may
    assert.deepEqual(result.errors, [], JSON.stringify(result));
    if (mode === "deferred") {
      assert.equal(result.disposedBeforeFrames, 0, "deferred disposal ran before xterm's pending frame");
      assert.equal(result.disposedAfterFrames, 0, "deferred disposal ran before the task after xterm's frame");
      assert.equal(result.stdinDisabled, true);
      assert.equal(result.detachedAtCleanup, true);
    }
    console.log(`PASS actual xterm ${mode}: ${JSON.stringify(result)}`);
  }
} finally {
  await browser.close();
  server.stop(true);
}
