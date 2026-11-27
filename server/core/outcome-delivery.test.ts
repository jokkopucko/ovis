import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as omo from "../omo.ts";
import * as commands from "../commands.ts";
import * as prompt from "../prompt.ts";
import * as processStart from "../process-start.ts";
import { createSubmitText } from "./composer.ts";
import { handlePromptRequest, prepareCommandSend } from "../prompt.ts";
import { commandOutcome } from "../outcome.ts";
import type { HerdrPane, PanePromptResponse } from "../../shared/protocol.ts";

afterEach(() => mock.restore());
beforeEach(() => {
  spyOn(client, "paneProcessInfo").mockResolvedValue(undefined);
});

const pane = { pane_id: "delivery-fixture", workspace_id: "w", tab_id: "t", terminal_id: "terminal",
  cwd: "/fixture", focused: false, revision: 0, agent: "pi", agent_status: "idle" };
const roots = { omo: null, environ: null, pid: null, cwd: null };
const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

for (const scenario of ["unpolled replacement", "wrapper restart", "first turn", "reused pid", "suspended", "settled", "no agent process"] as const) {
  it.skipIf((scenario === "reused pid" || scenario === "suspended") && process.platform !== "linux")(`binds a Codex command at send time: ${scenario}`, async () => {
    const target: HerdrPane = { ...pane, pane_id: `codex-outcome-${scenario}`, agent: "codex", agent_session: null };
    let pid = 2147483645;
    let birth = 1000;
    let foreground = true;
    spyOn(client, "paneGet").mockResolvedValue(target);
    const processes = spyOn(client, "paneProcessInfo").mockImplementation(async () => ({
      pane_id: target.pane_id, foreground_process_group_id: 100,
      // native Windows: herdr lists only the shell
      foreground_processes: scenario === "no agent process" ? [{ pid: 100, name: "pwsh", argv: ["pwsh.exe"] }] : [
        { pid: 100, name: "sh", argv: ["sh", "-c", "while :; do codex; sleep 1; done"] },
        { pid: 101, name: "node", argv: ["node", "/fixture/codex/bin/codex.js"] },
        ...foreground ? [{ pid, name: "codex", argv: ["/fixture/native/codex"] }] : [],
      ],
    }));
    spyOn(processStart, "processStartedAt").mockImplementation((candidate) => candidate === pid ? birth : 500);
    const delivered = spyOn(client, "agentPrompt").mockResolvedValue();
    spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
    spyOn(client, "sessionSnapshot").mockResolvedValue({
      panes: [target], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
    });
    spyOn(client, "paneRead").mockResolvedValue({
      ...target, text: "fixture-codex-screen", source: "detection", format: "text", truncated: false,
    });
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${target.pane_id}`);
    const poll = async () => (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).outcomes;
    await submitter()(target.pane_id, "/myext", "/myext", Date.now());
    expect(delivered).toHaveBeenCalledTimes(1);
    const readsAtSend = processes.mock.calls.length;
    if (scenario !== "unpolled replacement") expect(await poll()).toMatchObject([{ state: "accepted" }]);
    if (scenario === "suspended") {
      foreground = false;
      expect(await poll()).toMatchObject([{ state: "accepted" }]);
      foreground = true;
    }
    if (scenario === "unpolled replacement" || scenario === "wrapper restart") pid++;
    if (scenario === "reused pid") birth++;
    target.agent_session = { agent: "codex", kind: "id", source: "herdr:codex", value: "first-turn" };
    const shown = await poll();
    const kept = scenario === "first turn" || scenario === "suspended" || scenario === "settled" || scenario === "no agent process";
    if (kept) expect(shown).toMatchObject([{ text: "/myext", state: "accepted", evidence: [] }]);
    else expect(shown).toBeUndefined();
    expect(readsAtSend).toBe(1);
    if (scenario === "settled") {
      const reads = processes.mock.calls.length;
      const later = Date.now() + 600_000;
      spyOn(Date, "now").mockImplementation(() => later);
      await poll();
      await poll();
      expect(processes.mock.calls.length).toBe(reads);
    }
  });
}

it("does not preview an unchanged pi screen after immediate delivery without a screen baseline", async () => {
  const target = { ...pane, pane_id: "delivery-preview-fixture" };
  let now = 20_000;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(client, "paneGet").mockResolvedValue(target);
  const delivered = spyOn(client, "agentPrompt").mockResolvedValue();
  spyOn(conversation, "paneProcessRoots").mockResolvedValue(roots);
  spyOn(conversation, "paneTranscript").mockRejectedValue(new Error("fixture: no native binding"));
  spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
  spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [target], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({
    ...target, text: "fixture-unchanged-output", source: "detection", format: "text", truncated: false,
  });
  await submitter()(target.pane_id, "/myext", "/myext", now);
  expect(delivered).toHaveBeenCalledTimes(1);
  const sentAt = delivered.mock.invocationCallOrder[0]!;
  expect(screen.mock.invocationCallOrder.filter((order) => order > sentAt)).toEqual([]);
  now++;
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${target.pane_id}`);
  const shown = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
  expect(shown.outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
  expect(shown.outcomes?.at(-1)?.preview ?? null).toBeNull();
});

it("keeps the changed-screen preview when a send-time baseline exists", () => {
  const sent = prepareCommandSend(pane, "/myext", "fixture-before");
  if (!sent) throw new Error("fixture command was not recorded");
  expect(commandOutcome(pane.pane_id, sent, { now: sent.at + 1, screen: "fixture-after" }))
    .toMatchObject({ state: "accepted", evidence: [], preview: "fixture-after" });
});

it("keeps repeated omp model outcomes under the original command rather than its switch alias", async () => {
  const target = { ...pane, pane_id: "omp-model-alias", agent: "omp",
    agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: "/fixture/session.jsonl" } };
  let now = 50_000;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(client, "paneGet").mockResolvedValue(target);
  spyOn(client, "paneRead").mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof client.paneRead>>);
  const deliver = spyOn(client, "agentPrompt").mockResolvedValue();
  const prepare = spyOn(prompt, "prepareCommandSend");
  await submitter()(target.pane_id, "/model", "/model", now);
  now++;
  await submitter()(target.pane_id, "/model", "/model", now);
  expect(deliver).toHaveBeenNthCalledWith(1, target.pane_id, "/switch", undefined, expect.any(Function));
  expect(deliver).toHaveBeenNthCalledWith(2, target.pane_id, "/switch", undefined, expect.any(Function));
  const first = prepare.mock.results[0]?.value as ReturnType<typeof prepareCommandSend>;
  expect(first?.text).toBe("/model");
  expect(first?.transcriptClosedAt).toBeUndefined();
});

