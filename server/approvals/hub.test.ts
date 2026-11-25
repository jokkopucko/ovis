import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { CLAUDE_HOOK_MIN_VERSION, claudeApprovals } from "./claude.ts";
import { ApprovalHub, hubAddress, type ApprovalAdapter } from "./hub.ts";
import { keyDigest, newNonce, seal, unseal } from "./relay.ts";

const roots: string[] = [];
const started: ApprovalHub[] = [];
const squatters: Server[] = [];
afterEach(() => {
  for (const hub of started.splice(0)) hub.stop();
  for (const squatter of squatters.splice(0)) squatter.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An agent whose hook takes `--hook <json>` and sends `{ command, words }`. */
const fake: ApprovalAdapter = {
  kind: "fake",
  supports: (version) => meetsMinVersion(version, "1.0.0"),
  launchArgs: (args, hook) => [...args ?? [], "--hook", JSON.stringify(hook)],
  toCard: (event) => {
    const { command, words } = event as { command?: unknown; words?: unknown };
    return typeof command === "string" ? { command, description: typeof words === "string" ? words : null } : null;
  },
  decision: (label) => label === "Allow" ? "allow" : label === "Deny" ? "deny" : null,
  toAnswer: (decision) => JSON.stringify({ decision }),
};

function hubIn() {
  // short names: a socket's path has at most 104 bytes on macOS, whose temp folder is long already
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-")));
  roots.push(root);
  const waiting: (() => void)[] = [];
  const hub = new ApprovalHub(join(root, "h"), [fake, claudeApprovals], { onHeld: () => waiting.shift()?.() });
  started.push(hub);
  const held = () => new Promise<void>((resolve) => waiting.push(resolve));
  return { hub, held, root };
}

const hookOf = (args: string[]): { command: string; args: string[] } => JSON.parse(args[args.indexOf("--hook") + 1]!) as { command: string; args: string[] };
const keyOf = (hook: { args: string[] }): string => readFileSync(hook.args[hook.args.indexOf("--launch-file") + 1]!, "utf8");

function ask(hook: { command: string; args: string[] }, event: unknown) {
  const relay = Bun.spawn([hook.command, ...hook.args], { stdin: new Blob([JSON.stringify(event)]), stdout: "pipe", stderr: "pipe" });
  return async () => {
    const out = await new Response(relay.stdout).text();
    expect(await relay.exited).toBe(0);
    return out === "" ? null : JSON.parse(out) as unknown;
  };
}

describe("which launches get the hook", () => {
  it("adds none to an agent the hub has no adapter for, and opens no listener for it", () => {
    const { hub } = hubIn();
    expect(hub.handles("codex")).toBe(false);
    expect(hub.launchArgs("codex", "p1", ["--model", "o3"], "1.2.3")).toEqual(["--model", "o3"]);
    expect(hub.launchArgs("codex", "p1", undefined, "1.2.3")).toBeUndefined();
    expect(existsSync(hub.address)).toBe(false);
  });

  it("adds none to a version its adapter does not support, or to one that could not be read", () => {
    const { hub } = hubIn();
    expect(hub.launchArgs("fake", "p1", ["--x"], "0.9.0")).toEqual(["--x"]);
    expect(hub.launchArgs("fake", "p1", ["--x"], null)).toEqual(["--x"]);
    expect(hub.launchArgs("fake", "p1", ["--x"], "1.0.0")).toContain("--hook");
    expect(hub.launchArgs("claude", "p1", undefined, "2.1.285")).toBeUndefined();
    expect(hub.launchArgs("claude", "p1", undefined, null)).toBeUndefined();
    expect(hub.launchArgs("claude", "p1", undefined, CLAUDE_HOOK_MIN_VERSION)?.[0]).toBe("--settings");
  });

  // CodeRabbit on #4516: a version read that ends after the server stopped opened the listener again
  it("adds none once the hub has stopped, and opens no listener again", () => {
    const { hub } = hubIn();
    hub.stop();
    expect(hub.launchArgs("fake", "p1", ["--x"], "1.0.0")).toEqual(["--x"]);
    expect(existsSync(hub.address)).toBe(false);
  });
});

describe("where the hub listens", () => {
  it("is a socket in its own folder, and on Windows a named pipe whose name no other hub has", () => {
    expect(hubAddress("/state/h", "linux")).toBe(join("/state/h", "hub.sock"));
    const pipe = hubAddress("C:\\state\\h", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\ovis-approvals-[0-9a-f]{32}$/);
    expect(hubAddress("C:\\state\\h", "win32")).not.toBe(pipe);
  });
});

describe("the channel", () => {
  it("holds a request apart from any screen, and answers it by its id", async () => {
    const { hub, held } = hubIn();
    const hook = hookOf(hub.launchArgs("fake", "p1", undefined, "1.0.0")!);
    const holding = held();
    const answer = ask(hook, { command: "make deploy", words: "Deploy" });
    await holding;
    const [request] = hub.held("p1");
    expect(request).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), kind: "fake", command: "make deploy", description: "Deploy" });
    expect(hub.held("p2")).toEqual([]);
    expect(hub.decision("p1", request!.id, "Allow")).toBe("allow");
    expect(hub.decision("p1", request!.id, "Later")).toBeNull();
    expect(hub.decision("p2", request!.id, "Allow")).toBeNull();
    expect(hub.settle("p1", "0".repeat(16), "allow")).toBe(false);
    expect(hub.settle("p1", request!.id, "allow")).toBe(true);
    expect(await answer()).toEqual({ decision: "allow" });
    expect(hub.held("p1")).toEqual([]);
  });

  it("gives no decision at once on an event its adapter does not take", async () => {
    const { hub, held } = hubIn();
    const hook = hookOf(hub.launchArgs("fake", "p1", undefined, "1.0.0")!);
    expect(await Promise.race([ask(hook, { other: true })(), held().then(() => "held")])).toEqual({ decision: null });
  });

  /** What the hub says to one raw line: its reply, or "" when it closed the connection without one. */
  const sent = (address: string, line: string) => new Promise<string>((resolve) => {
    let text = "";
    const socket = connect(address);
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk) => { text += String(chunk); });
    socket.on("close", () => resolve(text));
    socket.on("error", () => undefined);
  });

  it("holds nothing for a request not sealed with the launch's key, nor for a line that is no request", async () => {
    const { hub, held } = hubIn();
    const hook = hookOf(hub.launchArgs("fake", "p1", undefined, "1.0.0")!);
    const key = keyOf(hook);
    const event = JSON.stringify({ command: "make deploy" });
    const nonce = newNonce();
    const lines = [
      { launch: keyDigest(key), nonce, sealed: seal("another key", "request", nonce, event) },
      { launch: keyDigest(key), nonce, sealed: seal(key, "answer", nonce, event) },
      { launch: keyDigest(key), nonce: newNonce(), sealed: seal(key, "request", nonce, event) },
      { launch: keyDigest(key), nonce: "n\nrequest", sealed: seal(key, "request", "n\nrequest", event) },
      { launch: keyDigest(key), nonce, sealed: "é".repeat(64) },
      { launch: keyDigest(key), nonce, sealed: 7 },
      { launch: ["x"], nonce, sealed: "" },
    ].map((envelope) => `${JSON.stringify(envelope)}\n`);
    for (const line of [...lines, "null\n", "[]\n", "7\n", "{\n", `${"x".repeat(3 * 1024 * 1024)}`]) {
      // the hub reads a request whole before it closes the connection on it
      expect(await sent(hub.address, line), line.slice(0, 80)).toBe("");
    }
    expect(hub.held("p1")).toEqual([]);
    // and goes on answering
    const holding = held();
    const answer = ask(hook, { command: "make deploy" });
    await holding;
    expect(hub.settle("p1", hub.held("p1")[0]!.id, "deny")).toBe(true);
    expect(await answer()).toEqual({ decision: "deny" });
  });

  // main's hub took 256 KiB of the request's body, in bytes (its Content-Length)
  it("reads no event over 256 KiB of UTF-8, which the agent's terminal answers", async () => {
    const { hub, held } = hubIn();
    const hook = hookOf(hub.launchArgs("fake", "p1", undefined, "1.0.0")!);
    const command = "é".repeat(140 * 1024);
    expect(JSON.stringify({ command }).length).toBeLessThan(256 * 1024);
    expect(await Promise.race([ask(hook, { command })(), held().then(() => "held")])).toBeNull();
  });

  // a named pipe's name is anyone's to take once the hub has stopped, as a loopback port would be
  it("takes no answer from a listener at its address that does not hold the key, and tells it neither the key nor the command", async () => {
    const { hub } = hubIn();
    const hook = hookOf(hub.launchArgs("fake", "p1", undefined, "1.0.0")!);
    const key = keyOf(hook);
    hub.stop();
    const heard: string[] = [];
    const squatter = createServer((socket) => socket.on("data", (chunk) => {
      heard.push(String(chunk));
      const { nonce, launch, sealed } = JSON.parse(String(chunk).split("\n")[0]!) as { nonce: string; launch: string; sealed: string };
      // all it could seal with, or read with: what it heard
      expect(unseal(launch, "request", nonce, sealed)).toBeNull();
      socket.end(`${JSON.stringify({ sealed: seal(launch, "answer", nonce, JSON.stringify({ decision: "allow" })) })}\n`);
    }));
    squatters.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(hub.address, resolve));
    expect(await ask(hook, { command: "make deploy" })()).toBeNull();
    expect(heard.join("")).not.toContain(key);
    expect(heard.join("")).not.toContain("make deploy");
    expect(heard.join("")).toContain(keyDigest(key));
  });
});
