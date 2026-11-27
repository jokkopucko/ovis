import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PaneContext } from "../../shared/protocol.ts";
import { parsedByPublicPrompt } from "../dialogs/shared.ts";
import { parseInteractivePrompt } from "../prompt.ts";
import { ApprovalHub } from "./hub.ts";
import { ompApprovals } from "./omp.ts";

const posix = process.platform !== "win32";
const roots: string[] = [];
const started: ApprovalHub[] = [];
afterEach(() => {
  for (const hub of started.splice(0)) hub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hubIn(onContext?: (paneId: string, context: PaneContext | null) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omph-")));
  roots.push(root);
  const waiting: (() => void)[] = [];
  const settling: (() => void)[] = [];
  const options = { onHeld: () => waiting.shift()?.(), onSettled: () => settling.shift()?.(), onContext };
  const hub = new ApprovalHub(join(root, "h"), [ompApprovals], options);
  started.push(hub);
  return { hub, held: () => new Promise<void>((resolve) => waiting.push(resolve)), settled: () => new Promise<void>((resolve) => settling.push(resolve)) };
}

type Answer = "once" | "session" | "deny" | { grant: string; always: boolean };
interface Prompt { full: string; compact: string; session?: string; grants?: unknown[] }
interface Dialog { prompt: Prompt; signal: AbortSignal | undefined; choose: (answer: Answer) => void }

/** The prompt omp 18.14.0 gives `approve` for a bash call (tools/approval.ts requestApproval, tools/bash.ts formatApprovalDetails). */
const bashPrompt = (command: string, reason?: string): Prompt => ({
  full: ["Allow tool: bash", ...(reason ? [`Reason: ${reason}`] : []), `Command: ${command}`].join("\n"),
  compact: `Allow tool: bash\nCommand: ${command.split("\n")[0]}`,
});

/** omp's side of the extension: its events, and its terminal UI's approval dialog. */
async function loaded(args: string[], mode = "tui", getContextUsage?: () => { tokens: number; contextWindow: number; percent: number } | undefined, kind: "main" | "sub" = "main") {
  const { default: extension } = await import(args[args.indexOf("-e") + 1]!) as { default: (pi: unknown) => void };
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const dialogs: Dialog[] = [];
  const ui = {
    approve: (prompt: Prompt, opts?: { signal?: AbortSignal }) => new Promise<Answer>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve("deny"), { once: true });
      dialogs.push({ prompt, signal: opts?.signal, choose: resolve });
    }),
  };
  extension({ on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler) });
  const run = (type: string) => handlers.get(type)?.({ type }, { mode, hasUI: true, ui, agent: { kind, depth: 0 }, getContextUsage });
  run("session_start");
  /** what omp does for one bash call: its `tool_call` event, then its approval dialog */
  const call = (command: string, prompt = bashPrompt(command), id = "call-1") => {
    handlers.get("tool_call")!({ toolName: "bash", toolCallId: id, input: { command } });
    return ui.approve(prompt, {});
  };
  const seen = (command: string, id: string) => handlers.get("tool_call")!({ toolName: "bash", toolCallId: id, input: { command } });
  return { call, seen, dialogs, ui, run, resolved: (id = "call-1") => handlers.get("tool_approval_resolved")!({ toolCallId: id }) };
}

