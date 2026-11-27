import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readProcessBirth } from "../process-owner.ts";
import { COPILOT_HOOK_MIN_VERSION, copilotApprovals } from "./copilot.ts";
import { ApprovalHub, type TurnEvent } from "./hub.ts";
import { keyDigest, newNonce, seal } from "./relay.ts";

// Copilot CLI 1.0.109's own hooks from a --plugin-dir plugin, in its terminal UI: two sessions (the second after
// /clear, with a shell command it asked to run) and a third whose second prompt was typed while the first turn ran
const recorded = readFileSync(join(import.meta.dir, "..", "fixtures", "copilot-1.0.109-hooks.jsonl"), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

const roots: string[] = [];
const hubs: ApprovalHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hubIn() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ch-")));
  roots.push(root);
  const turns: TurnEvent[] = [];
  const hub = new ApprovalHub(join(root, "h"), [copilotApprovals], { onTurn: (_paneId, _kind, turn) => turns.push(turn) });
  hubs.push(hub);
  return { hub, turns, root };
}

/** The hook the plugin's hooks.json runs for each event, and the folder it is in. */
function pluginOf(args: string[]) {
  const dir = args[args.indexOf("--plugin-dir") + 1]!;
  const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8")) as { version: number; hooks: Record<string, { exec: string; args: string[]; timeoutSec: number }[]> };
  return { dir, hooks, hook: hooks.hooks["Stop"]![0]! };
}

