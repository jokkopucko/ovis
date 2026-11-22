import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

/**
 * Two web bridges on one herdr (a second install beside the first): herdr gives one of them
 * a terminal's attach.
 */
const rootA = mkdtempSync(join(tmpdir(), "herdr-held-a-"));
const rootB = mkdtempSync(join(tmpdir(), "herdr-held-b-"));
const first = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootA });
const second = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootB, attachHeldRetryMs: 200 });
const third = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: rootB, attachHeldRetryMs: 200, attachRetryForMs: 300 });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  first.stop();
  second.stop();
  third.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function connect(port: number, paneId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = {
    frames: 0, tail: "", errors: [] as string[], errorPanes: [] as (string | undefined)[], exits: 0, exitCodes: [] as (number | null)[],
    ready: 0, resumed: 0, submits: [] as { ok: boolean; code?: string }[],
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") {
      state.errors.push(frame.code);
      state.errorPanes.push(frame.pane_id);
    }
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exitCodes.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type === "input-ready" && frame.pane_id === paneId && frame.ready !== false) state.ready++;
    if (frame.type === "attach-resumed" && frame.pane_id === paneId) state.resumed++;
    if (frame.type === "pty-data" && frame.pane_id === paneId) {
      state.frames++;
      state.tail = (state.tail + frame.data).slice(-8192);
    }
    if (frame.type === "submit-result" && frame.pane_id === paneId) state.submits.push({ ok: frame.ok, code: frame.code });
  });
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const open = until(() => ws.readyState === WebSocket.OPEN, "socket open");
  return { ws, state, send, open };
}

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "ovis-test-held", cwd: rootA, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

function scriptedHerdr(attempts: string[]): { path: string; attempts: () => number } {
  const real = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr") || "herdr";
  const dir = mkdtempSync(join(rootB, "scripted-herdr-"));
  const count = join(dir, "count");
  const path = join(dir, "herdr");
  const cases = attempts.map((step, index) => {
    const pattern = index === attempts.length - 1 ? "*" : String(index);
    return `  ${pattern}) ${step === "real" ? `exec '${real}' "$@"` : step} ;;`;
  });
  writeFileSync(path, [
    "#!/bin/sh",
    `n=$(cat '${count}' 2>/dev/null || echo 0)`,
    `echo $((n + 1)) > '${count}'`,
    'case "$n" in',
    ...cases,
    "esac",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return { path, attempts: () => existsSync(count) ? Number(readFileSync(count, "utf8").trim() || 0) : 0 };
}

async function withHerdr<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env["OVIS_HERDR_BIN"];
  process.env["OVIS_HERDR_BIN"] = path;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env["OVIS_HERDR_BIN"];
    else process.env["OVIS_HERDR_BIN"] = previous;
  }
}

const READ_RACE = "printf 'herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\\r\\n'; exit 1";
const HELD = "printf 'herdr: server shut down: terminal attach failed: terminal term_0 already has an attached client; retry with --takeover\\r\\n'; exit 1";

