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
async function drain({ after = () => {}, afterPaste = () => {}, mode = "gjc", tabRace = "none", screen = "" }: { after?: (pane: Pane) => void; afterPaste?: (pane: Pane) => void; mode?: Mode; tabRace?: "none" | "birth" | "masked" | "live"; screen?: string }) {
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
    await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id: 2, pane_id: "p", pending_id: held.id, action: "steer" });
    return writes;
  }
  if (mode === "missing") shown.foreground = [];
  pane.agent_status = "idle";
  delivery.pending.status("p", "idle");
  delivery.drainPending("p");
  for (let lane = 0; lane < 3; lane++) await serialize("p", () => {});
  return writes;
}
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

for (const [name, screen] of Object.entries(CODEX_OWN_SCREENS)) {
  it(`types no queued message into ${name}, which herdr reports as Codex at rest`, async () => {
    expect(await drain({ mode: "codex-queued", screen })).toEqual([]);
  });
}

it("types no queued message into a screen of Codex's own that opens during the last checks before the paste", async () => {
  expect(await drain({ mode: "codex-queued", screen: CODEX_COMPOSER, after: (pane) => { pane.screen = CODEX_OWN_SCREENS["/rename's field"]; } })).toEqual([]);
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
