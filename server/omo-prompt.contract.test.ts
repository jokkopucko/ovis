import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * The pane runs a
 * small form drawn as omo 5.1 draws its ask_user_question overlay, reported as `pi` (herdr's name
 * for an omo pane waiting on the user): arrows move the cursor, Enter picks an option, the last answer
 * opens the review, and Enter there submits.
 */
const root = mkdtempSync(join(tmpdir(), "ovis-omo-prompt-"));
let server: { port: number; stop: () => void };
let workspace: string | undefined;
let pane: string;
const log = join(root, "answers.log");

const FORM = `
const { appendFileSync, writeFileSync } = require("node:fs");
const out = process.argv[2];
const questions = [
  { header: "표시 위치", question: "음성 사용량을 어디에 보여줄까요?", options: ["설정", "사이드바"] },
  { header: "월 한도", question: "월 사용 한도를 둘까요?", options: ["한도 없음", "월 $5 한도"] },
];
const picked = [];
let tab = 0;
let cursor = 0;
const draw = () => {
  const tabs = questions.map((q, i) => (i === tab ? "→ " : "  ") + q.header + (picked[i] === undefined ? "" : " ✓")).join("  ")
    + "  " + (tab === questions.length ? "→ Submit" : "  Submit");
  const count = picked.filter((p) => p !== undefined).length;
  const body = tab < questions.length ? [
    " " + questions[tab].question,
    ...questions[tab].options.map((o, i) => (i === cursor ? " → " : "   ") + (i + 1) + ". " + o + (picked[tab] === i ? " ✓" : "")),
    "   Type your own answer...",
    " Submit (" + count + "/2 answered) — Enter advances",
    " ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel",
  ] : [
    " Review your answers",
    ...questions.map((q, i) => "   " + q.header + ": " + q.options[picked[i]]),
    "",
    " Comment (optional; unanswered questions are reported)",
    ">",
    " Submit (" + count + "/2 answered)",
    " enter submit  ↑ review answers  shift+tab back  tab next question  esc back",
  ];
  process.stdout.write("\\u001b[2J\\u001b[H" + ["", " Ask user · 30m", " " + tabs, ...body, "", "─".repeat(60), " ~/project · main"].join("\\r\\n"));
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  if (tab < questions.length && (data === "\\u001b[B" || data === "\\u001bOB")) {
    cursor = Math.min(questions[tab].options.length - 1, cursor + 1);
  } else if (tab < questions.length && (data === "\\u001b[A" || data === "\\u001bOA")) {
    cursor = Math.max(0, cursor - 1);
  } else if (tab < questions.length && (data.includes("\\r") || (/^[1-9]$/.test(data) && questions[tab].options[Number(data) - 1]))) {
    picked[tab] = data.includes("\\r") ? cursor : Number(data) - 1;
    appendFileSync(out, questions[tab].header + "=" + questions[tab].options[picked[tab]] + "\\n");
    tab += 1;
    cursor = 0;
  } else if (tab === questions.length && data.includes("\\r")) appendFileSync(out, "submitted\\n");
  draw();
});
// earlier output in the pane's history, for its viewport to scroll back to
process.stdout.write(" earlier output\\r\\n".repeat(80));
draw();
writeFileSync(out, "");
`;

const base = () => `http://localhost:${server.port}`;
const logged = () => readFileSync(log, "utf8").split("\n").filter(Boolean);

async function card(): Promise<{ id: string; title: string; options: { label: string }[]; steps?: { label: string; answered: boolean; current: boolean }[] }> {
  const { prompt } = await (await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json() as { prompt: any };
  if (!prompt) throw new Error("no card");
  return prompt;
}

async function answer(promptId: string, optionIndex: number): Promise<Response> {
  return fetch(`${base()}/api/pane/prompt/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: pane, prompt_id: promptId, option_index: optionIndex }),
  });
}

beforeAll(async () => {
  server = createServer({ port: 0, stateDir: join(root, "push") });
  writeFileSync(join(root, "form.js"), FORM);
  copyFileSync(process.execPath, join(root, "form"));
  chmodSync(join(root, "form"), 0o755);
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "ovis-test-omo-prompt", cwd: root, focus: false },
  );
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${join(root, "form")}' '${join(root, "form.js")}' '${log}'\n` });
  for (let i = 0; i < 200 && !existsSync(log); i++) await Bun.sleep(50);
  expect(existsSync(log)).toBe(true);
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "pi", state: "blocked" });
}, 30_000);

