import { afterEach, describe, expect, it, jest, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane } from "../../shared/protocol.ts";
import * as claudeStore from "../claude-store.ts";
import * as conversation from "../conversation.ts";
import * as herdr from "../herdr/client.ts";
import * as gjc from "../gjc-status.ts";
import * as omo from "../omo.ts";
import * as records from "../omo-records.ts";
import * as service from "../opencode-service.ts";
import * as agyStore from "../agy-store.ts";
import * as processStart from "../process-start.ts";
import { closeOpenCodeNative, openCodeNativeState, openCodePaneService, PANE_VERIFIED_MS, trackVerifiedOpenCodePanes } from "../opencode-native.ts";
import type { StatusCollectorDeps } from "../collector.ts";
import { noteSubmitted } from "../prompt.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import { at, claude, collectorSnapshot, handlers, hub, line, opencode, originalCollector, root, workingClaude } from "./status.fake.ts";
import { notePaneFolders, otherHostsShare } from "../windows-share.ts";

describe.each(["baseline", "gap", "resync", "newer-event"] as const)("native OpenCode ownership reconciliation (%s)", (mode) => {
  it.each([
    { proof: "known shell status", agent: null, status: "idle", front: "unreadable" },
    { proof: "another agent", agent: "claude", status: "idle", front: "unreadable" },
    { proof: "unknown handover", agent: null, status: "unknown", front: "unreadable" },
    { proof: "unknown handover with an agent in front", agent: null, status: "unknown", front: "agent" },
    { proof: "unknown handover after exec opencode", agent: null, status: "unknown", front: "exec" },
    { proof: "unknown status with the shell in front", agent: null, status: "unknown", front: "shell" },
  ] as const)(`${mode}: reconciles a verified pane from $proof`, async ({ agent, status, front }) => {
    // Given a pane verified before its collector has heard any status event.
    const h = hub();
    closeOpenCodeNative();
    const pane: HerdrPane = { ...claude, ...opencode("ses_parent"), focused: false, revision: 0, terminal_id: "native-reconcile" };
    const lookup = spyOn(service, "openCodeService").mockResolvedValue({
      version: "2.0.32", config: { baseUrl: "http://127.0.0.1:1", port: 1, pid: process.pid, password: "fixture" },
    });
    const session = spyOn(service, "openCodeHasSession").mockResolvedValue(true);
    let closed = false;
    const events = spyOn(service, "subscribeOpenCodeEvents").mockImplementation(() => ({ close() { closed = true; } }));
    const changed = { ...pane, agent, agent_status: status, agent_session: null };
    let snapshotPane = mode === "baseline" ? changed : pane;
    // OpenCode is in front while herdr's snapshot still shows it; what `front` names after the change
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => snapshotPane !== changed ? {
      pane_id: pane.pane_id, shell_pid: 41000, foreground_processes: [{ pid: 41001, name: "opencode", argv: ["/usr/bin/opencode"] }],
    } : front === "unreadable" ? undefined : {
      pane_id: pane.pane_id, shell_pid: 41000,
      foreground_processes: [{ pid: front === "shell" || front === "exec" ? 41000 : 41001, name: front === "shell" ? "sh" : "opencode", argv: [front === "shell" ? "/bin/sh" : "/usr/bin/opencode"] }],
    });
    let collector: ReturnType<typeof originalCollector> | undefined;
    try {
      expect(await openCodePaneService(pane)).not.toBeNull();
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [pane.pane_id] });
      // When the real collector sees a replacement agent at the same status, without
      // a status frame. Exercise the first baseline, a gap and a lost subscription.
      let live: Parameters<StatusCollectorDeps["subscribe"]>[1] | undefined;
      let hold: Promise<void> | undefined;
      let resynced = false;
      let reconciled = Promise.withResolvers<void>();
      const asked = Promise.withResolvers<void>();
      collector = originalCollector({
        onBaseline: handlers.onBaseline,
        onReconciled: (panes) => {
          handlers.onReconciled(panes);
          if (mode !== "resync" || resynced) reconciled.resolve();
        },
        onResync: (panes, newer) => { handlers.onResync(panes, newer); resynced = true; },
        onStatus: handlers.onStatus,
        onPaneEnded: handlers.onPaneEnded,
        onStructureChange() {},
      }, {
        snapshot: async () => {
          h.herdrSays(snapshotPane);
          const snapshot = await collectorSnapshot();
          if (hold) { asked.resolve(); await hold; }
          return snapshot;
        },
        subscribe: (_subs, callbacks) => {
          if (_subs[0]?.type === "pane.agent_status_changed") live = callbacks;
          queueMicrotask(() => {
            if (mode === "gap") snapshotPane = changed;
            callbacks.onStarted?.();
          });
          return { close() {} };
        },
      });
      await collector.ready;
      if (!live) throw new Error("status subscription missing");
      if (mode === "resync") {
        snapshotPane = changed;
        reconciled = Promise.withResolvers<void>();
        live.onClose?.();
        await reconciled.promise;
        await collector.ready;
      } else if (mode === "newer-event") {
        const answer = Promise.withResolvers<void>();
        snapshotPane = changed;
        hold = answer.promise;
        reconciled = Promise.withResolvers<void>();
        collector.trackPane(pane.pane_id);
        await asked.promise;
        live.onEvent({ event: "pane.agent_status_changed", data: { pane_id: pane.pane_id, agent_status: "idle", agent: "opencode" } });
        answer.resolve();
        await reconciled.promise;
      }
      // Then the authoritative agent releases ownership, but an event newer than the
      // snapshot preserves both the verified pane and its service subscription.
      const retained = mode === "newer-event" || (status === "unknown" && (front !== "shell" || process.platform === "win32"));
      expect(openCodeNativeState()).toEqual({ stream: retained, panes: retained ? [pane.pane_id] : [] });
      expect(closed).toBe(!retained);
    } finally {
      collector?.stop();
      closeOpenCodeNative();
      info.mockRestore();
      events.mockRestore();
      session.mockRestore();
      lookup.mockRestore();
    }
  });
});

describe("native OpenCode ownership verified during a snapshot", () => {
  it.each(["baseline", "gap replay", "reverification"] as const)("retains newer verification through an older %s", async (mode) => {
    // Given a snapshot that captured Claude before OpenCode's native verification.
    const h = hub();
    closeOpenCodeNative();
    const pane: HerdrPane = { ...claude, ...opencode("ses_parent"), focused: false, revision: 0, terminal_id: "native-newer" };
    const lookup = spyOn(service, "openCodeService").mockResolvedValue({
      version: "2.0.32", config: { baseUrl: "http://127.0.0.1:1", port: 1, pid: process.pid, password: "fixture" },
    });
    const session = spyOn(service, "openCodeHasSession").mockResolvedValue(true);
    let closed = 0;
    const events = spyOn(service, "subscribeOpenCodeEvents").mockImplementation(() => ({ close() { closed++; } }));
    const captured = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const reconciled = Promise.withResolvers<void>();
    let collector: ReturnType<typeof originalCollector> | undefined;
    let untrack: (() => void) | undefined;
    let replayed = false;
    let hold = mode !== "gap replay";
    h.herdrSays(mode === "gap replay" ? { ...pane, agent_status: "working" } : { ...pane, agent: "claude", agent_status: "idle" });
    try {
      if (mode === "reverification") expect(await openCodePaneService(pane)).not.toBeNull();
      collector = originalCollector({
        onBaseline: handlers.onBaseline,
        onReconciled: (panes) => {
          handlers.onReconciled(panes);
          if (panes.some((seen) => seen.agent === "claude")) reconciled.resolve();
        },
        onStatus: (...args) => { replayed ||= args[3] !== undefined; handlers.onStatus(...args); },
        onPaneEnded: handlers.onPaneEnded,
        onStructureChange() {},
      }, {
        snapshot: async () => {
          const snapshot = await collectorSnapshot();
          if (hold) { captured.resolve(); await answer.promise; }
          return snapshot;
        },
        subscribe: (subs, callbacks) => {
          queueMicrotask(() => {
            if (mode === "gap replay" && subs[0]?.type === "pane.agent_status_changed") {
              h.herdrSays({ ...pane, agent: "claude", agent_status: "idle" });
              hold = true;
            }
            callbacks.onStarted?.();
          });
          return { close() {} };
        },
      });
      await captured.promise;
      untrack = trackVerifiedOpenCodePanes(collector.trackPane, collector.refresh);
      // When verification succeeds while the captured snapshot is still pending,
      // trackPane requests another read but must not let the older one release it.
      expect(await openCodePaneService(pane)).not.toBeNull();
      h.herdrSays(pane);
      hold = false;
      answer.resolve();
      await reconciled.promise;
      await collector.ready;
      // Then neither reconciliation nor a status replay closes the new ownership.
      expect(replayed).toBe(mode === "gap replay");
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [pane.pane_id] });
      expect(closed).toBe(0);
    } finally {
      collector?.stop();
      untrack?.();
      answer.resolve();
      closeOpenCodeNative();
      events.mockRestore();
      session.mockRestore();
      lookup.mockRestore();
    }
  });
});

describe("native OpenCode ownership without a status event", () => {
  it.each([
    { label: "herdr's label changes", left: { agent: null, agent_status: "idle" } },
    { label: "herdr's label stays", left: { agent: "opencode", agent_status: "unknown" } },
  ] as const)("releases a verified pane whose agent left with no event, once its verification is due again ($label)", async ({ left }) => {
    // Given a pane verified as OpenCode v2 and tracked by the real collector, with its status subscription live.
    jest.useFakeTimers();
    const h = hub();
    closeOpenCodeNative();
    const pane: HerdrPane = { ...claude, ...opencode("ses_parent"), agent_status: "unknown", focused: false, revision: 0, terminal_id: "native-silent" };
    const lookup = spyOn(service, "openCodeService").mockResolvedValue({
      version: "2.0.32", config: { baseUrl: "http://127.0.0.1:1", port: 1, pid: process.pid, password: "fixture" },
    });
    const session = spyOn(service, "openCodeHasSession").mockResolvedValue(true);
    let closed = false;
    const events = spyOn(service, "subscribeOpenCodeEvents").mockImplementation(() => ({ close() { closed = true; } }));
    h.herdrSays(pane);
    let reconciled = Promise.withResolvers<void>();
    const collector = originalCollector({
      onBaseline: handlers.onBaseline,
      onReconciled: (panes) => { handlers.onReconciled(panes); reconciled.resolve(); },
      onStatus: handlers.onStatus,
      onPaneEnded: handlers.onPaneEnded,
      onStructureChange() {},
    }, {
      snapshot: collectorSnapshot,
      subscribe: (_subs, callbacks) => { queueMicrotask(() => callbacks.onStarted?.()); return { close() {} }; },
    });
    const untrack = trackVerifiedOpenCodePanes(collector.trackPane, collector.refresh);
    let info: { mockRestore(): void } | undefined;
    try {
      await collector.ready;
      reconciled = Promise.withResolvers<void>();
      expect(await openCodePaneService(pane)).not.toBeNull();
      // the read its tracking asked for, still of OpenCode in the pane
      await reconciled.promise;
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [pane.pane_id] });
      // When OpenCode leaves and herdr's snapshot says so (the shell idle in front), but no status event
      // or lifecycle frame tells the collector (seen from herdr 0.9.3 on a loaded host).
      // herdr 0.9.3 can also keep the label, while its own process read finds the shell alone in front.
      h.herdrSays({ ...pane, ...left, ...(left.agent === null ? { agent_session: null } : {}) });
      info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({
        pane_id: pane.pane_id, shell_pid: 41000, foreground_processes: [{ pid: 41000, name: "bash", argv: ["/bin/bash", "--noprofile", "--norc"] }],
      });
      reconciled = Promise.withResolvers<void>();
      jest.advanceTimersByTime(PANE_VERIFIED_MS);
      await reconciled.promise;
      // Then the pane is read again once its verification is due, and its hold on the stream ends.
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
      expect(closed).toBe(true);
    } finally {
      untrack();
      collector.stop();
      closeOpenCodeNative();
      jest.useRealTimers();
      info?.mockRestore();
      events.mockRestore();
      session.mockRestore();
      lookup.mockRestore();
    }
  });

  it("keeps a verified pane whose OpenCode the shell stopped (Ctrl+Z), herdr's label staying with the shell alone in front", async () => {
    // Given a pane verified as OpenCode v2 and tracked by the real collector, with its status subscription live.
    jest.useFakeTimers();
    const h = hub();
    closeOpenCodeNative();
    const pane: HerdrPane = { ...claude, ...opencode("ses_parent"), agent_status: "unknown", focused: false, revision: 0, terminal_id: "native-stopped" };
    const lookup = spyOn(service, "openCodeService").mockResolvedValue({
      version: "2.0.32", config: { baseUrl: "http://127.0.0.1:1", port: 1, pid: process.pid, password: "fixture" },
    });
    const session = spyOn(service, "openCodeHasSession").mockResolvedValue(true);
    let closed = false;
    const events = spyOn(service, "subscribeOpenCodeEvents").mockImplementation(() => ({ close() { closed = true; } }));
    h.herdrSays(pane);
    let reconciled = Promise.withResolvers<void>();
    const collector = originalCollector({
      onBaseline: handlers.onBaseline,
      onReconciled: (panes) => { handlers.onReconciled(panes); reconciled.resolve(); },
      onStatus: handlers.onStatus,
      onPaneEnded: handlers.onPaneEnded,
      onStructureChange() {},
    }, {
      snapshot: collectorSnapshot,
      subscribe: (_subs, callbacks) => { queueMicrotask(() => callbacks.onStarted?.()); return { close() {} }; },
    });
    const untrack = trackVerifiedOpenCodePanes(collector.trackPane, collector.refresh);
    let info: { mockRestore(): void } | undefined;
    const stopped = spyOn(conversation, "stoppedAgentJob").mockImplementation(async (shellPid, agent) => shellPid === 41000 && agent === "opencode");
    try {
      await collector.ready;
      reconciled = Promise.withResolvers<void>();
      expect(await openCodePaneService(pane)).not.toBeNull();
      await reconciled.promise;
      // When the user stops OpenCode with Ctrl+Z: herdr 0.9.5 keeps calling the pane OpenCode and names the
      // shell alone in front, as right after an exit (live-checked), while OpenCode is the shell's stopped job.
      h.herdrSays(pane);
      info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({
        pane_id: pane.pane_id, shell_pid: 41000, foreground_process_group_id: 41000, foreground_processes: [{ pid: 41000, name: "bash", argv: ["/bin/bash"] }],
      });
      reconciled = Promise.withResolvers<void>();
      jest.advanceTimersByTime(PANE_VERIFIED_MS);
      await reconciled.promise;
      // Then the pane keeps its hold on the stream, for the events of a send made before it stopped.
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [pane.pane_id] });
      expect(closed).toBe(false);
    } finally {
      untrack();
      collector.stop();
      closeOpenCodeNative();
      jest.useRealTimers();
      stopped.mockRestore();
      info?.mockRestore();
      events.mockRestore();
      session.mockRestore();
      lookup.mockRestore();
    }
  });

  it("ends a verified pane gone from herdr's snapshot while each read outlasts the recheck", async () => {
    // Given a pane verified as OpenCode v2 and tracked by the real collector, on a host where every snapshot
    // takes longer than PANE_VERIFIED_MS to answer.
    jest.useFakeTimers();
    const h = hub();
    closeOpenCodeNative();
    const pane: HerdrPane = { ...claude, ...opencode("ses_parent"), agent_status: "unknown", focused: false, revision: 0, terminal_id: "native-slow" };
    const lookup = spyOn(service, "openCodeService").mockResolvedValue({
      version: "2.0.32", config: { baseUrl: "http://127.0.0.1:1", port: 1, pid: process.pid, password: "fixture" },
    });
    const session = spyOn(service, "openCodeHasSession").mockResolvedValue(true);
    let closed = false;
    const events = spyOn(service, "subscribeOpenCodeEvents").mockImplementation(() => ({ close() { closed = true; } }));
    h.herdrSays(pane);
    let gone = false;
    let slow = false;
    let slowReads = 0;
    /** the slow reads in the order they were asked, each answered when the test says */
    const asked = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const answers: (() => void)[] = [];
    let reconciled = Promise.withResolvers<void>();
    let read = Promise.withResolvers<void>();
    const collector = originalCollector({
      // the collector checks its tracked panes in the same turn, right after this
      onBaseline: (panes) => { handlers.onBaseline(panes); read.resolve(); },
      onReconciled: (panes) => { handlers.onReconciled(panes); reconciled.resolve(); },
      onStatus: handlers.onStatus,
      onPaneEnded: handlers.onPaneEnded,
      onStructureChange() {},
    }, {
      replaySettleMs: 1,
      snapshot: async () => {
        const snapshot = await collectorSnapshot();
        const read = gone ? { ...snapshot, panes: [] } : snapshot;
        if (slow) {
          const answer = Promise.withResolvers<void>();
          answers.push(answer.resolve);
          asked[slowReads++]?.resolve();
          await answer.promise;
        }
        return read;
      },
      subscribe: (_subs, callbacks) => { queueMicrotask(() => callbacks.onStarted?.()); return { close() {} }; },
    });
    const untrack = trackVerifiedOpenCodePanes(collector.trackPane, collector.refresh);
    try {
      await collector.ready;
      reconciled = Promise.withResolvers<void>();
      expect(await openCodePaneService(pane)).not.toBeNull();
      await reconciled.promise;
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [pane.pane_id] });
      // When the pane goes with no lifecycle frame, and the recheck comes due again while each read is on its way.
      gone = true;
      slow = true;
      jest.advanceTimersByTime(PANE_VERIFIED_MS);
      for (const pending of asked) {
        await pending.promise;
        jest.advanceTimersByTime(PANE_VERIFIED_MS);
        read = Promise.withResolvers<void>();
        answers.shift()!();
        await read.promise;
        // the pane set changed: the collector lets the old subscription settle before it reads on
        jest.advanceTimersByTime(1);
      }
      // Then a read asked after the pane was tracked ends it, and its hold on the stream goes.
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
      expect(closed).toBe(true);
    } finally {
      untrack();
      collector.stop();
      for (const answer of answers) answer();
      closeOpenCodeNative();
      jest.useRealTimers();
      events.mockRestore();
      session.mockRestore();
      lookup.mockRestore();
    }
  });
});

