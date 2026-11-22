import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import { startFakePushService } from "./push.fake.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-prompt-"));
let server: { port: number; stop: () => void };
const workspaces: string[] = [];

const MENU = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { head, rows, drift } = JSON.parse(spec);
let cursor = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  ...head, "", ...rows.map((row, index) => " " + (index === cursor ? "❯" : " ") + " " + row), "", " Enter to confirm · Esc to cancel",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  // drift: a key typed in the pane at the same moment, one more row down
  if (/\\u001b[\\[O]B/.test(data)) cursor = Math.min(rows.length - 1, cursor + 1 + (drift ? 1 : 0));
  if (/\\u001b[\\[O]A/.test(data)) cursor = Math.max(0, cursor - 1);
  if (data.includes("\\r")) appendFileSync(out, rows[cursor] + "\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

const TICKING = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out] = process.argv.slice(2);
const frames = ["✢", "✳", "✶", "✻", "✽"];
let tick = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  frames[tick % frames.length] + " Tempering… (" + (55 + tick) + "s · ↓ " + (10 + tick / 10).toFixed(1) + "k tokens)", "",
  "Which environment?", "", "  1. Staging", "  2. Production", "", "Enter a number, or Esc to cancel",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const key = chunk.toString("utf8");
  if (key === "1" || key === "2") appendFileSync(out, (key === "1" ? "Staging" : "Production") + "\\n");
});
setInterval(() => { tick += 1; draw(); }, 200);
draw();
writeFileSync(out, "");
`;

/**
 * Claude's command approval with two numbered rows, its whole panel under its rule: ↑/↓ move its `❯`, Enter or a row's number
 * logs the row it picks.
 */
const APPROVAL = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { rows } = JSON.parse(spec);
let cursor = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  "─".repeat(40), " Bash command", "", "   pwd", "", " Do you want to proceed?",
  ...rows.map((row, index) => " " + (index === cursor ? "❯" : " ") + " " + (index + 1) + ". " + row), "", " Esc to cancel",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  if (/\\u001b[\\[O]B/.test(data)) cursor = Math.min(rows.length - 1, cursor + 1);
  if (/\\u001b[\\[O]A/.test(data)) cursor = Math.max(0, cursor - 1);
  const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
  if (digit >= 0 && digit < rows.length) appendFileSync(out, rows[digit] + "\\n");
  else if (data.includes("\\r")) appendFileSync(out, rows[cursor] + "\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

interface Menu { pane: string; log: string }
let trust: Menu;
let guessed: Menu;
let drifting: Menu;
let ticking: Menu;
let twin: Menu;

async function menu(label: string, head: string[], rows: string[], drift = false, script = "menu.js"): Promise<Menu> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `ovis-test-prompt-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.log`);
  const spec = JSON.stringify({ head, rows, drift });
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "claude")}' '${join(root, script)}' '${log}' '${spec}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "blocked" });
  return { pane: created.root_pane.pane_id, log };
}

const base = () => `http://localhost:${server.port}`;
const chosen = (target: Menu) => readFileSync(target.log, "utf8").split("\n").filter(Boolean);

async function confirmed(target: Menu): Promise<string[]> {
  for (let i = 0; i < 40 && chosen(target).length === 0; i++) await Bun.sleep(50);
  return chosen(target);
}

