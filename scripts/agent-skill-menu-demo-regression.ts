import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { caseRun, type ColorScheme, type SkillMenuCase } from "./skill-menu-case.ts";
import { openLens } from "./header-lens.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const caseDir = join(import.meta.dir, "skill-menu-cases");
const evidenceRoot = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "agent-skill-menu");
const TARGET = panes.hermes;
const WIDTHS = [1280, 390] as const;

const named = process.argv.slice(2);
const names = named.length > 0 ? named : readdirSync(caseDir).filter((file) => file.endsWith(".ts")).map((file) => file.slice(0, -".ts".length)).sort();
const cases: (SkillMenuCase & { name: string })[] = [];
for (const name of names) {
  const loaded = await import(`./skill-menu-cases/${name}.ts`) as SkillMenuCase;
  assert.equal(name.split("-")[0], loaded.agent, `scripts/skill-menu-cases/${name}.ts is ${loaded.agent}'s case`);
  cases.push({ ...loaded, name });
}

const failures: string[] = [];
let screenshots = 0;

const patch = `<script>(() => {
  const TARGET = ${JSON.stringify(TARGET)};
  const fix = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) { value.forEach(fix); return value; }
    const { agent, commands, turnText } = window.skillCase;
    // the pane, in a snapshot's panes and agents: the case's agent
    if (value.pane_id === TARGET && "agent_status" in value && "agent" in value) value.agent = agent;
    // GET /api/pane/commands: the case's list
    if (Array.isArray(value.commands)) value.commands = commands.map((command) => ({ ...command }));
    // GET /api/pane/conversation of the chat: one more user turn, half a minute after the last
    if (value.source === "hermes-transcript" && Array.isArray(value.turns) && !value.turns.some((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text === turnText))) {
      const last = value.turns[value.turns.length - 1];
      const at = last ? Date.parse(last.end_ts ?? last.ts) + 30_000 : Date.now();
      value.turns.push({ role: "user", ts: new Date(at).toISOString(), parts: [{ kind: "text", text: turnText }] });
    }
    for (const key of Object.keys(value)) fix(value[key]);
    return value;
  };
  const clone = structuredClone;
  window.structuredClone = (value, options) => fix(clone(value, options));
  const parse = JSON.parse;
  JSON.parse = function (text, reviver) { return fix(parse.call(JSON, text, reviver)); };
  const json = Response.prototype.json;
  Response.prototype.json = async function () { return fix(await json.call(this)); };
})();</script>`;

await withDemoBrowser({ tempPrefix: "herdr-agent-skill-menu-demo-", beforeTransport: `${patch}\n    ` }, async ({ browser, baseUrl }) => {
  const url = `${baseUrl}?pane=${encodeURIComponent(TARGET)}`;

  const withPane = async (browser: Browser, width: number, scheme: ColorScheme, skillCase: SkillMenuCase, run: (page: Page) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await appContext(browser, { viewport: { width, height: touch ? 844 : 800 }, hasTouch: touch, isMobile: touch, colorScheme: scheme });
    try {
      await context.addInitScript((patched) => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: patched.scheme }));
        if (patched.enterSends && localStorage.getItem("ovis:enter-sends") === null) localStorage.setItem("ovis:enter-sends", "true");
        const sentSubmits: string[] = [];
        Object.assign(window, { skillCase: patched, sentSubmits });
        let current = window.WebSocket;
        Object.defineProperty(window, "WebSocket", {
          configurable: true,
          get: () => current,
          set: (next: typeof WebSocket) => {
            current = function (url: string | URL, protocols?: string | string[]) {
              const socket = new next(url, protocols);
              const send = socket.send.bind(socket);
              socket.send = (data) => {
                try { const frame = JSON.parse(String(data)) as { type?: unknown; text?: unknown }; if (frame.type === "submit") sentSubmits.push(String(frame.text)); } catch {}
                send(data);
              };
              return socket;
            } as unknown as typeof WebSocket;
          },
        });
      }, { agent: skillCase.agent, commands: skillCase.commands, turnText: skillCase.turnText, scheme, enterSends: skillCase.enterSendsAt?.includes(width) ?? false });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      if (await page.locator(".terminal-stack.is-chat").count() === 0) await openLens(page, "chat");
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".terminal-stack.is-chat .composer-attach:enabled").waitFor();
      await page.locator(".chat-turn-user").first().waitFor();
      await appFaces(page);
      await run(page);
      if (errors.length > 0) failures.push(`${skillCase.agent} pane at ${width}px (${scheme}): page errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
    }
  };

  for (const skillCase of cases) {
    const evidence = join(evidenceRoot, skillCase.name);
    mkdirSync(evidence, { recursive: true });
    const lines: string[] = [];
    const log = (line: string): void => { lines.push(line); console.log(line); };
    log(`${skillCase.name}: ${skillCase.commands.length} commands, chips ${skillCase.chips.join(", ")}`);
    for (const scheme of skillCase.schemes ?? ["dark" as const]) for (const width of skillCase.widths ?? WIDTHS) await withPane(browser, width, scheme, skillCase, async (page) => {
      const scenario = async (name: string, file: string | null, run: (capture: () => Promise<void>) => Promise<void>): Promise<void> => {
        let captured = false;
        const capture = async (): Promise<void> => {
          if (captured || file === null) return;
          captured = true;
          await page.screenshot({ path: join(evidence, file) });
          screenshots += 1;
          log(`  ${file}`);
        };
        try {
          await run(capture);
          log(`PASS ${name}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try { await capture(); } catch (shot) { log(`  (no screenshot: ${shot instanceof Error ? shot.message : String(shot)})`); }
          failures.push(`${skillCase.name} ${name}: ${message}`);
          log(`FAIL ${name}: ${message}`);
        }
      };
      await skillCase.expect(caseRun(page, width, skillCase, scenario, log, scheme));
    });
    writeFileSync(join(evidence, "run.log"), lines.join("\n") + "\n");
  }
});

console.log(failures.length === 0
  ? `PASS ${names.join(", ")} skill menu and chips: ${screenshots} screenshots in ${evidenceRoot}`
  : `FAIL ${failures.length} case(s):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
if (failures.length > 0) process.exitCode = 1;
