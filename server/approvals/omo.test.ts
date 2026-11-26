import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaneContext } from "../../shared/protocol.ts";
import { parsedByPublicPrompt } from "../dialogs/shared.ts";
import { parseInteractivePrompt } from "../prompt.ts";
import { ApprovalHub } from "./hub.ts";
import { omoApprovals } from "./omo.ts";

const posix = process.platform !== "win32";
const roots: string[] = [];
const started: ApprovalHub[] = [];
afterEach(() => {
  for (const hub of started.splice(0)) hub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** What OmO 5.1.81's permission system announced and drew for a shell command (approval-matrix, 2026-11-23). */
const asked = JSON.parse(readFileSync(new URL("../fixtures/omo-permission-asked-5.1.81.json", import.meta.url), "utf8")) as {
  request: { metadata: { command: string }; tool: { callID: string } }; title: string; options: string[];
};
const COMMAND = asked.request.metadata.command;
const CALL = asked.request.tool.callID;

/** What OmO 5.1.81 told an extension of its runs, in the order it told them (the fixture says how it was recorded). */
const runs = JSON.parse(readFileSync(new URL("../fixtures/omo-agent-runs-5.1.81.json", import.meta.url), "utf8")) as Record<string, { type: string }[]>;

function hubIn(onContext?: (paneId: string, context: PaneContext | null) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omh-")));
  roots.push(root);
  const waiting: (() => void)[] = [];
  const settling: (() => void)[] = [];
  const turns: string[] = [];
  const turning: { count: number; resolve: () => void }[] = [];
  const options = {
    onHeld: () => waiting.shift()?.(), onSettled: () => settling.shift()?.(),
    onTurn: (paneId: string, kind: string, { turn }: { turn: string }) => {
      turns.push(`${paneId} ${kind} ${turn}`);
      for (const wait of turning.filter((wait) => turns.length >= wait.count)) { turning.splice(turning.indexOf(wait), 1); wait.resolve(); }
    },
    onContext,
  };
  const hub = new ApprovalHub(join(root, "h"), [omoApprovals], options);
  started.push(hub);
  return {
    hub, turns, held: () => new Promise<void>((resolve) => waiting.push(resolve)), settled: () => new Promise<void>((resolve) => settling.push(resolve)),
    told: (count: number) => new Promise<void>((resolve) => { if (turns.length >= count) resolve(); else turning.push({ count, resolve }); }),
  };
}

interface Dialog { title: string; options: string[]; signal: AbortSignal | undefined; choose: (label: string | undefined) => void }

/** OmO's side of the extension: its session's UI, whose `select` the permission system opens its dialog with. */
async function loaded(args: string[], hasUI = true, getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null }) {
  const { default: extension } = await import(args[args.indexOf("-e") + 1]!) as { default: (pi: unknown) => void };
  const handlers = new Map<string, (...rest: unknown[]) => void>();
  const listeners = new Map<string, (data: unknown) => void>();
  const dialogs: Dialog[] = [];
  const ui = {
    select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      dialogs.push({ title, options, signal: opts?.signal, choose: resolve });
    }),
  };
  extension({ on: (name: string, handler: (...rest: unknown[]) => void) => handlers.set(name, handler), events: { on: (name: string, listener: (data: unknown) => void) => listeners.set(name, listener) } });
  /** what OmO tells its extensions of a run */
  const run = (event: { type: string }) => handlers.get(event.type)?.(event, { hasUI, ui, getContextUsage });
  run({ type: "session_start" });
  /** what the permission system does for one request: announce it, then ask in its dialog */
  const ask = (request: unknown = asked.request, title = asked.title, options = asked.options, call = CALL) => {
    listeners.get("permission_asked")!(request);
    return ui.select(title, options, { toolCallId: call } as { signal?: AbortSignal });
  };
  return { ask, dialogs, run };
}