async function card(target: Menu): Promise<{ id: string; kind: string; title: string; question: string; body: string | null; fallback?: true; options: { label: string }[] }> {
  for (let i = 0; i < 100; i++) {
    const { prompt } = await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(target.pane)}`)).json() as { prompt: any };
    if (prompt) return prompt;
    await Bun.sleep(50);
  }
  throw new Error("no card within 5s");
}

async function answer(target: Menu, promptId: string, optionIndex: number): Promise<Response> {
  return fetch(`${base()}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: target.pane, prompt_id: promptId, option_index: optionIndex }),
  });
}

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "menu.js"), MENU);
  writeFileSync(join(root, "tick.js"), TICKING);
  copyFileSync(process.execPath, join(root, "claude"));
  chmodSync(join(root, "claude"), 0o755);
  trust = await menu("trust", [" Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?"], ["No, exit", "Yes, I trust this folder"]);
  guessed = await menu("guessed", ["─".repeat(35), " Trust?"], ["Yes, trust and enable all hooks", "Yes, trust this folder", "No, exit"]);
  drifting = await menu("drifting", [" Accessing workspace:", "", " Quick safety check: Is this a project you created or one you trust?"], ["No, exit", "Yes, I trust this folder", "Yes, and enable its hooks"], true);
  ticking = await menu("ticking", [], [], false, "tick.js");
  twin = await menu("twin", [" Run the migration again?"], ["Yes, run it", "No, stop"]);
}, 30_000);

afterAll(async () => {
  server?.stop();
  for (const id of workspaces) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("answers to Claude's unnumbered menus", () => {
  it("moves the cursor to the row answered, then confirms it", async () => {
    const prompt = await card(trust);
    expect(prompt.options.map((option) => option.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    const response = await answer(trust, prompt.id, 1);
    expect(response.status).toBe(200);
    expect(await confirmed(trust)).toEqual(["Yes, I trust this folder"]);
  });

  it("confirms nothing when the cursor lands on a row the card does not show", async () => {
    const prompt = await card(guessed);
    expect(prompt.options).toHaveLength(2);
    const response = await answer(guessed, prompt.id, 1);
    expect(response.status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(guessed)).toEqual([]);
  });

  it("confirms nothing when the cursor moved past the row meanwhile", async () => {
    const prompt = await card(drifting);
    const response = await answer(drifting, prompt.id, 1);
    expect(response.status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(drifting)).toEqual([]);
  });

  it("refuses the id of a menu already answered once the same menu is asked again", async () => {
    const prompt = await card(twin);
    expect((await answer(twin, prompt.id, 0)).status).toBe(200);
    expect(await confirmed(twin)).toEqual(["Yes, run it"]);
    const again = await card(twin);
    expect(again.options).toEqual(prompt.options);
    expect(again.id).not.toBe(prompt.id);
    expect((await answer(twin, prompt.id, 0)).status).toBe(409);
    await Bun.sleep(300);
    expect(chosen(twin)).toEqual(["Yes, run it"]);
  });

  it("takes an answer to a fallback card whose screen only ticked since it was read", async () => {
    const prompt = await card(ticking);
    expect(prompt.fallback).toBe(true);
    expect(prompt.options.map((option) => option.label)).toEqual(["Staging", "Production", "Enter", "Esc"]);
    let later = prompt;
    for (let i = 0; i < 40 && later.body === prompt.body; i++) { await Bun.sleep(100); later = await card(ticking); }
    expect(later.body).not.toBe(prompt.body);
    expect(later.id).toBe(prompt.id);
    const response = await answer(ticking, prompt.id, 1);
    expect(response.status).toBe(200);
    expect(await confirmed(ticking)).toEqual(["Production"]);
  });
});

describe("answer buttons on a question's alert (#2916)", () => {
  it("carries the card's id and options, and its button's answer goes through as the card's would", async () => {
    const device = await startFakePushService();
    const alerting = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "push-buttons"), machines: false, pushLoopbackHttp: true, alertTiming: { short: 0, long: 0, longTurn: 0 } });
    try {
      const subscribe = await fetch(`http://127.0.0.1:${alerting.port}/api/push/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: device.subscription, alerts: { input: true, done: "off" } }),
      });
      expect(subscribe.status).toBe(204);
      writeFileSync(join(root, "approval.js"), APPROVAL);
      const asked = await menu("push-buttons", [], ["Yes", "No"], false, "approval.js");
      const question = (push: (typeof device.received)[number]) => push.payload.pane_id === asked.pane && push.payload.prompt_id !== undefined;
      const alert = () => device.received.find(question);
      for (let attempt = 0; attempt < 20 && !alert(); attempt++) {
        await herdrRpc("pane.report_agent", { pane_id: asked.pane, source: "manual", agent: "claude", state: "idle" });
        await herdrRpc("pane.report_agent", { pane_id: asked.pane, source: "manual", agent: "claude", state: "blocked" });
        await device.waitFor(question, "the question's alert", 1_000).catch(() => undefined);
      }
      const payload = alert()!.payload;
      const shown = await card(asked);
      expect(payload.prompt_id).toBe(shown.id);
      expect(shown.kind).toBe("approval");
      expect(payload.actions).toEqual([{ option_index: 0, label: "Yes" }, { option_index: 1, label: "No" }]);
      // what a tap allows is on the alert: the question and the command
      expect(payload.body).toContain("Do you want to proceed?");
      expect(payload.body).toContain("pwd");
      const response = await fetch(`http://127.0.0.1:${alerting.port}/api/pane/prompt/answer`, {
        method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
        body: JSON.stringify({ pane_id: asked.pane, prompt_id: payload.prompt_id, option_index: payload.actions![1]!.option_index }),
      });
      expect(response.status).toBe(200);
      expect(await confirmed(asked)).toEqual(["No"]);
    } finally {
      alerting.stop();
      device.stop();
    }
  }, 30_000);
});

