import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanePromptResponse } from "../../shared/protocol.ts";
import { socketAddress } from "../herdr/client.ts";
import { handlePromptRequest, noteSubmitted, prepareCommandSend } from "../prompt.ts";
import { paneCommands } from "../commands.ts";
import { commandInvocations, commandOutcome, CommandReservations, type CommandSend } from "../outcome.ts";
import { hermesChromeStart, hermesEchoOf } from "./hermes.ts";
import { registry } from "./registry.ts";
import { findLastIndex } from "./shared.ts";

// Recorded Hermes 0.21.5 screens (server/fixtures/hermes-results). The 120-column pane ran, in order:
// /status (status-120), /version (version-120), /profile (profile-120), /reload-skills (reload-skills-120),
// /help (help-120-cut), /reload-skills after a skill was added (reload-skills-added-120), /status twice (status-twice-120).
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", "hermes-results", `${name}.txt`), "utf8").replace(/\r\n/g, "\n");
const rows = paneCommands("hermes", null, "/nonexistent-home");
const readers = registry.readersFor("hermes");
const at = Date.parse("2026-10-20T00:00:00Z");

function send(ledger: CommandReservations, text: string, screen: string, offset = 0): CommandSend {
  const invocations = commandInvocations("hermes", text, rows);
  const sent: CommandSend = { id: `send-${offset}`, text, at: at + offset, agent: "hermes", identity: "hermes-pane", screen, invocations, form: invocations[0]?.form ?? null };
  ledger.add(sent, readers);
  return sent;
}
const observe = (sent: CommandSend, screen: string, nextAt?: number) => {
  sent.outcome = commandOutcome("pane-1", sent, { now: sent.at + 50, screen, readers, ...(nextAt === undefined ? {} : { nextAt }) });
  return sent.outcome;
};

const twice = fixture("status-twice-120").split("\n");
const statusEchoes = twice.flatMap((line, index) => hermesEchoOf(line.trimEnd(), "/status") ? [index] : []);
const [firstEcho, secondEcho] = statusEchoes.slice(-2) as [number, number];
const chrome = twice.slice(hermesChromeStart(twice.map((line) => line.trimEnd())));
const until = (end: number, input: (line: string) => string = (line) => line) => [...twice.slice(0, end), ...chrome.map(input)].join("\n");
const busy = (line: string) => line.replace(/^❯ /, "⠋ ");

