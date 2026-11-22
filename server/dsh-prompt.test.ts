import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { handlePromptRequest, type PromptRequestOptions } from "./prompt.ts";

// dsh-tui 0.20.0's ask_user_question panel (fixtures/dsh-question-0.20.0-*.txt) through the real routes, redrawn after
// each key as dsh-tui draws it (AskUserQuestionPanel.js)
const fixture = (name: string): string[] => readFileSync(join(import.meta.dir, "fixtures", `dsh-question-0.20.0-${name}.txt`), "utf8").split("\n");
const Q1 = fixture("q1");
const TOP = Q1.slice(0, 37);
const HINT = Q1.slice(44, 46);
const TYPING_HINT = fixture("q1-custom").slice(44, 46);
const FOOTER = Q1.slice(46);
const OPTIONS = [
  ["Device + WebDriverAgent (Recommended)", "Uses iphone172 and the MacBook; no App Attest workaround, no ToS risk, durable."],
  ["Dev API + Firebase token", "No hardware, but depends on an unprotected staging API."],
] as const;

interface Panel { status: string; cursor: number; text: string; open: boolean; answers: unknown[]; sent: string[]; onSent?: (sent: string) => void }

function panelLines(panel: Panel): string[] {
  const rows = OPTIONS.flatMap(([label, description], index) => [
    ...(index === panel.cursor ? [""] : []),
    `    ${index === panel.cursor ? "❯●" : " ○"} ${label}`,
    `       ${description}`,
  ]);
  const onText = panel.cursor === OPTIONS.length;
  return [...rows, ...(onText ? [""] : []), `    ${onText ? "❯" : " "}✎ Custom answer：${panel.text || (onText ? "" : " Type directly…")}`, "", ...(onText ? TYPING_HINT : HINT)];
}

function screen(panel: Panel): string {
  // dsh-tui takes the panel down once it is answered or cancelled, and its input box comes back
  if (!panel.open) return [...TOP.slice(0, 32), "  ● Answers received.", "", "  ╭────╮", "  ⌸ ❯", "  ╰────╯", ...FOOTER.slice(0, 2)].join("\n");
  return [...TOP, ...panelLines(panel), ...FOOTER].join("\n");
}

function press(panel: Panel, key: string): void {
  if (key === "down") panel.cursor = Math.min(OPTIONS.length, panel.cursor + 1);
  else if (key === "up") panel.cursor = Math.max(0, panel.cursor - 1);
  else if (key === "enter" && panel.open) {
    // Enter on an empty free-text row only asks for text
    if (panel.cursor === OPTIONS.length && !panel.text) return;
    panel.answers.push(panel.text ? { custom: panel.text } : OPTIONS[panel.cursor]![0]);
    panel.open = false;
  } else if (key.startsWith("text:") && panel.open) panel.text += key.slice(5);
}

async function withDsh(panel: Panel, run: () => Promise<void>, drawn: (panel: Panel) => string = screen): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dsh-prompt-"));
  const path = join(root, "herdr.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "dsh-tui", agent_status: panel.status }], layouts: [] } });
      if (request.method === "pane.read") return answer({ read: { text: drawn(panel) } });
      if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1", agent: "dsh-tui", agent_status: panel.status, scroll: { offset_from_bottom: 0 } } });
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: [] } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
      for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
        panel.sent.push(sent);
        press(panel, sent);
        panel.onSent?.(sent);
      }
      answer({});
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(); } finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const MIXED = "用WDA方案先在真机上跑通，然后把预发环境的接口当作夜间任务的后备，手机离线时自动切换，两条路径都记日志，这样两周后可以比较哪条更稳定一些。";
const CHINESE = "先在真机上跑通方案然后把预发环境的接口当作夜间任务的后备手机离线时自动切换两条路径都记日志这样两周后可以比较哪条更稳定一些";
const newPanel = (status = "blocked"): Panel => ({ status, cursor: 0, text: "", open: true, answers: [], sent: [] });

async function card(): Promise<InteractivePrompt | null> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  return ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt | null }).prompt;
}

async function answer(body: Record<string, unknown>, options: PromptRequestOptions = {}): Promise<number> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  return (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "p_1", ...body }) }), url, options))!.status;
}