/**
 * pi's dialogs against the real server. A pane runs a menu drawn the way pi draws it, reported
 * as `pi`, and — as measured on pi itself — reported **idle** while it waits: pi never calls
 * itself blocked for a dialog. So this is the case where the card has to come from the reader
 * rather than from the status badge, which is how the other agents' cards are gated.
 */
const PI_MENU = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { title, rows } = JSON.parse(spec);
let cursor = 0;
const draw = () => process.stdout.write("\\u001b[2J\\u001b[H" + [
  ...Array.from({ length: 10 }, (_, i) => "earlier line " + i), "",
  " " + title, "",
  ...rows.map((row, index) => (index === cursor ? " \\u2192 " : "   ") + row), "",
  " \\u2191\\u2193 navigate  enter select  escape/ctrl+c cancel",
  "\\u2500".repeat(40), "/tmp/app", "0.0%/215k (auto)                                   some-model \\u2022 medium",
].join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  if (/\\u001b\\[\\[?B/.test(data)) cursor = Math.min(rows.length - 1, cursor + 1);
  if (/\\u001b\\[\\[?A/.test(data)) cursor = Math.max(0, cursor - 1);
  if (data.includes("\\r")) appendFileSync(out, rows[cursor] + "\\n");
  draw();
});
draw();
writeFileSync(out, "");
`;

async function piMenu(label: string, title: string, rows: string[]): Promise<Menu> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `ovis-test-prompt-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.log`);
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "pi")}' '${join(root, "pi-menu.js")}' '${log}' '${JSON.stringify({ title, rows })}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  // pi reports idle while one of its dialogs is open, and the card still has to be offered
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "pi", state: "idle" });
  return { pane: created.root_pane.pane_id, log };
}

describe("answers to pi's dialogs", () => {
  let select: Menu;
  let confirm: Menu;

  beforeAll(async () => {
    writeFileSync(join(root, "pi-menu.js"), PI_MENU);
    copyFileSync(process.execPath, join(root, "pi"));
    chmodSync(join(root, "pi"), 0o755);
    select = await piMenu("pi-select", "Allow dangerous command?", ["Allow once", "Always allow", "Block"]);
    confirm = await piMenu("pi-confirm", "Clear session?", ["Yes", "No"]);
  }, 30_000);

  it("offers the card while pi reports the pane idle, and answers the row it showed", async () => {
    const prompt = await card(select);
    expect(prompt.question).toBe("Allow dangerous command?");
    expect(prompt.options.map((option) => option.label)).toEqual(["Allow once", "Always allow", "Block"]);
    expect((await answer(select, prompt.id, 2)).status).toBe(200);
    expect(await confirmed(select)).toEqual(["Block"]);
  });

  it("presses No on a confirmation rather than cancelling it", async () => {
    const prompt = await card(confirm);
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    expect((await answer(confirm, prompt.id, 1)).status).toBe(200);
    // pi's own Yes/No: pressing the row answers the question false, where Escape leaves it open
    expect(await confirmed(confirm)).toEqual(["No"]);
  });
});

/**
 * Claude Code's `/model` list against the real server. A pane runs a list drawn the way Claude
 * Code 2.1.290 draws it, reported as `claude` and, as measured on Claude Code itself, **idle**
 * while it waits. ↑/↓ move its `❯` inside a window of the list, `s` takes the row for the
 * session and Enter saves it as the default: the log says which key took which model.
 */
const MODEL_LIST = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out, spec] = process.argv.slice(2);
const { models, current, shown } = JSON.parse(spec);
let cursor = current;
let from = 0;
let taken = null;
const draw = () => {
  if (taken !== null) return void process.stdout.write("\\u001b[2J\\u001b[H" + ["❯ /model", "  ⎿  Set model to " + taken + " for this session only", "", "─".repeat(60), "❯ ", "─".repeat(60), "  [" + taken + "] │ app git:(main)"].join("\\r\\n"));
  // the window moves only when the cursor leaves it
  if (cursor < from) from = cursor;
  if (cursor >= from + shown) from = cursor - shown + 1;
  const below = models.length - from - shown;
  const rows = models.slice(from, from + shown).map(([name, said], index) => {
    const row = from + index;
    const mark = row === cursor ? "❯" : index === 0 && from > 0 ? "↑" : index === shown - 1 && below > 0 ? "↓" : " ";
    return "  " + mark + " " + (row + 1 + ".").padEnd(3) + " " + (name + (row === current ? " ✔" : "")).padEnd(21) + "  " + said;
  });
  process.stdout.write("\\u001b[2J\\u001b[H" + [
    "❯ /model", "", "─".repeat(100), "  Select model", "  Switch between Claude models. Your pick becomes the default for new sessions.", "",
    ...rows, ...(below > 0 ? ["     … +" + below + " model" + (below === 1 ? "" : "s")] : []), "",
    "  ◐ Medium effort (default) ←/→ to adjust", "", "  Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\\r\\n"));
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  // a key that comes after the list has closed went to Claude's own prompt: logged, so a test sees it
  if (taken !== null) return void appendFileSync(out, "stray: " + JSON.stringify(chunk.toString("utf8")) + "\\n");
  for (const key of chunk.toString("utf8").match(/\\u001b[\\[O][AB]|\\r|s/g) ?? []) {
    if (taken !== null) break;
    if (key.endsWith("B")) cursor = Math.min(models.length - 1, cursor + 1);
    else if (key.endsWith("A")) cursor = Math.max(0, cursor - 1);
    else {
      appendFileSync(out, (key === "s" ? "session: " : "default: ") + models[cursor][0] + "\\n");
      taken = models[cursor][0];
    }
  }
  draw();
});
draw();
writeFileSync(out, "");
`;

describe("picks from Claude Code's model list", () => {
  const MODELS: [name: string, said: string][] = [
    ["Default (recommended)", "Fable 5.1"], ["Opus 5.5", "For complex work and everyday tasks"], ["Fable 5.1", "For your toughest challenges"],
    ["Sonnet 5.5", "Most efficient for simpler tasks"], ["Haiku 4.5", "Fastest for quick answers"], ["Sonnet 5", "Efficient for routine tasks"],
    ["Opus 5", "Best for everyday, complex tasks"],
  ];
  let models: Menu;

  beforeAll(async () => {
    writeFileSync(join(root, "model.js"), MODEL_LIST);
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "ovis-test-prompt-claude-model", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const log = join(root, "claude-model.log");
    await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "claude")}' '${join(root, "model.js")}' '${log}' '${JSON.stringify({ models: MODELS, current: 1, shown: 5 })}'\n` });
    for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
    expect(existsSync(log)).toBe(true);
    await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
    models = { pane: created.root_pane.pane_id, log };
  }, 30_000);

  it("offers the rows drawn while herdr reports the pane idle, and takes the tapped one for this session", async () => {
    const prompt = await card(models);
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 2 more models are listed in the terminal.");
    expect(prompt.options.map((option) => option.label)).toEqual(MODELS.slice(0, 5).map(([name]) => name));
    // the window's last row, three below the cursor: ↓ ↓ ↓ and then s, never the Enter that saves a default
    expect((await answer(models, prompt.id, 4)).status).toBe(200);
    expect(await confirmed(models)).toEqual(["session: Haiku 4.5"]);
    let after: unknown = prompt;
    for (let i = 0; i < 100 && after !== null; i++) {
      await Bun.sleep(50);
      after = (await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(models.pane)}`)).json() as { prompt: unknown }).prompt;
    }
    expect(after).toBeNull();
    expect(chosen(models)).toEqual(["session: Haiku 4.5"]);
  });
});

const SCREENS = String.raw`
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const [out, specFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, "utf8"));
let frame = spec.frames[0];
let swap = spec.swap;
let cursor = 0;
const rows = () => frame.lines.join("\n").match(/\{\d+\}/g).length;
const draw = () => process.stdout.write("\u001b[2J\u001b[H" + frame.lines.map((line) => line.replace(/\{(\d+)\}/, (_, row) => Number(row) === cursor ? frame.mark : " ")).join("\r\n"));
const later = () => { if (existsSync(out + ".go")) draw(); else setTimeout(later, 20); };
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  const key = /\u001b[\[O]B/.test(data) ? "down" : /\u001b[\[O]A/.test(data) ? "up" : data === "\r" ? "enter" : data === "\t" ? "tab" : "text:" + data;
  if (key === "down") cursor = Math.min(rows() - 1, cursor + 1);
  if (key === "up") cursor = Math.max(0, cursor - 1);
  if (swap && key.split(":")[0] === swap) { frame = spec.frames[1]; swap = null; cursor = 0; }
  appendFileSync(out, key + "\n");
  if (spec.hold) later(); else draw();
});
draw();
writeFileSync(out, "");
`;

interface Frame { lines: string[]; mark: string }

async function screens(label: string, agent: string, spec: { frames: Frame[]; swap?: string; hold?: boolean }): Promise<Menu> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: `ovis-test-prompt-${label}`, cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  const log = join(root, `${label}.log`);
  writeFileSync(join(root, `${label}.json`), JSON.stringify(spec));
  if (!existsSync(join(root, agent))) { copyFileSync(process.execPath, join(root, agent)); chmodSync(join(root, agent), 0o755); }
  await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, agent)}' '${join(root, "screens.js")}' '${log}' '${join(root, `${label}.json`)}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent, state: "blocked" });
  return { pane: created.root_pane.pane_id, log };
}

async function send(target: Menu, promptId: string, choice: Record<string, unknown>): Promise<Response> {
  return fetch(`${base()}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: target.pane, prompt_id: promptId, ...choice }),
  });
}

