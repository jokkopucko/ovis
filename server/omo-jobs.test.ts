import { describe, expect, it } from "bun:test";
import { NO_JOBS, omoJobCount, omoJobsAfter, omoJobTasks, type OmoJobs } from "./omo-jobs.ts";

// Records as OmO 5.1 writes them in a session file (shapes copied from real sessions).
const evalResult = (at: string, text: string, toolCalls: unknown[] = [], summary = "run the refit") => ({
  type: "message", timestamp: at,
  message: { role: "toolResult", toolName: "eval", content: [{ type: "text", text }], details: { language: "js", summary, toolCalls } },
});
const notice = (customType: string, at: string, content: string, details?: unknown) => ({ type: "custom_message", customType, timestamp: at, content, display: false, ...(details ? { details } : {}) });
const read = (...entries: unknown[]): OmoJobs => entries.reduce<OmoJobs>((jobs, entry) => omoJobsAfter(jobs, entry), NO_JOBS);

const bashCall = {
  name: "bash", ok: true, args: { command: "python refit.py > refit.log 2>&1; echo EXIT $?", run_in_background: true },
  resultPreview: "Command running in background with ID: bash_1 (native PTY unavailable — running via pipe fallback; bash_input/bash_resize are limited.)",
};
const monitorCall = {
  name: "monitor", ok: true, args: { description: "refit done", command: "until test -f done; do sleep 1; done; printf 'READY\\n'", filter: "^READY$" },
  resultPreview: "Monitor started with ID: mon_FDXZMFR0QJTTRAD3",
};
const directMonitor = (id: string, description: string, monitorId: string, persistent = false) => [
  { type: "message", timestamp: "2026-10-21T20:03:37.000Z", message: { role: "assistant", content: [{ type: "toolCall", id, name: "monitor", arguments: { description, command: "printf READY", persistent } }] } },
  { type: "message", timestamp: "2026-10-21T20:03:38.401Z", message: { role: "toolResult", toolCallId: id, toolName: "monitor", content: [{ type: "text", text: `Monitor started with ID: ${monitorId}` }] } },
];