describe("Hermes result outcomes", () => {
  it("cuts the bottom chrome at the status bar on every recorded screen", () => {
    for (const name of ["status-40", "status-120", "version-40", "profile-40", "reload-skills-40", "help-40", "help-120"]) {
      const lines = fixture(name).split("\n").map((line) => line.trimEnd());
      const start = hermesChromeStart(lines);
      expect(lines[start]).toStartWith(" ☤ ");
      expect(lines.slice(start + 1).filter((line) => line.trim() && !/^─+$/.test(line)).every((line) => line.startsWith("❯"))).toBeTrue();
    }
    for (const reader of readers.filter((candidate) => candidate.kind === "result")) expect(reader.chromeStart).toBe(hermesChromeStart);
    expect(hermesChromeStart(["plain output", "no input area"])).toBe(-1);
  });

  it("never takes a rule that is not the input area's for chrome, so an old result is not promoted (T24-A3-1)", () => {
    const shown = fixture("status-120").split("\n").map((line) => line.trimEnd());
    const input = shown.findIndex((line) => line.startsWith("❯ "));
    const echo = shown.findIndex((line) => hermesEchoOf(line, "/status"));
    const withRule = [...shown.slice(0, echo), "────────────────────────────────", "fixture reply text", ...shown.slice(echo)];
    const ruleAt = echo;
    const inputAt = input + 2;
    const torn = withRule.filter((_, index) => index !== inputAt - 1);
    expect(hermesChromeStart(torn)).toBe(-1);
    expect(hermesChromeStart(withRule)).toBe(inputAt - 2);
    expect(withRule[ruleAt]).toMatch(/^─+$/);
    expect(hermesChromeStart([...withRule.slice(0, inputAt), "something else", ...withRule.slice(inputAt + 1)])).toBe(-1);
    const sent = send(new CommandReservations(), "/status", torn.join("\n"));
    expect(observe(sent, withRule.join("\n")).state).toBe("accepted");
  });

  it("resolves each recorded informational command from the screen that followed it", () => {
    for (const [before, after, text] of [["status-120", "version-120", "/version"], ["version-120", "profile-120", "/profile"], ["profile-120", "reload-skills-120", "/reload-skills"]] as const) {
      const sent = send(new CommandReservations(), text, fixture(before));
      expect(observe(sent, fixture(after))).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
    }
  });

  it("gives two identical /status sends two completions, each from the block under its own echo", () => {
    const ledger = new CommandReservations();
    const first = send(ledger, "/status", until(firstEcho));
    expect(first.form).toEqual({ match: "bare", interaction: "dialog", dialog: "hermes-status" });
    expect(observe(first, until(secondEcho))).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
    const second = send(ledger, "/status", until(secondEcho), 100);
    expect(observe(second, until(secondEcho + 1, busy)).state).toBe("accepted");
    expect(observe(second, twice.join("\n"))).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
  });

  it("resolves the earlier of two quick /status sends from its own block, which the later echo completes", () => {
    const ledger = new CommandReservations();
    const first = send(ledger, "/status", until(firstEcho));
    const second = send(ledger, "/status", until(firstEcho), 1);
    expect(observe(second, until(secondEcho)).state).toBe("accepted");
    // Hermes echoes the next command only after the previous one finished: the later echo is the first block's end
    const earlier = observe(first, twice.join("\n"), second.at);
    expect(earlier).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
    expect(earlier.result_text).toContain(twice[firstEcho + 1]!.trim());
    expect(earlier.result_text).not.toContain(twice[secondEcho]!.trim());
    expect(observe(second, twice.join("\n")).state).toBe("result-observed");
  });
  it("sets catalog_changed for this send's successful reload only", () => {
    const added = send(new CommandReservations(), "/reload-skills", fixture("help-120-cut"));
    expect(observe(added, fixture("reload-skills-added-120"))).toMatchObject({ state: "result-observed", catalog_changed: true });
    const failed = send(new CommandReservations(), "/reload-skills", fixture("profile-120"));
    const failure = observe(failed, fixture("reload-skills-failed-120"));
    expect(failure.state).toBe("result-observed");
    expect(failure.catalog_changed).toBeUndefined();
    const old = send(new CommandReservations(), "/reload-skills", fixture("reload-skills-added-120"));
    expect(observe(old, fixture("reload-skills-added-120")).state).toBe("accepted");
  });

  it("does not resolve a Chat /status from a /status typed in the terminal after it, though its own echo alone does", () => {
    expect(observe(send(new CommandReservations(), "/status", until(firstEcho)), until(secondEcho)).state).toBe("result-observed");
    expect(observe(send(new CommandReservations(), "/status", until(firstEcho)), twice.join("\n")).state).toBe("accepted");
    const typedOnly = [...twice.slice(0, firstEcho + 1), ...twice.slice(secondEcho)].join("\n");
    expect(observe(send(new CommandReservations(), "/status", until(firstEcho)), typedOnly).state).toBe("accepted");
  });

  it("carries the recognized block verbatim as result_text, only on recognized-result evidence", () => {
    const sent = send(new CommandReservations(), "/version", fixture("status-120"));
    const shown = observe(sent, fixture("version-120"));
    expect(shown.evidence).toEqual([{ kind: "recognized-result", at: expect.any(String) }]);
    const lines = fixture("version-120").split("\n").map((line) => line.trimEnd());
    const echo = findLastIndex(lines, (line) => hermesEchoOf(line, "/version"));
    const update = lines.findIndex((line, index) => index > echo && line.startsWith("Update available"));
    expect(shown.result_text).toBe(lines.slice(echo + 1, update + 1).join("\n"));
    const external = send(new CommandReservations(), "/version", fixture("status-120"), 1);
    const proved = commandOutcome("pane-1", external, { now: external.at + 50, screen: fixture("version-120"), readers, evidence: { kind: "dialog", at: external.at + 10 } });
    expect(proved.state).toBe("result-observed");
    expect(proved).not.toHaveProperty("result_text");
    const read = fixture("help-120").split("\n").map((line) => line.trimEnd());
    const helpEcho = findLastIndex(read, (line) => hermesEchoOf(line, "/help"));
    const after = read.findIndex((line, index) => index > helpEcho && /^⚙/.test(line));
    const input = read.slice(hermesChromeStart(read));
    const help = send(new CommandReservations(), "/help", [...read.slice(0, helpEcho), ...input].join("\n"));
    const long = observe(help, [...read.slice(0, after), ...input].join("\n"));
    expect(long.state).toBe("result-observed");
    expect(long.result_text?.length).toBe(2000);
  });

  it("serves result_text to the pane's owner and withholds it from observers", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-hermes-result-route-"));
    const socketPath = join(root, "herdr.sock");
    const previous = process.env.HERDR_SOCKET;
    const paneId = `hermes-result-${Date.now()}`;
    let screen = fixture("status-120");
    const server = createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input) as { id: string; method: string };
        const result = request.method === "session.snapshot"
          ? { snapshot: { panes: [{ pane_id: paneId, agent: "hermes", agent_status: "idle" }], layouts: [] } }
          : { read: { text: screen } };
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
    process.env.HERDR_SOCKET = socketPath;
    try {
      const invocations = commandInvocations("hermes", "/version", rows);
      noteSubmitted(paneId, "/version", { id: "hermes-version-send", text: "/version", at: Date.now() - 1, agent: "hermes",
        identity: JSON.stringify([undefined, undefined]), screen, invocations, form: invocations[0]?.form ?? null, store: null });
      screen = fixture("version-120");
      const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
      const owner = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
      expect(owner.outcomes?.at(-1)).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
      expect(owner.outcomes?.at(-1)?.result_text?.split("\n")[0]).toStartWith("Hermes Agent v");
      expect(owner.prompt).toBeNull();
      const watched = await (await handlePromptRequest(new Request(url), url, { readOnly: true }))?.json() as PanePromptResponse;
      expect(watched.outcomes?.at(-1)?.state).toBe("result-observed");
      expect(watched.outcomes?.at(-1)).not.toHaveProperty("result_text");
    } finally {
      if (previous === undefined) delete process.env.HERDR_SOCKET;
      else process.env.HERDR_SOCKET = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a send without requesting a pre-send screen that could fail delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-hermes-presend-"));
    const socketPath = join(root, "herdr.sock");
    const previous = process.env.HERDR_SOCKET;
    const paneId = `hermes-presend-${Date.now()}`;
    const server = createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input) as { id: string; method: string };
        socket.end(`${JSON.stringify(request.method === "pane.read"
          ? { id: request.id, error: { code: "pane_not_found", message: "pane read failed" } }
          : { id: request.id, result: {} })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
    process.env.HERDR_SOCKET = socketPath;
    try {
      const pane = { pane_id: paneId, agent: "hermes", agent_status: "idle" } as Parameters<typeof prepareCommandSend>[0];
      expect(prepareCommandSend(pane, "/status")).toMatchObject({ text: "/status", screen: "", store: null });
    } finally {
      if (previous === undefined) delete process.env.HERDR_SOCKET;
      else process.env.HERDR_SOCKET = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the transcript on a prompt poll only while a sent command can still change from it", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-hermes-transcript-gate-"));
    const socketPath = join(root, "herdr.sock");
    const previous = process.env.HERDR_SOCKET;
    const paneId = `hermes-gate-${Date.now()}`;
    let screen = fixture("status-120");
    let snapshots = 0;
    let processReads = 0;
    const server = createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input) as { id: string; method: string };
        if (request.method === "session.snapshot") snapshots++;
        if (request.method === "pane.process_info") processReads++;
        const result = request.method === "session.snapshot"
          ? { snapshot: { panes: [{ pane_id: paneId, agent: "hermes", agent_status: "idle" }], layouts: [] } }
          : { read: { text: screen } };
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
    process.env.HERDR_SOCKET = socketPath;
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
    const poll = async () => {
      snapshots = 0;
      processReads = 0;
      const body = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
      return { snapshots, processReads, state: body.outcomes?.at(-1)?.state };
    };
    const note = (id: string, at: number) => {
      const invocations = commandInvocations("hermes", "/version", rows);
      noteSubmitted(paneId, "/version", { id, text: "/version", at, agent: "hermes",
        identity: JSON.stringify([undefined, undefined]), screen, invocations, form: invocations[0]?.form ?? null, store: null });
    };
    try {
      note("hermes-gate-send", Date.now() - 1);
      const open = await poll();
      expect(open).toEqual({ snapshots: 1, processReads: 1, state: "accepted" });
      screen = fixture("version-120");
      expect((await poll()).state).toBe("result-observed");
      const settled = await poll();
      expect(settled).toEqual({ snapshots: 1, processReads: 0, state: "result-observed" });
      screen = fixture("status-120");
      note("hermes-gate-expired", Date.now() - 11 * 60_000);
      expect(await poll()).toMatchObject({ snapshots: 1, processReads: 0 });
    } finally {
      if (previous === undefined) delete process.env.HERDR_SOCKET;
      else process.env.HERDR_SOCKET = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
