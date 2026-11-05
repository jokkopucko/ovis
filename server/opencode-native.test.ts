import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import type { CommandSend } from "./outcome.ts";
import * as herdr from "./herdr/client.ts";
import * as omo from "./omo.ts";
import { omoSessionFolder } from "./omo.ts";
import * as processStart from "./process-start.ts";
import { paneProcessRoots } from "./conversation.ts";
import { closeOpenCodeNative, openCodeNativeState, openCodePaneService, openCodeSkillsToType, openCodeVerificationCheckpoint, releaseOpenCodePane, skillsNotAttached, startOpenCodeWatch, trackVerifiedOpenCodePanes } from "./opencode-native.ts";
import { commandOutcome } from "./outcome.ts";
import * as service from "./opencode-service.ts";
import * as commands from "./commands.ts";
import { CATALOG_SOURCE_BUDGET_MS } from "./catalog-sources.ts";
import { forgetOpenCodeService, openCodeServiceOptions } from "./opencode-service.ts";

const root = mkdtempSync(join(tmpdir(), "opencode-native-test-"));
const held = new Set<() => void>();
/** a service that never answers, one that answers 503, and none at all */
const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>((resolve) => held.add(() => resolve(new Response(null, { status: 503 })))) });
const failing = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 503 }) });
afterAll(() => {
  closeOpenCodeNative();
  for (const release of held) release();
  slow.stop(true);
  failing.stop(true);
  delete openCodeServiceOptions.stateDir;
  forgetOpenCodeService();
  rmSync(root, { recursive: true, force: true });
});

const pane = { pane_id: "p_native", agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_native01" } } as unknown as HerdrPane;
const sent: CommandSend = { id: "send-native", text: "@effect apply it", at: Date.now(), agent: "opencode", identity: "[]", screen: "", form: null, invocations: [{ name: "effect", argument: "apply it", form: null }] };

describe("a skill OpenCode did not attach", () => {
  it("reaches the outcome by id, with the note, as terminal-required", () => {
    const result = commandOutcome("p_native", skillsNotAttached(sent, ["effect"]), { now: sent.at + 100 });
    expect(result).toMatchObject({ state: "terminal-required", unattached_skills: ["effect"] });
    expect(result.note).toContain("@effect");
    expect(commandOutcome("p_native", sent, { now: sent.at + 100 }).unattached_skills).toBeUndefined();
  });
});

describe("cold skill lookup budget", () => {
  it.each(["absent", "present"])("records only known skills when the service times out and a remembered catalog is %s", async (availability) => {
    const remembered = availability === "present";
    const target = { ...pane, pane_id: `p_review_catalog_${remembered}`, cwd: root } as HerdrPane;
    const text = "@effect @a.ts @alice,";
    if (remembered) commands.rememberPaneCommands(target, "opencode", [{ name: "effect", description: "", source: "skill", trigger: "@" }]);
    let clock = 1_000;
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    const lookup = spyOn(service, "openCodeService").mockImplementation(async () => {
      clock += CATALOG_SOURCE_BUDGET_MS;
      return { version: "2.0.32", config: { baseUrl: failing.url.origin, port: failing.port!, pid: process.pid, password: "fixture" } };
    });
    const scan = spyOn(commands, "paneCommands");
    try {
      const result = await openCodeSkillsToType(target, undefined, text);
      expect(result.skills).toEqual([]);
      if (remembered) expect(result.sent?.unattached).toEqual(["effect"]);
      else expect(result.sent).toBeUndefined();
      expect(scan).not.toHaveBeenCalled();
    } finally { now.mockRestore(); rpc.mockRestore(); lookup.mockRestore(); scan.mockRestore(); }
  });

  it.each([0, CATALOG_SOURCE_BUDGET_MS])("never starts a synchronous scan after a service lookup taking %d ms", async (elapsed) => {
    let clock = 1_000;
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } } as never);
    const lookup = spyOn(service, "openCodeService").mockImplementation(async () => {
      clock += elapsed;
      return { version: "2.0.32", config: { baseUrl: failing.url.origin, port: failing.port!, pid: process.pid, password: "fixture" } };
    });
    const session = spyOn(service, "openCodeHasSession").mockResolvedValue(false);
    const scan = spyOn(commands, "paneCommands");
    try {
      const result = await openCodeSkillsToType({ ...pane, pane_id: `p_cold_${elapsed}`, cwd: root } as HerdrPane, undefined, "@effect");
      expect(scan).not.toHaveBeenCalled();
      expect(result.skills).toEqual([]);
      if (elapsed === CATALOG_SOURCE_BUDGET_MS) {
        expect(result.sent).toBeUndefined();
        expect(clock).toBe(1_000 + CATALOG_SOURCE_BUDGET_MS);
        expect(session).not.toHaveBeenCalled();
      }
    } finally {
      now.mockRestore(); rpc.mockRestore(); lookup.mockRestore(); session.mockRestore(); scan.mockRestore();
    }
  });
});