describe("native OpenCode verification in flight", () => {
  it("survives a reconciled snapshot that still shows another agent in the pane", async () => {
    // Given a verification of a pane not yet verified, held at its session check.
    hub();
    closeOpenCodeNative();
    const pane: HerdrPane = { ...claude, ...opencode("ses_parent"), focused: false, revision: 0, terminal_id: "native-in-flight" };
    const lookup = spyOn(service, "openCodeService").mockResolvedValue({
      version: "2.0.32", config: { baseUrl: "http://127.0.0.1:1", port: 1, pid: process.pid, password: "fixture" },
    });
    const asked = Promise.withResolvers<void>();
    const found = Promise.withResolvers<boolean>();
    const session = spyOn(service, "openCodeHasSession").mockImplementation(() => { asked.resolve(); return found.promise; });
    const events = spyOn(service, "subscribeOpenCodeEvents").mockImplementation(() => ({ close() {} }));
    try {
      const verifying = openCodePaneService(pane);
      await asked.promise;
      // When a snapshot read before OpenCode started is reconciled while it is in flight.
      handlers.onReconciled([{ ...pane, agent: "claude", agent_status: "idle", agent_session: null }]);
      found.resolve(true);
      // Then the verification still completes and holds the stream.
      expect(await verifying).not.toBeNull();
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [pane.pane_id] });
    } finally {
      found.resolve(false);
      closeOpenCodeNative();
      events.mockRestore();
      session.mockRestore();
      lookup.mockRestore();
    }
  });
});

describe("pane end during native transcript replay", () => {
  for (const agent of ["omo", "gjc"] as const) {
    it(`drops a suspended ${agent} replay when the collector reports pane end`, async () => {
      // Given a real cooperative replay suspended after its first record.
      const h = hub();
      const pane: HerdrPane = { ...claude, agent, agent_status: "idle", agent_session: null, focused: false, revision: 0, terminal_id: "test" };
      const path = join(root, `${agent}-ended.jsonl`);
      writeFileSync(path, line({ type: "message", message: { role: "user" } })
        + line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] } }));
      const started = Promise.withResolvers<void>();
      const read = records.readOmoLinesCooperatively;
      let reduced = 0;
      const reader = spyOn(records, "readOmoLinesCooperatively").mockImplementation((fd, from, size, each, current) =>
        read(fd, from, size, (entry) => { each(entry); reduced++; started.resolve(); }, current));
      const discovery = agent === "omo"
        ? spyOn(omo, "omoPanes").mockResolvedValue(new Map([[pane.pane_id, { path, startedAt: null }]]))
        : spyOn(gjc, "gjcPanes").mockResolvedValue(new Map([[pane.pane_id, { path, startedAt: null }]]));
      const tracker = h.status[agent];
      const replay = tracker.refresh([pane]);
      try {
        await started.promise;
        expect(reduced).toBe(1);
        expect(h.last().status).toBeUndefined();
        // When the actual production lifecycle callback runs before replay resumes.
        handlers.onPaneEnded(pane.pane_id);
        await replay;
        // Then no stale status or alert resurrects the ended pane.
        expect(h.last().status).toBeUndefined();
        expect(h.alerts).toEqual([]);
        expect(tracker.runs(pane.pane_id)).toBe(false);
        expect(reduced).toBe(1);
      } finally {
        tracker.stop();
        await replay;
        reader.mockRestore();
        discovery.mockRestore();
      }
    }, 5000);
  }
});

describe("the status hub's OpenCode subagents", () => {
  it("holds an OpenCode turn after Claude Code's on its subagent though its session is found after the turn, and calls its finish off", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "claude");
    handlers.onStatus("w1:p1", "idle", "claude");
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // OpenCode's first turn there starts a subagent and ends before any snapshot
    h.herdrSays(opencode("ses_parent"));
    const from = h.alerts.length;
    handlers.onStatus("w1:p1", "working", "opencode");
    handlers.onStatus("w1:p1", "idle", "opencode");
    await h.settle();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.alerts.slice(from).at(-1)).toBe("working");
    // the snapshot that follows, Claude's tracker letting go of the pane, keeps it
    await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("keeps an OpenCode turn held though a snapshot read before its session was found is answered after", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "claude");
    handlers.onStatus("w1:p1", "idle", "claude");
    // what herdr says as a snapshot's read begins: OpenCode's home screen
    h.herdrSays(opencode(null));
    const answer = await h.heldSnapshot();
    h.herdrSays(opencode("ses_parent"));
    handlers.onStatus("w1:p1", "working", "opencode");
    await h.settle();
    await answer();
    handlers.onStatus("w1:p1", "idle", "opencode");
    await h.settle();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("lets a Claude Code session that follows OpenCode's in the pane hold nothing of OpenCode's", async () => {
    const h = hub();
    h.herdrSays(opencode("ses_parent"));
    handlers.onBaseline([opencode("ses_parent")]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "opencode");
    handlers.onStatus("w1:p1", "idle", "opencode");
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // a resting Claude session with a subagent running from before
    h.herdrSays(claude);
    await h.snapshot();
    handlers.onStatus("w1:p1", "idle", "claude");
    expect(h.last().bg).toBe(false);
  });
});

describe("the status hub's agy tasks", () => {
  it("holds an agy turn that ended on its background task, and alerts its finish once the task's turn ends", async () => {
    const path = join(root, "agy-transcript.jsonl");
    const step = (type: string, status: string, offset: number, content: string) => line({ step_index: offset, source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", type, status, created_at: new Date(at + offset).toISOString(), content });
    writeFileSync(path, step("USER_INPUT", "DONE", 0, "deploy it") + step("GENERIC", "RUNNING", 10, "Tool is running as a background task with task id: s1/task-2\nTask Description: gh run watch 1"));
    const h = hub();
    const stubs = [spyOn(agyStore, "resolveAgyStore").mockResolvedValue({ root, session: "s1", path, pid: 1, started: "x" }), spyOn(processStart, "processStartUpperBoundAsync").mockResolvedValue(null)];
    try {
      const agy = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", agent: "agy" };
      h.herdrSays(agy);
      handlers.onBaseline([agy]);
      await h.snapshot();
      await h.status.taskAgents.refresh([agy as HerdrPane]);
      handlers.onStatus("w1:p1", "working", "agy");
      handlers.onStatus("w1:p1", "idle", "agy");
      expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
      expect(h.alerts.at(-1)).toBe("working");
      // its notice ends the task and starts the next turn
      appendFileSync(path, step("SYSTEM_MESSAGE", "DONE", 20, "[Message] sender=s1/task-2 content=Task id \"s1/task-2\" finished"));
      h.status.taskAgents.poll();
      handlers.onStatus("w1:p1", "working", "agy");
      handlers.onStatus("w1:p1", "idle", "agy");
      expect(h.last()).toEqual({ status: "done", tasks: 0, bg: false });
      expect(h.alerts.at(-1)).toBe("done");
    } finally { for (const stub of stubs) stub.mockRestore(); }
  });

  it("holds an agy turn that ended on its task though its session was not found a moment before, and through one lookup that fails after (#3502)", async () => {
    const path = join(root, "agy-late-transcript.jsonl");
    const step = (type: string, status: string, offset: number, content: string) => line({ step_index: offset, source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", type, status, created_at: new Date(at + offset).toISOString(), content });
    writeFileSync(path, step("USER_INPUT", "DONE", 0, "deploy it") + step("GENERIC", "RUNNING", 10, "Tool is running as a background task with task id: s2/task-2\nTask Description: gh run watch 1"));
    const h = hub();
    const store = spyOn(agyStore, "resolveAgyStore").mockResolvedValue(null);
    // the lookups a snapshot or a status begins are not waited for by either
    const begun: Promise<void>[] = [];
    const track = h.status.taskAgents.track.bind(h.status.taskAgents);
    const stubs = [store, spyOn(processStart, "processStartUpperBoundAsync").mockResolvedValue(null), spyOn(h.status.taskAgents, "track").mockImplementation((...args) => { const done = track(...args); begun.push(done); return done; })];
    const looked = async () => { await h.settle(); await Promise.all(begun.splice(0)); };
    // one moment: every lookup below falls inside the time a snapshot waits before it asks again
    setSystemTime(Date.now());
    try {
      const agy = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle", agent: "agy" };
      h.herdrSays(agy);
      handlers.onBaseline([agy]);
      await h.snapshot();
      await looked();
      h.herdrSays({ ...agy, agent_status: "working" });
      handlers.onStatus("w1:p1", "working", "agy");
      await looked();
      expect(store).toHaveBeenCalledTimes(2);
      // the session is there by now, and the next snapshot does not ask for it yet
      store.mockResolvedValue({ root, session: "s2", path, pid: 1, started: "x" });
      await h.snapshot();
      await looked();
      expect(store).toHaveBeenCalledTimes(2);
      // the turn's end does, so the turn is held on the task it started
      h.herdrSays(agy);
      handlers.onStatus("w1:p1", "idle", "agy");
      await looked();
      expect(store).toHaveBeenCalledTimes(3);
      expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
      expect(h.alerts.at(-1)).toBe("working");
      // the session is looked up again once that lookup is old: one that fails then ends no wait and alerts nothing
      const alerted = h.alerts.length;
      store.mockResolvedValue(null);
      setSystemTime(Date.now() + 30_000);
      await h.snapshot();
      await looked();
      expect(store).toHaveBeenCalledTimes(4);
      expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
      expect(h.alerts).toHaveLength(alerted);
    } finally {
      setSystemTime();
      for (const stub of stubs) stub.mockRestore();
    }
  });
});

describe("Claude rest evidence regressions (#2072)", () => {
  it("keeps a new terminal turn working before the next transcript entry", async () => {
    // Given a completed turn whose child still streams.
    const h = await workingClaude();
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // When herdr reports a new turn before Claude flushes its user record.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    h.poll();
    // Then the queue cannot deliver during that turn.
    h.pending.enqueue("owner", h.pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: h.pane.agent_session.value });
    expect(h.last()).toEqual({ status: "working", tasks: 1, bg: false });
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("keeps working when the next user record is incomplete", async () => {
    const h = await workingClaude();
    h.rest();
    appendFileSync(h.path, '{"type":"user","message":{"content":"next');
    // When a poll reaches EOF without parsing every byte.
    h.poll();
    // Then the earlier rest cannot certify readiness.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });

  it("announces a rest first discovered by a snapshot", async () => {
    const h = await workingClaude();
    h.rest();
    // When a snapshot discovers the turn end before the timer.
    const snapshot = await h.snapshot();
    // Then events, pending delivery and the returned snapshot agree immediately.
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "done", background_tasks: 1, background_wait: true });
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.alerts.at(-1)).toBe("working");
  });

  it("keeps Codex working when the previous Claude transcript ends", async () => {
    const h = await workingClaude();
    handlers.onStatus(h.pane.pane_id, "working", "codex");
    h.rest();
    // When the old tracker polls before the next roster refresh.
    h.poll();
    // Then no Claude finish replaces Codex's work.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.alerts.at(-1)).toBe("working");
  });

  it("keeps working when an oversized next user record is skipped", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    appendFileSync(h.path, line({ type: "user", message: { role: "user", content: "x".repeat(9 * 1024 * 1024) } }));
    // When the reader skips a complete record beyond its line budget.
    h.poll();
    // Then a skipped prompt cannot leave the previous rest in force.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });

  it("keeps working when a /loop wakeup fires before its turn writes anything else", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    expect(h.last().status).toBe("done");
    // When the wakeup fires with herdr still at working from the spinner, before the resumed turn's prompt.
    appendFileSync(h.path, line({ type: "system", subtype: "scheduled_task_fire", taskKind: "loop", taskId: "591b6f5a", timestamp: new Date(at + 4000).toISOString() }));
    h.poll();
    h.pending.enqueue("owner", h.pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: h.pane.agent_session.value });
    // Then the turn before's rest no longer stands: the pane is working and its queue holds.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("retains raw working evidence across collector snapshot replay", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    const snapshot = await collectorSnapshot();
    const pane = snapshot.panes[0];
    if (pane === undefined) throw new Error("Missing fixture pane");
    handlers.onStatus(pane.pane_id, pane.agent_status, "claude", { before: "working", agent: "claude" });
    h.next();
    // When the transcript catches up to the next turn after a collector replay.
    h.poll();
    // Then raw working is still available to restore work.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });

  it("announces a child ending when a snapshot reads it first", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    appendFileSync(h.child, line({ type: "assistant", isSidechain: true, timestamp: new Date(at + 500).toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [] } }));
    // When the snapshot discovers the child end instead of the timer (omo M1).
    const snapshot = await h.snapshot();
    // Then the old BG frame is replaced, the transcript's rest stands over herdr's working from before
    // the child ended (#3348), and the alerts take the wait for the child's notice for working.
    expect(h.last()).toEqual({ status: "done", tasks: 0, bg: true });
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "done" });
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.alerts.at(-1)).toBe("working");
  });

  it("invalidates old rest when a chat send succeeds before transcript logging", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // When the existing immediate/queued input seam confirms submission.
    noteSubmitted(h.pane.pane_id, "next");
    const snapshot = await h.snapshot();
    // Then a stale transcript cannot make the submitted turn ready.
    expect(h.last()).toEqual({ status: "working", tasks: 1, bg: false });
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "working" });
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
  });
});

