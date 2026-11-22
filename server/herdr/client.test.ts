import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrError,
  herdrRpc,
  paneRead,
  paneSendKeys,
  paneSendText,
  ping,
  sessionSnapshot,
  subscribeEvents,
  workspaceClose,
  workspaceCreate,
} from "./client.ts";


describe("ping", () => {
  it("reaches the live herdr server and reports its protocol", async () => {
    const result = await ping();
    expect(typeof result.version).toBe("string");
    expect(result.version.length).toBeGreaterThan(0);
    expect(result.protocol).toBeGreaterThan(0);
  });
});

describe("sessionSnapshot", () => {
  it("returns the live workspace/tab/pane tree", async () => {
    const snapshot = await sessionSnapshot();
    expect(snapshot.workspaces.length).toBeGreaterThan(0);
    expect(snapshot.panes.length).toBeGreaterThan(0);
    for (const workspace of snapshot.workspaces) {
      expect(typeof workspace.workspace_id).toBe("string");
      expect(workspace.workspace_id.length).toBeGreaterThan(0);
      expect(typeof workspace.label).toBe("string");
    }
    for (const pane of snapshot.panes) {
      expect(typeof pane.pane_id).toBe("string");
      expect(typeof pane.workspace_id).toBe("string");
    }
  });

  it("issues a fresh connection per call, so sequential calls both succeed", async () => {
    const first = await sessionSnapshot();
    const second = await sessionSnapshot();
    expect(first.workspaces.length).toBe(second.workspaces.length);
  });
});

