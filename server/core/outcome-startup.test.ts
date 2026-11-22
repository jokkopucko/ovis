import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HerdrPane, PanePromptResponse } from "../../shared/protocol.ts";
import * as client from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as started from "../process-start.ts";
import * as omo from "../omo.ts";
import { handlePromptRequest } from "../prompt.ts";
import { commandTranscriptRecords } from "../outcome.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

it("keeps a startup send bound to the reported omp session and observes its later transcript", async () => {
  const home = mkdtempSync(join(tmpdir(), "outcome-startup-"));
  const extensions = join(home, ".omp", "agent", "extensions");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, "herdr-omp-agent-state.ts"), "// fixture\n");
  const at = 30_000;
  let now = at;
  const initial: HerdrPane = { pane_id: home, workspace_id: "w", tab_id: "t", terminal_id: "terminal",
    cwd: home, focused: false, revision: 0, agent: "omp", agent_status: "idle" };
  const reported: HerdrPane = { ...initial,
    agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: join(home, "session.jsonl") } };
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let current = initial;
  let transcript = "";
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(started, "processStartedAt").mockReturnValue(at);
  spyOn(omo, "processEnviron").mockReturnValue([`HOME=${home}`]);
  const get = spyOn(client, "paneGet").mockImplementation(async () => current);
  spyOn(client, "paneProcessInfo").mockResolvedValue({ pane_id: home, foreground_processes: [{ pid: 123, name: "omp", argv: ["omp"], cwd: home }] });
  spyOn(client, "sessionSnapshot").mockImplementation(async () => ({
    panes: [current], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  }));
  spyOn(client, "paneRead").mockImplementation(async () => ({
    ...current, text: "", source: "detection", format: "text", truncated: false,
  }));
  spyOn(conversation, "paneProcessRoots").mockResolvedValue({ omo: null, environ: null, pid: null, cwd: null });
  spyOn(conversation, "readCommandTranscript").mockImplementation(async () => ({
    identity: "fixture", records: commandTranscriptRecords(transcript),
  }));
  spyOn(Bun, "sleep").mockImplementation(() => { entered.resolve(); return resume.promise; });
  const deliver = spyOn(client, "agentPrompt").mockResolvedValue();
  const send = createSubmitText({
    options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
  });
  const finished = send(home, "/handoff", "/handoff", at).then(() => null, (error: unknown) => error);
  const poll = async () => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(home)}`);
    return await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
  };
  try {
    expect(await Promise.race([entered.promise.then(() => "waiting"), finished.then(() => "finished")])).toBe("waiting");
    expect(deliver).not.toHaveBeenCalled();
    current = reported;
    now += 100;
    resume.resolve();
    expect(await finished).toBeNull();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect((await poll()).outcomes).toMatchObject([{ state: "accepted", evidence: [] }]);
    const handoff = JSON.parse(readFileSync(new URL("../fixtures/omp-handoff-18.8.7-session.jsonl", import.meta.url), "utf8")
      .split("\n").find(line => line.includes('"type":"compaction"'))!);
    transcript = JSON.stringify({ ...handoff, timestamp: new Date(now + 1).toISOString() });
    now += 2;
    expect((await poll()).outcomes).toMatchObject([{ state: "result-observed", evidence: [{ kind: "transcript" }] }]);
  } finally {
    current = reported;
    resume.resolve();
    await finished;
    rmSync(home, { recursive: true, force: true });
  }
});