describe("recording a send never waits on OpenCode's service", () => {
  const services: [string, () => string | null][] = [["slow", () => slow.url.origin], ["erroring", () => failing.url.origin], ["absent", () => null]];
  it.each(services)("registers synchronously with a %s service", (name, origin) => {
    const dir = join(root, name);
    openCodeServiceOptions.stateDir = dir;
    forgetOpenCodeService();
    closeOpenCodeNative();
    const url = origin();
    if (url) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "service.json"), JSON.stringify({ url, pid: process.pid, password: "x", version: "2.0.32" }));
    }
    const lookups = [spyOn(service, "openCodeService"), spyOn(service, "readOpenCodeService"), spyOn(service, "openCodeHasSession")];
    try {
      const watch = startOpenCodeWatch(pane, sent);
      expect(watch === null || typeof (watch as { then?: unknown }).then === "undefined").toBe(true);
      expect(watch).not.toBeNull();
      // registration is in-memory bookkeeping only: by its return, nothing has asked for the service or its file
      expect(lookups.map((lookup) => lookup.mock.calls.length)).toEqual([0, 0, 0]);
      watch!.cancel();
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  });

  it("follows nothing for a pane that is not OpenCode, or a send that needs the terminal", () => {
    expect(startOpenCodeWatch({ ...pane, agent: "claude", agent_session: null } as unknown as HerdrPane, sent)).toBeNull();
    expect(startOpenCodeWatch(pane, { ...sent, form: { match: "bare", interaction: "terminal" } })).toBeNull();
    expect(startOpenCodeWatch(pane, undefined)).toBeNull();
  });

  it("does not treat an OmO pane herdr labels opencode as OpenCode", async () => {
    const omoPane = { ...pane, agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_omo001" } } as unknown as HerdrPane;
    const home = join(root, "omo-home");
    const agentDir = join(home, ".omo", "agent");
    const holders = join(agentDir, "sessions", omoSessionFolder(root), "session-holders", "sess_omo001");
    mkdirSync(holders, { recursive: true });
    // a fixed start for the omo process: only /proc (Linux) or ps (macOS) can read a real one, never Windows
    const startedAt = 1_700_000_000_000;
    writeFileSync(join(holders, `${process.pid}.json`), JSON.stringify({ pid: process.pid, processStartedAtMs: startedAt, cwd: root }));
    const started = spyOn(processStart, "processStartedAt").mockReturnValue(startedAt);
    const oldHome = process.env["HOME"];
    process.env["HOME"] = home;
    const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [{ pid: process.pid, argv: ["omo"], cwd: root }] } } as never);
    const environ = spyOn(omo, "processEnviron").mockReturnValue(null);
    const lookup = spyOn(service, "openCodeService").mockResolvedValue(null);
    try {
      expect((await paneProcessRoots(omoPane.pane_id, "opencode")).omo?.held).toBeTrue();
      expect(await openCodePaneService(omoPane)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
      const send = { ...sent, store: null };
      const typed = await openCodeSkillsToType(omoPane, send, "@skill");
      expect(typed).toEqual({ sent: send, skills: [] });
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      if (oldHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldHome;
      started.mockRestore();
      environ.mockRestore();
      rpc.mockRestore();
      lookup.mockRestore();
    }
  });

  it("does not probe process roots for a non-OpenCode skill send", async () => {
    const claudePane = { ...pane, agent: "claude", agent_session: { agent: "claude", source: "herdr:claude", kind: "id", value: "ses_claude001" } } as unknown as HerdrPane;
    const send = { ...sent, agent: "claude", store: null };
    const rpc = spyOn(herdr, "herdrRpc");
    const lookup = spyOn(service, "openCodeService");
    try {
      expect(await openCodeSkillsToType(claudePane, send, "@file")).toEqual({ sent: send, skills: [] });
      expect(rpc).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      rpc.mockRestore();
      lookup.mockRestore();
    }
  });
});