it("does not rewrite /model when the resolved pane agent is OmO", async () => {
  const target = { ...pane, pane_id: "omo-labelled-omp", agent: "omp" };
  const dir = mkdtempSync(join(tmpdir(), "omo-command-roots-"));
  const agentDir = join(dir, ".omo", "agent");
  mkdirSync(agentDir, { recursive: true });
  spyOn(client, "paneGet").mockResolvedValue(target);
  spyOn(client, "paneProcessInfo").mockResolvedValue({ pane_id: target.pane_id, foreground_processes: [{ pid: process.pid, name: "omo", argv: ["omo"], cwd: dir }] });
  spyOn(omo, "omoProcessIdentity").mockReturnValue({ agentDir, heldIds: ["session-1"], custom: true, held: true });
  spyOn(client, "paneRead").mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof client.paneRead>>);
  const deliver = spyOn(client, "agentPrompt").mockResolvedValue();
  try {
    await submitter()(target.pane_id, "/model", "/model", Date.now());
    expect(deliver).toHaveBeenCalledWith(target.pane_id, "/model", undefined, expect.any(Function));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const dependency of ["process-info", "transcript", "catalog", "snapshot"] as const) {
  for (const failure of ["slow", "failing"] as const) {
    it(`delivers before ${failure} ${dependency} outcome discovery can affect its deadline`, async () => {
      let now = 10_000;
      spyOn(Date, "now").mockImplementation(() => now);
      spyOn(client, "paneGet").mockResolvedValue(pane);
      const delivered = spyOn(client, "agentPrompt").mockResolvedValue();
      const processInfo = spyOn(conversation, "paneProcessRoots").mockResolvedValue(roots);
      spyOn(conversation, "paneTranscript").mockRejectedValue(new Error("fixture: no native binding"));
      const transcript = spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
      const catalog = spyOn(commands, "paneCommands").mockReturnValue([]);
      const screen = { ...pane, text: "", source: "detection" as const, format: "text" as const, truncated: false };
      const snapshot = spyOn(client, "paneRead").mockResolvedValue(screen);
      const disrupt = () => {
        if (failure === "failing") throw new Error(`fixture: ${dependency} failed`);
        now += 2000;
      };
      if (dependency === "process-info") processInfo.mockImplementation(async () => { disrupt(); return roots; });
      if (dependency === "transcript") transcript.mockImplementation(async () => { disrupt(); return null; });
      if (dependency === "catalog") catalog.mockImplementation(() => { disrupt(); return []; });
      if (dependency === "snapshot") snapshot.mockImplementation(async () => {
        if (delivered.mock.calls.length > 0) disrupt(); return screen;
      });
      const result = await submitter()(pane.pane_id, "/myext", "/myext", now).then(() => "delivered", (error: unknown) => error);
      expect(result).toBe("delivered");
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(now).toBe(10_000);
      const sent = prepareCommandSend(pane, "/myext");
      if (!sent) throw new Error("fixture command was not recorded");
      expect(commandOutcome(pane.pane_id, sent, { now: sent.at + 600_000 })).toMatchObject({ state: "unknown", evidence: [] });
    });
  }
}

for (const dependency of ["send-time process", "scroll"] as const) {
  for (const failure of ["slow", "failing", "never answering"] as const) {
    it(`delivers before a ${failure} ${dependency} read for its outcome can affect its deadline`, async () => {
      let now = 10_000;
      spyOn(Date, "now").mockImplementation(() => now);
      const target: HerdrPane = dependency === "scroll"
        ? { ...pane, pane_id: `delivery-scroll-${failure}`, agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "known" },
          scroll: { max_offset_from_bottom: 7, offset_from_bottom: 0, viewport_rows: 40 } }
        : { ...pane, pane_id: `delivery-send-process-${failure}`, agent_session: null };
      spyOn(client, "paneGet").mockResolvedValue(target);
      spyOn(conversation, "paneProcessRoots").mockResolvedValue(roots);
      spyOn(conversation, "paneTranscript").mockRejectedValue(new Error("fixture: no native binding"));
      spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
      spyOn(client, "sessionSnapshot").mockResolvedValue({
        panes: [target], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
      });
      spyOn(client, "paneRead").mockResolvedValue({ ...target, text: "", source: "detection", format: "text", truncated: false });
      const delivered = spyOn(client, "agentPrompt").mockResolvedValue();
      const noted = spyOn(prompt, "noteSubmitted");
      let answer = (): void => {};
      let reads = 0;
      let sendRead: Promise<unknown> = Promise.resolve();
      const read = <T>(value: T): Promise<T> => {
        if (reads++ > 0) return Promise.resolve(value);
        const disrupted = failure === "failing" ? Promise.reject(new Error(`fixture: ${dependency} failed`))
          : new Promise<T>((resolve) => { if (failure === "slow") answer = () => { now += 2000; resolve(value); }; });
        sendRead = disrupted;
        return disrupted;
      };
      const asked = dependency === "scroll"
        ? spyOn(client, "paneScrollInfo").mockImplementation(() => read(target.scroll ?? null))
        : spyOn(client, "paneProcessInfo").mockImplementation(() => read({ pane_id: target.pane_id,
          foreground_processes: [{ pid: 2147483640, name: "pi", argv: ["pi"] }] }));
      await submitter()(target.pane_id, "/myext", "/myext", now);
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(now).toBe(10_000);
      const sent = noted.mock.calls[0]?.[2];
      if (!sent) throw new Error("fixture command was not recorded");
      answer();
      if (failure !== "never answering") await sendRead.catch(() => {});
      if (dependency === "scroll") expect(sent.top).toBe(failure === "slow" ? 7 : undefined);
      const url = new URL(`http://localhost/api/pane/prompt?pane_id=${target.pane_id}`);
      const shown = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
      expect(shown.outcomes).toMatchObject([{ text: "/myext", state: "accepted" }]);
    });
  }
}