describe("paneRead", () => {
  it("polls recent text without sending scroll events into an idle alternate-screen TUI", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-passive-read-"));
    let workspaceId: string | undefined;
    try {
      const input = join(root, "input.log");
      const fixture = join(root, "tui.ts");
      writeFileSync(input, "");
      writeFileSync(fixture, `
        import { appendFileSync } from "node:fs";
        process.stdin.setRawMode(true);
        process.stdin.on("data", (chunk) => appendFileSync(${JSON.stringify(input)}, chunk));
        process.stdout.write("\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[H"
          + "\\x1b[31mA saved answer on the desktop.\\x1b[0m\\r\\n"
          + "\\x1b]8;;https://example.invalid\\x07A saved link\\x1b]8;;\\x07\\r\\n"
          + "\\r\\n› ");
      `);
      const created = await workspaceCreate({ cwd: root, label: "ovis-test-passive-read" });
      workspaceId = created.workspace.workspace_id;
      const paneId = created.root_pane.pane_id;
      const quote = (text: string) => `'${text.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
      await paneSendText(paneId, `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(fixture)}`);
      await paneSendKeys(paneId, ["enter"]);
      const deadline = Date.now() + 5000;
      while (!(await paneRead({ paneId, source: "visible" })).text.includes("A saved answer on the desktop.")) {
        if (Date.now() > deadline) throw new Error(`alternate-screen TUI did not start: ${(await paneRead({ paneId, source: "visible" })).text}`);
        await Bun.sleep(25);
      }
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle" });
      const before = (await paneRead({ paneId, source: "visible" })).text;
      for (const source of ["recent", "recent_unwrapped"] as const) {
        for (let poll = 0; poll < 2; poll++) {
          const read = await paneRead({ paneId, source, lines: 400 });
          expect(read.text).toContain("A saved answer on the desktop.");
          expect(read.text).toContain("A saved link");
          expect(read.text).not.toContain("\x1b");
          expect(read.format).toBe("text");
          expect(read.source).toBe(source);
        }
        const raw = await paneRead({ paneId, source, lines: 400, stripAnsi: false });
        expect(raw.text).toContain("A saved answer on the desktop.");
        expect(raw.text).toContain("\x1b");
        expect(raw.format).toBe("text");
      }
      expect(readFileSync(input, "utf8")).toBe("");
      expect((await paneRead({ paneId, source: "visible" })).text).toBe(before);
      const styled = await paneRead({ paneId, source: "recent", format: "ansi", lines: 400 });
      expect(styled.text).toContain("\x1b");
      expect(styled.format).toBe("ansi");
    } finally {
      if (workspaceId) await workspaceClose(workspaceId);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("returns terminal text for a live pane and echoes its id", async () => {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes[0];
    expect(pane).toBeDefined();
    const read = await paneRead({ paneId: pane!.pane_id, source: "visible" });
    expect(read.pane_id).toBe(pane!.pane_id);
    expect(typeof read.text).toBe("string");
  });

  it("keeps escape sequences when reading ansi", async () => {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes[0]!;
    const read = await paneRead({ paneId: pane.pane_id, source: "visible", format: "ansi" });
    expect(typeof read.text).toBe("string");
    expect(read.format).toBe("ansi");
  });

  it("rejects an unknown pane with a coded HerdrError", async () => {
    let caught: unknown = null;
    try {
      await paneRead({ paneId: "w9999:p9999", source: "visible" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    const error = caught as HerdrError;
    expect(typeof error.code).toBe("string");
    expect(error.code.length).toBeGreaterThan(0);
    expect(error.code).not.toBe("timeout");
  });
});

describe("subscribeEvents", () => {
  it("opens a streaming connection and closes cleanly", async () => {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes[0]!;
    let handle: { close: () => void } | null = null;

    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription_started not received within 5s")), 5000);
      handle = subscribeEvents(
        [
          { type: "pane.updated", pane_id: pane.pane_id },
          { type: "workspace.focused" },
        ],
        {
          onEvent: () => {},
          onStarted: () => {
            clearTimeout(timer);
            resolve();
          },
          onError: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        },
      );
    });

    await started;
    expect(handle).not.toBeNull();
    expect(() => handle!.close()).not.toThrow();
  });

  it("reports a connect that fails as closed, so a subscriber retrying on close retries", async () => {
    const closed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onClose not called within 5s")), 5000);
      let error = "";
      subscribeEvents([{ type: "workspace.focused" }], {
        onEvent: () => {},
        onError: (err) => { error = (err as Error & { code?: string }).code ?? ""; },
        onClose: () => {
          clearTimeout(timer);
          resolve(error);
        },
      }, "/nonexistent/ovis-test.sock");
    });
    expect(await closed).toBe("connect_failed");
  });
});

describe("a failed herdr call", () => {
  function standIn(answer: (client: { write(text: string): void; end(): void }, id: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "herdr-failed-call-"));
    const socket = join(root, "herdr.sock");
    const listener = Bun.listen({ unix: socket, socket: { data(client, chunk) { answer(client, (JSON.parse(chunk.toString().split("\n")[0]!) as { id: string }).id); } } });
    return { socket, close: () => { listener.stop(true); rmSync(root, { recursive: true, force: true }); } };
  }
  const cases: [string, ((client: { write(text: string): void; end(): void }, id: string) => void) | null, boolean][] = [
    ["no herdr listening", null, false],
    ["garbage", (client) => { client.write("not json\n"); }, false],
    ["an error of herdr's own", (client, id) => { client.write(`${JSON.stringify({ id, error: { code: "boom", message: "herdr's own words" } })}\n`); }, true],
    ["the connection closed before an answer", (client) => { client.end(); }, false],
    ["no answer within the timeout", () => {}, false],
  ];
  it.each(cases)("is marked as a failed call when herdr gives %s, and as a reply's only for herdr's own error", async (_, answer, reply) => {
    const herdr = answer === null ? null : standIn(answer);
    const socket = herdr?.socket ?? join(mkdtempSync(join(tmpdir(), "herdr-failed-call-")), "herdr.sock");
    try {
      const error = await herdrRpc("ping", {}, socket, 50).then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(HerdrError);
      expect([(error as HerdrError).failedCall, (error as HerdrError).fromReply]).toEqual([true, reply]);
    } finally { herdr?.close(); }
  });

  it("is not a refusal the bridge words itself", () => {
    const refusal = new HerdrError("read_only", "this device can only watch");
    expect([refusal.failedCall, refusal.fromReply]).toEqual([undefined, false]);
    expect(Object.keys(refusal)).toEqual(["code", "name"]);
  });

  it("carries the outcome the bridge knows as no field of its own", () => {
    const told = new HerdrError("pane_not_moved", "the client's words", false, true, "the bridge's outcome");
    expect([told.outcome, Object.keys(told), JSON.stringify(told)]).toEqual(["the bridge's outcome", ["code", "name"], JSON.stringify(new HerdrError("pane_not_moved", "the client's words"))]);
  });
});