describe.skipIf(!posix)("OmO's approval hook", () => {
  it("keeps the context from a retryable end when the user aborts the backoff", async () => {
    const contexts: (PaneContext | null)[] = [];
    const { hub, turns, told } = hubIn((_paneId, context) => contexts.push(context));
    let tokens = 10_000;
    const omo = await loaded(hub.launchArgs("omo", "p1", [], "5.1.81")!, true,
      () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }));
    omo.run({ type: "agent_start" });
    tokens = 50_000;
    const failed = { type: "agent_end", willRetry: true };
    omo.run(failed);
    omo.run({ type: "session_abort" });
    await told(2);
    expect(turns).toEqual(["p1 omo began", "p1 omo ended"]);
    expect(contexts).toEqual([{ used: 10_000, window: 200_000 }, { used: 50_000, window: 200_000 }]);
  });

  it("reports the selected model's context window without waiting for a turn to end", async () => {
    const { hub, told } = hubIn();
    let contextWindow = 200_000;
    const omo = await loaded(hub.launchArgs("omo", "p1", [], "5.1.81")!, true,
      () => ({ tokens: 50_000, contextWindow, percent: 5_000_000 / contextWindow }));
    contextWindow = 1_000_000;
    const selected = { type: "model_select", model: { contextWindow }, previousModel: { contextWindow: 200_000 }, source: "set" };
    omo.run(selected);
    omo.run({ type: "agent_start" });
    await told(1);
    expect(hub.contextOf("p1", "omo")).toEqual({ used: 50_000, window: 1_000_000 });
  });

  it("clears its last exact context when compaction leaves the token count unknown", async () => {
    const contexts: (PaneContext | null)[] = [];
    const { hub, told } = hubIn((_paneId, context) => contexts.push(context));
    // Senpi's core/extensions/types.d.ts allows both tokens and percent to be null after compaction.
    let compacted = false;
    const omo = await loaded(hub.launchArgs("omo", "p1", [], "5.1.81")!, true,
      () => compacted ? { tokens: null, contextWindow: 200_000, percent: null } : { tokens: 54_321, contextWindow: 200_000, percent: 27.1605 });
    compacted = true;
    omo.run({ type: "session_compact" });
    omo.run({ type: "agent_start" });
    await told(1);
    expect(contexts).toEqual([{ used: 54_321, window: 200_000 }, null]);
  });

  it("adds only its extension, for OmO 5.x from 5.1.81", () => {
    const { hub } = hubIn();
    const args = hub.launchArgs("omo", "p1", ["--permission-preset", "ask"], "5.1.81")!;
    expect(args.slice(0, 1)).toEqual(["-e"]);
    expect(args.slice(2)).toEqual(["--permission-preset", "ask"]);
    expect(statSync(args[1]!).mode & 0o777).toBe(0o600);
    for (const version of ["5.1.80", "6.0.0", null]) expect(hub.launchArgs("omo", "p1", ["--x"], version), String(version)).toEqual(["--x"]);
  });

  it("answers OmO's own dialog for a shell command from Ovis's card, the dialog closed", async () => {
    const { hub, held } = hubIn();
    const omo = await loaded(hub.launchArgs("omo", "p1", undefined, "5.1.81")!);
    for (const [decision, label] of [["allow", "Allow once"], ["deny", "Deny"]] as const) {
      const holding = held();
      const choice = omo.ask();
      await holding;
      const dialog = omo.dialogs.at(-1)!;
      expect(dialog.title).toBe(asked.title);
      expect(dialog.options).toEqual(asked.options);
      const [request] = hub.held("p1");
      expect(request).toMatchObject({ kind: "omo", command: COMMAND, description: null });
      expect(hub.decision("p1", request!.id, "Allow always")).toBeNull();
      expect(hub.settle("p1", request!.id, decision)).toBe(true);
      expect(await choice).toBe(label);
      expect(dialog.signal?.aborted).toBe(true);
    }
  });

  it("takes any option answered in the terminal, and releases the held request at once", async () => {
    const { hub, held, settled } = hubIn();
    const omo = await loaded(hub.launchArgs("omo", "p1", undefined, "5.1.81")!);
    const holding = held();
    const choice = omo.ask();
    await holding;
    const releasing = settled();
    omo.dialogs.at(-1)!.choose("Allow always");
    expect(await choice).toBe("Allow always");
    await releasing;
    expect(hub.held("p1")).toEqual([]);
  });

  it("leaves to OmO's dialog alone a request it does not take, or cannot tie to its dialog", async () => {
    const { hub } = hubIn();
    const omo = await loaded(hub.launchArgs("omo", "p1", undefined, "5.1.81")!);
    const edit = { ...asked.request, permission: "edit", metadata: { filepath: "a.txt" } };
    const cases: [unknown, string, string][] = [
      [edit, "Permission required: edit\n\nFile: a.txt", CALL],
      // another call's dialog than the one announced
      [asked.request, asked.title, "another-call"],
    ];
    for (const [request, title, call] of cases) {
      const choice = omo.ask(request, title, asked.options, call);
      omo.dialogs.at(-1)!.choose("Deny");
      expect(await choice).toBe("Deny");
    }
    expect(hub.held("p1")).toEqual([]);
    const without = await loaded(hub.launchArgs("omo", "p2", undefined, "5.1.81")!, false);
    const choice = without.ask();
    without.dialogs.at(-1)!.choose("Allow once");
    expect(await choice).toBe("Allow once");
    expect(hub.held("p2")).toEqual([]);
  });

  it("tells the hub a run began, and ended only when OmO will not retry it", async () => {
    const { hub, turns, told } = hubIn();
    const omo = await loaded(hub.launchArgs("omo", "p1", undefined, "5.1.81")!);
    // five retries of a failed request, then OmO gave up: one turn, however many runs
    for (const event of runs["retriedThenGaveUp"]!) omo.run(event);
    await told(7);
    expect(turns).toEqual([...Array.from({ length: 6 }, () => "p1 omo began"), "p1 omo ended"]);
    turns.length = 0;
    // stopped by the user, then answered after a follow-up, in the terminal
    for (const event of runs["tui"]!) omo.run(event);
    await told(6);
    expect(turns).toEqual(["p1 omo began", "p1 omo ended", "p1 omo began", "p1 omo ended", "p1 omo began", "p1 omo ended"]);
    turns.length = 0;
    // stopped (Esc) while it waited to retry: that retry never starts, and no agent_end tells its end
    for (const type of ["agent_start", "agent_end", "session_abort", "agent_settled"]) omo.run({ type, ...(type === "agent_end" ? { willRetry: true } : {}) });
    // the start of a turn after it shows that nothing else was queued before
    omo.run({ type: "agent_start" });
    await told(3);
    expect(turns).toEqual(["p1 omo began", "p1 omo ended", "p1 omo began"]);
  });

  it("reads the command of OmO's permission dialog on a pane herdr-core names omo and herdr names pi", () => {
    const fixtures: [string, string][] = [
      ["omo-permission-5.1.81.txt", "touch qa-allow-1.flag"],
      ["omo-permission-multi-5.1.81.txt", "cat <<'EOF' > am-multi-omo-hook-multi-a0-mwtdzpu6.txt\nfirst line\nsecond line with  two spaces\n   third line after a tab\nEOF\nwc -l am-multi-omo-hook-multi-a0-mwtdzpu6.txt"],
    ];
    for (const [file, command] of fixtures) {
      for (const agent of ["omo", "pi"]) {
        const prompt = parseInteractivePrompt(agent, readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8"))!;
        expect(prompt, `${file} ${agent}`).toMatchObject({ kind: "question", question: "Permission required: bash", options: asked.options.map((label) => ({ label })) });
        expect(parsedByPublicPrompt.get(prompt)?.approvalCommand?.split("\n").map((line) => line.trim()), `${file} ${agent}`).toEqual(command.split("\n").map((line) => line.trim()));
      }
    }
  });

  it("says a permission dialog whose top is above the pane shows a command it cannot read whole", () => {
    const lines = readFileSync(new URL("../fixtures/omo-permission-multi-5.1.81.txt", import.meta.url), "utf8").split("\n");
    const top = lines.map((line) => line.includes("third line after a tab")).lastIndexOf(true);
    const prompt = parseInteractivePrompt("omo", lines.slice(top).join("\n"))!;
    expect(prompt).toMatchObject({ kind: "question" });
    expect(parsedByPublicPrompt.get(prompt)?.approvalCommand).toBeNull();
  });
});