async function keys(target: Menu): Promise<string[]> {
  let seen = chosen(target);
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    const now = chosen(target);
    if (now.length === seen.length) return now;
    seen = now;
  }
  return seen;
}

describe("an answer whose menu changes under it", () => {
  const continueMenu = (title: string, rows: string[]): Frame => ({
    mark: "›", lines: [title, "", ...rows.map((row, index) => `{${index}} ${index + 1}. ${row}`), "", "Press enter to continue"],
  });
  const resume = continueMenu("Conversation interrupted", ["Resume the task", "Start over", "Quit"]);
  const cleanup = continueMenu("Branch cleanup", ["Keep the branch", "Delete the branch", "Quit"]);
  const permission: Frame = { mark: "❯", lines: ["╭─ Permission ────────────╮", "│ Allow tool: bash", "│ rm -rf build", "│{0} Approve", "│{1} Deny", "╰─────────────────────────╯"] };
  let steady: Menu;
  let replaced: Menu;
  let ended: Menu;
  let denied: Menu;

  beforeAll(async () => {
    writeFileSync(join(root, "screens.js"), SCREENS);
    steady = await screens("codex-steady", "codex", { frames: [resume] });
    replaced = await screens("codex-replaced", "codex", { frames: [resume, cleanup], swap: "down" });
    ended = await screens("codex-ended", "codex", { frames: [resume], hold: true });
    denied = await screens("omp-denied", "omp", { frames: [permission] });
  }, 60_000);

  it("moves to the row of a Codex menu and confirms it", async () => {
    const prompt = await card(steady);
    expect(prompt.options.map((option) => option.label)).toEqual(["Resume the task", "Start over", "Quit"]);
    expect((await send(steady, prompt.id, { option_index: 2 })).status).toBe(200);
    expect(await keys(steady)).toEqual(["down", "down", "enter"]);
  });

  it("moves to Deny on omp's permission and presses it", async () => {
    const prompt = await card(denied);
    expect(prompt.options.map((option) => option.label)).toEqual(["Approve", "Deny"]);
    expect((await send(denied, prompt.id, { option_index: 1 })).status).toBe(200);
    expect(await keys(denied)).toEqual(["down", "enter"]);
  });

  it("presses no Enter into the menu that took a Codex menu's place under its move", async () => {
    const prompt = await card(replaced);
    const response = await send(replaced, prompt.id, { option_index: 1 });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
    expect(await keys(replaced)).toEqual(["down"]);
    expect((await card(replaced)).options.map((option) => option.label)).toEqual(["Keep the branch", "Delete the branch", "Quit"]);
  });

  it("presses no Enter once herdr reports the agent back at work under its move", async () => {
    const prompt = await card(ended);
    const socket = new WebSocket(`ws://localhost:${server.port}/ws`);
    const working = new Promise<void>((resolve) => socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; pane_id?: string; agent_status?: string };
      if (message.type === "pane-status" && message.pane_id === ended.pane && message.agent_status === "working") resolve();
    }));
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    try {
      const response = send(ended, prompt.id, { option_index: 1 });
      for (let i = 0; i < 100 && !chosen(ended).includes("down"); i++) await Bun.sleep(20);
      const waiting = performance.now();
      expect(chosen(ended)).toEqual(["down"]);
      await herdrRpc("pane.report_agent", { pane_id: ended.pane, source: "manual", agent: "codex", state: "working" });
      await working;
      await herdrRpc("pane.report_agent", { pane_id: ended.pane, source: "manual", agent: "codex", state: "blocked" });
      // well inside the answer's own wait (1.5 s) for the cursor: the refusal below is for the
      // asking that ended, not for a menu that never showed the move
      expect(performance.now() - waiting).toBeLessThan(600);
      writeFileSync(`${ended.log}.go`, "");
      expect((await response).status).toBe(409);
      expect(await keys(ended)).toEqual(["down"]);
    } finally { socket.close(); }
  });
});