describe("a terminal another web bridge holds", () => {
  it("waits for that bridge instead of ending, then attaches when it lets go", async () => {
    const paneId = await pane();

    const a = connect(first.port, paneId);
    const b = connect(second.port, paneId);
    try {
      await a.open;
      a.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await until(() => a.state.frames > 0, "first bridge attached");

      await b.open;
      b.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await until(() => b.state.errors.includes("attach_held"), "second bridge told the pane is held");
      await Bun.sleep(900);
      expect(b.state.exits).toBe(0);
      expect(b.state.ready).toBe(0);
      expect(b.state.errors.filter((code) => code === "attach_held")).toHaveLength(1);
      expect(b.state.errors).not.toContain("attach_conflict");
      expect(b.state.errorPanes[b.state.errors.indexOf("attach_held")]).toBe(paneId);
      expect(a.state.exits).toBe(0);
      // nothing is typed through the waiting bridge into a pane the other one has
      b.send({ type: "submit", id: 1, pane_id: paneId, text: "echo held", payload: "echo held" });
      await until(() => b.state.submits.length === 1, "submit answered while held");
      expect(b.state.submits[0]).toEqual({ ok: false, code: "attach_held" });
      // nor keys or input: A's half-typed command is not run from B
      const marker = join(rootA, "entered-through-b");
      a.send({ type: "input", pane_id: paneId, text: `touch '${marker}'` });
      await Bun.sleep(300);
      b.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
      b.send({ type: "input", pane_id: paneId, text: "\r" });
      await Bun.sleep(500);
      expect(existsSync(marker)).toBe(false);
      expect(b.state.errors.filter((code) => code === "attach_held")).toHaveLength(2);
      a.send({ type: "input", pane_id: paneId, text: "\r" });
      await until(() => existsSync(marker), "first bridge runs its own command");

      a.send({ type: "detach", pane_id: paneId });
      await until(() => b.state.resumed === 1, "second bridge attached after the first let go");
      await until(() => b.state.frames > 0, "second bridge paints the terminal");
      expect(b.state.ready).toBe(1);
      expect(b.state.exits).toBe(0);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  }, 30_000);

  it("takes the pane when asked, and the bridge it was taken from waits in turn", async () => {
    const paneId = await pane();
    const a = connect(first.port, paneId);
    const b = connect(second.port, paneId);
    const watcher = connect(first.port, paneId);
    try {
      await a.open;
      a.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await until(() => a.state.frames > 0, "first bridge attached");
      await b.open;
      b.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await until(() => b.state.errors.includes("attach_held"), "second bridge told the pane is held");

      // an observer may not take it
      await watcher.open;
      watcher.send({ type: "role", mode: "observe" });
      watcher.send({ type: "take-over", pane_id: paneId });
      await until(() => watcher.state.errors.includes("read_only"), "observer refused");

      b.send({ type: "take-over", pane_id: paneId });
      await until(() => b.state.resumed === 1 && b.state.ready > 0, "second bridge took the pane");
      await until(() => a.state.errors.includes("attach_held"), "first bridge told the pane is held");
      expect(a.state.exits).toBe(0);
      const marker = join(rootA, "typed-after-take-over");
      b.send({ type: "input", pane_id: paneId, text: `touch '${marker}'\r` });
      await until(() => existsSync(marker), "second bridge types into the pane");

      a.send({ type: "take-over", pane_id: paneId });
      await until(() => a.state.resumed === 1, "first bridge took it back");
      await until(() => b.state.errors.filter((code) => code === "attach_held").length === 2, "second bridge waits again");
      expect(b.state.exits).toBe(0);
      expect(a.state.exits).toBe(0);
    } finally {
      a.ws.close();
      b.ws.close();
      watcher.ws.close();
    }
  }, 30_000);
});

describe("an attach classified as held", () => {
  it("is only herdr's own refusal: other output gets bounded live-terminal recovery", async () => {
    const paneId = await pane();
    const herdr = scriptedHerdr([`${HELD.replace("; exit 1", "")}; printf 'more pane output\\r\\n'; sleep 0.5; exit 1`]);
    await withHerdr(herdr.path, async () => {
      const client = connect(third.port, paneId);
      try {
        await client.open;
        client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
        await until(() => client.state.exits === 1, "the repeatedly failed attach reaches its one recovery deadline");
        expect(client.state.exitCodes).toEqual([1]);
        expect(client.state.errors).not.toContain("attach_held");
        expect(client.state.tail).toContain("already has an attached client");
        const attempts = herdr.attempts();
        expect(attempts).toBeGreaterThan(1);
        expect(attempts).toBeLessThan(16);
        await Bun.sleep(400);
        expect(herdr.attempts()).toBe(attempts);
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("gives a read race after the wait its full retry budget", async () => {
    const paneId = await pane();
    const herdr = scriptedHerdr([READ_RACE, HELD, HELD, HELD, READ_RACE, "real"]);
    await withHerdr(herdr.path, async () => {
      const client = connect(third.port, paneId);
      try {
        await client.open;
        client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
        await until(() => client.state.resumed === 1, "attached after the wait and the second read race");
        await until(() => client.state.frames > 0, "the attach paints");
        expect(herdr.attempts()).toBe(6);
        expect(client.state.exits).toBe(0);
        expect(client.state.errors).toEqual(["attach_held"]);
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("is not pane output that shows herdr's refusal: a live attach whose screen has it is painted and resumes", async () => {
    const paneId = await pane();
    const shown = HELD.replace("; exit 1", "");
    const herdr = scriptedHerdr([HELD, `${shown}; printf 'more pane output\\r\\n'; sleep 10`]);
    await withHerdr(herdr.path, async () => {
      const client = connect(third.port, paneId);
      try {
        await client.open;
        client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
        await until(() => client.state.resumed === 1, "the live attach resumes", 5_000);
        await until(() => client.state.tail.includes("more pane output"), "the live attach paints", 5_000);
        expect(client.state.errors).toEqual(["attach_held"]);
        expect(client.state.exits).toBe(0);
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("is not resumed by the attach's own setup bytes when herdr's refusal comes after them", async () => {
    const paneId = await pane();
    // herdr refuses, then a busy herdr answers late: the attach's own mode setup (mouse
    // reporting off, the alternate screen on), a gap longer than the hold, its teardown (modes
    // reset, the cursor style restored), another such gap, the refusal; then the real attach.
    // herdr writes the teardown and its message apart: a loaded PC can pause it between them.
    const late = `printf '\\033[?1006l\\033[?1000l'; sleep 0.2; printf '\\033[?1049h\\033[?1006l\\033[?2031l\\033[?7h'; sleep 0.4; printf '\\033[?1049l\\033[?25h\\033[0 q'; sleep 0.4; ${HELD}`;
    const herdr = scriptedHerdr([HELD, late, "real"]);
    await withHerdr(herdr.path, async () => {
      const client = connect(third.port, paneId);
      try {
        await client.open;
        client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
        await until(() => herdr.attempts() === 3, "the real attach starts");
        await until(() => client.state.frames > 0, "the real attach paints");
        expect(client.state.resumed).toBe(1);
        expect(client.state.errors).toEqual(["attach_held"]);
        expect(client.state.exits).toBe(0);
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("keeps the pane held when a refusal's exit is overdue, and tries again instead of resuming", async () => {
    const paneId = await pane();
    const herdr = scriptedHerdr([HELD, `${HELD.replace("; exit 1", "")}; sleep 10`, HELD, "real"]);
    await withHerdr(herdr.path, async () => {
      const client = connect(third.port, paneId);
      try {
        await client.open;
        client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
        await until(() => client.state.errors.includes("attach_held"), "the first refusal holds the pane", 5_000);
        await until(() => herdr.attempts() === 2, "the retry whose exit never comes starts", 5_000);
        // just past that refusal's exit budget: still held, and a key does not get through
        await Bun.sleep(2_150);
        client.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
        await until(() => client.state.errors.filter((code) => code === "attach_held").length === 2, "keys refused while held", 5_000);
        await until(() => client.state.resumed === 1, "the real attach resumes", 5_000);
        expect(herdr.attempts()).toBe(4);
        await until(() => client.state.frames > 0, "the real attach paints", 5_000);
        expect(client.state.tail).not.toContain("already has an attached client");
        expect(client.state.exits).toBe(0);
      } finally { client.ws.close(); }
    });
  }, 30_000);
});