describe.skipIf(!posix)("omp's approval hook", () => {
  it("keeps depth-zero subagents from reporting context for the main pane", async () => {
    const contexts: (PaneContext | null)[] = [];
    const finished = Promise.withResolvers<void>();
    const { hub } = hubIn((_paneId, context) => {
      contexts.push(context);
      if (context?.used === 45_000) finished.resolve();
    });
    const args = hub.launchArgs("omp", "p1", [], "18.14.0")!;
    let tokens = 40_000;
    const main = await loaded(args, "tui", () => ({ tokens, contextWindow: 200_000, percent: tokens / 2_000 }));
    const child = await loaded(args, "print", () => ({ tokens: 3_200, contextWindow: 32_000, percent: 10 }), "sub");
    child.run("agent_end");
    tokens = 45_000;
    main.run("agent_end");
    await finished.promise;
    expect(contexts).toEqual([{ used: 40_000, window: 200_000 }, { used: 45_000, window: 200_000 }]);
  });

  it("tells the pane its exact context at startup and after a turn", async () => {
    let told = Promise.withResolvers<{ paneId: string; context: PaneContext | null }>();
    const { hub } = hubIn((paneId, context) => told.resolve({ paneId, context }));
    // ContextUsage from omp 18.14.0's rpc-wire.generated.ts, returned by ctx.getContextUsage().
    let usage = { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 };
    const omp = await loaded(hub.launchArgs("omp", "p1", [], "18.14.0")!, "tui", () => usage);
    expect(await told.promise).toEqual({ paneId: "p1", context: { used: 12_345, window: 200_000 } });

    told = Promise.withResolvers();
    usage = { ...usage, tokens: 15_123, percent: 7.5615 };
    omp.run("agent_end");
    expect(await told.promise).toEqual({ paneId: "p1", context: { used: 15_123, window: 200_000 } });
    expect(hub.contextOf("p1", "omp")).toEqual({ used: 15_123, window: 200_000 });
    expect(hub.contextOf("p2", "omp")).toBeUndefined();
    hub.launchArgs("omp", "p1", [], "18.13.2");
    expect(hub.contextOf("p1", "omp")).toBeUndefined();
  }, 1500);

  it("adds only its extension, for omp 18.x from 18.14.0 and omp 19.x", () => {
    const { hub } = hubIn();
    const args = hub.launchArgs("omp", "p1", ["--thinking", "off"], "18.14.0")!;
    expect(args.slice(0, 1)).toEqual(["-e"]);
    expect(args.slice(2)).toEqual(["--thinking", "off"]);
    expect(statSync(args[1]!).mode & 0o777).toBe(0o600);
    expect(readFileSync(args[1]!, "utf8")).toContain(hub.address);
    expect(hub.launchArgs("omp", "p1", ["--x"], "19.2.1")?.slice(2)).toEqual(["--x"]);
    for (const version of ["18.13.2", "20.0.0", null]) expect(hub.launchArgs("omp", "p1", ["--x"], version), String(version)).toEqual(["--x"]);
    // omp 19.2 refuses an extension beside these (cli/args.ts), so the launch keeps its own arguments
    for (const args of [["--no-tools"], ["--no-tools=true"], ["--trusted-extension", "/x/ext.ts"], ["--trusted-extension=/x/ext.ts"]]) {
      expect(hub.launchArgs("omp", "p1", args, "19.2.1"), args.join(" ")).toEqual(args);
    }
    for (const after of ["--no-tools", "--no-tools=true"]) expect(hub.launchArgs("omp", "p1", ["--", after], "19.2.1")?.[0], after).toBe("-e");
  });

  it("answers omp's own dialog for a shell command from Ovis's card, the dialog closed", async () => {
    const { hub, held } = hubIn();
    const omp = await loaded(hub.launchArgs("omp", "p1", undefined, "18.14.0")!);
    const command = "cat <<'EOF' > a.txt\nfirst line\n\tsecond\nEOF\necho \"안녕 'Ovis'\" | wc -l";
    for (const [decision, answer] of [["allow", "once"], ["deny", "deny"]] as const) {
      const holding = held();
      const choice = omp.call(command);
      await holding;
      const dialog = omp.dialogs.at(-1)!;
      expect(dialog.prompt).toEqual(bashPrompt(command));
      const [request] = hub.held("p1");
      expect(request).toMatchObject({ kind: "omp", command, description: null });
      expect(hub.decision("p1", request!.id, "Approve bash for this session")).toBeNull();
      expect(hub.settle("p1", request!.id, decision)).toBe(true);
      expect(await choice).toBe(answer);
      expect(dialog.signal?.aborted).toBe(true);
    }
  });

  it("asks the hub for one approval at a time, the one omp shows, with omp's reason as its words", async () => {
    const { hub, held } = hubIn();
    const omp = await loaded(hub.launchArgs("omp", "p1", undefined, "18.14.0")!);
    const first = held();
    const shown = omp.call("touch a", bashPrompt("touch a", "Prompt required by bash pattern: touch*"), "call-1");
    const queued = omp.call("touch b", bashPrompt("touch b"), "call-2");
    await first;
    expect(hub.held("p1")).toEqual([expect.objectContaining({ command: "touch a", description: "Prompt required by bash pattern: touch*" })]);
    // omp's queued dialog is not held until the one before it is answered
    const second = held();
    omp.dialogs[0]!.choose("deny");
    expect(await shown).toBe("deny");
    await second;
    const [request] = hub.held("p1");
    expect(request).toMatchObject({ command: "touch b", description: null });
    hub.settle("p1", request!.id, "allow");
    expect(await queued).toBe("once");
    // a dialog the hub does not take holds its place in omp's queue too
    const elided = omp.call("x".repeat(3000), bashPrompt(`${"x".repeat(2000)}[…1000ch elided…]`), "call-3");
    const third = held();
    const behind = omp.call("touch c", bashPrompt("touch c"), "call-4");
    omp.dialogs.at(-2)!.choose("deny");
    expect(await elided).toBe("deny");
    await third;
    const [last] = hub.held("p1");
    expect(last).toMatchObject({ command: "touch c" });
    hub.settle("p1", last!.id, "deny");
    expect(await behind).toBe("deny");
  });

  it("takes any answer given in the terminal, and releases the held request at once", async () => {
    const { hub, held, settled } = hubIn();
    const omp = await loaded(hub.launchArgs("omp", "p1", undefined, "18.14.0")!);
    const holding = held();
    const choice = omp.call("touch a", { ...bashPrompt("touch a"), session: "Approve bash for this session" });
    await holding;
    const releasing = settled();
    omp.dialogs.at(-1)!.choose("session");
    expect(await choice).toBe("session");
    await releasing;
    expect(hub.held("p1")).toEqual([]);
  });

  it("leaves to omp's dialog alone a prompt it cannot tie to a bash call it saw whole", async () => {
    const { hub } = hubIn();
    const omp = await loaded(hub.launchArgs("omp", "p1", undefined, "18.14.0")!);
    const cases: [string, Prompt][] = [
      // omp cut the command in its prompt past its length
      ["x".repeat(3000), bashPrompt(`${"x".repeat(2000)}[…1000ch elided…]`)],
      // another tool's prompt
      ["touch a", { full: "Allow tool: write\nPath: a.txt", compact: "Allow tool: write" }],
      // a prompt offering grants to remember
      ["touch a", { ...bashPrompt("touch a"), grants: [{ scope: "target", label: "Approve", alwaysLabel: "Always Approve" }] }],
      // a provider safety check under the command
      ["touch a", { ...bashPrompt("touch a"), full: `${bashPrompt("touch a").full}\nProvider safety checks:\n1. x` }],
    ];
    for (const [command, prompt] of cases) {
      const choice = omp.call(command, prompt);
      const dialog = omp.dialogs.at(-1)!;
      // omp's dialog as omp opened it, with no race against the hub
      expect(dialog.signal, prompt.full.slice(0, 40)).toBeUndefined();
      dialog.choose("deny");
      expect(await choice).toBe("deny");
      omp.resolved();
    }
    // a call whose whole command reads as another's cut one: the cut call's prompt is never the other's
    const cut = `${"x".repeat(2000)}[…1000ch elided…]`;
    omp.seen(cut, "call-2");
    const elided = omp.call("x".repeat(3000), bashPrompt(cut));
    expect(omp.dialogs.at(-1)!.signal).toBeUndefined();
    omp.dialogs.at(-1)!.choose("deny");
    expect(await elided).toBe("deny");
    expect(hub.held("p1")).toEqual([]);
    const rpc = await loaded(hub.launchArgs("omp", "p2", undefined, "18.14.0")!, "rpc");
    const inRpc = rpc.call("touch a");
    rpc.dialogs.at(-1)!.choose("once");
    expect(await inRpc).toBe("once");
    expect(hub.held("p2")).toEqual([]);
  });

  it("reads the command of omp's bash approval, and a command omp cut is a card only for a held request", () => {
    const read = (file: string) => {
      const prompt = parseInteractivePrompt("omp", readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8"))!;
      expect(prompt, file).toMatchObject({ kind: "approval", title: "Allow tool: bash", options: [{ label: "Approve" }, { label: "Deny" }] });
      return parsedByPublicPrompt.get(prompt)!;
    };
    expect(read("omp-approval-hook-18.14.0-short.txt")).toMatchObject({ approvalCommand: "touch qa-short-a1.flag" });
    expect(read("omp-approval-hook-18.14.0-short.txt").approvalHeldOnly).toBeUndefined();
    expect(read("omp-approval-hook-18.14.0-multi.txt")).toMatchObject({ approvalCommand: null, approvalHeldOnly: true });
    // omp 19.2.1 (its UI moved to its own library in 19.2.0) draws the same dialog, with its session grant between
    const omp19 = parseInteractivePrompt("omp", readFileSync(new URL("../fixtures/omp-approval-hook-19.2.1-short.txt", import.meta.url), "utf8"))!;
    expect(omp19).toMatchObject({ kind: "approval", title: "Allow tool: bash", options: [{ label: "Approve" }, { label: "Approve bash for this session" }, { label: "Deny" }] });
    expect(parsedByPublicPrompt.get(omp19)).toMatchObject({ approvalCommand: "touch qa19.flag" });
  });
});