describe("a /loop wakeup that fires at a Claude pane herdr reads at rest (#3494)", () => {
  type Fixture = Awaited<ReturnType<typeof workingClaude>>;
  const queue = (h: Pick<Fixture, "pending" | "pane">) =>
    h.pending.enqueue("owner", h.pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: h.pane.agent_session.value });
  /** `written`: the fire's own timestamp, by which a transcript's first read tells how old it is. */
  const fires = (path: string, written = at + 4000) =>
    appendFileSync(path, line({ type: "system", subtype: "scheduled_task_fire", taskKind: "loop", taskId: "591b6f5a", timestamp: new Date(written).toISOString() }));
  const turnEnds = (h: Pick<Fixture, "path">) =>
    appendFileSync(h.path, line({ type: "system", subtype: "turn_duration", timestamp: new Date(at + 6000).toISOString() }));
  /** The prompt of the turn a wakeup resumed, with the keys Claude Code 2.1.318 writes on it right after the fire. */
  const resumes = (path: string) =>
    appendFileSync(path, line({ type: "user", isMeta: true, isSidechain: false, permissionMode: "auto", promptSource: "system", queuePriority: "later", turnOrigin: "scheduled", wakeupSource: "loop_wakeup", scheduledTaskId: "591b6f5a", timestamp: new Date(at + 4100).toISOString(), message: { role: "user", content: "check the deploy" } }));
  const NOTICE = '<task-notification>\n<task-id>bq1</task-id>\n<tool-use-id>toolu_bq1</tool-use-id>\n<status>completed</status>\n<summary>Background command "bun test" completed (exit code 0)</summary>\n</task-notification>';
  /** A background task ends, and Claude queues its notice: with a turn at work it waits there for that turn's rest. */
  const taskEnds = (path: string) =>
    appendFileSync(path, line({ type: "queue-operation", operation: "enqueue", timestamp: new Date(at + 4000).toISOString(), content: NOTICE }));
  /**
   * Claude resumes a turn on that notice: it takes it off its queue and writes the turn's prompt, the notice itself as a
   * user entry, with the keys Claude Code 2.1.296 to 2.1.321 write on it (read from the transcripts of this PC).
   */
  const noticeTurn = (path: string) =>
    appendFileSync(path, line({ type: "queue-operation", operation: "dequeue", timestamp: new Date(at + 4040).toISOString() })
      + line({ type: "user", isSidechain: false, origin: { kind: "task-notification" }, permissionMode: "auto", turnOrigin: "task_notification", timestamp: new Date(at + 4040).toISOString(), message: { role: "user", content: NOTICE } }));
  /** A background task that ends at a pane at rest: the turn on its notice begins at once. */
  const notices = (path: string) => { taskEnds(path); noticeTurn(path); };
  /** A turn that set its wakeup and came to rest, which herdr told: every read of the pane says idle from here. `drained`: each time its queue is told to look again. */
  const rested = async (drained: string[] = []): Promise<Fixture> => {
    const h = await workingClaude(undefined, (paneId) => { drained.push(paneId); });
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    h.herdrSays(h.pane);
    return h;
  };
  /** herdr's word on the pane: what its snapshots read from here on, and its event. */
  const says = (h: Pick<Fixture, "herdrSays" | "pane">, status: "working" | "blocked" | "idle") => {
    h.herdrSays({ ...h.pane, agent_status: status });
    handlers.onStatus(h.pane.pane_id, status, "claude");
  };

  it("holds the queue from the fire to the resumed turn's rest, whatever herdr reads meanwhile", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    queue(h);
    // Given a pane at rest, whose queued message may go.
    expect(h.pending.next(id)).not.toBeNull();
    const shown = h.last().status;
    // When the wakeup fires before herdr says the pane works.
    fires(h.path); h.poll();
    // Then the status shown stays herdr's, and the queue waits for the resumed turn.
    expect(h.last().status).toBe(shown);
    expect(h.pending.current(id)).toBe("working");
    expect(h.pending.next(id)).toBeNull();
    expect(h.status.queueHeld(id, false)).toBe(true);
    // A snapshot that still reads the pane idle lets nothing go, nor does herdr's idle word for the turn before.
    expect((await h.snapshot()).panes[0]?.agent_status).toBe(shown);
    handlers.onStatus(id, "idle", "claude");
    expect(h.pending.next(id)).toBeNull();
    expect(h.status.queueHeld(id, false)).toBe(true);
    // The resumed turn's own rest does.
    turnEnds(h); h.poll();
    expect(h.pending.current(id)).toBe(shown);
    expect(h.pending.next(id)).not.toBeNull();
    expect(h.status.queueHeld(id, false)).toBe(false);
  });

  it("tells the queue when a replay that changes nothing is the first to read the resumed turn's rest", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    queue(h);
    fires(h.path); h.poll();
    expect(h.pending.next(id)).toBeNull();
    // When the resumed turn's rest is written, and what reads it first is a snapshot's replay around
    // a gap that changes nothing: no status is reported after it.
    turnEnds(h);
    handlers.onStatus(id, "idle", "claude", { before: "done", agent: "claude" });
    // Then the queue is told all the same: nothing else would tell it before the pane's next status.
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.current(id)).not.toBe("working");
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("tells the queue when the read a status report makes of the pane's work is the first to find the resumed turn's rest", async () => {
    const drained: string[] = [];
    const h = await rested(drained);
    const id = h.pane.pane_id;
    fires(h.path); resumes(h.path); h.poll();
    queue(h);
    expect(h.pending.next(id)).toBeNull();
    // Given herdr's idle word arriving just before Claude writes the resumed turn's rest: the event's own read of
    // the transcript finds none, and the rest is there for the read its report makes next (written here from
    // the GJC poll, which runs between the two).
    const between = spyOn(h.status.gjc, "poll").mockImplementationOnce(async () => { turnEnds(h); });
    const told = drained.length;
    try { handlers.onStatus(id, "idle", "claude"); } finally { between.mockRestore(); }
    // Then the queue hears of the hold's end from that report: no later read would find anything changed.
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.current(id)).not.toBe("working");
    expect(h.pending.next(id)).not.toBeNull();
    expect(drained.slice(told).at(-1)).toBe(id);
  });

  it("holds the queue from the read a status report makes of the pane's work, when that is the first to find the fire", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    queue(h);
    expect(h.pending.next(id)).not.toBeNull();
    // Given a wakeup that fires between herdr's idle event and the read its report makes: the report told the
    // queue the pane rests a moment before.
    const between = spyOn(h.status.gjc, "poll").mockImplementationOnce(async () => { fires(h.path); });
    try { handlers.onStatus(id, "idle", "claude"); } finally { between.mockRestore(); }
    // Then the queue is told of the hold at once, not by the delivery's own check.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.current(id)).toBe("working");
    expect(h.pending.next(id)).toBeNull();
  });

  it("keeps the queue held when herdr tells the resumed turn and then reads the pane at rest with no rest written, until the hold's time is up", async () => {
    const drained: string[] = [];
    const h = await rested(drained);
    const id = h.pane.pane_id;
    fires(h.path); resumes(h.path); h.poll();
    queue(h);
    expect(h.pending.next(id)).toBeNull();
    // Given herdr telling the resumed turn, on time.
    says(h, "working");
    expect(h.last().status).toBe("working");
    expect(h.pending.next(id)).toBeNull();
    const from = Date.now();
    try {
      // When that turn is interrupted, which writes no rest here, and herdr says the pane does no work.
      setSystemTime(from + 10_000);
      says(h, "idle");
      // Then herdr's word lets nothing go: nothing tells that pane from one herdr reads at rest while its turn runs.
      expect(h.last().status).not.toBe("working");
      expect(h.status.queueHeld(id, false)).toBe(true);
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
      setSystemTime(from + 59_000);
      h.poll();
      expect(h.pending.next(id)).toBeNull();
      const told = drained.length;
      // And once the hold's time is up (LOOP_HOLD_MS after the turn's prompt was read) the queue is told with no
      // status event, and the message is offered.
      setSystemTime(from + 61_000);
      h.poll();
      expect(drained.slice(told)).toEqual([id]);
      expect(h.status.queueHeld(id, false)).toBe(false);
      expect(h.pending.current(id)).not.toBe("working");
      expect(h.pending.next(id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  it.each(["the timer's poll", "a replay that changes nothing", "a status herdr reports", "a send's own read of the hold"] as const)("tells the queue that the hold's time is up when %s is the first to find it so", async (first) => {
    const drained: string[] = [];
    const h = await rested(drained);
    const id = h.pane.pane_id;
    fires(h.path); h.poll();
    queue(h);
    expect(h.pending.current(id)).toBe("working");
    const from = Date.now();
    try {
      // Given a resumed turn that wrote nothing more, and no poll since its time ran out.
      setSystemTime(from + 61_000);
      expect(h.pending.next(id)).toBeNull();
      const told = drained.length;
      if (first === "the timer's poll") h.poll();
      else if (first === "a replay that changes nothing") handlers.onStatus(id, "idle", "claude", { before: "done", agent: "claude" });
      else if (first === "a status herdr reports") handlers.onStatus(id, "idle", "claude");
      else expect(h.status.queueHeld(id, true)).toBe(false);
      // Then the queue is told there and then: no later read would find anything changed.
      expect(drained.slice(told).at(-1)).toBe(id);
      expect(h.pending.current(id)).not.toBe("working");
      expect(h.pending.next(id)).not.toBeNull();
      const after = drained.length;
      h.poll();
      expect(drained.slice(after)).toEqual([]);
    } finally { setSystemTime(); }
  });

  it("holds the queue though herdr told the resumed turn a moment before Claude wrote its fire", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    // Given herdr reading the resumed turn before the fire reaches the transcript.
    says(h, "working");
    fires(h.path); h.poll();
    queue(h);
    expect(h.last().status).toBe("working");
    expect(h.pending.next(id)).toBeNull();
    // When herdr reads the pane at rest while that turn has written no rest.
    says(h, "idle");
    // Then the fire still holds the queue: herdr's word for the turn began no hold, and ends none.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // And the turn's rest lets the message go.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("holds the queue when herdr took its working word back before the fire was written", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    // Given a working word of herdr's with no turn behind it, taken back at once.
    handlers.onStatus(id, "working", "claude");
    handlers.onStatus(id, "idle", "claude");
    // When the wakeup fires next: that word told nothing of the turn it resumes.
    fires(h.path); h.poll();
    queue(h);
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
  });

  it("keeps the queue held through herdr's late words for the turn before the fire, and through its words for the wakeup's own turn", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    // Given a short turn begun after herdr's idle word, its rest and then the wakeup's fire, all
    // written before herdr tells that turn.
    h.next();
    turnEnds(h);
    fires(h.path); h.poll();
    queue(h);
    expect(h.status.queueHeld(id, false)).toBe(true);
    // When herdr's working and idle words for the short turn come late.
    says(h, "working");
    says(h, "idle");
    // Then they end nothing of the fire's hold: the message does not go into the wakeup's turn.
    expect(h.pending.next(id)).toBeNull();
    expect(h.status.queueHeld(id, false)).toBe(true);
    // Nor do herdr's words for the wakeup's own turn, a working and an idle it reads between two of its steps.
    says(h, "working");
    expect(h.pending.next(id)).toBeNull();
    says(h, "idle");
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // The wakeup turn's rest does.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it.each(["a poll before herdr's late words", "no poll before them"] as const)("keeps the queue held through herdr's late words when the turn before the fire stopped on a permission prompt herdr told in time (%s)", async (order) => {
    const h = await rested();
    const id = h.pane.pane_id;
    queue(h);
    // Given a person's turn herdr tells in time, which stops on a permission prompt herdr tells in time too.
    h.next();
    says(h, "working");
    says(h, "blocked");
    // Approved, the turn goes on and rests, and the due wakeup writes its fire and prompt, all before
    // herdr tells that the turn went on.
    turnEnds(h);
    fires(h.path);
    resumes(h.path);
    if (order === "a poll before herdr's late words") { h.poll(); expect(h.status.queueHeld(id, false)).toBe(true); }
    // When herdr's working for the approved turn and its idle come late.
    says(h, "working");
    says(h, "idle");
    // Then they end nothing of the wakeup's hold, wherever herdr's words stand among the turns written.
    expect(h.status.queueHeld(id, true)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // And the wakeup turn's rest lets the message go.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("keeps the queue held when herdr's late working for the turn before the fire is heard twice: in a snapshot, then in its event", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    h.next();
    turnEnds(h);
    fires(h.path); h.poll();
    queue(h);
    expect(h.status.queueHeld(id, false)).toBe(true);
    // When a snapshot is answered between herdr's change to working for the short turn and that change's event.
    h.herdrSays({ ...h.pane, agent_status: "working" });
    await h.snapshot();
    handlers.onStatus(id, "working", "claude");
    expect(h.status.queueHeld(id, false)).toBe(true);
    // And herdr's idle word for that turn follows.
    h.herdrSays(h.pane);
    handlers.onStatus(id, "idle", "claude");
    // Then the word heard a second time ended nothing of the fire's hold: the message does not go into the wakeup's turn.
    expect(h.pending.next(id)).toBeNull();
    expect(h.status.queueHeld(id, false)).toBe(true);
    // And the wakeup turn's rest lets it go.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("keeps the queue held through herdr's late words though a snapshot looked the pane's session up again since its rest word", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    const from = Date.now();
    try {
      // Given a snapshot 5 s after herdr's idle word: the session, whose process is not known, is looked up
      // again, and what is kept of the pane is built anew.
      setSystemTime(from + 5000);
      await h.snapshot();
      // And a short turn, its rest and the wakeup's fire, all written before herdr tells that turn.
      h.next();
      turnEnds(h);
      fires(h.path); h.poll();
      queue(h);
      expect(h.status.queueHeld(id, false)).toBe(true);
      // When herdr's working and idle words for the short turn come late.
      handlers.onStatus(id, "working", "claude");
      handlers.onStatus(id, "idle", "claude");
      // Then the message does not go into the wakeup's turn.
      expect(h.pending.next(id)).toBeNull();
      expect(h.status.queueHeld(id, false)).toBe(true);
      // And the wakeup turn's rest lets it go.
      turnEnds(h); h.poll();
      expect(h.status.queueHeld(id, false)).toBe(false);
      expect(h.pending.next(id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  /** A server that starts with the pane at rest: herdr's idle is read from a snapshot, and none of its rest words was heard in an event. */
  const restarted = async (drained: string[] = []) => {
    const old = await workingClaude();
    old.rest();
    const h = hub(old.path, undefined, (paneId) => { drained.push(paneId); });
    h.herdrSays(old.pane);
    handlers.onBaseline([old.pane]);
    await h.snapshot();
    h.poll();
    return { ...h, path: old.path, pane: old.pane, next: old.next };
  };

  it.each(["after the fire was read", "before the fire was written"] as const)("keeps the queue held through herdr's late words for the turn before the fire on a server that heard no rest word of herdr's in an event, its working heard %s", async (heard) => {
    const h = await restarted();
    const id = h.pane.pane_id;
    queue(h);
    expect(h.pending.next(id)).not.toBeNull();
    // Given a short turn of the person's and its rest, written before herdr tells that turn.
    h.next();
    turnEnds(h);
    if (heard === "after the fire was read") {
      fires(h.path); h.poll();
      expect(h.status.queueHeld(id, false)).toBe(true);
    }
    // When herdr's working for the short turn comes late, with the wakeup's fire written before it or right after.
    h.herdrSays({ ...h.pane, agent_status: "working" });
    handlers.onStatus(id, "working", "claude");
    if (heard === "before the fire was written") { fires(h.path); h.poll(); }
    // And herdr's idle word for the short turn follows.
    h.herdrSays(h.pane);
    handlers.onStatus(id, "idle", "claude");
    // Then the message does not go into the wakeup's turn, though no rest word of herdr's says which turn that working told.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // And the wakeup turn's rest lets it go.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("holds on the first wakeup after a server start as on any other: to its turn's rest or its time, though herdr tells that turn", async () => {
    const drained: string[] = [];
    const h = await restarted(drained);
    const id = h.pane.pane_id;
    queue(h);
    fires(h.path); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(true);
    // Given herdr's working for the wakeup's own turn.
    says(h, "working");
    expect(h.pending.next(id)).toBeNull();
    // When that turn is interrupted, which writes no rest here, and herdr says the pane does no work.
    says(h, "idle");
    // Then the message waits out the fire's time.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    const from = Date.now();
    try {
      const told = drained.length;
      setSystemTime(from + 60_000);
      expect(h.status.queueHeld(id, false)).toBe(false);
      h.poll();
      // And the queue is told with no status event, so the message goes.
      expect(drained.slice(told)).toEqual([id]);
      expect(h.pending.next(id)).not.toBeNull();
      // The next wakeup, minutes later, holds in the same way, through herdr's words for its turn.
      fires(h.path, at + 4000 + 5 * 60_000); h.poll();
      expect(h.status.queueHeld(id, false)).toBe(true);
      says(h, "working");
      says(h, "idle");
      expect(h.status.queueHeld(id, false)).toBe(true);
      expect(h.pending.next(id)).toBeNull();
      // And its turn's rest lets the message go.
      turnEnds(h); h.poll();
      expect(h.status.queueHeld(id, false)).toBe(false);
      expect(h.pending.next(id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  it("holds the queue on the second of two loops due together, whose prompt follows the first loop turn's rest with no fire", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    // Given two loops due in one tick: both fires, then the first loop's prompt and turn, which herdr tells.
    fires(h.path); fires(h.path); resumes(h.path); h.poll();
    queue(h);
    expect(h.status.queueHeld(id, false)).toBe(true);
    says(h, "working");
    expect(h.pending.next(id)).toBeNull();
    // When that turn rests and the second loop's prompt runs at once, before herdr's idle word for the first.
    turnEnds(h); resumes(h.path); h.poll();
    says(h, "idle");
    // Then that idle word lets nothing into the second loop's turn.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // And the second loop turn's rest lets the message go.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("holds the queue on the second loop's turn when herdr's working for the first, heard before that one's rest, still waited for a turn", async () => {
    // Given a turn of the person's at work, which herdr told, and a message queued behind it.
    const h = await workingClaude();
    const id = h.pane.pane_id;
    queue(h);
    // That turn rests with two loops due: both fires and the first loop's prompt are written before herdr's idle word for it.
    h.rest(); fires(h.path); fires(h.path); resumes(h.path);
    h.herdrSays(h.pane);
    handlers.onStatus(id, "idle", "claude");
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // herdr's working for the first loop's turn finds no turn written past that idle word, and waits for one.
    h.herdrSays({ ...h.pane, agent_status: "working" });
    handlers.onStatus(id, "working", "claude");
    expect(h.pending.next(id)).toBeNull();
    // When that turn is short: its rest and the second loop's prompt are read by the timer's poll before herdr's idle word for it.
    turnEnds(h); resumes(h.path); h.poll();
    h.herdrSays(h.pane);
    handlers.onStatus(id, "idle", "claude");
    // Then that idle word lets nothing into the second loop's turn.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.next(id)).toBeNull();
    // And the second loop turn's rest lets the message go.
    turnEnds(h); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("holds the queue from the snapshot a send reads the pane with, before the timer's poll", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    fires(h.path);
    // When the read a queued send makes of the pane is the first to find the fire.
    await h.snapshot();
    // Then that send finds the queue held, and waits.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.current(id)).toBe("working");
  });

  it("holds nothing of the queue once herdr names another agent in the pane, though the Claude session it had still holds", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    fires(h.path); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.status.queueHeld(id, true)).toBe(true);
    // When herdr's event names Codex there, before any snapshot shows the Claude tracker that its session is gone.
    handlers.onStatus(id, "idle", "codex");
    queue(h);
    // Then that session's hold says nothing of the pane's queue, as its last poll left it or read anew: the
    // resumed turn was Claude's, and Codex's message goes by herdr's status.
    expect(h.status.claudeAgents.loopHolds(id)).toBe(true);
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.status.queueHeld(id, true)).toBe(false);
    expect(h.pending.current(id)).not.toBe("working");
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("tells the queue herdr's blocked through the hold: only a pane herdr reads at rest is held as one at work", async () => {
    const h = await rested();
    const id = h.pane.pane_id;
    fires(h.path); resumes(h.path); h.poll();
    queue(h);
    expect(h.pending.current(id)).toBe("working");
    // When the resumed turn stops on a permission prompt, and herdr tells that.
    says(h, "blocked");
    // Then the queue is told so, as for any turn: the hold stands for no status of herdr's but its rest words.
    expect(h.status.claudeAgents.loopHolds(id)).toBe(true);
    expect(h.pending.current(id)).toBe("blocked");
    expect(h.pending.next(id)).toBeNull();
    // And once herdr reads the pane at rest with no rest written, the hold is what the queue goes by again.
    says(h, "idle");
    expect(h.pending.current(id)).toBe("working");
    expect(h.pending.next(id)).toBeNull();
  });

  it("lets the queue go when herdr never tells the resumed turn, however long nothing is written", async () => {
    const drained: string[] = [];
    const h = await rested(drained);
    const id = h.pane.pane_id;
    const shown = h.last().status;
    fires(h.path); h.poll();
    queue(h);
    // Given a turn interrupted before herdr read it: no rest is written, and herdr has no word to say.
    const from = Date.now();
    try {
      // Past the time a busy signal is shown working (BUSY_HOLD_MS), the fire still holds.
      setSystemTime(from + 6000);
      h.poll();
      expect(h.pending.next(id)).toBeNull();
      expect(h.status.queueHeld(id, false)).toBe(true);
      const told = drained.length;
      // When the hold's own time (LOOP_HOLD_MS, checked to the millisecond in claude-subagents.test.ts) is long up.
      setSystemTime(from + 10 * 60_000);
      expect(h.status.queueHeld(id, false)).toBe(false);
      h.poll();
      // Then the queue is told with no status event, and the message goes.
      expect(drained.slice(told)).toEqual([id]);
      expect(h.last().status).toBe(shown);
      expect(h.pending.current(id)).toBe(shown);
      expect(h.pending.next(id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  it("holds nothing on a fire the server finds written long before it starts", async () => {
    const old = await workingClaude();
    old.rest();
    fires(old.path, Date.now() - 10 * 60_000);
    // Given a server that first reads the pane idle, the fire's turn interrupted long before it started.
    const h = hub(old.path);
    h.herdrSays(old.pane);
    handlers.onBaseline([old.pane]);
    await h.snapshot();
    h.poll();
    queue({ pending: h.pending, pane: old.pane });
    // Then that fire is history: nothing says its turn still runs.
    expect(h.status.queueHeld(old.pane.pane_id, false)).toBe(false);
    expect(h.pending.current(old.pane.pane_id)).toBe("idle");
    expect(h.pending.next(old.pane.pane_id)).not.toBeNull();
  });

  it("holds the queue on a fire written a moment before the server first reads the pane's transcript", async () => {
    const old = await workingClaude();
    const id = old.pane.pane_id;
    old.rest();
    // Given a wakeup that fired as the server started, or as the pane's session was found: herdr still reads the pane idle.
    fires(old.path, Date.now());
    const h = hub(old.path);
    h.herdrSays(old.pane);
    handlers.onBaseline([old.pane]);
    await h.snapshot();
    queue({ pending: h.pending, pane: old.pane });
    // Then the queue waits for the turn it resumed, as on a fire read while the server ran.
    expect(h.status.queueHeld(id, false)).toBe(true);
    expect(h.pending.current(id)).toBe("working");
    expect(h.pending.next(id)).toBeNull();
    // And that turn's rest lets the message go.
    turnEnds(old); h.poll();
    expect(h.status.queueHeld(id, false)).toBe(false);
    expect(h.pending.next(id)).not.toBeNull();
  });

  it("lets a fire found as the server starts hold only for what is left of its time", async () => {
    const drained: string[] = [];
    const old = await workingClaude();
    const id = old.pane.pane_id;
    old.rest();
    const from = Date.now();
    // Given a fire written 30 s before the server's first read, whose turn was interrupted: no rest, and no word of herdr's.
    fires(old.path, from - 30_000);
    const h = hub(old.path, undefined, (paneId) => { drained.push(paneId); });
    h.herdrSays(old.pane);
    handlers.onBaseline([old.pane]);
    await h.snapshot();
    queue({ pending: h.pending, pane: old.pane });
    try {
      // It holds for the 30 s its time (LOOP_HOLD_MS, to the millisecond in claude-subagents.test.ts) has left.
      setSystemTime(from + 29_000);
      h.poll();
      expect(h.status.queueHeld(id, false)).toBe(true);
      expect(h.pending.next(id)).toBeNull();
      const told = drained.length;
      setSystemTime(from + 31_000);
      expect(h.status.queueHeld(id, false)).toBe(false);
      h.poll();
      // Then the queue is told with no status event, and the message goes.
      expect(drained.slice(told)).toEqual([id]);
      expect(h.pending.next(id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  it("goes by herdr's status alone while the pane's transcript is not found, and holds from the lookup that finds it", async () => {
    const old = await workingClaude();
    const id = old.pane.pane_id;
    old.rest();
    const from = Date.now();
    fires(old.path, from);
    // Given a server whose lookup of the pane's session finds no transcript, with a wakeup just fired there.
    const h = hub(old.path);
    const lookup = spyOn(conversation, "claudePaneSession").mockResolvedValue(null);
    try {
      h.herdrSays(old.pane);
      handlers.onBaseline([old.pane]);
      await h.snapshot();
      queue({ pending: h.pending, pane: old.pane });
      // Then nothing tells of that wakeup: herdr reads the pane idle, so the message may go. A pane whose transcript
      // is never found is not kept waiting, and a send's own read of the hold has no transcript to read.
      expect(h.status.claudeAgents.sessionOf(id)).toBeNull();
      expect(h.status.queueHeld(id, true)).toBe(false);
      expect(h.pending.current(id)).toBe("idle");
      expect(h.pending.next(id)).not.toBeNull();
      // Nor does that read look the session up: a lookup that found nothing is made again 5 s later, by a snapshot.
      const looked = lookup.mock.calls.length;
      lookup.mockResolvedValue({ path: old.path, startedAt: null, pid: null });
      await h.snapshot();
      expect(lookup.mock.calls.length).toBe(looked);
      expect(h.status.queueHeld(id, true)).toBe(false);
      // When that lookup finds the transcript: 5 s after the one that found nothing, which was made a moment after the fire.
      setSystemTime(Date.now() + 5000);
      await h.snapshot();
      expect(lookup.mock.calls.length).toBe(looked + 1);
      // Then the fire it reads there holds the queue for what is left of its time, as one found when the server starts.
      expect(h.status.queueHeld(id, false)).toBe(true);
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
      // And the resumed turn's rest lets the message go.
      turnEnds(old); h.poll();
      expect(h.status.queueHeld(id, false)).toBe(false);
      expect(h.pending.next(id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  describe("a pane with no wakeup goes as before", () => {
    it("is told nothing at a replay that changes nothing: the queue stays as a delivery's own look at the pane left it", async () => {
      const drained: string[] = [];
      const h = await rested(drained);
      const id = h.pane.pane_id;
      queue(h);
      // Given a queue told to wait by a delivery's look at the pane, which read herdr's working before its event came.
      h.pending.observe(id, "working", h.pending.mark(id));
      expect(h.pending.next(id)).toBeNull();
      const told = drained.length;
      // When a snapshot's replay around a gap changes nothing.
      handlers.onStatus(id, "idle", "claude", { before: "done", agent: "claude" });
      // Then nothing is told: the hub tells the queue there only of a self-resumed turn's hold.
      expect(drained.slice(told)).toEqual([]);
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
    });

    it("places herdr's working after a permission prompt past that prompt: a turn it may tell holds the pane at work", async () => {
      const h = await rested();
      const id = h.pane.pane_id;
      queue(h);
      // Given a turn of the person's whose first word from herdr is a permission prompt.
      h.next();
      says(h, "blocked");
      // Approved, the turn goes on and rests, before herdr tells that it went on.
      turnEnds(h);
      // When herdr's working comes after that rest: the turn's own, late, or a next turn's whose first entry is not written.
      says(h, "working");
      h.poll();
      // Then the pane is at work, and its queue waits: that word is placed past the prompt herdr told, not in the turn before it.
      expect(h.last().status).toBe("working");
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
    });

    it("answers a send's own read of the hold for a self-resumed turn alone: a busy signal's hold is asked where it was", async () => {
      const h = await rested();
      const id = h.pane.pane_id;
      const from = Date.now();
      try {
        // Given herdr's working with no turn written for it, which waited its time in vain: the pane rests on
        // its background subagent, and that signal holds its queue.
        says(h, "working");
        setSystemTime(from + 6000);
        h.poll();
        expect(h.status.claudeAgents.holdsQueue(id)).toBe(true);
        expect(h.status.queueHeld(id, false)).toBe(true);
        // Then the read made right before a write finds no wakeup, and answers for nothing else.
        expect(h.status.queueHeld(id, true)).toBe(false);
      } finally { setSystemTime(); }
    });
  });

  describe("a turn resumed on a background task's notice", () => {
    it("holds the queue from the prompt of the notice's turn to that turn's rest, whatever herdr reads meanwhile", async () => {
      const h = await rested();
      const id = h.pane.pane_id;
      queue(h);
      // Given a pane at rest, whose queued message may go.
      expect(h.pending.next(id)).not.toBeNull();
      const shown = h.last().status;
      // When a background task ends and Claude resumes a turn on its notice, before herdr says the pane works.
      notices(h.path); h.poll();
      // Then the status shown stays herdr's, and the queue waits for that turn.
      expect(h.last().status).toBe(shown);
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
      expect(h.status.queueHeld(id, false)).toBe(true);
      // A snapshot that still reads the pane idle lets nothing go, nor does herdr's idle word for the turn before.
      expect((await h.snapshot()).panes[0]?.agent_status).toBe(shown);
      handlers.onStatus(id, "idle", "claude");
      expect(h.pending.next(id)).toBeNull();
      expect(h.status.queueHeld(id, false)).toBe(true);
      // The turn's own rest does.
      turnEnds(h); h.poll();
      expect(h.pending.current(id)).toBe(shown);
      expect(h.pending.next(id)).not.toBeNull();
      expect(h.status.queueHeld(id, false)).toBe(false);
    });

    it("keeps the queue held through herdr's idle word for the turn the notice came during, when the notice's turn began at that turn's rest", async () => {
      // Given a turn of the person's at work, which herdr told, and a message queued behind it.
      const h = await workingClaude();
      const id = h.pane.pane_id;
      queue(h);
      // A task ends while it works. The turn rests and Claude begins the notice's turn at once, its prompt written
      // before herdr's idle word for the turn before is heard (the prompt is dated 24 to 97 ms after that rest in the
      // transcripts of this PC, and read once as it reached the file, 133 ms after that date).
      taskEnds(h.path); h.rest(); noticeTurn(h.path);
      h.herdrSays(h.pane);
      handlers.onStatus(id, "idle", "claude");
      // Then that idle word lets nothing into the notice's turn.
      expect(h.status.queueHeld(id, false)).toBe(true);
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
      // And that turn's rest lets the message go.
      turnEnds(h); h.poll();
      expect(h.status.queueHeld(id, false)).toBe(false);
      expect(h.pending.next(id)).not.toBeNull();
    });

    it("lets the queue go, and tells it so, a minute after the prompt of a notice's turn that was interrupted and wrote no rest", async () => {
      const drained: string[] = [];
      const h = await rested(drained);
      const id = h.pane.pane_id;
      notices(h.path); h.poll();
      queue(h);
      expect(h.pending.next(id)).toBeNull();
      // Given herdr telling the notice's turn, on time.
      says(h, "working");
      expect(h.last().status).toBe("working");
      const from = Date.now();
      try {
        // When that turn is interrupted, which writes no rest here, and herdr says the pane does no work.
        setSystemTime(from + 10_000);
        says(h, "idle");
        // Then herdr's word lets nothing go: nothing tells that pane from one herdr reads at rest while its turn runs.
        expect(h.last().status).not.toBe("working");
        expect(h.status.queueHeld(id, false)).toBe(true);
        expect(h.pending.current(id)).toBe("working");
        expect(h.pending.next(id)).toBeNull();
        setSystemTime(from + 59_000);
        h.poll();
        expect(h.pending.next(id)).toBeNull();
        const told = drained.length;
        // And once the hold's time is up the queue is told with no status event, and the message is offered.
        setSystemTime(from + 61_000);
        h.poll();
        expect(drained.slice(told)).toEqual([id]);
        expect(h.status.queueHeld(id, false)).toBe(false);
        expect(h.pending.current(id)).not.toBe("working");
        expect(h.pending.next(id)).not.toBeNull();
      } finally { setSystemTime(); }
    });

    it("shows a notice's turn begun under a background subagent's spinner at work, and at rest on that subagent again, as before", async () => {
      // Given a turn at rest while its background subagent works: herdr reads the spinner as working, and the pane is
      // shown at rest, its queue free (#2069).
      const h = await workingClaude();
      const id = h.pane.pane_id;
      h.rest(); h.poll();
      expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
      queue(h);
      expect(h.pending.next(id)).not.toBeNull();
      // When another task of the session's ends, and Claude resumes a turn on its notice.
      notices(h.path); h.poll();
      // Then the pane is shown at work and its queue waits, as before this hold: herdr's working is that turn's now.
      expect(h.last()).toEqual({ status: "working", tasks: 1, bg: false });
      expect(h.pending.current(id)).toBe("working");
      expect(h.pending.next(id)).toBeNull();
      expect(h.status.claudeAgents.holdsQueue(id)).toBe(false);
      // And at that turn's rest the pane rests on its subagent again, and the message may go: the hold ended there.
      turnEnds(h); h.poll();
      expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
      expect(h.status.queueHeld(id, false)).toBe(false);
      expect(h.pending.current(id)).toBe("done");
      expect(h.pending.next(id)).not.toBeNull();
    });
  });

  describe("with the bridge's own delivery", () => {
    let sockets = 0;
    const READY = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
    const spies: { mockRestore(): void }[] = [];
    afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

    /**
     * A pane at rest that herdr told, its queue delivered by the bridge: what is written to the pane, in order.
     * `on`: what a test has happen as the delivery reads the pane's screen (`read`), pastes (`paste`), or while the
     * connection its Enter is written on is still being made (`connect`), and an answer on the queue's hold a test
     * gives in the hub's place (`held`, asked `fresh` or not);
     * `asked`: each answer the delivery got on the queue's hold; `results`: the answers its submits got;
     * `steps`: everything the delivery awaited of herdr and every answer on the hold it took, in order.
     * `keys`: the Enter goes through a stand-in that asks the write's guard once connected, as herdr's client
     * does, or through that client itself (herdrRpc), to a socket the test listens on in herdr's place.
     * `on.front`: the process herdr reads in front of the pane's shell; none unless a test names one (claudeInFront).
     */
    async function delivering(keys: "a stand-in" | "herdr's own client" = "a stand-in") {
      const writes: string[] = [];
      const on: { read?: () => void; paste?: () => void; connect?: () => void; held?: (fresh: boolean) => boolean; front?: { pid: number; name: string; argv: string[] } } = {};
      const asked: boolean[] = [];
      const steps: ("screen" | "processes" | "hold as last read" | "hold read now" | "paste" | "keys")[] = [];
      const frames: { type: string; id?: number; ok?: boolean; code?: string; typed_now?: boolean; pending?: { state: string } }[] = [];
      const client: Client = { data: connectionData({ readOnly: false, deviceId: undefined }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (encoded: string) => { frames.push(JSON.parse(encoded)); return 1; }, close: () => {} };
      let lane: Promise<unknown> = Promise.resolve();
      const serialize = <T>(_paneId: string, task: () => T | Promise<T>): Promise<T> => { const next = lane.catch(() => undefined).then(task); lane = next; return next; };
      let h!: Awaited<ReturnType<typeof workingClaude<Client, unknown>>>;
      const delivery = createPendingDelivery({
        options: { submitDelayMs: 0 }, clients: new Set([client]), attachments: new Map(), serialize, lastTyped: new Map(),
        sight: () => ({ origin: null, pty: null, claim: null, facts: () => READY, write: (data: string) => { writes.push(data); } }) as never,
        submitText: (async () => { throw new Error("no immediate send in this test"); }) as never, authorizeSocket: () => {},
        clientSnapshot: () => h.status.clientSnapshot(), omo: { sessionOf: () => null },
        queueHeld: (paneId, fresh) => { steps.push(fresh === true ? "hold read now" : "hold as last read"); const held = on.held?.(fresh === true) ?? h.status.queueHeld(paneId, fresh); asked.push(held); return held; },
        SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
      });
      h = await workingClaude(delivery.pending as never, delivery.drainPending);
      spies.push(
        spyOn(herdr, "paneRead").mockImplementation(async () => { steps.push("screen"); on.read?.(); return { text: "" } as never; }),
        spyOn(herdr, "paneProcessInfo").mockImplementation(async () => { steps.push("processes"); return { foreground_processes: on.front ? [on.front] : [], shell_pid: on.front ? on.front.pid - 1 : null } as never; }),
        spyOn(herdr, "paneSendText").mockImplementation(async (_paneId, text) => { steps.push("paste"); writes.push(`paste ${text}`); on.paste?.(); }),
      );
      if (keys === "a stand-in") {
        spies.push(spyOn(herdr, "paneSendKeys").mockImplementation(async (_paneId, sent, _socket, guard) => {
          steps.push("keys");
          on.connect?.();
          if (guard && !guard()) throw new herdr.HerdrError("cancelled", "herdr pane.send_keys was not sent: the sender may no longer send");
          writes.push(`keys ${sent.join(",")}`);
        }));
      } else {
        const socket = join(root, `keys${++sockets}.sock`);
        const before = process.env["HERDR_SOCKET"];
        process.env["HERDR_SOCKET"] = socket;
        const listener = Bun.listen<{ buffer: string }>({
          unix: socket,
          socket: {
            open(peer) { peer.data = { buffer: "" }; },
            data(peer, chunk) {
              peer.data.buffer += chunk.toString();
              if (!peer.data.buffer.includes("\n")) return;
              const request = JSON.parse(peer.data.buffer) as { id: string; method: string; params: { keys?: string[] } };
              // only the key is herdr's to take here: everything else the delivery asks of herdr is stood in for
              if (request.method !== "pane.send_keys") { peer.end(`${JSON.stringify({ id: request.id, error: { code: "not_stood_in", message: request.method } })}\n`); return; }
              writes.push(`keys ${request.params.keys?.join(",")}`);
              peer.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
            },
          },
        });
        const connect = Bun.connect;
        spies.push(
          // the client's connection to herdr is asked for and not made yet: what a test has happen now comes before the key's write
          spyOn(Bun, "connect").mockImplementation(((options: { unix?: string }) => {
            if (options.unix === socket) { steps.push("keys"); on.connect?.(); }
            return connect(options as never);
          }) as never),
          { mockRestore: () => { listener.stop(true); if (before === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = before; } },
        );
      }
      h.rest(); h.poll();
      handlers.onStatus(h.pane.pane_id, "idle", "claude");
      h.herdrSays(h.pane);
      /** `only`: a message for an agent alone (#511), which a paste refused its Enter leaves held for the person */
      const submit = (id: number, text: string, only = false) => delivery.pendingFrames.submit(client, { type: "submit", id, pane_id: h.pane.pane_id, text, payload: text, delivery: "queue", ...(only ? { agent_only: true } : {}) } as never);
      /** every delivery begun so far has run, and whatever its end began in turn */
      const flush = async () => {
        for (let seen: unknown = null; seen !== lane;) { seen = lane; await lane.catch(() => undefined); await new Promise((resolve) => setTimeout(resolve, 0)); }
      };
      /** the states of the messages the pane's queue holds */
      const waiting = () => delivery.pending.list(client, h.pane.pane_id).map((message) => message.state);
      return { h, delivery, writes, client, submit, flush, on, asked, steps, waiting, results: () => frames.filter((frame) => frame.type === "submit-result") };
    }
    /**
     * The wakeup fires. `told`: its turn writes its prompt and herdr tells that turn at once, on time, in what its
     * snapshots read from here on and in an event: the delivery under way hears it at whatever step it has reached.
     */
    const wakes = (h: Pick<Fixture, "path" | "herdrSays" | "pane">, told: boolean) => {
      fires(h.path);
      if (!told) return;
      resumes(h.path);
      says(h, "working");
    };
    /** The resumed turn rests, read by the timer's poll, or told by herdr where herdr told the turn (`told`). */
    const rests = (h: Pick<Fixture, "path" | "herdrSays" | "pane" | "poll">, told: boolean) => {
      turnEnds(h);
      if (told) says(h, "idle"); else h.poll();
    };
    /** herdr tells nothing of the resumed turn before the delivery ends, or tells it at once. */
    const HERDR: { told: boolean; herdr: string }[] = [{ told: false, herdr: "herdr not telling the resumed turn yet" }, { told: true, herdr: "herdr telling the resumed turn at once" }];
    /** The wakeup fires at the delivery's first read of the screen after it asked for the hold and found none. */
    const firesAfterTheHoldCheck = (d: Awaited<ReturnType<typeof delivering>>) => {
      const fired = { yet: false };
      d.asked.length = 0;
      d.on.read = () => { if (d.asked.length > 0 && !fired.yet) { fired.yet = true; fires(d.h.path); } };
      return fired;
    };

    it("keeps a message sent as the wakeup fires waiting, and types it at the resumed turn's rest", async () => {
      const { h, delivery, writes, client, submit, flush } = await delivering();
      // When the wakeup fires, and the send's own read of the pane is the first to find it.
      fires(h.path);
      await submit(11, "wait");
      await flush();
      // Then nothing is typed into the resumed turn.
      expect(writes).toEqual([]);
      expect(delivery.pending.list(client, h.pane.pane_id).map((message) => message.state)).toEqual(["queued"]);
      // And the turn's rest sends it by itself.
      turnEnds(h); h.poll();
      await flush();
      expect(writes).toEqual(["paste \u001b[200~wait\u001b[201~", "keys Enter"]);
    });

    it("refuses the automatic send of a queued message while the fire holds, though the queue was told the pane rests", async () => {
      const { h, delivery, writes, client, submit, flush } = await delivering();
      fires(h.path); h.poll();
      await submit(12, "first");
      // When a status read before the fire reaches the queue after it.
      delivery.pending.status(h.pane.pane_id, "done"); delivery.drainPending(h.pane.pane_id);
      await flush();
      // Then the delivery's own check of the hold turns the send away, and the message waits on.
      expect(writes).toEqual([]);
      expect(delivery.pending.list(client, h.pane.pane_id)[0]?.state).toBe("queued");
    });

    it("pastes nothing when the wakeup fires after the delivery's hold check, while it reads Claude's input box", async () => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting } = d;
      const id = h.pane.pane_id;
      // Given a message queued while a turn of the person's works.
      h.next();
      h.herdrSays({ ...h.pane, agent_status: "working" });
      handlers.onStatus(id, "working", "claude");
      await submit(13, "later");
      expect(waiting()).toEqual(["queued"]);
      // And a wakeup that fires once the delivery found the queue free, before its paste.
      const fired = firesAfterTheHoldCheck(d);
      // When that turn rests and herdr says so: the queue is delivered.
      turnEnds(h);
      h.herdrSays(h.pane);
      handlers.onStatus(id, "idle", "claude");
      await flush();
      // Then the hold is read again right before the paste: nothing is left in Claude's input line, and the message waits on.
      expect(fired.yet).toBe(true);
      expect(writes).toEqual([]);
      expect(waiting()).toEqual(["queued"]);
      // And the resumed turn's rest sends it.
      turnEnds(h); h.poll();
      await flush();
      expect(writes).toEqual(["paste \u001b[200~later\u001b[201~", "keys Enter"]);
      expect(waiting()).toEqual([]);
    });

    it("queues a message typed at once when the wakeup fires after its hold check, before its paste", async () => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting, results } = d;
      // Given a pane at rest with nothing waiting, and a wakeup that fires once the send found the queue free.
      const fired = firesAfterTheHoldCheck(d);
      await submit(15, "soon");
      await flush();
      // Then nothing is typed: the message is accepted as queued, as one arriving a moment later would be.
      expect(fired.yet).toBe(true);
      expect(writes).toEqual([]);
      expect(results()).toMatchObject([{ id: 15, ok: true, pending: { state: "queued" } }]);
      expect(results()[0]?.typed_now).toBeUndefined();
      expect(waiting()).toEqual(["queued"]);
      // And the resumed turn's rest sends it.
      turnEnds(h); h.poll();
      await flush();
      expect(writes).toEqual(["paste \u001b[200~soon\u001b[201~", "keys Enter"]);
      expect(waiting()).toEqual([]);
    });

    /** The screen reads a delivery makes between the first answer it takes on the queue's hold and its paste, in order. */
    const BEFORE_PASTE = {
      "queued behind a turn": ["its read of Claude's input box", "its check for a masked prompt, the last read before the paste"],
      "typed at once": ["its look at the pane", "its read of Claude's input box", "its check for a masked prompt, the last read before the paste"],
    } as const;
    type Sent = keyof typeof BEFORE_PASTE;
    /** A message sent to a pane at rest (`typed at once`), or queued behind a turn of the person's that then rests; `ready` runs once it only waits to be delivered. */
    const sends = async (d: Awaited<ReturnType<typeof delivering>>, sent: Sent, id: number, text: string, ready: () => void) => {
      const { h, submit } = d;
      if (sent === "typed at once") { ready(); await submit(id, text); return; }
      h.next();
      h.herdrSays({ ...h.pane, agent_status: "working" });
      handlers.onStatus(h.pane.pane_id, "working", "claude");
      await submit(id, text);
      ready();
      turnEnds(h);
      h.herdrSays(h.pane);
      handlers.onStatus(h.pane.pane_id, "idle", "claude");
    };

    it.each((Object.keys(BEFORE_PASTE) as Sent[]).flatMap((sent) => BEFORE_PASTE[sent].flatMap((during, at) => HERDR.map((word) => ({ sent, during, read: at + 1, ...word })))))(
      "pastes nothing for a message $sent when the wakeup fires before its paste, during $during ($herdr)", async ({ sent, read, told }) => {
        const d = await delivering();
        const { h, writes, flush, waiting, results } = d;
        // Given a wakeup that fires at one of the reads of the screen the delivery makes once it found the queue free.
        const fired = { yet: false };
        let reads = 0;
        await sends(d, sent, 22, "early", () => {
          d.asked.length = 0;
          d.on.read = () => { if (d.asked.length > 0 && ++reads === read) { fired.yet = true; wakes(h, told); } };
        });
        await flush();
        expect(fired.yet).toBe(true);
        // Then the hold, read from the transcript after the last of those reads, stops the paste: nothing is left in Claude's
        // input line, and the message waits as one queued. herdr's word for the resumed turn, heard meanwhile, ends no hold.
        expect(writes).toEqual([]);
        expect(waiting()).toEqual(["queued"]);
        if (sent === "typed at once") expect(results()).toMatchObject([{ id: 22, ok: true, pending: { state: "queued" } }]);
        // And the resumed turn's rest sends it.
        rests(h, told);
        await flush();
        expect(writes).toEqual(["paste \u001b[200~early\u001b[201~", "keys Enter"]);
        expect(waiting()).toEqual([]);
      });

    it.each(Object.keys(BEFORE_PASTE) as Sent[])("reads the queue's hold from the transcript last of all before the paste, and again before the Enter, of a message %s", async (sent) => {
      const d = await delivering();
      const { writes, flush, steps } = d;
      await sends(d, sent, 23, "through", () => { steps.length = 0; });
      await flush();
      expect(writes).toEqual(["paste \u001b[200~through\u001b[201~", "keys Enter"]);
      // Nothing is awaited of herdr between either answer and the write it lets through, but that write's own connection:
      // a wakeup has no read of the delivery's left to fire during. The Enter's is read once more once connected.
      const paste = steps.indexOf("paste");
      const enter = steps.indexOf("keys");
      expect(steps.slice(paste - 1, paste + 1)).toEqual(["hold read now", "paste"]);
      expect(steps.slice(enter - 1)).toEqual(["hold read now", "keys", "hold read now"]);
      // And the screen reads before the paste are the ones named above: each of them is tried with a wakeup.
      const first = steps.findIndex((step) => step.startsWith("hold"));
      expect(steps.slice(first, paste).filter((step) => step === "screen")).toHaveLength(BEFORE_PASTE[sent].length);
    });

    it("leaves the queue at working by its own word when its check before the paste finds the hold, and tries no other send", async () => {
      const d = await delivering();
      const { h, delivery, writes, submit, flush, waiting, results, asked } = d;
      // Given a hold that the delivery's check right before the paste is the first to find, and that nothing else
      // tells the queue of: the answer is given here in the hub's place, whose own read tells the queue as it answers.
      let found = false;
      asked.length = 0;
      d.on.held = (fresh) => (found ||= fresh);
      await submit(21, "held");
      await flush();
      // Then nothing is typed and the message is queued, with the queue at working by the delivery's own word.
      expect(writes).toEqual([]);
      expect(results()).toMatchObject([{ id: 21, ok: true, pending: { state: "queued" } }]);
      expect(waiting()).toEqual(["queued"]);
      expect(delivery.pending.current(h.pane.pane_id)).toBe("working");
      // And no other send was tried behind it: the hold was asked for by the submit and by that check alone.
      expect(asked).toEqual([false, true]);
    });

    it.each(HERDR)("sends no Enter, nor a Ctrl+Enter, for a message typed at once when the wakeup fires as it is pasted ($herdr), and leaves the queue free", async ({ told }) => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting, results } = d;
      // Given a pane at rest with nothing waiting, and a wakeup that fires during the paste itself. Where herdr tells
      // its turn at once, the look before the Enter reads the pane at work, as it does for a turn the message may steer.
      d.on.paste = () => { delete d.on.paste; wakes(h, told); };
      await submit(14, "now");
      await flush();
      // Then its Enter is not sent into the resumed turn: the paste stays in Claude's input line, and the send is answered as not confirmed.
      expect(writes).toEqual(["paste \u001b[200~now\u001b[201~"]);
      expect(results()).toMatchObject([{ id: 14, ok: false, code: "submit_changed" }]);
      // No copy of it waits to be typed a second time, and the queue is not stuck behind it.
      expect(waiting()).toEqual([]);
      rests(h, told);
      await submit(16, "after");
      await flush();
      expect(writes.slice(1)).toEqual(["paste \u001b[200~after\u001b[201~", "keys Enter"]);
    });

    it("still commits a message typed at once into a turn herdr tells as it is pasted: only the queue's hold stops its Enter", async () => {
      const d = await delivering();
      const { h, writes, submit, flush, results } = d;
      // When a turn of the person's begins during the paste, which herdr reads at once.
      d.on.paste = () => { delete d.on.paste; h.next(); h.herdrSays({ ...h.pane, agent_status: "working" }); };
      await submit(17, "steer");
      await flush();
      // Then it is sent into that turn as before (Claude Code takes Ctrl+Enter now): no hold of the queue's says otherwise.
      expect(writes).toEqual(["paste \u001b[200~steer\u001b[201~", "keys ctrl+enter"]);
      expect(results()).toMatchObject([{ id: 17, ok: true }]);
    });

    it.each(HERDR)("leaves a paste uncommitted when the wakeup fires between a queued message's paste and its Enter ($herdr)", async ({ told }) => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting } = d;
      const id = h.pane.pane_id;
      h.next();
      h.herdrSays({ ...h.pane, agent_status: "working" });
      handlers.onStatus(id, "working", "claude");
      await submit(18, "pasted");
      // Given a wakeup that fires during the paste itself: no check before the paste can see it.
      d.on.paste = () => { delete d.on.paste; wakes(h, told); };
      turnEnds(h);
      h.herdrSays(h.pane);
      handlers.onStatus(id, "idle", "claude");
      await flush();
      // Then the Enter is refused, and the message is left for the person to check: never typed into the resumed turn, never typed twice.
      expect(writes).toEqual(["paste \u001b[200~pasted\u001b[201~"]);
      expect(waiting()).toEqual(["uncertain"]);
      rests(h, told);
      await flush();
      expect(writes).toEqual(["paste \u001b[200~pasted\u001b[201~"]);
    });

    it.each(([
      { sent: "queued behind a turn", during: "its last look at the pane", read: 1 },
      { sent: "queued behind a turn", during: "its check for a masked prompt, the last read before the Enter", read: 2 },
      { sent: "typed at once", during: "its last look at the pane", read: 1 },
      { sent: "typed at once", during: "its check for a masked prompt, the last read before the Enter", read: 2 },
    ] as const).flatMap((each) => HERDR.map((word) => ({ ...each, ...word }))))("sends no Enter for a message $sent when the wakeup fires after its paste, during $during ($herdr)", async ({ sent, read, told }) => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting, results } = d;
      const id = h.pane.pane_id;
      // Given a wakeup that fires at one of the two reads of the screen the delivery makes between its paste and its Enter.
      // Where herdr tells its turn at once, that word is heard with the delivery at its last checks: it ends no hold.
      const fired = { yet: false };
      let reads = 0;
      d.on.paste = () => { delete d.on.paste; d.on.read = () => { if (++reads === read) { fired.yet = true; wakes(h, told); } }; };
      if (sent === "typed at once") await submit(20, "late");
      else {
        h.next();
        h.herdrSays({ ...h.pane, agent_status: "working" });
        handlers.onStatus(id, "working", "claude");
        await submit(20, "late");
        turnEnds(h);
        h.herdrSays(h.pane);
        handlers.onStatus(id, "idle", "claude");
      }
      await flush();
      expect(fired.yet).toBe(true);
      // Then the hold, read from the transcript after that last read, stops the Enter: the paste stays, not confirmed.
      expect(writes).toEqual(["paste \u001b[200~late\u001b[201~"]);
      if (sent === "typed at once") {
        expect(results()).toMatchObject([{ id: 20, ok: false, code: "submit_changed" }]);
        expect(waiting()).toEqual([]);
      } else expect(waiting()).toEqual(["uncertain"]);
    });

    /**
     * Claude Code in front of the pane's shell, as a message for an agent alone is typed only into (#511). Its start and
     * the session its own record names are stood in for: nothing of this PC's processes or of its Claude store is read.
     */
    const claudeInFront = (d: Awaited<ReturnType<typeof delivering>>) => {
      d.on.front = { pid: 41001, name: "claude", argv: ["claude"] };
      spies.push(spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000), spyOn(claudeStore, "claudeForegroundSession").mockResolvedValue(null));
    };

    it.each((["queued behind a turn", "typed at once"] as const).flatMap((sent) => HERDR.flatMap((word) => ([
      { sent, ...word, only: false, whose: "a message", left: "submit_changed" },
      { sent, ...word, only: true, whose: "a message for an agent alone", left: "pasted_not_sent" },
    ] as const))))(
      "sends no Enter for $whose $sent when the wakeup fires while its Enter's connection to herdr is being made ($herdr)", async ({ sent, told, only, left }) => {
        // Given the Enter written by herdr's own client, to a socket that stands in for herdr's.
        const d = await delivering("herdr's own client");
        const { h, delivery, writes, client, submit, flush, waiting, results, steps } = d;
        if (only) claudeInFront(d);
        // And a wakeup that fires once every check before the Enter found the queue free, with the connection asked for.
        const fired = { yet: false };
        d.on.paste = () => { delete d.on.paste; d.on.connect = () => { delete d.on.connect; fired.yet = true; wakes(h, told); }; };
        if (sent === "typed at once") await submit(24, "last", only);
        else {
          h.next();
          says(h, "working");
          await submit(24, "last", only);
          turnEnds(h);
          says(h, "idle");
        }
        await flush();
        expect(fired.yet).toBe(true);
        // Then the hold is read once more once connected, right before the key's write: herdr is sent no key, and the
        // paste stays, not confirmed. A message for an agent alone is answered as any Enter refused it is: pasted, not
        // sent, and kept for the person, never typed again by itself.
        expect(steps.slice(-3)).toEqual(["hold read now", "keys", "hold read now"]);
        expect(writes).toEqual(["paste \u001b[200~last\u001b[201~"]);
        if (sent === "typed at once") {
          expect(results()).toMatchObject([{ id: 24, ok: false, code: left }]);
          expect(waiting()).toEqual([]);
        } else {
          expect(waiting()).toEqual(["uncertain"]);
          expect(delivery.pending.list(client, h.pane.pane_id)[0]?.error?.code).toBe(left);
        }
        // And with no wakeup that same client writes the Enter: a message sent once the turn rested goes through.
        if (sent === "typed at once") {
          rests(h, told);
          await submit(25, "next", only);
          await flush();
          expect(writes.slice(1)).toEqual(["paste \u001b[200~next\u001b[201~", "keys Enter"]);
        }
      });

    it("sends no Enter for a queued message when a busy signal's hold comes up after its paste: the looks before the Enter ask for that hold where they did", async () => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting } = d;
      const id = h.pane.pane_id;
      h.next();
      says(h, "working");
      await submit(28, "behind");
      const from = Date.now();
      try {
        // Given herdr's working with no turn written for it, heard as the message is pasted, which waits its time in vain
        // while the delivery goes on: the pane rests on its background subagent, and that signal holds its queue.
        d.on.paste = () => { delete d.on.paste; says(h, "working"); setSystemTime(from + 6000); h.poll(); };
        turnEnds(h);
        says(h, "idle");
        await flush();
        // Then no wakeup holds the queue, so the reads made right before the writes find nothing; the look before the
        // Enter still finds the busy signal's hold, as it did before this: the paste is left, not confirmed.
        expect(h.status.claudeAgents.holdsQueue(id)).toBe(true);
        expect(h.status.queueHeld(id, true)).toBe(false);
        expect(writes).toEqual(["paste \u001b[200~behind\u001b[201~"]);
        expect(waiting()).toEqual(["uncertain"]);
      } finally { setSystemTime(); }
    });

    it("types a message the person sends now though the wakeup's hold stands: only what is sent by itself waits for it", async () => {
      const d = await delivering();
      const { h, delivery, writes, client, submit, flush, waiting } = d;
      const id = h.pane.pane_id;
      // Given a resumed turn herdr told and then read at rest with no rest written (interrupted): its hold stands for its time.
      fires(h.path); resumes(h.path); h.poll();
      says(h, "working");
      says(h, "idle");
      await submit(26, "now anyway");
      await flush();
      expect(writes).toEqual([]);
      expect(waiting()).toEqual(["queued"]);
      expect(h.status.queueHeld(id, true)).toBe(true);
      // When the person sends that message now.
      const queued = delivery.pending.list(client, id)[0];
      if (queued === undefined) throw new Error("no queued message");
      await delivery.pendingFrames["pending-action"](client, { type: "pending-action", id: 27, pane_id: id, pending_id: queued.id, action: "steer" } as never);
      await flush();
      // Then it is typed and committed at once: the hold is for the queue's own sends.
      expect(writes).toEqual(["paste \u001b[200~now anyway\u001b[201~", "keys Enter"]);
      expect(waiting()).toEqual([]);
    });

    it("types nothing into the second of two loops' turns when the first was short, and sends the message at its rest", async () => {
      const d = await delivering();
      const { h, writes, submit, flush, waiting } = d;
      const id = h.pane.pane_id;
      // Given a message queued while a turn of the person's works.
      h.next();
      h.herdrSays({ ...h.pane, agent_status: "working" });
      handlers.onStatus(id, "working", "claude");
      await submit(19, "after both");
      expect(waiting()).toEqual(["queued"]);
      // That turn rests with two loops due: both fires and the first loop's prompt are written before herdr's idle word for it.
      turnEnds(h); fires(h.path); fires(h.path); resumes(h.path);
      h.herdrSays(h.pane);
      handlers.onStatus(id, "idle", "claude");
      await flush();
      expect(writes).toEqual([]);
      // herdr tells the first loop's turn, which is short: its rest and the second loop's prompt are read before herdr's idle word for it.
      h.herdrSays({ ...h.pane, agent_status: "working" });
      handlers.onStatus(id, "working", "claude");
      turnEnds(h); resumes(h.path); h.poll();
      // When that idle word comes, with the second loop's turn at work.
      h.herdrSays(h.pane);
      handlers.onStatus(id, "idle", "claude");
      await flush();
      // Then nothing is typed into it, and the message waits on.
      expect(writes).toEqual([]);
      expect(waiting()).toEqual(["queued"]);
      // And that turn's rest sends it.
      turnEnds(h); h.poll();
      await flush();
      expect(writes).toEqual(["paste \u001b[200~after both\u001b[201~", "keys Enter"]);
      expect(waiting()).toEqual([]);
    });

    describe("for a turn resumed on a background task's notice", () => {
      it("keeps a message sent as the notice's turn begins waiting, and types it at that turn's rest", async () => {
        const { h, writes, submit, flush, waiting } = await delivering();
        // When a background task ends at the pane at rest, and the send's own read of the pane is the first to find its turn.
        notices(h.path);
        await submit(31, "wait");
        await flush();
        // Then nothing is typed into that turn.
        expect(writes).toEqual([]);
        expect(waiting()).toEqual(["queued"]);
        // And the turn's rest sends it by itself.
        turnEnds(h); h.poll();
        await flush();
        expect(writes).toEqual(["paste \u001b[200~wait\u001b[201~", "keys Enter"]);
        expect(waiting()).toEqual([]);
      });

      it("types nothing into a notice's turn begun at the rest of the turn a message waited behind, and sends it at the notice's turn's rest", async () => {
        const d = await delivering();
        const { h, writes, submit, flush, waiting } = d;
        const id = h.pane.pane_id;
        // Given a message queued while a turn of the person's works, and a task that ends meanwhile.
        h.next();
        says(h, "working");
        await submit(32, "behind");
        expect(waiting()).toEqual(["queued"]);
        taskEnds(h.path);
        // That turn rests and the notice's turn begins at once: its prompt is written before herdr's idle word for the turn before.
        turnEnds(h); noticeTurn(h.path);
        h.herdrSays(h.pane);
        handlers.onStatus(id, "idle", "claude");
        await flush();
        // Then that idle word types nothing into the notice's turn, and the message waits on.
        expect(writes).toEqual([]);
        expect(waiting()).toEqual(["queued"]);
        // herdr tells the notice's turn, and its rest sends the message.
        says(h, "working");
        turnEnds(h);
        says(h, "idle");
        await flush();
        expect(writes).toEqual(["paste \u001b[200~behind\u001b[201~", "keys Enter"]);
        expect(waiting()).toEqual([]);
      });

      it("sends a waiting message by itself a minute after the prompt of a notice's turn that was interrupted and wrote no rest", async () => {
        const d = await delivering();
        const { h, writes, submit, flush, waiting } = d;
        // Given a notice's turn that herdr tells, and a message sent meanwhile.
        notices(h.path); h.poll();
        says(h, "working");
        await submit(33, "after the minute");
        const from = Date.now();
        try {
          // When that turn is interrupted, which writes no rest here, and herdr reads the pane at rest.
          setSystemTime(from + 10_000);
          says(h, "idle");
          await flush();
          // Then the message waits on, though the pane shows as idle.
          expect(writes).toEqual([]);
          expect(waiting()).toEqual(["queued"]);
          setSystemTime(from + 59_000);
          h.poll();
          await flush();
          expect(writes).toEqual([]);
          // And once the hold's time is up the timer's poll tells the queue, which sends it with no status event.
          setSystemTime(from + 61_000);
          h.poll();
          await flush();
          expect(writes).toEqual(["paste \u001b[200~after the minute\u001b[201~", "keys Enter"]);
          expect(waiting()).toEqual([]);
        } finally { setSystemTime(); }
      });

      it("sends a message at once to a pane whose notice turn's hold ran out, though this PC's clock was set back since", async () => {
        const d = await delivering();
        const { h, writes, submit, flush, waiting } = d;
        const id = h.pane.pane_id;
        // Given a notice's turn that wrote no rest: its hold ran out its minute, which the queue was told, and the
        // polls since found the pane's files as they were and read nothing.
        notices(h.path); h.poll();
        expect(h.status.queueHeld(id, false)).toBe(true);
        const from = Date.now();
        try {
          setSystemTime(from + 61_000);
          h.poll();
          expect(h.status.queueHeld(id, false)).toBe(false);
          setSystemTime(from + 64_000);
          h.poll();
          setSystemTime(from + 70_000);
          h.poll();
          // When the clock is set back ten minutes, to before that hold began, and a message is sent to the pane
          // herdr reads at rest.
          setSystemTime(from + 70_000 - 10 * 60_000);
          h.poll();
          expect(h.status.queueHeld(id, false)).toBe(false);
          expect(h.status.queueHeld(id, true)).toBe(false);
          await submit(37, "after the clock went back");
          await flush();
          // Then it is typed at once: the hold that ended holds nothing again. One that did would keep the message
          // waiting with no poll to read that its time was up, until herdr's next word on the pane.
          expect(writes).toEqual(["paste \u001b[200~after the clock went back\u001b[201~", "keys Enter"]);
          expect(waiting()).toEqual([]);
        } finally { setSystemTime(); }
      });

      it("leaves a paste uncommitted when the notice's turn begins between a queued message's paste and its Enter", async () => {
        const d = await delivering();
        const { h, writes, submit, flush, waiting } = d;
        const id = h.pane.pane_id;
        h.next();
        says(h, "working");
        await submit(34, "pasted");
        // Given a task that ends during the paste itself: no check before the paste can see its turn.
        d.on.paste = () => { delete d.on.paste; notices(h.path); };
        turnEnds(h);
        h.herdrSays(h.pane);
        handlers.onStatus(id, "idle", "claude");
        await flush();
        // Then the Enter is refused, and the message is left for the person to check: never typed into that turn, never typed twice.
        expect(writes).toEqual(["paste \u001b[200~pasted\u001b[201~"]);
        expect(waiting()).toEqual(["uncertain"]);
        turnEnds(h); h.poll();
        await flush();
        expect(writes).toEqual(["paste \u001b[200~pasted\u001b[201~"]);
      });

      it("leaves a paste uncommitted when herdr's idle word for the turn a message waited behind is heard before the prompt of the notice's turn begun at that rest is written", async () => {
        const d = await delivering();
        const { h, writes, submit, flush, waiting } = d;
        const id = h.pane.pane_id;
        // Given a message queued behind a turn of the person's, and a task that ends while that turn works: its notice
        // waits in Claude's queue, which holds nothing.
        h.next();
        says(h, "working");
        await submit(36, "at the rest");
        taskEnds(h.path);
        // That turn rests and the notice's turn begins at once, but herdr's idle word is heard before Claude has written
        // that turn's prompt: the check before the paste has no prompt to read, and the prompt is in the file for the
        // read before the Enter (written here during the paste). A known bound: nothing holds between that rest and
        // the prompt's line, which reaches the file up to a few tenths of a second after that rest.
        d.on.paste = () => { delete d.on.paste; noticeTurn(h.path); };
        turnEnds(h);
        h.herdrSays(h.pane);
        handlers.onStatus(id, "idle", "claude");
        await flush();
        // Then no Enter goes into the notice's turn: the text stays in Claude's input line and the message is left for
        // the person to check, typed again by nothing, that turn's rest included.
        expect(writes).toEqual(["paste \u001b[200~at the rest\u001b[201~"]);
        expect(waiting()).toEqual(["uncertain"]);
        turnEnds(h); h.poll();
        await flush();
        expect(writes).toEqual(["paste \u001b[200~at the rest\u001b[201~"]);
      });

      it("sends no Enter for a message typed at once when the notice's turn begins while its Enter's connection to herdr is being made", async () => {
        // Given the Enter written by herdr's own client, to a socket that stands in for herdr's.
        const d = await delivering("herdr's own client");
        const { h, writes, submit, flush, waiting, results, steps } = d;
        // And a task that ends once every check before the Enter found the queue free, with the connection asked for.
        const begun = { yet: false };
        d.on.paste = () => { delete d.on.paste; d.on.connect = () => { delete d.on.connect; begun.yet = true; notices(h.path); }; };
        await submit(35, "last");
        await flush();
        expect(begun.yet).toBe(true);
        // Then the hold is read once more once connected, right before the key's write: herdr is sent no key, and the
        // paste stays, not confirmed.
        expect(steps.slice(-3)).toEqual(["hold read now", "keys", "hold read now"]);
        expect(writes).toEqual(["paste \u001b[200~last\u001b[201~"]);
        expect(results()).toMatchObject([{ id: 35, ok: false, code: "submit_changed" }]);
        expect(waiting()).toEqual([]);
      });
    });
  });
});

describe("Claude turn starts the transcript does not show yet (#2072)", () => {
  const queue = (h: Awaited<ReturnType<typeof workingClaude>>) =>
    h.pending.enqueue("owner", h.pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: h.pane.agent_session.value });
  const turnEnds = (h: Awaited<ReturnType<typeof workingClaude>>) =>
    appendFileSync(h.path, line({ type: "system", subtype: "turn_duration", timestamp: new Date(at + 6000).toISOString() }));

  it("closes the queue for a next turn herdr tells while the subagents' spinner never left working", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    expect(h.last().status).toBe("done");
    // When herdr says working again, with no idle between, before Claude writes the next prompt.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    h.poll();
    queue(h);
    const snapshot = await h.snapshot();
    // Then the rest the transcript holds is the turn before's.
    expect(h.last().status).toBe("working");
    expect(snapshot.panes[0]?.agent_status).toBe("working");
    expect(h.pending.current(h.pane.pane_id)).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
    // And the turn's own rest, once written, ends it.
    h.next(); turnEnds(h); h.poll();
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("reaches rest when herdr's working event comes after the turn it tells has ended", async () => {
    const h = await workingClaude();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // Given a whole next turn written before herdr's event for it arrives.
    h.next(); turnEnds(h);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    h.poll();
    // Then that turn's rest is its own.
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
  });

  it("reaches rest when a chat send returns after the turn it started has ended and been read", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // Given the send's whole turn written, and read at rest, before its send returns.
    h.next(); turnEnds(h); h.poll();
    noteSubmitted(h.pane.pane_id, "short question", undefined, at + 4000);
    h.poll();
    // Then the turn begun after its Enter is its own.
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("keeps working for a turn after one the same signal source already waited for", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // Given herdr telling turn B before Claude writes it, and B written whole before the next read.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    h.next(); turnEnds(h);
    // When herdr tells turn C before Claude writes it.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    // Then B is the first signal's, and C has no rest yet.
    expect(h.last().status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("keeps working when the chat sends a prompt after a terminal turn it did not start", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // Given turn B typed in the terminal and ended, not read yet.
    h.next(); turnEnds(h);
    // When the chat's prompt C returns before Claude writes it.
    noteSubmitted(h.pane.pane_id, "new prompt", undefined, at + 5500);
    queue(h);
    // Then B, begun before C's Enter, is not C's.
    expect(h.last().status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("reaches rest when herdr's working event for a turn already read at rest comes after an idle one", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // Given turn B written and read at rest before herdr's working event for it.
    h.next(); turnEnds(h); h.poll();
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    // Then B, the first turn begun since herdr said idle, is that event's.
    expect(h.last().status).toBe("done");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
  });

  it("reaches rest when the chat's message was taken into the turn at work", async () => {
    const h = await workingClaude();
    // Given a message Claude takes into its turn at work, and the turn's end, before the send returns.
    appendFileSync(h.path, line({ type: "attachment", timestamp: new Date(at + 200).toISOString(), attachment: { type: "queued_command", commandMode: "prompt", prompt: "also check docs" } }));
    h.rest();
    noteSubmitted(h.pane.pane_id, "also check docs", undefined, at + 100);
    h.poll();
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("shows a signal whose turn is never written at rest once it waited, and holds the queue until herdr says the pane does no work", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // When herdr says working again with nothing to place it, and no turn follows.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    expect(h.last().status).toBe("working");
    setSystemTime(Date.now() + 6000);
    try {
      h.poll();
      // Then the pane is shown at rest again, not working while the subagent streams,
      expect(h.last().status).toBe("done");
      expect((await h.snapshot()).panes[0]?.agent_status).toBe("done");
      // but its time running out proves no turn ended: the queue waits on.
      expect(h.pending.next(h.pane.pane_id)).toBeNull();
    } finally { setSystemTime(); }
    // herdr's word that the pane does no work lets it go.
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
  });

  it("holds the queue on a signal that waited in vain until a rest is written past it", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // When herdr tells a turn whose first entry is not written within the hold.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    setSystemTime(Date.now() + 6000);
    try {
      h.poll();
      expect(h.pending.next(h.pane.pane_id)).toBeNull();
    } finally { setSystemTime(); }
    // Then that turn, written late, holds the queue until its own rest.
    h.next(); h.poll();
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
    turnEnds(h); h.poll();
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
  });

  it("keeps working when herdr tells the next turn after a terminal turn that ended unseen", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // Given terminal turn B begun and ended between polls, with no herdr word for it.
    h.next(); turnEnds(h);
    // When herdr tells turn C before Claude writes it.
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    queue(h);
    // Then B's rest is not C's.
    expect(h.last().status).toBe("working");
    expect((await h.snapshot()).panes[0]?.agent_status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("takes a person's prompt that quotes a local command's output for a turn", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    appendFileSync(h.path, line({ type: "user", origin: { kind: "human" }, permissionMode: "default", timestamp: new Date(at + 5000).toISOString(), message: { role: "user", content: "<local-command-stdout>example</local-command-stdout> Explain this format." } }));
    h.poll();
    queue(h);
    expect(h.last().status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("finds a pane at rest under its subagents' spinner when the server starts", async () => {
    const old = await workingClaude();
    old.rest();
    // Given a server that first reads the pane working, its turn's rest already written.
    const h = hub(old.path);
    const pane = { ...old.pane, agent_status: "working" };
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    await h.snapshot();
    h.poll();
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]?.agent_status).toBe("done");
    expect(h.pending.current(pane.pane_id)).toBe("done");
  });

  it("closes the queue when a task notification Claude marks as its own (isMeta) begins a turn", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // When another task's notification resumes Claude before its first answer is written.
    appendFileSync(h.path, line({ type: "user", isMeta: true, userType: "external", timestamp: new Date(at + 4000).toISOString(), message: { role: "user", content: "<task-notification><task-id>other</task-id><status>completed</status></task-notification>" } }));
    h.poll();
    queue(h);
    expect(h.last().status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("closes the queue when a skill begins a turn, before Claude's first answer", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // the entries Claude Code writes as a skill or custom command begins
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "user", timestamp: ts(5000), message: { role: "user", content: "<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>\n<command-args>12</command-args>" } })
      + line({ type: "user", isMeta: true, timestamp: ts(5000), message: { role: "user", content: [{ type: "text", text: "Review the PR.\n\nARGUMENTS: 12" }] } })
      + line({ type: "attachment", timestamp: ts(5001), attachment: { type: "environment" } }));
    h.poll();
    queue(h);
    expect(h.last().status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("keeps the rest through bash-mode records written with no model turn after them", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // the entries Claude Code writes for \`!ls\`
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "user", timestamp: ts(6000), message: { role: "user", content: "<bash-input>ls</bash-input>" } })
      + line({ type: "user", timestamp: ts(6001), message: { role: "user", content: "<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>" } }));
    h.poll();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("shows /compact at work while it runs, and at rest again once its output is written", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    // the entries Claude Code 2.1.29x-2.1.30x writes for /compact typed at rest
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "user", timestamp: ts(6000), message: { role: "user", content: "/compact" } }));
    h.poll();
    expect(h.last().status).toBe("working");
    appendFileSync(h.path, line({ type: "system", subtype: "compact_boundary", timestamp: ts(9000), content: "Conversation compacted" })
      + line({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: ts(9000), message: { role: "user", content: "This session is being continued from a previous conversation." } })
      + line({ type: "user", isMeta: true, timestamp: ts(9001), message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } })
      + line({ type: "user", timestamp: ts(9001), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } })
      + line({ type: "user", timestamp: ts(9002), message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }));
    h.poll();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("keeps working when a message is taken in, or a skill runs, while /compact runs", async () => {
    for (const between of ["queued", "skill"] as const) {
      const h = await workingClaude();
      h.rest(); h.poll();
      const ts = (ms: number) => new Date(at + ms).toISOString();
      appendFileSync(h.path, line({ type: "user", timestamp: ts(6000), message: { role: "user", content: "/compact" } })
        + line({ type: "system", subtype: "compact_boundary", timestamp: ts(9000), content: "Conversation compacted" })
        + line({ type: "user", isCompactSummary: true, timestamp: ts(9000), message: { role: "user", content: "This session is being continued from a previous conversation." } })
        + (between === "queued"
          ? line({ type: "attachment", timestamp: ts(9000), attachment: { type: "queued_command", commandMode: "prompt", prompt: "and then?" } })
          : line({ type: "user", timestamp: ts(9000), message: { role: "user", content: "<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>" } }))
        + line({ type: "user", isMeta: true, timestamp: ts(9001), message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } })
        + line({ type: "user", timestamp: ts(9001), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" } })
        + line({ type: "user", timestamp: ts(9002), message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }));
      h.poll();
      queue(h);
      // the compaction's output takes back only what it began
      expect(h.last().status).toBe("working");
      expect(h.pending.next(h.pane.pane_id)).toBeNull();
    }
  });

  it("keeps a person's prompt sent while /compact runs, though it quotes /compact's echo", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "user", timestamp: ts(6000), message: { role: "user", content: "/compact" } })
      + line({ type: "user", origin: { kind: "human" }, permissionMode: "default", timestamp: ts(7000), message: { role: "user", content: "<command-name>/compact</command-name> what does this tag do?" } })
      + line({ type: "user", isMeta: true, timestamp: ts(9001), message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } })
      + line({ type: "user", timestamp: ts(9001), message: { role: "user", content: "<command-name>/compact</command-name>" } })
      + line({ type: "user", timestamp: ts(9002), message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }));
    h.poll();
    queue(h);
    expect(h.last().status).toBe("working");
    expect(h.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("returns /compact with arguments to rest once its output is written", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "user", timestamp: ts(6000), message: { role: "user", content: "/compact focus on the <command-name>/model</command-name> parser\nand tests" } })
      + line({ type: "user", isMeta: true, timestamp: ts(9001), message: { role: "user", content: "<local-command-caveat>Caveat</local-command-caveat>" } })
      + line({ type: "user", timestamp: ts(9001), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-args>focus on the parser</command-args>" } })
      + line({ type: "user", timestamp: ts(9002), message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }));
    h.poll();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("lets go of a bash-mode line the chat sent once its records are written, however late", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    noteSubmitted(h.pane.pane_id, "!sleep 10", undefined, at + 5500);
    queue(h);
    const ts = (ms: number) => new Date(at + ms).toISOString();
    setSystemTime(Date.now() + 6000);
    try {
      h.poll();
      expect(h.pending.next(h.pane.pane_id)).toBeNull();
      // a version that writes the records alone, after the command ends
      appendFileSync(h.path, line({ type: "user", timestamp: ts(16000), message: { role: "user", content: "<bash-input>sleep 10</bash-input>" } })
        + line({ type: "user", timestamp: ts(16001), message: { role: "user", content: "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>" } }));
      h.poll();
      expect(h.last().status).toBe("done");
      expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
    } finally { setSystemTime(); }
  });

  it("closes the queue for a bash-mode line the chat sends until Claude takes it in", async () => {
    for (const shape of ["model turn", "no turn"] as const) {
      const h = await workingClaude();
      h.rest(); h.poll();
      noteSubmitted(h.pane.pane_id, "!ls", undefined, at + 5500);
      queue(h);
      expect(h.last().status).toBe("working");
      expect(h.pending.next(h.pane.pane_id)).toBeNull();
      const ts = (ms: number) => new Date(at + ms).toISOString();
      const bash = line({ type: "user", timestamp: ts(6000), message: { role: "user", content: "<bash-input>ls</bash-input>" } })
        + line({ type: "user", timestamp: ts(6001), message: { role: "user", content: "<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>" } });
      // Claude Code 2.1.311 answers it in a model turn; versions before it may write the records alone
      if (shape === "model turn") {
        appendFileSync(h.path, line({ type: "api-request", timestamp: ts(6002) }) + bash);
        h.poll();
        expect(h.last().status).toBe("working");
        appendFileSync(h.path, line({ type: "assistant", timestamp: ts(7000), message: { role: "assistant", stop_reason: "end_turn", content: [] } })
          + line({ type: "system", subtype: "turn_duration", timestamp: ts(7001) }));
      } else appendFileSync(h.path, bash);
      h.poll();
      expect(h.last().status).toBe("done");
      expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
    }
  });

  it("keeps the rest through a compaction Claude Code runs while idle", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "system", subtype: "compact_boundary", timestamp: ts(6000), content: "Conversation compacted" })
      + line({ type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: ts(6000), message: { role: "user", content: "This session is being continued from a previous conversation." } })
      + line({ type: "system", subtype: "informational", timestamp: ts(6001), content: "Compacted while idle" }));
    h.poll();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("keeps the rest through a slash command, which runs no turn", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    noteSubmitted(h.pane.pane_id, "/model sonnet");
    // the entries Claude Code writes for a local command
    const ts = (ms: number) => new Date(at + ms).toISOString();
    appendFileSync(h.path, line({ type: "user", isMeta: true, timestamp: ts(6000), message: { role: "user", content: "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>" } })
      + line({ type: "user", timestamp: ts(6001), message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>" } })
      + line({ type: "user", timestamp: ts(6002), message: { role: "user", content: "<local-command-stdout>Set model to sonnet</local-command-stdout>" } })
      + line({ type: "system", subtype: "local_command", timestamp: ts(6003), content: "<local-command-stdout>Set model to sonnet</local-command-stdout>" }));
    h.poll();
    const snapshot = await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(snapshot.panes[0]?.agent_status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
  });

  it("leaves a pane herdr reads idle idle when the chat sends it a prompt", async () => {
    const h = await workingClaude();
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    const alerts = h.alerts.length;
    // When a send returns before herdr or the transcript tells of any turn.
    noteSubmitted(h.pane.pane_id, "hello");
    queue(h);
    // Then the status stays herdr's: nothing ends a working the server made up.
    expect(h.last().status).toBe("done");
    expect(h.pending.current(h.pane.pane_id)).toBe("done");
    expect(h.pending.next(h.pane.pane_id)).not.toBeNull();
    expect(h.alerts.slice(alerts)).not.toContain("working");
  });

  it("keeps working when herdr's working event came before the transcript was first found", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const path = join(root, `${id}.jsonl`);
    const dir = join(root, id, "subagents");
    mkdirSync(dir, { recursive: true });
    // Given a transcript whose last turn ended long ago, with a subagent still at work.
    writeFileSync(path, line({ type: "user", timestamp: new Date(at - 1000).toISOString(), message: { role: "user", content: "old" } })
      + line({ type: "system", subtype: "turn_duration", timestamp: new Date(at + 300).toISOString() }));
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", toolUseId: "toolu_a1", requestShape: "background" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), line({ type: "user", isSidechain: true, agentId: "a1", sessionId: id, timestamp: new Date(at).toISOString(), message: { role: "user", content: "review" } }));
    const pane = { ...claude, agent_status: "working", agent_session: { ...claude.agent_session, value: id } };
    const h = hub(path);
    h.herdrSays(pane);
    // When herdr's working event comes before the pane's transcript is looked up.
    handlers.onStatus(pane.pane_id, "working", "claude");
    await h.snapshot();
    h.poll();
    h.pending.enqueue("owner", pane.pane_id, 1, "queued", null, { agent: "claude", terminalId: "test", session: id });
    // Then the old rest ends no turn begun since.
    expect(h.last().status).toBe("working");
    expect(h.pending.current(pane.pane_id)).toBe("working");
    expect(h.pending.next(pane.pane_id)).toBeNull();
  });
});

describe("the status hub's Claude turn at rest under its background subagent", () => {
  // the session's turn starts a background subagent, which works on after the turn ends
  const RESTING = "22222222-2222-4222-8222-222222222222";
  const path = join(root, `${RESTING}.jsonl`);
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const ts = (ms: number) => new Date(at + ms).toISOString();
  mkdirSync(join(root, RESTING, "subagents"), { recursive: true });
  writeFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(-1000), permissionMode: "default", message: { role: "user", content: "go" } }));
  writeFileSync(join(root, RESTING, "subagents", "agent-b1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "essays", toolUseId: "toolu_b1", requestShape: "background" }));
  writeFileSync(join(root, RESTING, "subagents", "agent-b1.jsonl"), line({ isSidechain: true, sessionId: RESTING, agentId: "b1", type: "user", timestamp: ts(0), message: { role: "user", content: "write" } }));
  const pane = { ...claude, agent_session: { ...claude.agent_session, value: RESTING } };

  it("takes herdr's working for a rest held on the subagent, and herdr's word again once a next turn starts (#2069)", async () => {
    const h = hub(path);
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    await h.snapshot();
    h.herdrSays({ ...pane, agent_status: "working" });
    handlers.onStatus("w1:p1", "working", "claude");
    expect(h.last().status).toBe("working");
    // the turn ends (its `turn_duration` entry), and Claude's busy title stays up while the subagent streams: herdr says nothing new
    appendFileSync(path, line({ type: "assistant", isSidechain: false, timestamp: ts(200), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } })
      + line({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: ts(300), pendingBackgroundAgentCount: 1 }));
    h.poll();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.alerts.at(-1)).toBe("working");
    // a snapshot read meanwhile says the same
    await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // the person prompts again while the subagent works: the session is at work, as herdr has said all along
    appendFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(5000), permissionMode: "default", message: { role: "user", content: "next" } }));
    h.poll();
    expect(h.last().status).toBe("working");
  });
});

describe("the status hub's Claude turn at rest when its last background task ends (#3348)", () => {
  const ts = (ms: number) => new Date(at + ms).toISOString();
  let fixtures = 0;
  afterEach(() => { setSystemTime(); });

  /**
   * A turn at rest under its background subagent, herdr still reading Claude's busy title as working; then the
   * subagent's own turn ends before herdr says anything new, read by a poll unless `read` is false. `together`: the
   * turn's rest and the subagent's end are both written before a poll reads either.
   */
  async function endedUnderRest({ read = true, together = false }: { read?: boolean; together?: boolean } = {}) {
    const id = `55555555-5555-4555-8555-${String(++fixtures).padStart(12, "0")}`;
    const path = join(root, `${id}.jsonl`);
    const agentFile = join(root, id, "subagents", "agent-b1.jsonl");
    mkdirSync(join(root, id, "subagents"), { recursive: true });
    writeFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(-1000), permissionMode: "default", message: { role: "user", content: "go" } }));
    writeFileSync(join(root, id, "subagents", "agent-b1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "essays", toolUseId: "toolu_b1", requestShape: "background" }));
    writeFileSync(agentFile, line({ isSidechain: true, sessionId: id, agentId: "b1", type: "user", timestamp: ts(0), message: { role: "user", content: "write" } }));
    const pane = { ...claude, agent_session: { ...claude.agent_session, value: id } };
    const h = hub(path);
    h.herdrSays(pane);
    handlers.onBaseline([pane]);
    await h.snapshot();
    h.herdrSays({ ...pane, agent_status: "working" });
    handlers.onStatus("w1:p1", "working", "claude");
    appendFileSync(path, line({ type: "assistant", isSidechain: false, timestamp: ts(200), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "OK" }] } })
      + line({ type: "system", subtype: "turn_duration", isSidechain: false, timestamp: ts(300), pendingBackgroundAgentCount: 1 }));
    if (!together) {
      h.poll();
      expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    }
    appendFileSync(agentFile, line({ isSidechain: true, sessionId: id, agentId: "b1", type: "assistant", timestamp: ts(400), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }));
    if (read) h.poll();
    return { ...h, session: pane, next: () => appendFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(5000), permissionMode: "default", message: { role: "user", content: "next" } })) };
  }

  it("keeps the transcript's rest when the last one ends while herdr's last word is still working", async () => {
    const h = await endedUnderRest();
    expect(h.last()).toEqual({ status: "done", tasks: 0, bg: true });
    // a snapshot repeating herdr's stale word answers the rest, and emits it so
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "done" });
    expect(snapshot.panes[0]?.background_tasks ?? 0).toBe(0);
    expect(h.last()).toEqual({ status: "done", tasks: 0, bg: true });
  });

  it("keeps the rest when a later refresh looks the same session up again", async () => {
    const h = await endedUnderRest();
    // past the refresh interval: a pane with no known process start is looked up again, finding the same session
    setSystemTime(Date.now() + 6000);
    await h.snapshot();
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "done" });
    expect(h.last().status).toBe("done");
  });

  it("keeps the rest when the same session is looked up again under another key (its cwd changed)", async () => {
    const h = await endedUnderRest();
    h.herdrSays({ ...h.session, agent_status: "working", cwd: "/elsewhere" });
    // the first snapshot starts the lookup under the new key; the second answers after it
    await h.snapshot();
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]).toMatchObject({ agent_status: "done" });
    expect(h.last().status).toBe("done");
  });

  it("keeps the rest when the turn's rest and the last task's end are read by the same poll", async () => {
    const h = await endedUnderRest({ together: true });
    expect(h.last()).toMatchObject({ status: "done", tasks: 0 });
    expect((await h.snapshot()).panes[0]).toMatchObject({ agent_status: "done" });
  });

  it("reads working again on herdr's working event after the end, read by a poll first or not", async () => {
    for (const read of [true, false]) {
      const h = await endedUnderRest({ read });
      handlers.onStatus("w1:p1", "working", "claude");
      expect([read, h.last()]).toEqual([read, { status: "working", tasks: 0, bg: false }]);
      expect([read, (await h.snapshot()).panes[0]?.agent_status]).toEqual([read, "working"]);
    }
  });

  it("reads working again for a next turn written late, after herdr's working event or with none", async () => {
    const told = await endedUnderRest();
    handlers.onStatus("w1:p1", "working", "claude");
    // the event's turn is not written within the busy hold: the rest it broke is not taken back
    setSystemTime(Date.now() + 6000);
    told.poll();
    expect((await told.snapshot()).panes[0]).toMatchObject({ agent_status: "working" });
    told.next();
    told.poll();
    expect(told.last().status).toBe("working");
    expect((await told.snapshot()).panes[0]).toMatchObject({ agent_status: "working" });
    setSystemTime();
    // herdr never left working, so no event tells the next turn: its prompt written is enough
    const untold = await endedUnderRest();
    untold.next();
    untold.poll();
    expect(untold.last().status).toBe("working");
    expect((await untold.snapshot()).panes[0]).toMatchObject({ agent_status: "working" });
  });
});