/**
 * Codex's `/model` lists against the real server. A pane runs the two lists drawn the way Codex
 * 0.160.1 draws them, reported as `codex` and idle: the models, whose rows only open a model's
 * levels on Enter, then the levels, where `s` takes one for the session and Enter saves it as the
 * default. The footer is the row's own, and the log says which key did what.
 */
const CODEX_LISTS = `
const { appendFileSync, writeFileSync } = require("node:fs");
const [out] = process.argv.slice(2);
const MODELS = [["GPT-6.1-Sol (default)", "Latest workhorse model."], ["GPT-6-Astra", "Frontier intelligence."], ["GPT-6-Luna", "Fast and affordable."]];
const LEVELS = [["Low", "Lighter reasoning"], ["Medium (default)", "Everyday tasks"], ["High", "Complex problems"]];
let model = null;
let cursor = 1;
let taken = null;
const draw = () => {
  if (taken !== null) return void process.stdout.write("\\u001b[2J\\u001b[H" + ["• Model changed to " + taken + " for this session only", "", "› Ask Codex to do anything"].join("\\r\\n"));
  const rows = model === null ? MODELS : LEVELS;
  const width = Math.max(...rows.map(([name], row) => name.length + (row === 1 ? 10 : 0)));
  process.stdout.write("\\u001b[2J\\u001b[H" + [
    "  >_ OpenAI Codex (v0.160.1)", "", "  " + (model === null ? "Select Model and Effort" : "Select Reasoning Level for " + model), "", "",
    ...rows.map(([name, said], row) => (row === cursor ? "›" : " ") + " " + (row + 1) + ". " + (name + (row === 1 ? " (current)" : "")).padEnd(width) + "  " + said), "",
    model === null ? "  enter select · esc back" : "  enter default · s session · esc back",
  ].join("\\r\\n"));
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  // a key that comes after the lists have closed went to Codex's own prompt: logged, so a test sees it
  if (taken !== null) return void appendFileSync(out, "stray: " + JSON.stringify(chunk.toString("utf8")) + "\\n");
  for (const key of chunk.toString("utf8").match(/\\u001b[\\[O][AB]|\\r|s/g) ?? []) {
    const rows = model === null ? MODELS : LEVELS;
    if (key.endsWith("B")) cursor = Math.min(rows.length - 1, cursor + 1);
    else if (key.endsWith("A")) cursor = Math.max(0, cursor - 1);
    else if (model === null) {
      // a model's row takes Enter alone, and it only opens that model's levels
      if (key === "s") { appendFileSync(out, "ignored: s\\n"); continue; }
      model = MODELS[cursor][0].replace(" (default)", "");
      appendFileSync(out, "opened: " + model + "\\n");
      cursor = 1;
    } else {
      taken = model + " " + LEVELS[cursor][0];
      appendFileSync(out, (key === "s" ? "session: " : "default: ") + taken + "\\n");
      break;
    }
  }
  draw();
});
draw();
writeFileSync(out, "");
`;

