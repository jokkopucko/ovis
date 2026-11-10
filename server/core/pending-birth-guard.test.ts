import { afterEach, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as claude from "../claude-store.ts";
import * as client from "../herdr/client.ts";
import * as opencode from "../opencode-native.ts";
import * as pi from "../pi.ts";
import * as prompt from "../prompt.ts";
import * as processStart from "../process-start.ts";
import * as composer from "./composer.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

afterEach(() => { mock.restore(); setSystemTime(); });

const PROMPT = "Enter passphrase for key '/tmp/key': ";

/**
 * A queued message to an idle gjc pane (pid 41001), drained. `after` runs once the catalog the paste is prepared with
 * was read, the last await before the final checks of the paste; `afterPaste` once the paste was written. Both may
 * replace what the pane shows or runs, as another process or a prompt can between a check and herdr's write.
 */
async function drain({ after = () => {}, afterPaste = () => {}, mode = "gjc", tabRace = "none", screen = "", beforeDrain = () => {}, afterDrain, behind = 0 }: { after?: (pane: Pane) => void; afterPaste?: (pane: Pane) => void; mode?: Mode; tabRace?: "none" | "birth" | "masked" | "live"; screen?: string;
  /** once the message is queued (or held), before the agent's turn ends and the queue is drained (or before its Send now) */ beforeDrain?: (pane: Pane) => void;
  /** after that drain; `turn` is one more turn of the agent, ended, and the drain its end brings */ afterDrain?: (pane: Pane, turn: () => Promise<void>) => Promise<void>;
  /** how many more messages are queued behind the first */ behind?: number }) {
  spyOn(pi, "piTranscriptPath").mockResolvedValue(null);
  if (mode === "claude") { spyOn(claude, "claudeForegroundSession").mockResolvedValue("session-a"); spyOn(composer, "freeClaudeBox").mockResolvedValue(undefined as never); }
  if (mode === "skill") { spyOn(prompt, "prepareCommandSend").mockReturnValue({} as never); spyOn(prompt, "bindCommandProcess").mockImplementation(() => {}); spyOn(opencode, "startOpenCodeWatch").mockReturnValue(null); }
  const shown: Pane = { birth: 1_000 as number | null, screen, foreground: [{ pid: 41001, name: "gjc", argv: ["gjc"] }] };
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => shown.birth);
  spyOn(client, "paneProcessInfo").mockImplementation(async () => {
    shown.onProcessRead?.();
    return { pane_id: "p", shell_pid: 41000, foreground_processes: shown.foreground };
  });
  // OpenCode's autocomplete with the skill's row selected, as the skill key's own screen reads see it; `tabRace` changes
  // the pane during the read right before its Tab
  let visible = 0;
  const selected = readFileSync(join(import.meta.dir, "../fixtures/opencode-autocomplete-2.0.32-ansi-first-selected.ansi"), "utf8");
  spyOn(client, "paneRead").mockImplementation(async (options) => {
    if (mode !== "skill" || options.source !== "visible") {
      const text = shown.screen;
      shown.onScreenRead?.();
      return { text } as Awaited<ReturnType<typeof client.paneRead>>;
    }
    if (++visible === 2 && tabRace === "birth") shown.birth = 5_000;
    // the visible viewport, scrolled, still shows the row while the live screen has a masked prompt
    if (visible === 2 && tabRace === "live") shown.screen = PROMPT;
    return { text: tabRace === "masked" && visible >= 2 ? `${selected}\n${PROMPT}` : selected } as Awaited<ReturnType<typeof client.paneRead>>;
  });
  const skillsToType = opencode.openCodeSkillsToType;
  spyOn(opencode, "openCodeSkillsToType").mockImplementation(async (...args: Parameters<typeof skillsToType>) => {
    const result = mode === "skill" ? { sent: {} as never, skills: ["effect"] } : await skillsToType(...args);
    after(shown);
    return result;
  });
  const writes: string[] = [];
  spyOn(client, "paneSendText").mockImplementation(async () => { writes.push("paste"); afterPaste(shown); });
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane: string, keys: string[]) => {
    writes.push(keys.join("+"));
    // Codex shows the steered message waiting after its Enter; a masked prompt comes up during the steering's process check
    if (mode === "codex" && keys[0] === "Enter") {
      shown.screen = "• Working (2s • esc to interrupt)\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ FOLLOWUP\n› Ask Codex to do anything\n  gpt-6.1 default · /workspace\n";
      let reads = 0;
      shown.onProcessRead = () => { if (++reads === 3) shown.screen = PROMPT; };
    }
  });

  const agent = mode === "skill" || mode === "missing" ? "gjc" : mode === "codex-queued" ? "codex" : mode;
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent, agent_status: "working", cwd: "/tmp", focused: false, revision: 0 } as HerdrPane;
  const frames: ServerMessage[] = [];
  told = frames;
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as ServerMessage); return 1; } } as unknown as Client;
  owner.data.attached.set("p", { keepSize: false });
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(),
    sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
    serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ ...pane }] }) as unknown as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const text = mode === "skill" ? "@effect" : "FOLLOWUP";
  await delivery.pendingFrames.submit(owner, { type: "submit", id: 1, pane_id: "p", text, payload: text, delivery: mode === "codex" ? "hold" : "queue" });
  if (mode === "codex") {
    // a held message's Send now steers the working agent
    const held = frames.flatMap((frame) => frame.type === "submit-result" && frame.pending ? [frame.pending] : [])[0]!;
    beforeDrain(shown);
    await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.id, action: "steer" });
    return writes;
  }
  if (mode === "missing") shown.foreground = [];
  for (let more = 1; more <= behind; more++) await delivery.pendingFrames.submit(owner, { type: "submit", id: 10 + more, pane_id: "p", text: `${text} ${more}`, payload: `${text} ${more}`, delivery: "queue" });
  beforeDrain(shown);
  pane.agent_status = "idle";
  delivery.pending.status("p", "idle");
  delivery.drainPending("p");
  for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  await afterDrain?.(shown, async () => {
    delivery.pending.status("p", "working");
    delivery.pending.status("p", "idle");
    delivery.drainPending("p");
    for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  });
  return writes;
}
/** the frames the last drain's connection was sent, and the pending messages its last list holds: state and reason */
let told: ServerMessage[] = [];
const listed = (): Array<[string, string | undefined, string | undefined]> => told.flatMap((frame) => frame.type === "pending-messages" ? [frame.messages] : []).at(-1)
  ?.map((message) => [message.state, message.error?.code, message.error?.message]) ?? [];