describe("dsh-tui's question through the answer route", () => {
  test("a typed answer goes in on the free-text row, then Enter", async () => {
    const panel = newPanel();
    await withDsh(panel, async () => {
      expect(await answer({ prompt_id: (await card())!.id, custom_text: "node\n--test" })).toBe(200);
      expect(panel.sent).toEqual(["down", "down", "text:node --test", "enter"]);
      expect(panel.answers).toEqual([{ custom: "node --test" }]);
    });
  });

  test.each([
    ["words typed into the row after the answer's text", (panel: Panel) => { panel.text += " AND MINE"; }],
    ["the question cancelled after the answer's text", (panel: Panel) => { panel.open = false; }],
  ])("sends no Enter with %s", async (_, change) => {
    const panel = newPanel();
    panel.onSent = (sent) => { if (sent.startsWith("text:")) change(panel); };
    await withDsh(panel, async () => {
      expect(await answer({ prompt_id: (await card())!.id, custom_text: "card words" })).toBe(409);
      expect(panel.sent).toEqual(["down", "down", "text:card words"]);
      expect(panel.answers).toEqual([]);
    });
  });

  test("sends no Enter when the question closes during the look right before it", async () => {
    const panel = newPanel();
    const beforeKey = async (): Promise<void> => { if (panel.text) panel.open = false; };
    await withDsh(panel, async () => {
      expect(await answer({ prompt_id: (await card())!.id, custom_text: "card words" }, { beforeKey })).toBe(409);
      expect(panel.sent).toEqual(["down", "down", "text:card words"]);
    });
  });

  test("sends no Enter onto a row where a space was put in at the wrap (the row recorded at 118 columns)", async () => {
    const panel = newPanel();
    const typed = "Use the device with WebDriverAgent first, then keep the staging API as a fallback for nightlyruns when the phone is offline, and log both paths so we can compare flakiness over two weeks";
    const wrapped = readFileSync(join(import.meta.dir, "fixtures", "dsh-question-0.20.0-q1-typed-wrapped.txt"), "utf8");
    await withDsh(panel, async () => {
      expect(await answer({ prompt_id: (await card())!.id, custom_text: typed })).toBe(409);
      expect(panel.sent).toEqual(["down", "down", `text:${typed}`]);
    }, (drawn) => drawn.text ? wrapped : screen(drawn));
  });

  test.each([
    ["q1-typed-mixed", MIXED], ["q1-typed-mixed-111", MIXED],
    ["q1-typed-chinese-111", CHINESE], ["q1-typed-chinese-107", CHINESE], ["q1-typed-chinese-101", CHINESE],
  ])("sends the Enter for a Chinese answer whose row ends a cell short, the `：` kept or squeezed out (%s, recorded)", async (name, text) => {
    const panel = newPanel();
    const row = readFileSync(join(import.meta.dir, "fixtures", `dsh-question-0.20.0-${name}.txt`), "utf8");
    await withDsh(panel, async () => {
      expect(await answer({ prompt_id: (await card())!.id, custom_text: text })).toBe(200);
      expect(panel.sent).toEqual(["down", "down", `text:${text}`, "enter"]);
    }, (drawn) => drawn.text ? row : screen(drawn));
  });

  test("sends no Enter onto a row, its `：` squeezed out, that holds other words than the answer (101 columns, recorded)", async () => {
    const panel = newPanel();
    const other = CHINESE.replace("两周后", "三周后");
    const row = readFileSync(join(import.meta.dir, "fixtures", "dsh-question-0.20.0-q1-typed-chinese-101.txt"), "utf8");
    await withDsh(panel, async () => {
      expect(await answer({ prompt_id: (await card())!.id, custom_text: other })).toBe(409);
      expect(panel.sent).toEqual(["down", "down", `text:${other}`]);
    }, (drawn) => drawn.text ? row : screen(drawn));
  });

  test.each(["idle", "done", "working"])("keeps the keys of a picker card on a dsh-tui pane at rest (%s), as without a dsh card", async (status) => {
    const panel = newPanel(status);
    const picker = ["", "  Pick a model", "", "  ❯ deepseek-flash", "    deepseek-pro", "", "  ↑/↓ move · Enter select · Esc cancel"].join("\n");
    await withDsh(panel, async () => {
      const shown = (await card())!;
      expect(shown.fallback).toBe(true);
      expect(await answer({ prompt_id: shown.id, option_index: 0 })).toBe(200);
      expect(panel.sent).toEqual(["up"]);
    }, () => picker);
  });

  test("sends no key once herdr stops reporting the pane's dsh-tui as waiting, its panel still on the screen", async () => {
    const panel = newPanel();
    let answering = false;
    // dsh killed right after the answer's first read: its panel stays, the shell's prompt on the footer's last row
    const killed = (drawn: Panel): string => {
      if (answering) drawn.status = "unknown";
      return screen(drawn).replace(/   esc to interrupt\s*$/, "bash-5.3$ ");
    };
    await withDsh(panel, async () => {
      const id = (await card())!.id;
      answering = true;
      expect(await answer({ prompt_id: id, option_index: 1 })).toBe(409);
      expect(panel.sent).toEqual([]);
    }, (drawn) => answering ? killed(drawn) : screen(drawn));
  });

  test.each(["idle", "done", "working"])("offers no card for the panel while herdr says %s", async (status) => {
    const panel = newPanel(status);
    await withDsh(panel, async () => {
      expect(await card()).toBeNull();
    });
  });

  test.each([
    ["a panel with more output under it", (panel: Panel) => [...TOP, ...panelLines(panel), "", "  ● Done.", "  a", "  b", ...FOOTER].join("\n")],
    ["a quoted panel over dsh's input box", (panel: Panel) => [...TOP, ...panelLines(panel), "", "  ╭────╮", "  ⌸ ❯", "  ╰────╯", ...FOOTER.slice(0, 2)].join("\n")],
  ])("gives %s no question card, and its Enter stays unsent", async (_, drawn) => {
    const panel = newPanel();
    await withDsh(panel, async () => {
      const shown = await card();
      expect(shown?.fallback).toBe(true);
      expect(shown?.options.map((option) => option.label)).not.toContain(OPTIONS[0][0]);
      expect(panel.sent).toEqual([]);
    }, drawn);
  });

  test("still reads the live panel while herdr says blocked", async () => {
    const panel = newPanel();
    await withDsh(panel, async () => {
      expect((await card())?.options.map((option) => option.label)).toEqual(OPTIONS.map(([label]) => label));
    });
  });
});