describe("omoJobsAfter", () => {
  it("ends a direct monitor on its summary using its matching assistant call", () => {
    // Given a direct call whose result contains no arguments.
    const jobs = read(...directMonitor("call-1", "direct done", "mon_DIRECT", true));
    expect(jobs.running[0]).toMatchObject({ title: "direct done", description: "direct done", persistent: true });
    // When its summary carries a process id.
    const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
      monitors: [{ id: "bash_2", description: "direct done", kinds: ["summary"] }],
    }));
    // Then the monitor ends.
    expect(done.running).toEqual([]);
    expect(done.ended.map((job) => [job.id, job.ended?.status])).toEqual([["mon_DIRECT", "completed"]]);
  });

  it("ends the right direct monitor when calls and results are interleaved", () => {
    // Given two assistant calls followed by their results in reverse order.
    const first = directMonitor("call-1", "first done", "mon_FIRST");
    const second = directMonitor("call-2", "second done", "mon_SECOND");
    const jobs = read(first[0], second[0], second[1], first[1]);
    expect(omoJobCount(jobs, null)).toBe(2);
    // When only the second monitor finishes.
    const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
      monitors: [{ id: "bash_2", description: "second done", kinds: ["summary"] }],
    }));
    // Then toolCallId, not result order, selects its description.
    expect(done.running.map((job) => [job.id, job.description])).toEqual([["mon_FIRST", "first done"]]);
    expect(done.ended.map((job) => job.id)).toEqual(["mon_SECOND"]);
    expect(omoJobCount(done, null)).toBe(1);
  });

  for (const count of [1, 2]) {
    it(`falls back to an undescribed direct monitor only when unique (${count} live)`, () => {
      // Given starts whose assistant calls are missing from the transcript.
      const jobs = read(directMonitor("call-1", "first done", "mon_FIRST")[1],
        ...count === 2 ? [directMonitor("call-2", "second done", "mon_SECOND")[1]] : []);
      // When a summary has only a process id and description.
      const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
        monitors: [{ id: "bash_2", description: "first done", kinds: ["summary"] }],
      }));
      // Then ambiguous missing calls never end either monitor.
      expect(done.running.length).toBe(count === 1 ? 0 : 2);
      expect(done.ended.map((job) => job.id)).toEqual(count === 1 ? ["mon_FIRST"] : []);
    });
  }

  it("starts a background command and a monitor launched inside eval, titled by command and description", () => {
    // Given an eval answer that started both.
    const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "[\"Command running in background with ID: bash_1\",\"Monitor started with ID: mon_FDXZMFR0QJTTRAD3\"]", [bashCall, monitorCall]));
    // Then both run, the command titled by its command line and the monitor by its description.
    expect(jobs.running.map((job) => [job.id, job.kind, job.title])).toEqual([
      ["bash_1", "command", "python refit.py > refit.log 2>&1; echo EXIT $?"],
      ["mon_FDXZMFR0QJTTRAD3", "monitor", "refit done"],
    ]);
    expect(omoJobCount(jobs, null)).toBe(2);
  });

  it("ends a command with its terminal notification and a monitor with its summary event", () => {
    // Given both running; when the monitor reports a line, then its summary, and the command finishes.
    const jobs = read(
      evalResult("2026-10-21T20:03:38.401Z", "", [bashCall, monitorCall]),
      notice("senpi-monitor:notification", "2026-10-21T20:04:00.000Z", "<system-reminder>Monitor event(refit done): READY</system-reminder>", { monitors: [{ id: "bash_2", description: "refit done", eventCount: 1, kinds: ["line"] }] }),
      notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "<system-reminder>Monitor event(refit done): watcher completed (exit code 0)</system-reminder>", { monitors: [{ id: "bash_2", description: "refit done", eventCount: 1, kinds: ["summary"] }] }),
      notice("senpi-terminal:notification", "2026-10-21T20:05:36.684Z", "<system-reminder>Background terminal session bash_1 finished: completed (exit code 0).\nFinal output:\nEXIT 0</system-reminder>"),
    );
    // Then neither runs, and both are listed as done.
    expect(jobs.running).toEqual([]);
    expect(jobs.ended.map((job) => [job.id, job.ended?.status])).toEqual([["mon_FDXZMFR0QJTTRAD3", "completed"], ["bash_1", "completed"]]);
  });

  it("keeps a monitor running while only line events arrive", () => {
    const jobs = read(
      evalResult("2026-10-21T20:03:38.401Z", "", [monitorCall]),
      notice("senpi-monitor:notification", "2026-10-21T20:04:00.000Z", "<system-reminder>Monitor event(refit done): epoch 3</system-reminder>", { monitors: [{ id: "bash_2", description: "refit done", eventCount: 1, kinds: ["line"] }] }),
    );
    expect(jobs.running.map((job) => job.id)).toEqual(["mon_FDXZMFR0QJTTRAD3"]);
  });

  it("ends only the identified monitor when descriptions are shared", () => {
    // Given two live monitors with the same description.
    const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "", [
      monitorCall, { ...monitorCall, resultPreview: "Monitor started with ID: mon_SECOND" },
    ]));
    expect(omoJobCount(jobs, null)).toBe(2);
    // When the second monitor ends.
    const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
      monitors: [{ id: "mon_SECOND", description: "refit done", kinds: ["summary"] }],
    }));
    // Then only the second ends and the count drops by one.
    expect(done.running.map((job) => job.id)).toEqual(["mon_FDXZMFR0QJTTRAD3"]);
    expect(done.ended.map((job) => job.id)).toEqual(["mon_SECOND"]);
    expect(omoJobCount(done, null)).toBe(1);
  });

  for (const count of [1, 2]) {
    it(`ends a monitor without an id only when its description is unique (${count} live)`, () => {
      // Given one or two live monitors sharing a description.
      const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "", [
        monitorCall, ...count === 2 ? [{ ...monitorCall, resultPreview: "Monitor started with ID: mon_SECOND" }] : [],
      ]));
      // When a legacy notification has no id.
      const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
        monitors: [{ description: "refit done", kinds: ["summary"] }],
      }));
      // Then an ambiguous description ends neither monitor.
      expect(omoJobCount(done, null)).toBe(count === 1 ? 0 : 2);
      expect(done.ended.map((job) => job.id)).toEqual(count === 1 ? ["mon_FDXZMFR0QJTTRAD3"] : []);
    });
  }

  it("ends a monitor by its unique description when the notification carries its process id", () => {
    // Given a live monitor.
    const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "", [monitorCall]));
    // When the runtime reports the process id rather than the monitor id.
    const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
      monitors: [{ id: "bash_2", description: "refit done", kinds: ["summary"] }],
    }));
    // Then the uniquely described monitor ends and is no longer counted.
    expect(done.running).toEqual([]);
    expect(done.ended.map((job) => [job.id, job.ended?.status])).toEqual([["mon_FDXZMFR0QJTTRAD3", "completed"]]);
    expect(omoJobCount(done, null)).toBe(0);
  });

  it("ends neither monitor when a process id cannot distinguish shared descriptions", () => {
    // Given two live monitors with the same description.
    const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "", [
      monitorCall, { ...monitorCall, resultPreview: "Monitor started with ID: mon_SECOND" },
    ]));
    // When the runtime reports a process id that matches neither monitor id.
    const done = omoJobsAfter(jobs, notice("senpi-monitor:notification", "2026-10-21T20:04:01.000Z", "watcher completed", {
      monitors: [{ id: "bash_2", description: "refit done", kinds: ["summary"] }],
    }));
    // Then neither monitor ends and both remain counted.
    expect(done).toEqual(jobs);
    expect(omoJobCount(done, null)).toBe(2);
  });

  for (const [word, status] of [["signal_SIGTERM", "cancelled"], ["killed", "cancelled"], ["exited_1 (exit code 1)", "failed"]] as const) {
    it(`reads a command that finished ${word} as ${status}`, () => {
      const jobs = read(
        evalResult("2026-10-21T20:03:38.401Z", "", [bashCall]),
        notice("senpi-terminal:notification", "2026-10-21T20:05:36.684Z", `<system-reminder>Background terminal session bash_1 finished: ${word}.</system-reminder>`),
      );
      expect(jobs.ended.map((job) => job.ended?.status)).toEqual([status]);
    });
  }

  it("ends a command that kill_bash stopped", () => {
    const jobs = read(
      { type: "message", timestamp: "2026-10-22T05:00:00.000Z", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "Command running in background with ID: bash_5" }] } },
      { type: "message", timestamp: "2026-10-22T05:10:33.893Z", message: { role: "toolResult", toolName: "kill_bash", content: [{ type: "text", text: "Killed bash_5." }] } },
    );
    expect(jobs.running).toEqual([]);
    expect(jobs.ended.map((job) => [job.id, job.ended?.status])).toEqual([["bash_5", "cancelled"]]);
  });

  it("starts a command a finished cell left auto-detached", () => {
    const jobs = read(notice("senpi-codemode:notification", "2026-10-22T06:00:00.000Z",
      "<system-reminder>Detached eval cell toolu_x (js) completed.\n\"Command is still running; auto-detached to background with ID: bash_9 (not killed; the original 1800s timeout still applies).\"</system-reminder>"));
    expect(jobs.running.map((job) => [job.id, job.kind])).toEqual([["bash_9", "command"]]);
  });

  it("lists a detached cell by its summary without counting it again", () => {
    // Given a cell that detached (omo-detached.ts counts it).
    const jobs = read(evalResult("2026-10-30T12:22:44.000Z", "Eval cell toolu_cell detached and is running in the js kernel (0 other live cells).", [], "build the GT"));
    expect(jobs.running.map((job) => [job.id, job.kind, job.title])).toEqual([["toolu_cell", "cell", "build the GT"]]);
    expect(omoJobCount(jobs, null)).toBe(0);
    // When its notice arrives, it ends.
    const done = omoJobsAfter(jobs, notice("senpi-codemode:notification", "2026-10-30T12:22:54.000Z", "<system-reminder>Detached eval cell toolu_cell (js) completed.\n(no output)</system-reminder>"));
    expect(done.ended.map((job) => [job.id, job.ended?.status])).toEqual([["toolu_cell", "completed"]]);
  });

  it("ignores the same words quoted by the user or the assistant", () => {
    const jobs = read(
      { type: "message", timestamp: "2026-10-22T05:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Command running in background with ID: bash_7" }] } },
      { type: "message", timestamp: "2026-10-22T05:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "Monitor started with ID: mon_FAKE" }] } },
    );
    expect(jobs).toEqual(NO_JOBS);
  });
});

describe("omoJobTasks and omoJobCount", () => {
  it("lists work from before the current OmO process as lost and does not count it", () => {
    // Given a command started before the process holding the session.
    const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "", [bashCall]));
    const since = Date.parse("2026-10-21T21:00:00.000Z");
    // Then it is lost in the list and not counted.
    expect(omoJobTasks(jobs, since).map((task) => [task.id, task.status, task.category])).toEqual([["bash_1", "lost", "bash"]]);
    expect(omoJobCount(jobs, since)).toBe(0);
  });

  it("does not count a persistent monitor", () => {
    const jobs = read(evalResult("2026-10-21T20:03:38.401Z", "", [{ ...monitorCall, args: { ...monitorCall.args, persistent: true } }]));
    expect(omoJobCount(jobs, null)).toBe(0);
    expect(omoJobTasks(jobs, null).map((task) => task.status)).toEqual(["running"]);
  });
});