/** Runs the plugin's hook as Copilot does, with the event on stdin: what it prints. */
async function run(hook: { exec: string; args: string[] }, event: unknown): Promise<string> {
  const relay = Bun.spawn([hook.exec, ...hook.args], { stdin: new Blob([JSON.stringify(event)]), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(relay.stdout).text();
  expect(await relay.exited).toBe(0);
  return out;
}

describe("Copilot's launch", () => {
  it("gets a plugin folder of its own with the four told hooks, and keeps every argument it had", () => {
    const { hub, root } = hubIn();
    const args = hub.launchArgs("copilot", "p1", ["--plugin-dir", "/home/user/mine", "--model", "gpt-5"], COPILOT_HOOK_MIN_VERSION)!;
    const { dir, hooks, hook } = pluginOf(args);
    expect(args.slice(2)).toEqual(["--plugin-dir", "/home/user/mine", "--model", "gpt-5"]);
    expect(dir.startsWith(join(root, "h"))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["hooks.json", "plugin.json"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "hooks.json")).mode & 0o777).toBe(0o600);
    expect(Object.keys(hooks.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(hook.args).toContain("--launch-file");
    expect(hook.timeoutSec).toBe(10);
  });

  it("gets no hook below the version measured, or past its major", () => {
    const { hub } = hubIn();
    expect(hub.launchArgs("copilot", "p1", ["--yolo"], "1.0.108")).toEqual(["--yolo"]);
    expect(hub.launchArgs("copilot", "p1", ["--yolo"], "2.0.0")).toEqual(["--yolo"]);
    expect(hub.launchArgs("copilot", "p1", undefined, null)).toBeUndefined();
  });
});

describe("what Copilot's recorded hooks tell", () => {
  it("reads a turn from each prompt taken in and each Stop, with the session's transcript, and nothing from the rest", () => {
    const turns = recorded.map((event) => copilotApprovals.turn!(event));
    expect(turns.filter((turn) => turn?.turn === "began")).toHaveLength(4);
    expect(turns.filter((turn) => turn?.turn === "ended").map((turn) => turn && "transcript" in turn ? turn.transcript : null)).toEqual([
      "/home/user/.copilot/session-state/42eec6eb-dbb8-403b-a959-bad5a446e598/events.jsonl",
      "/home/user/.copilot/session-state/bc54b8db-e1b7-4f23-ba10-223ac686a213/events.jsonl",
      "/home/user/.copilot/session-state/45237465-a4e2-47e4-8ea8-4a9927746b1f/events.jsonl",
      "/home/user/.copilot/session-state/45237465-a4e2-47e4-8ea8-4a9927746b1f/events.jsonl",
    ]);
    expect(turns.every((turn) => turn === null || turn.prompt === null)).toBe(true);
  });

  it("reads each session from its first hook to its SessionEnd, and no card or answer from a permission request", () => {
    const told = recorded.map((event) => copilotApprovals.session!(event));
    expect(told.filter((session) => session !== null && "ended" in session).map((session) => session && "ended" in session ? session.ended : null))
      .toEqual(["42eec6eb-dbb8-403b-a959-bad5a446e598", "bc54b8db-e1b7-4f23-ba10-223ac686a213", "45237465-a4e2-47e4-8ea8-4a9927746b1f"]);
    const permission = recorded.find((event) => event["hookName"] === "permissionRequest")!;
    expect(copilotApprovals.session!(permission)).toBeNull();
    expect(copilotApprovals.turn!(permission)).toBeNull();
    expect(copilotApprovals.toCard(permission)).toBeNull();
  });
});

describe("the session the hub keeps", () => {
  it("is the one the hook told, with the process that ran the hook, until its SessionEnd, the pane's next launch or the hub's stop", async () => {
    const { hub, turns } = hubIn();
    const { hook } = pluginOf(hub.launchArgs("copilot", "p1", [], COPILOT_HOOK_MIN_VERSION)!);
    const [start, submit, stop, end] = recorded;
    expect(await run(hook, start)).toBe("");
    const birth = readProcessBirth(process.pid);
    // the relay's parent: this test, as Copilot is the parent of the hook it runs
    expect(hub.toldSession("p1")).toEqual({ session: "42eec6eb-dbb8-403b-a959-bad5a446e598", pid: process.pid,
      birth: process.platform === "linux" && birth.state === "identified" ? birth.birth.value : null });
    expect(await run(hook, submit)).toBe("");
    expect(await run(hook, stop)).toBe("");
    expect(turns.map((turn) => turn.turn)).toEqual(["began", "ended"]);
    expect(await run(hook, end)).toBe("");
    expect(hub.toldSession("p1")).toBeNull();
    await run(hook, recorded[4]);
    expect(hub.toldSession("p1")?.session).toBe("bc54b8db-e1b7-4f23-ba10-223ac686a213");
    // a launch into the pane: what the earlier one told is not the new one's
    hub.launchArgs("copilot", "p1", [], COPILOT_HOOK_MIN_VERSION);
    expect(hub.toldSession("p1")).toBeNull();
    expect(await run(hook, recorded[4])).toBe("");
    expect(hub.toldSession("p1")).toBeNull();
  });

  it("goes with the launch whose key it was told under, when the hub lets that launch go or stops", async () => {
    const { hub } = hubIn();
    const { hook } = pluginOf(hub.launchArgs("copilot", "p1", [], COPILOT_HOOK_MIN_VERSION)!);
    await run(hook, recorded[0]);
    expect(hub.toldSession("p1")).not.toBeNull();
    // the hub keeps 256 launches: past them the oldest one's key goes, and its /clear could no longer be told
    for (let pane = 0; pane < 256; pane++) hub.launchArgs("copilot", `other-${pane}`, [], COPILOT_HOOK_MIN_VERSION);
    expect(hub.toldSession("p1")).toBeNull();
    const next = pluginOf(hub.launchArgs("copilot", "p2", [], COPILOT_HOOK_MIN_VERSION)!).hook;
    await run(next, recorded[0]);
    expect(hub.toldSession("p2")).not.toBeNull();
    hub.stop();
    expect(hub.toldSession("p2")).toBeNull();
  });

  it("is told by a hook that answers no approval, which the harness list does not offer as one", () => {
    const { hub } = hubIn();
    expect(hub.handles("copilot")).toBe(true);
    expect(hub.answers("copilot")).toBe(false);
  });

  it("is not told by a request whose process is not the one sealed into it", async () => {
    const { hub } = hubIn();
    const { hook } = pluginOf(hub.launchArgs("copilot", "p1", [], COPILOT_HOOK_MIN_VERSION)!);
    const key = readFileSync(hook.args[hook.args.indexOf("--launch-file") + 1]!, "utf8");
    const nonce = newNonce();
    const socket = connect(hub.address);
    const closed = new Promise<string>((resolve) => {
      let received = "";
      socket.on("data", (chunk) => { received += chunk.toString(); });
      socket.on("close", () => resolve(received));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ launch: keyDigest(key), nonce, pid: process.pid + 1, sealed: seal(key, "request", nonce, JSON.stringify(recorded[0]), process.pid) })}\n`));
    expect(await closed).toBe("");
    expect(hub.toldSession("p1")).toBeNull();
  });
});
