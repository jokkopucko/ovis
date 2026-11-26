import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaneContext } from "../../shared/protocol.ts";
import { parsedByPublicPrompt } from "../dialogs/shared.ts";
import { parseInteractivePrompt } from "../prompt.ts";
import { permissionDecision } from "./extension.ts";
import { ApprovalHub } from "./hub.ts";
import { piApprovals } from "./pi.ts";

const posix = process.platform !== "win32";
const roots: string[] = [];
const started: ApprovalHub[] = [];
afterEach(() => {
  for (const hub of started.splice(0)) hub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pih-")));
  roots.push(root);
  return root;
}

function hubIn(onContext?: (paneId: string, context: PaneContext | null) => void) {
  const waiting: (() => void)[] = [];
  const settling: (() => void)[] = [];
  const hub = new ApprovalHub(join(tempRoot(), "h"), [piApprovals], { onHeld: () => waiting.shift()?.(), onSettled: () => settling.shift()?.(), onContext });
  started.push(hub);
  return { hub, held: () => new Promise<void>((resolve) => waiting.push(resolve)), settled: () => new Promise<void>((resolve) => settling.push(resolve)) };
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface Dialog { title: string; options: string[]; signal: AbortSignal; choose: (label: string | undefined) => void }

type Usage = { tokens: number | null; contextWindow: number; percent: number | null };

/** pi's side of the extension: the handlers it registers, and the dialogs it opens. */
async function loaded(args: string[], getContextUsage?: () => Usage | undefined) {
  const file = args[args.indexOf("-e") + 1]!;
  const { default: extension } = await import(file) as { default: (pi: unknown) => void };
  const handlers = new Map<string, Handler>();
  extension({ on: (name: string, handler: Handler) => handlers.set(name, handler) });
  const dialogs: Dialog[] = [];
  const opened: (() => void)[] = [];
  const ctx = (mode: string) => ({
    hasUI: mode !== "print",
    mode,
    signal: undefined,
    getContextUsage,
    ui: {
      select: (title: string, options: string[], opts: { signal: AbortSignal }) => new Promise<string | undefined>((resolve) => {
        opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        dialogs.push({ title, options, signal: opts.signal, choose: resolve });
        opened.shift()?.();
      }),
    },
  });
  const call = (input: unknown, toolName = "bash", mode = "tui") => handlers.get("tool_call")!({ toolName, toolCallId: "call-1", input }, ctx(mode));
  /** what pi tells its extensions of the session (pi 1.4.0's ExtensionAPI events) */
  const run = (type: string) => handlers.get(type)?.({ type }, ctx("tui"));
  return { call, run, dialogs, opened: () => new Promise<void>((resolve) => opened.push(resolve)) };
}

describe.skipIf(!posix)("pi's approval hook", () => {
  it("adds only its extension, for pi 1.x from 1.4.0", () => {
    const { hub } = hubIn();
    const args = hub.launchArgs("pi", "p1", ["--model", "dsapi/m", "--", "-e"], "1.4.0")!;
    expect(args.slice(0, 1)).toEqual(["-e"]);
    expect(args.slice(2)).toEqual(["--model", "dsapi/m", "--", "-e"]);
    expect(statSync(args[1]!).mode & 0o777).toBe(0o600);
    expect(readFileSync(args[1]!, "utf8")).toContain(hub.address);
    for (const version of ["1.3.9", "2.0.0", null]) expect(hub.launchArgs("pi", "p1", ["--x"], version), String(version)).toEqual(["--x"]);
  });

  it("tells the pane its exact context at startup, after a turn, a model switch and a branch move, and as unknown after compaction", async () => {
    let told = Promise.withResolvers<{ paneId: string; context: PaneContext | null }>();
    const { hub } = hubIn((paneId, context) => told.resolve({ paneId, context }));
    // ContextUsage of pi 1.4.0's ExtensionContext.getContextUsage(): tokens and percent are null after compaction
    let usage: Usage = { tokens: 12_345, contextWindow: 1_000_000, percent: 1.2345 };
    const pi = await loaded(hub.launchArgs("pi", "p1", undefined, "1.4.0")!, () => usage);
    pi.run("session_start");
    expect(await told.promise).toEqual({ paneId: "p1", context: { used: 12_345, window: 1_000_000 } });

    for (const [type, next, context] of [
      ["agent_end", { tokens: 15_123, contextWindow: 1_000_000, percent: 1.5123 }, { used: 15_123, window: 1_000_000 }],
      ["model_select", { tokens: 15_123, contextWindow: 200_000, percent: 7.5615 }, { used: 15_123, window: 200_000 }],
      // /tree moved to a shorter branch: nothing else is told until the next run
      ["session_tree", { tokens: 9_000, contextWindow: 200_000, percent: 4.5 }, { used: 9_000, window: 200_000 }],
      ["session_compact", { tokens: null, contextWindow: 200_000, percent: null }, null],
    ] as const) {
      told = Promise.withResolvers();
      usage = next;
      pi.run(type);
      expect(await told.promise, type).toEqual({ paneId: "p1", context });
    }
    expect(hub.contextOf("p1", "pi")).toBeNull();
  }, 1500);

  it("answers a shell command from Ovis's card, its own dialog closed", async () => {
    const { hub, held } = hubIn();
    const pi = await loaded(hub.launchArgs("pi", "p1", undefined, "1.4.0")!);
    for (const [decision, result] of [["allow", undefined], ["deny", { block: true, reason: "The user declined this command." }]] as const) {
      const holding = held();
      const asked = pi.call({ command: "touch a b" });
      await holding;
      const dialog = pi.dialogs.at(-1)!;
      expect(dialog.title).toBe("Permission required: bash\n\nCommand: $ touch a b");
      expect(dialog.options).toEqual(["Allow once", "Deny"]);
      const [request] = hub.held("p1");
      expect(request).toMatchObject({ kind: "pi", command: "touch a b", description: null });
      expect(hub.settle("p1", request!.id, decision)).toBe(true);
      expect(await asked).toEqual(result);
      expect(dialog.signal.aborted).toBe(true);
    }
  });

  it("takes the terminal's answer and releases the held request at once", async () => {
    const { hub, held, settled } = hubIn();
    const pi = await loaded(hub.launchArgs("pi", "p1", undefined, "1.4.0")!);
    // an Escape closes pi's dialog with no choice, which declines
    for (const [label, blocked] of [["Allow once", false], ["Deny", true], [undefined, true]] as const) {
      const holding = held();
      const asked = pi.call({ command: "rm -rf build" });
      await holding;
      const releasing = settled();
      pi.dialogs.at(-1)!.choose(label);
      expect((await asked as { block?: boolean } | undefined)?.block === true, String(label)).toBe(blocked);
      await releasing;
      expect(hub.held("p1")).toEqual([]);
    }
  });

  it("leaves the dialog alone to answer once the hub gives no decision", async () => {
    const { hub, held } = hubIn();
    const pi = await loaded(hub.launchArgs("pi", "p1", undefined, "1.4.0")!);
    const holding = held();
    const asked = pi.call({ command: "make deploy" });
    await holding;
    hub.forget("p1");
    expect(await Promise.race([asked, Bun.sleep(300).then(() => "waiting")])).toBe("waiting");
    pi.dialogs.at(-1)!.choose("Allow once");
    expect(await asked).toBeUndefined();
  });

  // RPC mode has a UI too, whose dialogs wait on the RPC client
  it("holds no other tool, and nothing outside pi's terminal UI", async () => {
    const { hub } = hubIn();
    const pi = await loaded(hub.launchArgs("pi", "p1", undefined, "1.4.0")!);
    expect(await pi.call({ path: "a.txt", content: "x" }, "write")).toBeUndefined();
    expect(await pi.call({ command: "ls" }, "bash", "rpc")).toBeUndefined();
    expect(await pi.call({ command: "ls" }, "bash", "print")).toBeUndefined();
    expect(hub.held("p1")).toEqual([]);
    expect(await pi.call({}, "bash")).toBeUndefined();
    expect(pi.dialogs).toEqual([]);
  });

  it("runs a relay that gave no answer at all again, and asks no more after the hub's own no decision", async () => {
    const root = tempRoot();
    const count = join(root, "count");
    const script = join(root, "relay.ts");
    writeFileSync(count, "0");
    // no answer twice (no hub yet), then the answer given as the script's argument
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const runs = Number(readFileSync(${JSON.stringify(count)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(count)}, String(runs));
await Bun.stdin.text();
if (runs > 2) process.stdout.write(process.argv[2]!);
`);
    for (const [answer, runs] of [['{"decision":"deny"}', 3], ['{"decision":null}', 3]] as const) {
      writeFileSync(count, "0");
      const pi = await loaded(piApprovals.launchArgs(undefined, { command: process.execPath, args: [script, answer] }, join(root, "h"))!);
      const asked = pi.call({ command: "ls" });
      if (answer.includes("deny")) expect(await asked).toMatchObject({ block: true });
      else {
        const opened = pi.dialogs.length ? Promise.resolve() : pi.opened();
        await opened;
        const deadline = Date.now() + 10_000;
        while (Number(readFileSync(count, "utf8")) < 3) {
          if (Date.now() > deadline) throw new Error("the relay was not run three times");
          await Bun.sleep(25);
        }
        // fixed wait: proves no fourth run comes, which the next retry would start within 1 s
        await Bun.sleep(1_500);
        pi.dialogs.at(-1)!.choose("Allow once");
        expect(await asked).toBeUndefined();
      }
      expect(Number(readFileSync(count, "utf8"))).toBe(runs);
    }
  });

  it("reads the command of the dialog pi 1.4.0 drew for it, and only Allow once and Deny as decisions", () => {
    const prompt = parseInteractivePrompt("pi", readFileSync(new URL("../fixtures/pi-permission-1.4.0.txt", import.meta.url), "utf8"))!;
    expect(prompt).toMatchObject({ kind: "question", question: "Permission required: bash", options: [{ label: "Allow once" }, { label: "Deny" }] });
    expect(parsedByPublicPrompt.get(prompt)?.approvalCommand).toBe("touch qa-allow-1.flag");
    // a card read from the screen alone (no held request) shows the command, and one read for another command is another card
    expect(prompt.body).toBe("touch qa-allow-1.flag");
    const other = parseInteractivePrompt("pi", readFileSync(new URL("../fixtures/pi-permission-1.4.0.txt", import.meta.url), "utf8")
      .replace("Command: $ touch qa-allow-1.flag", "Command: $ touch qa-allow-2.flag"))!;
    expect(other.body).toBe("touch qa-allow-2.flag");
    expect(other.id).not.toBe(prompt.id);
    // lines like OmO's patterns are the command's own in pi's dialog, which has none
    const quoted = "printf 'notes\n\nPatterns:\n  - example'";
    const own = parseInteractivePrompt("pi", readFileSync(new URL("../fixtures/pi-permission-1.4.0.txt", import.meta.url), "utf8")
      .replace("Command: $ touch qa-allow-1.flag", `Command: $ ${quoted}`))!;
    expect(parsedByPublicPrompt.get(own)?.approvalCommand).toBe(quoted);
    expect(permissionDecision("Allow once")).toBe("allow");
    expect(permissionDecision("Deny")).toBe("deny");
    expect(permissionDecision("Allow always")).toBeNull();
    expect(permissionDecision("Deny with feedback")).toBeNull();
  });
});
