/** Chat offers no Rewind: the real client over owned demo fixtures, as Claude Code, grok, Antigravity and Codex; no live herdr session. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

declare global { interface Window { chatAgent: string } }
const app = mkdtempSync(join(tmpdir(), "ovis-chat-no-rewind-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
try {
  await buildDemoApp(app);
  // the demo's hermes pane, shown as the agent under test: every pane record that names its agent says that one
  const patch = `<script>(() => {
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      if (value.pane_id === ${JSON.stringify(panes.hermes)} && "agent_status" in value && "agent" in value) value.agent = window.chatAgent;
      for (const key of Object.keys(value)) fix(value[key]);
      return value;
    };
    const clone = structuredClone;
    window.structuredClone = (value, options) => fix(clone(value, options));
    const parse = JSON.parse;
    JSON.parse = function(text, reviver) { return fix(parse.call(JSON, text, reviver)); };
    const json = Response.prototype.json;
    Response.prototype.json = async function() { return fix(await json.call(this)); };
  })();</script>`;
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => patch + '<script src="./demo-transport.js"></script><script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    try {
      for (const agent of ["claude", "grok", "agy", "codex"]) for (const width of [1280, 390]) {
        const phone = width === 390;
        const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: "dark", locale: "en-US" });
        try {
          await context.addInitScript((agent) => {
            window.chatAgent = agent;
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex", defaultView: "chat", alertsOn: false }));
          }, agent);
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.hermes)}&view=chat`);
          const frame = page.locator(`.pane-frame[data-layout-pane="${panes.hermes}"]`);
          const user = frame.locator(".chat-turn-user").first();
          const reply = frame.locator(".chat-turn-agent").first();
          await user.waitFor();
          await reply.waitFor();
          await appFaces(page);
          // the message actions show on hover with a mouse, and always on touch
          if (!phone) await user.hover();
          await user.getByRole("button", { name: "Copy message", exact: true }).waitFor();
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `chat-no-rewind-${agent}-${width}-user.png`) }); }
          if (!phone) await reply.hover();
          await reply.getByRole("button", { name: /^Copy/ }).first().waitFor();
          if (evidence) await page.screenshot({ path: join(evidence, `chat-no-rewind-${agent}-${width}-reply.png`) });
          const rewind = await frame.locator("[role=log]").evaluateAll((nodes) => nodes.flatMap((node) =>
            [...node.querySelectorAll("button, [role=button], [role=menuitem], a")].map((control) =>
              [control.textContent, control.getAttribute("aria-label"), control.getAttribute("title"), control.className].join(" "))
              .filter((text) => /rewind/i.test(text))));
          assert.deepEqual(rewind, [], `${agent} at ${width}: Chat offers no Rewind`);
          assert.deepEqual(errors, []);
          console.log(`PASS ${agent}-${width}: no Rewind in a message's actions`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