/** `codex-queued`: a message queued to a Codex pane and drained once it is idle (`codex` is a held one's Send now) */
type Mode = "gjc" | "claude" | "pi" | "codex" | "codex-queued" | "skill" | "missing";
/** `onScreenRead`: as a read of the live screen is answered, after its text was taken */
interface Pane { birth: number | null; screen: string; foreground: Array<{ pid: number; name: string; argv: string[] }>; onProcessRead?: () => void; onScreenRead?: () => void }

it("types nothing into another process that took the agent's PID before the paste", async () => {
  expect(await drain({ after: (pane) => { pane.birth = 5_000; } })).toEqual([]);
});

it("types nothing once the agent's known start can no longer be read at its PID", async () => {
  expect(await drain({ after: (pane) => { pane.birth = null; } })).toEqual([]);
});

it("withholds the Enter from another process that took the agent's PID after the paste", async () => {
  expect(await drain({ afterPaste: (pane) => { pane.birth = 5_000; } })).toEqual(["paste"]);
});

it("types nothing into a masked prompt that appears during the last process check before the paste", async () => {
  // the next process read is the last check's: the prompt comes up while it is answered
  expect(await drain({ after: (pane) => { pane.onProcessRead = () => { pane.screen = PROMPT; }; } })).toEqual([]);
});

it("withholds the Enter from a masked prompt that appears during the last process check before it", async () => {
  // the check before Enter reads the screen, then the process: the prompt comes up at the last process read
  expect(await drain({ afterPaste: (pane) => { let reads = 0; pane.onProcessRead = () => { if (++reads >= 3) pane.screen = PROMPT; }; } })).toEqual(["paste"]);
});