describe("picks from Codex's model lists", () => {
  let lists: Menu;
  type Card = Awaited<ReturnType<typeof card>>;
  const shown = async (): Promise<Card | null> => (await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(lists.pane)}`)).json() as { prompt: Card | null }).prompt;

  beforeAll(async () => {
    writeFileSync(join(root, "codex-lists.js"), CODEX_LISTS);
    if (!existsSync(join(root, "codex"))) { copyFileSync(process.execPath, join(root, "codex")); chmodSync(join(root, "codex"), 0o755); }
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "ovis-test-prompt-codex-model", cwd: root, focus: false },
    );
    workspaces.push(created.workspace.workspace_id);
    const log = join(root, "codex-model.log");
    await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, "codex")}' '${join(root, "codex-lists.js")}' '${log}'\n` });
    for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
    expect(existsSync(log)).toBe(true);
    await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "codex", state: "idle" });
    lists = { pane: created.root_pane.pane_id, log };
  }, 30_000);

  it("opens a model's levels with Enter, then takes a level with s and never with the Enter that saves a default", async () => {
    const models = await card(lists);
    expect(models.question).toBe("Select model for this session (currently GPT-6-Astra)");
    expect(models.options.map((option) => option.label)).toEqual(["GPT-6.1-Sol (default)", "GPT-6-Astra", "GPT-6-Luna"]);
    expect((await answer(lists, models.id, 2)).status).toBe(200);
    let levels = await shown();
    for (let i = 0; i < 100 && (levels === null || levels.id === models.id); i++) { await Bun.sleep(50); levels = await shown(); }
    expect(levels!.question).toBe("Select reasoning level for GPT-6-Luna for this session (currently Medium)");
    expect(levels!.options.map((option) => option.label)).toEqual(["Low", "Medium (default)", "High"]);
    expect((await answer(lists, levels!.id, 2)).status).toBe(200);
    expect(await confirmed(lists)).toContain("session: GPT-6-Luna High");
    let after = await shown();
    for (let i = 0; i < 100 && after !== null; i++) { await Bun.sleep(50); after = await shown(); }
    expect(after).toBeNull();
    expect(chosen(lists)).toEqual(["opened: GPT-6-Luna", "session: GPT-6-Luna High"]);
  });
});