/** A fake OpenCode v2 service whose session lookups and event stream the test steps through. */
function gatedService(dir: string) {
  const lookups: (() => void)[] = [];
  const lookupSeen = Promise.withResolvers<void>();
  const streamOpened = Promise.withResolvers<void>();
  const streamClosed = Promise.withResolvers<void>();
  let holdLookups = false;
  /** a session lookup held since the last hold() */
  let heldSeen = Promise.withResolvers<void>();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [], paths: { tmp: dir } });
    if (url.pathname.startsWith("/api/session/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const answer = () => Response.json({ data: { id } });
      lookupSeen.resolve();
      if (holdLookups) heldSeen.resolve();
      return holdLookups ? new Promise<Response>((resolve) => lookups.push(() => resolve(answer()))) : answer();
    }
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")); streamOpened.resolve(); },
        cancel() { streamClosed.resolve(); },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(null, { status: 404 });
  } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify({ url: server.url.origin, pid: process.pid, password: "x", version: "2.0.32" }));
  return {
    server, lookupSeen: lookupSeen.promise, streamOpened: streamOpened.promise, streamClosed: streamClosed.promise,
    hold() { holdLookups = true; heldSeen = Promise.withResolvers<void>(); }, release() { holdLookups = false; for (const answer of lookups.splice(0)) answer(); },
    heldLookup: () => heldSeen.promise,
  };
}
const opencodePane = (paneId: string, session: string) => ({ pane_id: paneId, agent: "opencode", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } }) as unknown as HerdrPane;
/** a bounded wait on an event, never a fixed delay */
const within = <T>(promise: Promise<T>, what: string, ms = 3_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen`)), ms); })]).finally(() => clearTimeout(timer));
};

describe("the shared event stream follows the verified panes", () => {
  it("stays open while a verified pane remains, and closes when the last one is released", async () => {
    const fake = gatedService(join(root, "lifecycle"));
    openCodeServiceOptions.stateDir = join(root, "lifecycle");
    forgetOpenCodeService();
    closeOpenCodeNative();
    try {
      expect(await openCodePaneService(opencodePane("p_a", "ses_a"))).not.toBeNull();
      expect(await openCodePaneService(opencodePane("p_b", "ses_b"))).not.toBeNull();
      await within(fake.streamOpened, "the stream opening");
      releaseOpenCodePane("p_a");
      expect(openCodeNativeState()).toEqual({ stream: true, panes: ["p_b"] });
      releaseOpenCodePane("p_b");
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
      await within(fake.streamClosed, "the stream closing at the service");
    } finally { closeOpenCodeNative(); fake.server.stop(true); }
  });
});

describe("a verification still in flight is cancelled by a reset or by its pane's end", () => {
  it("stays cancelled however many other panes are released while it is held", async () => {
    const fake = gatedService(join(root, "inflight-evicted"));
    openCodeServiceOptions.stateDir = join(root, "inflight-evicted");
    forgetOpenCodeService();
    closeOpenCodeNative();
    try {
      fake.hold();
      const verifying = openCodePaneService(opencodePane("p_held", "ses_held"));
      await within(fake.lookupSeen, "the session lookup");
      releaseOpenCodePane("p_held");
      // enough unrelated releases to evict any bounded record of the first one
      for (let index = 0; index < 2_000; index++) releaseOpenCodePane(`p_other_${index}`);
      fake.release();
      expect(await verifying).toBeNull();
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
    } finally { closeOpenCodeNative(); fake.release(); fake.server.stop(true); }
  });

  it("keeps a pane released while its process roots are still being read unverified, with no stream", async () => {
    const fake = gatedService(join(root, "inflight-roots"));
    openCodeServiceOptions.stateDir = join(root, "inflight-roots");
    forgetOpenCodeService();
    closeOpenCodeNative();
    const rootsAsked = Promise.withResolvers<void>();
    const roots = Promise.withResolvers<unknown>();
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation((() => { rootsAsked.resolve(); return roots.promise; }) as never);
    try {
      const verifying = openCodePaneService(opencodePane("p_roots", "ses_roots"));
      await within(rootsAsked.promise, "the process roots lookup");
      releaseOpenCodePane("p_roots");
      roots.resolve({ process_info: { foreground_processes: [] } });
      expect(await verifying).toBeNull();
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
    } finally { rpc.mockRestore(); closeOpenCodeNative(); fake.server.stop(true); }
  });

  for (const cancel of ["reset", "pane end"] as const) {
    it(`opens no stream and caches nothing after a ${cancel}`, async () => {
      const fake = gatedService(join(root, `inflight-${cancel}`));
      openCodeServiceOptions.stateDir = join(root, `inflight-${cancel}`);
      forgetOpenCodeService();
      closeOpenCodeNative();
      try {
        fake.hold();
        const verifying = openCodePaneService(opencodePane("p_c", "ses_c"));
        await within(fake.lookupSeen, "the session lookup");
        if (cancel === "reset") closeOpenCodeNative(); else releaseOpenCodePane("p_c");
        fake.release();
        expect(await verifying).toBeNull();
        expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
      } finally { closeOpenCodeNative(); fake.release(); fake.server.stop(true); }
    });
  }
});

describe("a re-verification begun after a snapshot was read", () => {
  it("is newer evidence: that older snapshot's release keeps it, the pane and the stream", async () => {
    const fake = gatedService(join(root, "reverify-newer"));
    openCodeServiceOptions.stateDir = join(root, "reverify-newer");
    forgetOpenCodeService();
    closeOpenCodeNative();
    try {
      // Given a pane verified before a snapshot's read began.
      expect(await openCodePaneService(opencodePane("p_re", "ses_re"))).not.toBeNull();
      await within(fake.streamOpened, "the stream opening");
      const checkpoint = openCodeVerificationCheckpoint();
      // And its re-verification, begun after that read, held at its session lookup.
      fake.hold();
      const reverifying = openCodePaneService(opencodePane("p_re", "ses_re"));
      await within(fake.heldLookup(), "the re-verification's session lookup");
      // When the older snapshot releases the pane, then the lookup answers.
      releaseOpenCodePane("p_re", checkpoint);
      fake.release();
      // Then the re-verification stands, and the pane keeps the stream.
      expect(await reverifying).not.toBeNull();
      expect(openCodeNativeState()).toEqual({ stream: true, panes: ["p_re"] });
    } finally { closeOpenCodeNative(); fake.release(); fake.server.stop(true); }
  });
});

describe("collectors track the verified panes", () => {
  it("hands a new collector every pane verified before it, and each pane once while it stays verified", async () => {
    const fake = gatedService(join(root, "trackers"));
    openCodeServiceOptions.stateDir = join(root, "trackers");
    forgetOpenCodeService();
    closeOpenCodeNative();
    const first: string[] = [];
    const second: string[] = [];
    const untrackFirst = trackVerifiedOpenCodePanes((paneId) => first.push(paneId));
    let untrackSecond = (): void => {};
    try {
      expect(await openCodePaneService(opencodePane("p_t1", "ses_t1"))).not.toBeNull();
      expect(await openCodePaneService(opencodePane("p_t1", "ses_t1"))).not.toBeNull();
      expect(first).toEqual(["p_t1"]);
      untrackFirst();
      untrackSecond = trackVerifiedOpenCodePanes((paneId) => second.push(paneId));
      expect(second).toEqual(["p_t1"]);
      expect(await openCodePaneService(opencodePane("p_t2", "ses_t2"))).not.toBeNull();
      expect(first).toEqual(["p_t1"]);
      expect(second).toEqual(["p_t1", "p_t2"]);
      // released, then verified again: a pane that came back is handed over again
      releaseOpenCodePane("p_t1");
      expect(await openCodePaneService(opencodePane("p_t1", "ses_t1"))).not.toBeNull();
      expect(second).toEqual(["p_t1", "p_t2", "p_t1"]);
    } finally { untrackFirst(); untrackSecond(); closeOpenCodeNative(); fake.server.stop(true); }
  });
});