it("types nothing once the bound process is no longer in front", async () => {
  expect(await drain({ mode: "missing" })).toEqual([]);
});

it("types nothing into Claude when another process took its PID during the last session check", async () => {
  expect(await drain({ mode: "claude", after: (pane) => { let reads = 0; pane.onProcessRead = () => { if (++reads === 2) pane.birth = 5_000; }; } })).toEqual([]);
});

it("withholds Pi's Enter from another process that took its PID during the last check after the receipt anchor", async () => {
  expect(await drain({ mode: "pi", afterPaste: (pane) => { let reads = 0; pane.onProcessRead = () => { if (++reads === 7) pane.birth = 5_000; }; } })).toEqual(["paste"]);
});

it("types no OpenCode skill into a masked prompt that comes up during the check before it", async () => {
  expect(await drain({ mode: "skill", after: (pane) => { let reads = 0; pane.onProcessRead = () => { if (++reads === 4) pane.screen = PROMPT; }; } })).toEqual([]);
});

it("sends no steering Escape into a masked prompt that comes up during the steering's check", async () => {
  expect(await drain({ mode: "codex" })).toEqual(["paste", "Enter"]);
});

// One drain per test: its mocks wrap what they replace, and are taken down after each test.
const CODEX_COMPOSER = "› Ask Codex to do anything\n  GPT-6-Astra default fast · main · Context 100% left\n  ← for agents · ? for shortcuts\n";
// /rename's field, the theme list and the /diff pager, as Codex 0.163 draws them: none is a card the chat can answer
const CODEX_OWN_SCREENS = {
  "/rename's field": "  Name thread\n› Type a name and press Enter\n  enter submit · esc back\n",
  "the theme list": "  catppuccin-macchiato\n› catppuccin-mocha (current)\n↓\n  enter select · esc back\n",
  "the /diff pager": "~\n~\n─────────────────── 100% ─\n ↑/↓ to scroll · pgup/pgdn to page · home/end to jump\n q close\n",
};

it("pastes a queued message into Codex's composer and sends it", async () => {
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER })).toEqual(["paste", "Enter"]);
});

const HELD_FOR_SCREEN: ReturnType<typeof listed> = [["held", "agent_blocked", "Codex has one of its own screens open in the terminal; close it there, then send"]];

for (const [name, screen] of Object.entries(CODEX_OWN_SCREENS)) {
  it(`types no queued message into ${name} when the turn ends with it up, and holds the message with that reason`, async () => {
    // queued over the composer while Codex works: the screen is up when the turn ends, which herdr reports as Codex at rest
    expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, beforeDrain: (pane) => { pane.screen = screen; } })).toEqual([]);
    expect(listed()).toEqual(HELD_FOR_SCREEN);
  });
}

it("does not send a queued message refused by one of Codex's own screens by itself later: nothing tells that the screen closed", async () => {
  // the screen is closed, and the agent's next turn ends over the composer: the message still waits for its Send now
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, beforeDrain: (pane) => { pane.screen = CODEX_OWN_SCREENS["/rename's field"]; },
    afterDrain: async (pane, turn) => { pane.screen = CODEX_COMPOSER; await turn(); } })).toEqual([]);
  expect(listed()).toEqual(HELD_FOR_SCREEN);
});

it("holds every message queued behind the one refused by one of Codex's own screens, each with that reason", async () => {
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, behind: 2, beforeDrain: (pane) => { pane.screen = CODEX_OWN_SCREENS["the theme list"]; } })).toEqual([]);
  expect(listed()).toEqual([...HELD_FOR_SCREEN, ...HELD_FOR_SCREEN, ...HELD_FOR_SCREEN]);
});

// a command's approval as Codex asks it: a card the chat reads, with a footer of its own, which herdr reports blocked
const CODEX_APPROVAL = "Would you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n";

it("queues a message again when the turn ends on a prompt Codex asks, which herdr reports: its end drains the queue", async () => {
  // herdr's word for the prompt may come a moment after the screen: the pane still reads at rest here
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, beforeDrain: (pane) => { pane.screen = CODEX_APPROVAL; },
    afterDrain: async (pane, turn) => { expect(listed()).toEqual([["queued", undefined, undefined]]); pane.screen = CODEX_COMPOSER; await turn(); } })).toEqual(["paste", "Enter"]);
});