afterAll(async () => {
  server?.stop();
  if (workspace) await herdrRpc("workspace.close", { workspace_id: workspace }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("answers to omo's form of several questions", () => {
  it("asks one question at a time, each answer back once the form shows the next step", async () => {
    let prompt: Awaited<ReturnType<typeof card>> | undefined;
    for (let i = 0; i < 100 && !prompt; i++) {
      prompt = await card().catch(() => undefined);
      if (!prompt) await Bun.sleep(50);
    }
    expect(prompt).toMatchObject({ title: "Question 1 of 2", steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }] });
    expect(prompt!.options.map((option) => option.label)).toEqual(["설정", "사이드바"]);
    expect((await answer(prompt!.id, 1)).status).toBe(200);

    const { pane: { scroll } } = await herdrRpc<{ pane: { scroll: { offset_from_bottom: number; viewport_rows: number } } }>("pane.scroll", { pane_id: pane, offset_from_bottom: 60 });
    expect(scroll.offset_from_bottom).toBeGreaterThanOrEqual(scroll.viewport_rows);

    const second = await card();
    expect(second).toMatchObject({ title: "Question 2 of 2", steps: [{ label: "표시 위치", answered: true, current: false }, { label: "월 한도", answered: false, current: true }] });
    expect((await answer(second.id, 0)).status).toBe(200);

    const review = await card();
    expect(review.title).toBe("Review your answers");
    expect(review.options.map((option) => option.label)).toEqual(["Submit", "표시 위치: 사이드바", "월 한도: 한도 없음", "Comment (optional; unanswered questions are reported)"]);
    expect((await answer(second.id, 1)).status).toBe(409);
    expect((await answer(review.id, 0)).status).toBe(200);
    for (let i = 0; i < 40 && !logged().includes("submitted"); i++) await Bun.sleep(50);
    expect(logged()).toEqual(["표시 위치=사이드바", "월 한도=한도 없음", "submitted"]);
  });
});

describe("slash commands follow the pane's process", () => {
  const opened: string[] = [];
  afterAll(async () => {
    for (const id of opened) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
  });

  /**
   * A pane with any reported label, running a program of the given name that only waits. The program
   * is a small shell named so (argv[0]) that says when it is up and then waits in a read: herdr lists
   * no argv for a process in uninterruptible sleep, as a fresh bun is while it pages its binary in,
   * even after it has said so, and the commands are read from that argv (#2085).
   */
  async function waiting(program: string, agent: string | null = "pi"): Promise<string> {
    const ready = join(root, `${program}-${opened.length}.ready`);
    writeFileSync(join(root, program), `#!/bin/bash\nexec -a "$0" /bin/sh -c ': > "$1"; read _' "$0" "$1"\n`);
    chmodSync(join(root, program), 0o755);
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: `ovis-test-commands-${program}`, cwd: root, focus: false },
    );
    opened.push(created.workspace.workspace_id);
    const watcher = watch(root);
    const started = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Program did not create ${ready}`)), 10_000);
      watcher.on("change", () => {
        if (existsSync(ready)) { clearTimeout(timeout); resolve(); }
      });
    });
    try {
      await herdrRpc("pane.send_text", { pane_id: created.root_pane.pane_id, text: `exec '${join(root, program)}' '${ready}'\n` });
      await started;
    } finally { watcher.close(); }
    if (agent) await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent, state: "idle" });
    return created.root_pane.pane_id;
  }
  const rows = async (paneId: string) => ((await (await fetch(`${base()}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`)).json()) as { commands: { name: string; visibility?: string }[] }).commands;
  const names = async (paneId: string) => (await rows(paneId)).map((command) => command.name);

  it("offers pi's commands to a pi process", async () => {
    expect(await names(await waiting("pi"))).toContain("scoped-models");
  }, 30_000);

  it.each(["pi", "claude", null])("offers omo commands with the reported label %j", async (agent) => {
    const listed = await rows(await waiting("omo", agent));
    const commands = listed.map((command) => command.name);
    expect(commands).toContain("favorite-models");
    expect(commands).toContain("compact");
    // /tree opens a browser only the terminal draws: listed as a terminal command
    expect(listed.find((command) => command.name === "tree")?.visibility).toBe("terminal");
    expect(commands).not.toContain("config");
  }, 30_000);

  it("keeps Claude commands for a Claude process", async () => {
    const listed = await rows(await waiting("claude", "claude"));
    const commands = listed.map((command) => command.name);
    // Claude's own list: /model (a picker the chat answers) is offered, /config (a screen only the
    // terminal draws) is listed as a terminal command
    expect(commands).toContain("model");
    expect(listed.find((command) => command.name === "config")?.visibility).toBe("terminal");
    expect(commands).not.toContain("favorite-models");
  }, 30_000);
});