describe("queued input while a busy signal holds a Claude pane's queue (#2072)", () => {
  const READY = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); setSystemTime(); });

  /** A pane shown at rest again after a herdr working signal whose turn was never written: its queue is held. */
  async function heldPane(queued = false) {
    const writes: string[] = [];
    const client: Client = { data: connectionData({ readOnly: false, deviceId: undefined }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: () => 1, close: () => {} };
    let lane: Promise<unknown> = Promise.resolve();
    const serialize = <T>(_paneId: string, task: () => T | Promise<T>): Promise<T> => { const next = lane.catch(() => undefined).then(task); lane = next; return next; };
    let h!: Awaited<ReturnType<typeof workingClaude<Client, unknown>>>;
    const delivery = createPendingDelivery({
      options: { submitDelayMs: 0 }, clients: new Set([client]), attachments: new Map(), serialize, lastTyped: new Map(),
      sight: () => ({ origin: null, pty: null, claim: null, facts: () => READY, write: (data: string) => { writes.push(data); } }) as never,
      submitText: (async () => { throw new Error("no immediate send in this test"); }) as never, authorizeSocket: () => {},
      clientSnapshot: () => h.status.clientSnapshot(), omo: { sessionOf: () => null }, queueHeld: (paneId) => h.status.queueHeld(paneId, false),
      SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    h = await workingClaude(delivery.pending as never, delivery.drainPending);
    spies.push(
      spyOn(herdr, "paneRead").mockResolvedValue({ text: "" } as never),
      spyOn(herdr, "paneProcessInfo").mockResolvedValue({ foreground_processes: [], shell_pid: null } as never),
      spyOn(herdr, "paneSendText").mockImplementation(async (_paneId, text) => { writes.push(`paste ${text}`); }),
      spyOn(herdr, "paneSendKeys").mockImplementation(async (_paneId, keys) => { writes.push(`keys ${keys.join(",")}`); }),
    );
    h.rest(); h.poll();
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    if (queued) await delivery.pendingFrames.submit(client, { type: "submit", id: 10, pane_id: h.pane.pane_id, text: "first", payload: "first", delivery: "queue" } as never);
    setSystemTime(Date.now() + 6000);
    h.poll();
    expect((await h.snapshot()).panes[0]?.agent_status).toBe("done");
    return { h, delivery, writes, client, flush: async () => { await lane; await lane; } };
  }

  it("keeps a queued message sent meanwhile waiting, and types nothing", async () => {
    const { h, delivery, writes, client } = await heldPane();
    await delivery.pendingFrames.submit(client, { type: "submit", id: 11, pane_id: h.pane.pane_id, text: "wait", payload: "wait", delivery: "queue" } as never);
    expect(writes).toEqual([]);
    expect(delivery.pending.list(client, h.pane.pane_id).map((message) => message.state)).toEqual(["queued"]);
  });

  it("offers no queued message when a held one is added meanwhile", async () => {
    const { h, delivery, client, flush } = await heldPane(true);
    // what the hold's own status read hands the queue, at the moment it hands it
    const observe = delivery.pending.observe.bind(delivery.pending);
    let offered = false;
    spies.push(spyOn(delivery.pending, "observe").mockImplementation((paneId, status, mark) => { observe(paneId, status, mark); offered ||= delivery.pending.next(h.pane.pane_id) !== null; }));
    await delivery.pendingFrames.submit(client, { type: "submit", id: 12, pane_id: h.pane.pane_id, text: "held", payload: "held", delivery: "hold" } as never);
    await flush();
    expect(offered).toBe(false);
    expect(delivery.pending.next(h.pane.pane_id)).toBeNull();
  });

  it("refuses the automatic send of a queued message though the pane is shown at rest", async () => {
    const { h, delivery, writes, client, flush } = await heldPane(true);
    delivery.pending.status(h.pane.pane_id, "done"); delivery.drainPending(h.pane.pane_id);
    await flush();
    expect(writes).toEqual([]);
    expect(delivery.pending.list(client, h.pane.pane_id)[0]?.state).toBe("queued");
  });
});

describe("the herdr a features frame names (#2257)", () => {
  it("is the snapshot's herdr, and only the one that answered the lifecycle subscription while its socket is still that herdr's", async () => {
    let socket: string | null = "herdr-socket-a";
    const h = hub(undefined, undefined, undefined, () => socket);
    const live = handlers.herdrLive!;
    // the collector reads herdr's identity through the hub's own reader
    expect(live.identity()).toBe("herdr-socket-a");
    // no subscription answered yet: a socket file alone proves no herdr
    expect(h.status.currentHerdrLifetime()).toBeUndefined();
    live.onChange("herdr-socket-a");
    const named = h.status.currentHerdrLifetime();
    expect(named).toBeString();
    expect((await h.snapshot()).herdr_lifetime).toBe(named);
    // herdr died: the subscription closes, while its socket file (still "herdr-socket-a" here) stays behind
    live.onChange(null);
    expect(h.status.currentHerdrLifetime()).toBeUndefined();
    // the socket became another herdr's after that one answered: it is not the herdr that answered
    live.onChange("herdr-socket-a");
    socket = "herdr-socket-b";
    expect(h.status.currentHerdrLifetime()).toBeUndefined();
    // once the new herdr answers, it is named
    live.onChange("herdr-socket-b");
    expect(h.status.currentHerdrLifetime()).toBeString();
    expect(h.status.currentHerdrLifetime()).not.toBe(named);
  });
});

describe("a pane closed, not ended by itself", () => {
  it("turns away what a closed pane held (a launch's first message) and sends no 'terminal ended' alert", async () => {
    // Given: a pane whose first message waits for its agent
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    // When: it is closed (herdr's pane.close, hc's terminal.kill) before the message goes
    handlers.onPaneClosed(claude.pane_id);
    // Then: what it held is turned away as for an ended pane, and nobody is told it ended
    expect(h.held).toEqual([{ paneId: claude.pane_id, code: "pane_not_found" }]);
    expect(h.ended()).toEqual({ push: [], frames: 0 });
  });

  it("still alerts for a pane that ended by itself, with the same cleanup", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onPaneEnded(claude.pane_id);
    expect(h.held).toEqual([{ paneId: claude.pane_id, code: "pane_not_found" }]);
    expect(h.ended()).toEqual({ push: [claude.pane_id], frames: 1 });
  });
});