it("queues a message again when such a prompt comes up during the last checks before the paste", async () => {
  // `after` runs in every try: the prompt comes up in the first one only
  let asked = false;
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, after: (pane) => { if (!asked) pane.screen = CODEX_APPROVAL; asked = true; },
    afterDrain: async (pane, turn) => { expect(listed()).toEqual([["queued", undefined, undefined]]); pane.screen = CODEX_COMPOSER; await turn(); } })).toEqual(["paste", "Enter"]);
});

it("holds a message when the turn ends on the folder question while herdr reports Codex at rest, as it does on a narrow pane", async () => {
  // the folder question as Codex 0.167 draws it at 40 columns, where herdr 0.9.5 says idle: answering it brings no status event
  const asked = readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/codex-0.167.0/trust-40.txt"), "utf8");
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, beforeDrain: (pane) => { pane.screen = asked; },
    afterDrain: async (pane, turn) => { pane.screen = CODEX_COMPOSER; await turn(); } })).toEqual([]);
  expect(listed()).toEqual(HELD_FOR_SCREEN);
});

it("types none of the queued messages when the screen closes between two of them: all are held in one step, in their order", async () => {
  // the first try reads the theme list; the user closes it as that read is answered, so the next try would find the composer
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, behind: 2,
    beforeDrain: (pane) => { pane.screen = CODEX_OWN_SCREENS["the theme list"]; pane.onScreenRead = () => { pane.screen = CODEX_COMPOSER; }; } })).toEqual([]);
  expect(listed()).toEqual([...HELD_FOR_SCREEN, ...HELD_FOR_SCREEN, ...HELD_FOR_SCREEN]);
});

it("answers a held message's Send now over one of Codex's own screens with the refusal alone, none of the drain's own notes", async () => {
  // the screen opens during the Send now's own checks, so the refusal comes from the send itself
  expect(await drain({ mode: "codex", screen: CODEX_COMPOSER, after: (pane) => { pane.screen = CODEX_OWN_SCREENS["/rename's field"]; } })).toEqual([]);
  const answer = told.find((frame) => frame.type === "pending-result");
  expect(answer).toMatchObject({ ok: false, code: "agent_blocked", message: "Codex has one of its own screens open in the terminal; close it there, then send" });
  expect(Object.keys(answer ?? {}).sort()).toEqual(["code", "id", "message", "ok", "pane_id", "pending_id", "type"]);
});

it("holds a message queued over /model's levels, a card of a list the user opened, as over any screen of Codex's own", async () => {
  const levels = readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/codex-0.167.0/model-effort-100.txt"), "utf8");
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, beforeDrain: (pane) => { pane.screen = levels; } })).toEqual([]);
  expect(listed()).toEqual(HELD_FOR_SCREEN);
});

it("refuses to queue a message while one of Codex's own screens is up, as with a menu herdr reports", async () => {
  expect(await drain({ mode: "codex-queued", screen: CODEX_OWN_SCREENS["the theme list"] })).toEqual([]);
  expect(told.flatMap((frame) => frame.type === "submit-result" ? [[frame.ok, frame.code]] : [])).toEqual([[false, "agent_blocked"]]);
  expect(listed()).toEqual([]);
});

it("types no queued message into a screen of Codex's own that opens during the last checks before the paste, and holds it", async () => {
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, after: (pane) => { pane.screen = CODEX_OWN_SCREENS["/rename's field"]; } })).toEqual([]);
  expect(listed()).toEqual(HELD_FOR_SCREEN);
});

it("still checks the process a queued Codex message was for after that screen read: another one at its PID gets nothing", async () => {
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, after: (pane) => { pane.birth = 5_000; } })).toEqual([]);
});

it("types no queued Codex message into a process that took the agent's PID while the last screen read was answered", async () => {
  // the next screen read is the last one before the paste: the composer is what it shows, and the PID is another's as it returns
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, after: (pane) => { pane.onScreenRead = () => { pane.birth = 5_000; }; } })).toEqual([]);
});