it("records a send's history row as the live screen's while another device has the terminal scrolled up", async () => {
  // herdr's detection read is the live screen: its first row is max_offset_from_bottom, whatever a device scrolled
  const target: HerdrPane = { ...pane, pane_id: "delivery-scrolled-device", agent: "claude",
    agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "known" },
    scroll: { max_offset_from_bottom: 7, offset_from_bottom: 3, viewport_rows: 40 } };
  spyOn(client, "paneGet").mockResolvedValue(target);
  spyOn(conversation, "paneProcessRoots").mockResolvedValue(roots);
  spyOn(conversation, "paneTranscript").mockRejectedValue(new Error("fixture: no native binding"));
  spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
  spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [target], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  spyOn(client, "paneRead").mockResolvedValue({ ...target, text: "", source: "detection", format: "text", truncated: false });
  spyOn(client, "agentPrompt").mockResolvedValue();
  const scrollRead = Promise.resolve(target.scroll ?? null);
  spyOn(client, "paneScrollInfo").mockImplementation(() => scrollRead);
  const noted = spyOn(prompt, "noteSubmitted");
  await submitter()(target.pane_id, "/myext", "/myext", Date.now());
  await scrollRead;
  expect(noted.mock.calls[0]?.[2]?.top).toBe(7);
});

it("delivers a terminal input-line command without requiring paneGet", async () => {
  const paneGet = spyOn(client, "paneGet").mockRejectedValue(new client.HerdrError("fixture_unavailable", "pane lookup failed"));
  const text = spyOn(client, "paneSendText").mockResolvedValue();
  const keys = spyOn(client, "paneSendKeys").mockResolvedValue();
  await submitter()(pane.pane_id, "/context", "/context", Date.now(), true);
  expect(text).toHaveBeenCalledWith(pane.pane_id, "/context", undefined, expect.any(Function));
  expect(keys).toHaveBeenCalledWith(pane.pane_id, ["Enter"], undefined, expect.any(Function));
  expect(paneGet).not.toHaveBeenCalled();
});

it("uses an already discovered inline skill only for the same pane identity", () => {
  commands.rememberPaneCommands(pane, "omo", [{ name: "review", description: "", source: "skill", trigger: "$",
    forms: [{ match: "bare", interaction: "unknown" }] }]);
  expect(prepareCommandSend(pane, "Please use $review")?.invocations).toHaveLength(1);
  expect(prepareCommandSend({ ...pane, terminal_id: "replacement" }, "Please use $review")).toBeUndefined();
  expect(prepareCommandSend({ ...pane, cwd: "/different" }, "Please use $review")).toBeUndefined();
});