describe("the read of herdr's snapshot", () => {
  afterEach(() => notePaneFolders([]));
  it("tells the share rule the folders the panes are in: the pane's and its program's (windows-share.ts)", async () => {
    const h = hub();
    const asked = (share: string) => otherHostsShare(`${share}\\a.md`, []);
    expect([asked("\\\\nas\\work"), asked("\\\\nas\\tools")]).toEqual([true, true]);
    // the pane's own folder on one share, its program's on another
    h.herdrSays({ ...claude, cwd: "\\\\nas\\tools\\bin", foreground_cwd: "\\\\nas\\work\\proj" });
    await h.status.clientSnapshot();
    expect([asked("\\\\nas\\work"), asked("\\\\nas\\tools")]).toEqual([false, false]);
    // the pane moved on: both are another host's again at the next read
    h.herdrSays({ ...claude, cwd: "C:\\code", foreground_cwd: "C:\\code\\sub" });
    await h.status.clientSnapshot();
    expect([asked("\\\\nas\\work"), asked("\\\\nas\\tools")]).toEqual([true, true]);
  });

  it("keeps what the newest read told when an older one is answered after it", async () => {
    const h = hub();
    h.herdrSays({ ...claude, cwd: "C:\\code" });
    // a read begun before a workspace is made on a share, and answered after the read that saw it
    const answerOlder = await h.heldSnapshot();
    h.herdrSays({ ...claude, cwd: "\\\\nas\\work\\proj" });
    await h.status.clientSnapshot();
    expect(otherHostsShare("\\\\nas\\work\\proj\\a.md", [])).toBe(false);
    await answerOlder();
    expect(otherHostsShare("\\\\nas\\work\\proj\\a.md", [])).toBe(false);
  });
});