it("keeps a Pi receipt waiting while the agent's start reads as unknown for a moment, and confirms it after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-pi-birth-"));
  try {
    const path = join(dir, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "session" })}\n${JSON.stringify({ type: "message", id: "base", parentId: null, message: { role: "assistant", content: [] } })}\n`);
    let birth: number | null = 1_000;
    spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => birth);
    spyOn(client, "paneProcessInfo").mockResolvedValue({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "pi", argv: ["pi"] }] } as Awaited<ReturnType<typeof client.paneProcessInfo>>);
    spyOn(pi, "piTranscriptPath").mockResolvedValue({ path, agentDir: null } as Awaited<ReturnType<typeof pi.piTranscriptPath>>);
    spyOn(client, "paneRead").mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof client.paneRead>>);
    spyOn(client, "paneSendText").mockResolvedValue(undefined);
    spyOn(client, "paneSendKeys").mockResolvedValue(undefined);
    const frames: ServerMessage[] = [];
    const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as ServerMessage); return 1; } } as unknown as Client;
    owner.data.attached.set("p", { keepSize: false });
    let tail: Promise<unknown> = Promise.resolve();
    const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
    const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
    const delivery = createPendingDelivery({
      options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(),
      sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
      serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
      clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "pi", agent_status: "idle", focused: false, revision: 0 }] }) as unknown as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    await delivery.pendingFrames.submit(owner, { type: "submit", id: 1, pane_id: "p", text: "hello", payload: "hello", delivery: "queue" });
    for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
    const messages = () => frames.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : []);
    expect(messages().some((message) => message.error?.code === "pi_transcript_pending")).toBe(true);
    birth = null;
    await delivery.reconcilePiDeliveries("p");
    expect(messages().some((message) => message.error?.code === "pi_transcript_target_changed")).toBe(false);
    birth = 1_000;
    appendFileSync(path, `${JSON.stringify({ type: "message", id: "ours", parentId: "base", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`);
    await delivery.reconcilePiDeliveries("p");
    expect(frames.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : [])).toContainEqual(expect.objectContaining({ outcome: "consumed" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("sends no skill-accept Tab to another process that took the agent's PID during its autocomplete read", async () => {
  expect(await drain({ mode: "skill", tabRace: "birth" })).toEqual(["paste"]);
});

it("sends no skill-accept Tab when its autocomplete read shows a masked prompt", async () => {
  expect(await drain({ mode: "skill", tabRace: "masked" })).toEqual(["paste"]);
});

it("sends no skill-accept Tab while the live screen shows a masked prompt behind a scrolled viewport", async () => {
  expect(await drain({ mode: "skill", tabRace: "live" })).toEqual(["paste"]);
});

it("keeps a first message waiting, not held, while its launched agent's start reads as unknown for a moment", async () => {
  let birth: number | null = 1_000;
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async () => birth);
  spyOn(client, "paneProcessInfo").mockResolvedValue({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "codex", argv: ["codex"] }] } as Awaited<ReturnType<typeof client.paneProcessInfo>>);
  const frames: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value) as ServerMessage); return 1; } } as unknown as Client;
  owner.data.attached.set("p", { keepSize: false });
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(),
    sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
    serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: "working", focused: false, revision: 0 }] }) as unknown as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const message = await delivery.queueFirstMessage("p", "FIRST", "codex", owner.data.connectionId, 41001);
  for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  const codes = () => frames.flatMap((frame) => frame.type === "pending-messages" ? frame.messages.filter((entry) => entry.id === message.id).map((entry) => entry.error?.code) : []);
  birth = null;
  delivery.drainPending("p");
  for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  expect(codes()).not.toContain("pending_target_changed");
  birth = 5_000;
  delivery.drainPending("p");
  for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  // a start read as another one is still a replacement
  expect(codes().at(-1)).toBe("pending_target_changed");
});

it("types nothing once the message's deadline passed during the last reads before the paste", async () => {
  // the last process check before the paste runs past the deadline
  expect(await drain({ after: (pane) => { pane.onProcessRead = () => { setSystemTime(new Date(Date.now() + 60_000)); }; } })).toEqual([]);
});
