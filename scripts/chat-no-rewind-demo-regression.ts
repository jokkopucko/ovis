/** Chat offers no Rewind: the real client over owned demo fixtures, as Claude Code, grok, Antigravity and Codex; no live herdr session. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

declare global { interface Window { chatAgent: string } }
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

await withDemoBrowser({ tempPrefix: "ovis-chat-no-rewind-demo-", beforeTransport: patch }, async ({ newContext, baseUrl, evidence }) => {
  for (const agent of ["claude", "grok", "agy", "codex"]) for (const width of [1280, 390]) {
    const phone = width === 390;
    const context = await newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: "dark" });
    try {
      await context.addInitScript((agent) => {
        window.chatAgent = agent;
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", darkTheme: "codex", defaultView: "chat", alertsOn: false }));
      }, agent);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.hermes)}&view=chat`);
      const frame = page.locator(`.pane-frame[data-layout-pane="${panes.hermes}"]`);
      const user = frame.locator(".chat-turn-user").first();
      const reply = frame.locator(".chat-turn-agent").first();
      await user.waitFor();
      await reply.waitFor();
      await appFaces(page);
      if (!phone) await user.hover();
      await user.getByRole("button", { name: "Copy message", exact: true }).waitFor();
      if (evidence) await page.screenshot({ path: join(evidence, `chat-no-rewind-${agent}-${width}-user.png`) });
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
});
