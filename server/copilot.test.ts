import { expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotImage, parseCopilotTranscript } from "./copilot.ts";
import * as copilotStore from "./copilot-store.ts";
import { copilotProcessSession, copilotTranscriptFile as selectedTranscriptFile, copilotUnwrittenSession as selectedUnwrittenSession, heldSessions } from "./copilot-store.ts";
import { ConversationUnavailable, forgetTranscriptState, HistoryChanged, paneConversation, toolOutput, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";
import * as herdr from "./herdr/client.ts";
import * as omo from "./omo.ts";
import * as processStart from "./process-start.ts";
import * as processOwner from "./process-owner.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

const session = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const other = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
const line = (type: string, data: object, agentId?: string) =>
  JSON.stringify({ type, data, id: crypto.randomUUID(), timestamp: "2026-10-21T00:00:00Z", parentId: null, ...(agentId ? { agentId } : {}) }) + "\n";
const start = line("session.start", { sessionId: session, copilotVersion: "1.0.102-1" });
const prompt = (text: string) => line("user.message", { content: text, transformedContent: "model-only text", turnId: crypto.randomUUID() });
const answer = (text: string, phase = "final_answer") => line("assistant.message", { content: text, phase, model: "fixture-model", turnId: crypto.randomUUID() });
const copilotTranscriptFile = (session: unknown, ...args: Parameters<typeof copilotProcessSession>) =>
  selectedTranscriptFile(session, copilotProcessSession(...args));
const copilotUnwrittenSession = (...args: Parameters<typeof copilotProcessSession>) =>
  selectedUnwrittenSession(copilotProcessSession(...args), args[1]);
const register = (id: string, action = "Registering") => `2026-10-24T00:00:00.000Z [INFO] ${action} foreground session: ${id}\n`;

async function logFixture(held: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "copilot-log-"));
  for (const id of [session, other]) mkdirSync(join(root, "session-state", id), { recursive: true });
  mkdirSync(join(root, "logs"));
  const child = Bun.spawn(["node", "-e", `
    const {openSync, closeSync} = require("node:fs");
    const root = process.argv[1];
    const log = root + "/logs/process-100-" + process.pid + ".log";
    for (const id of process.argv.slice(2)) openSync(root + "/session-state/" + id + "/inuse." + process.pid + ".hold", "w");
    let fd = openSync(log, "w");
    console.log("ready");
    require("node:readline").createInterface({input: process.stdin}).on("line", (command) => {
      if (command === "close") closeSync(fd);
      else if (command === "open") fd = openSync(log, "a");
      else if (command === "extra") openSync(root + "/logs/process-200-" + process.pid + ".log", "w");
      else throw new Error("unexpected fixture command: " + command);
      console.log("ok");
    });
  `, root, ...held], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  const close = async () => {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
  } catch (error) { await close(); throw error; }
  const environment = [`COPILOT_HOME=${root}`];
  return {
    root, environment, pid: child.pid, log: join(root, "logs", `process-100-${child.pid}.log`), close,
    binding: () => {
      const selected = copilotProcessSession(environment, ["copilot"], child.pid);
      return selected?.logged ? selected : null;
    },
    command: async (value: string) => {
      child.stdin.write(`${value}\n`);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ok");
    },
  };
}

for (const revoked of [false, true]) {
  it.skipIf(process.platform !== "linux")(`keeps ${revoked ? "denied" : "registered"} Copilot ownership when epoch start time changes`, async () => {
    const fixture = await logFixture([session]);
    const { environment, log, pid, binding } = fixture;
    const realStarted = processStart.processStartedAt;
    const started = realStarted(pid)!;
    let correction = 0;
    const epoch = spyOn(processStart, "processStartedAt").mockImplementation((current) =>
      current === pid ? started + correction : realStarted(current));
    try {
      appendFileSync(log, register(session));
      const original = binding();
      expect(original?.sessionId).toBe(session);
      if (revoked) {
        appendFileSync(log, register(session, "Unregistering"));
        expect(binding()).toBeNull();
        writeFileSync(log, "ordinary replacement without lifecycle evidence\n");
        expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
      }
      for (correction of [-2000, 3000, -1000]) {
        if (revoked) expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
        else expect(binding()?.generation).toBe(original?.generation);
      }
    } finally { epoch.mockRestore(); await fixture.close(); }
  });
}

it.skipIf(process.platform !== "linux")("retains denial on unknown birth but recognizes a genuinely replaced Copilot process", async () => {
  const fixture = await logFixture([session]);
  const { environment, log, pid } = fixture;
  const realBirth = processOwner.readProcessBirth;
  const original = realBirth(pid);
  let birth = original;
  const reading = spyOn(processOwner, "readProcessBirth").mockImplementation((current) =>
    current === pid ? birth : realBirth(current));
  const read = () => copilotProcessSession(environment, ["copilot"], pid);
  try {
    expect(original.state).toBe("identified");
    if (original.state !== "identified") throw new Error("Fixture process birth unavailable");
    appendFileSync(log, "CLI started\n");
    expect(read()?.sessionId).toBe(session);
    appendFileSync(log, register(session, "Unregistering"));
    expect(read()).toBeNull();
    writeFileSync(log, "replacement CLI started\n");
    expect(read()).toBeNull();
    birth = { state: "unknown" };
    expect(read()).toBeNull();
    birth = original;
    expect(read()).toBeNull();
    birth = { state: "identified", birth: { platform: "linux", value: original.birth.value + "0" } };
    expect(read()?.sessionId).toBe(session);
  } finally { reading.mockRestore(); await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("never reuses cached handoff unregister evidence when the process identity lookup fails", async () => {
  const fixture = await logFixture([session]);
  const { environment, log, pid } = fixture;
  const read = () => copilotProcessSession(environment, ["copilot"], pid, "unregistered");
  const realBirth = processOwner.readProcessBirth;
  try {
    appendFileSync(log, register(session) + register(session, "Unregistering"));
    expect(read()?.sessionId).toBe(session);
    writeFileSync(log, register(other));
    const missing = spyOn(processOwner, "readProcessBirth").mockImplementation((current) => current === pid ? { state: "unknown" } : realBirth(current));
    try { expect(read()).toBeNull(); } finally { missing.mockRestore(); }
    expect(read()).toBeNull();
    expect(copilotProcessSession(environment, ["copilot"], pid)?.sessionId).toBe(other);
  } finally { await fixture.close(); }
});

for (const observed of [false, true]) {
  it.skipIf(process.platform !== "linux")(`records legacy unregister proof from ${observed ? "continuous" : "initial"} log evidence without authorizing parent history`, async () => {
    const fixture = await logFixture([session]);
    const { environment, log, pid } = fixture;
    const ended = () => copilotProcessSession(environment, ["copilot"], pid, "unregistered");
    try {
      appendFileSync(log, "CLI started\n");
      if (observed) expect(copilotProcessSession(environment, ["copilot"], pid)?.logged).toBe(false);
      appendFileSync(log, register(session, "Unregistering").trimEnd());
      expect(ended()).toBeNull();
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
      appendFileSync(log, "\n");
      const released = ended();
      expect(released).toMatchObject({ sessionId: session, logged: true });
      if (!released?.logged) throw new Error("Fixture unregister proof missing");
      expect(ended()).toEqual(released);
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
      appendFileSync(log, register(session, "Unregistering"));
      expect(ended()).toBeNull();
      appendFileSync(log, register(other));
      expect(ended()).toBeNull();
      expect(copilotProcessSession(environment, ["copilot"], pid)?.sessionId).toBe(other);
      appendFileSync(log, register(session, "Unregistering"));
      expect(ended()).toBeNull();
    } finally { await fixture.close(); }
  });
}

for (const loss of ["rewrite", "descriptor gap"] as const) {
  it.skipIf(process.platform !== "linux")(`does not bootstrap legacy unregister proof after a log ${loss}`, async () => {
    const fixture = await logFixture([session]);
    const { environment, log, pid } = fixture;
    try {
      appendFileSync(log, "CLI started with an ordinary complete log\n");
      expect(copilotProcessSession(environment, ["copilot"], pid)?.logged).toBe(false);
      if (loss === "rewrite") writeFileSync(log, "replacement\n");
      else await fixture.command("close");
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
      if (loss === "descriptor gap") await fixture.command("open");
      appendFileSync(log, register(session, "Unregistering"));
      expect(copilotProcessSession(environment, ["copilot"], pid, "unregistered")).toBeNull();
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
    } finally { await fixture.close(); }
  });
}

it("parses persisted Copilot messages and tool rounds once, with failures and recorded metadata", () => {
  const text = start + prompt("Visible prompt")
    + line("assistant.message", { content: "Checking.", phase: "commentary", toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: { command: "pwd" }, toolTitle: "Check directory" }], model: "fixture-model" })
    + line("tool.execution_start", { toolCallId: "call-1", toolName: "shell" })
    + line("tool.execution_complete", { toolCallId: "call-1", success: false, result: { content: "failure ".repeat(900) } })
    + answer("Finished.") + line("system.message", { content: "not a prompt" })
    + line("session.compaction_complete", { success: true, summaryContent: "internal summary" })
    + line("assistant.message", { content: "another agent", model: "leaked-model" }, "child-agent")
    + line("user.message", { content: "child prompt" }, "child-agent")
    + line("user.message", { content: "nested prompt", parentAgentTaskId: "task-1", agentId: "child-agent" })
    + line("assistant.message", { content: "nested answer", agentId: "child-agent", model: "nested-model" })
    + '{"type":"user.message","data":';
  const turns = parseCopilotTranscript(text);
  expect(turns.map(({ role }) => role)).toEqual(["user", "assistant"]);
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Visible prompt" }]);
  expect(turns[1]?.parts[0]).toEqual({ kind: "text", text: "Checking.", phase: "commentary" });
  expect(turns[1]?.parts[1]).toMatchObject({ kind: "tool", name: "shell", summary: "Check directory", error: true, output_ref: "call-1" });
  expect(turns[1]?.parts[2]).toEqual({ kind: "text", text: "Finished.", phase: "final_answer" });
  expect(parseConversationMetadata(text, "copilot-transcript")).toEqual({ model: "fixture-model", reasoning_effort: null });
});

it("reads a redacted recorded CLI session with root task ancestry and a tool-only assistant message", () => {
  const recorded = readFileSync(new URL("./fixtures/copilot-recorded.jsonl", import.meta.url), "utf8");
  const turns = parseCopilotTranscript(recorded);
  expect(turns.map(({ role }) => role)).toEqual(["user", "assistant"]);
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Recorded fixture text." }]);
  expect(turns[1]?.parts).toEqual([
    { kind: "tool", name: "shell", summary: "redacted", input: "{}", output: "Recorded fixture text." },
    { kind: "text", text: "Recorded fixture text.", phase: "commentary" },
  ]);
  expect(parseConversationMetadata(recorded, "copilot-transcript").model).toBe("fixture-model");
});

it("names the pictures a recorded 1.0.105 session interned, attached and tool-read, and reads each back by its digest", async () => {
  const recorded = readFileSync(new URL("./fixtures/copilot-pictures-1.0.105-events.jsonl", import.meta.url), "utf8");
  const red = "copilot:db47bba5fe6470a832370fa0ca3cbfd9194dd1e36eaa3d67fdd33bea01d4b66a";
  const blue = "copilot:c75fe07b33afb7b182fa53cd500727a7cfa1699443a17d87d053d6536ad65438";
  const turns = parseCopilotTranscript(recorded);
  expect(turns.map(({ role }) => role)).toEqual(["user", "assistant"]);
  expect(turns[0]?.parts.slice(1)).toEqual([{ kind: "image", media_type: "image/png", ref: red }]);
  expect(turns[1]?.parts[0]).toMatchObject({ kind: "tool", name: "view", images: [{ media_type: "image/png", ref: blue }] });
  const dir = mkdtempSync(join(tmpdir(), "copilot-pictures-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, recorded);
    for (const ref of [red, blue]) {
      const image = await copilotImage(path, ref);
      expect(image?.mediaType).toBe("image/png");
      expect(new Bun.CryptoHasher("sha256").update(image!.bytes).digest("hex")).toBe(ref.slice("copilot:".length));
    }
    // a digest the session never interned, and bytes that no longer hash to the name they are filed under
    expect(await copilotImage(path, `copilot:${"0".repeat(64)}`)).toBeNull();
    // a line past the largest picture record is passed over without ending the search
    writeFileSync(path, `${"x".repeat(16 * 1024 * 1024)}\n${recorded}`);
    expect((await copilotImage(path, red))?.mediaType).toBe("image/png");
    // the picture's record last in the file, with no newline after it yet
    writeFileSync(path, recorded.split("\n")[2]!);
    expect((await copilotImage(path, red))?.mediaType).toBe("image/png");
    writeFileSync(path, recorded.replace("iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAU0lEQVR4", "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAU0lEQVR5"));
    expect(await copilotImage(path, red)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each(["assistant.message", "tool.execution_start"])("preserves string arguments from %s with bounded display and verified tool output", (type) => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-string-arguments-"));
  const path = join(dir, "events.jsonl");
  const inputs = ['{ "command": "pwd" }', "{not valid JSON", '"freeform"', "x".repeat(16_001)];
  try {
    writeFileSync(path, start + prompt("Check") + inputs.map((input, index) => {
      const request = { toolCallId: `string-${index}`, arguments: input };
      return line(type, type === "assistant.message"
        ? { toolRequests: [{ ...request, name: "shell" }] }
        : { ...request, toolName: "shell" })
        + line("tool.execution_complete", { toolCallId: request.toolCallId, success: false, result: { content: `output ${index} `.repeat(1000) } });
    }).join("") + answer("Finished."));
    const page = transcriptPage("copilot-transcript", path);
    const tools = page.turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools).toHaveLength(inputs.length);
    for (const [index, tool] of tools.entries()) {
      expect(tool.input).toBe(inputs[index]!.slice(0, 16_000));
      expect(tool.error).toBe(true);
      expect(tool.output_ref).toMatch(/^string-\d+@/);
      expect(transcriptToolOutput("copilot-transcript", path, tool.output_ref!)).toBe(`output ${index} `.repeat(1000));
    }
    expect(tools[0]?.summary).toBe("pwd");
    expect(page.turns.at(-1)?.parts.at(-1)).toEqual({ kind: "text", text: "Finished.", phase: "final_answer" });
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps root prompts carrying parentAgentTaskId and pages at those prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-root-page-"));
  const path = join(dir, "events.jsonl");
  try {
    const root = (i: number) => line("user.message", { content: `root ${i}`, parentAgentTaskId: `task-${i}` });
    writeFileSync(path, start + Array.from({ length: 65 }, (_, i) => root(i) + answer(`response ${i}`)
      + line("user.message", { content: `child ${i}`, parentAgentTaskId: `task-${i}`, agentId: "child" }, "child")).join(""));
    const latest = transcriptPage("copilot-transcript", path);
    expect(latest.turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0])).toContainEqual({ kind: "text", text: "root 64" });
    expect(latest.cursor).not.toBeNull();
    const older = transcriptPage("copilot-transcript", path, { before: latest.cursor! });
    expect(older.turns[0]?.parts[0]).toEqual({ kind: "text", text: "root 0" });
    expect([...latest.turns, ...older.turns].some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.startsWith("child")))).toBe(false);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("reads initial model and effort then folds native changes in order", () => {
  const header = line("session.start", { sessionId: session, selectedModel: "initial-model", reasoningEffort: "high" });
  expect(parseConversationMetadata(header, "copilot-transcript")).toEqual({ model: "initial-model", reasoning_effort: "high" });
  expect(parseConversationMetadata(header + line("session.model_change", { newModel: "next-model", reasoningEffort: "low" })
    + line("session.resume", { selectedModel: "resumed-model", reasoningEffort: "medium" }), "copilot-transcript"))
    .toEqual({ model: "resumed-model", reasoning_effort: "medium" });
});

it("keeps unphased completed prose available as an answer, and explicit commentary in work", () => {
  const turns = parseCopilotTranscript(start + prompt("question") + line("assistant.message", { content: "work", phase: "commentary" })
    + line("assistant.message", { content: "unphased answer" }) + line("assistant.turn_end", {}));
  expect(turns.at(-1)?.parts).toEqual([{ kind: "text", text: "work", phase: "commentary" }, { kind: "text", text: "unphased answer" }]);
});

it.each(["assistant.message", "tool.execution_start"])("renders Autopilot summaries from %s without duplicating an explicit answer or a child completion", (type) => {
  const completion = (id: string, summary: string) =>
    line(type, type === "assistant.message"
      ? { toolRequests: [{ toolCallId: id, name: "task_complete", arguments: { summary } }] }
      : { toolCallId: id, toolName: "task_complete", arguments: { summary } })
    + line("tool.execution_complete", { toolCallId: id, success: true, result: { content: "Task complete." } });
  const transcript = start + prompt("first") + answer("Working", "commentary")
    + completion("done-1", "Completed first task.")
    + line("session.task_complete", { summary: "Completed first task." })
    + prompt("second") + completion("done-2", "Tool fallback.")
    + line("session.task_complete", { summary: "Authoritative second summary." })
    + answer("Actual final reply.")
    + line("session.task_complete", { summary: "Do not repeat the final reply." })
    + prompt("third") + line("assistant.message", { content: "child", phase: "commentary" }, "child")
    + line("session.task_complete", { summary: "child secret", agentId: "child" }, "child")
    + line("assistant.message", { toolRequests: [{ toolCallId: "failed", name: "task_complete", arguments: { summary: "failed" } }] })
    + line("tool.execution_complete", { toolCallId: "failed", success: false, result: { content: "failed" } });
  const turns = parseCopilotTranscript(transcript);
  expect(turns[1]?.parts.filter((part) => part.kind === "text")).toEqual([
    { kind: "text", text: "Working", phase: "commentary" },
    { kind: "text", text: "Completed first task.", phase: "final_answer" },
  ]);
  expect(turns[3]?.parts.filter((part) => part.kind === "text")).toEqual([
    { kind: "text", text: "Actual final reply.", phase: "final_answer" },
  ]);
  expect(JSON.stringify(turns)).not.toContain("child secret");
  expect(JSON.stringify(turns)).not.toContain('"text":"failed"');
});

it.each(["commentary", "final_answer", undefined])("tracks the latest assistant message timestamp with phase %s", (phase) => {
  const stamp = "2026-10-21T00:00:05Z";
  const transcript = start + prompt("question") + answer("Working.", "commentary")
    + JSON.stringify({ type: "assistant.message", timestamp: stamp, data: { content: "Latest message.", phase } }) + "\n";
  expect(parseCopilotTranscript(transcript).at(-1)).toMatchObject({
    ts: "2026-10-21T00:00:00Z", end_ts: stamp,
  });
  const missingTimestamp = JSON.stringify({ type: "assistant.turn_end", data: {}, timestamp: null }) + "\n";
  expect(parseCopilotTranscript(transcript + missingTimestamp).at(-1)?.end_ts).toBe(stamp);
});

it("does not repeat a completion summary already present in the last unphased reply", () => {
  for (const phase of [undefined, "commentary"]) {
    for (const ending of ["", prompt("next question")]) {
      const turns = parseCopilotTranscript(start + prompt("finish")
        + line("assistant.message", { content: "All done.", phase })
        + line("session.task_complete", { summary: "All done." }) + ending);
      expect(turns[1]?.parts).toEqual([{ kind: "text", text: "All done.", phase: "final_answer" }]);
    }
  }
  const distinct = parseCopilotTranscript(start + prompt("finish")
    + line("assistant.message", { content: "Working." })
    + line("session.task_complete", { summary: "All done." }));
  expect(distinct[1]?.parts).toHaveLength(2);
});

it("advances activity time past intermediate tool rounds and the final answer without changing turn boundaries", () => {
  const at = (type: string, data: object, second: number) =>
    JSON.stringify({ type, data, timestamp: `2026-10-21T00:00:0${second}Z` }) + "\n";
  const work = start + prompt("question") + at("assistant.message", { content: "Working.", phase: "commentary" }, 1)
    + at("assistant.turn_end", {}, 2);
  const final = work + at("assistant.message", { content: "Done.", phase: "final_answer" }, 3);
  const completed = final + at("assistant.turn_end", {}, 4);
  expect(parseCopilotTranscript(work).at(-1)?.end_ts).toBe("2026-10-21T00:00:02Z");
  expect(parseCopilotTranscript(final).at(-1)?.end_ts).toBe("2026-10-21T00:00:03Z");
  expect(parseCopilotTranscript(completed).at(-1)?.end_ts).toBe("2026-10-21T00:00:04Z");
  const turns = parseCopilotTranscript(completed + at("user.message", { content: "Next question." }, 5)
    + at("assistant.turn_end", {}, 6));
  expect(turns.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
  expect(turns[1]?.end_ts).toBe("2026-10-21T00:00:04Z");
  expect(turns[2]?.end_ts).toBeUndefined();
});

it("pages bounded native turns and observes append, torn lines, and same-file resume without reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-page-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, start + Array.from({ length: 65 }, (_, i) => prompt(`prompt ${i}`) + answer(`answer ${i}`)).join(""));
    const first = transcriptPage("copilot-transcript", path);
    expect(first.turns.at(-1)?.parts[0]).toEqual({ kind: "text", text: "answer 64", phase: "final_answer" });
    expect(first.cursor).not.toBeNull();
    const older = transcriptPage("copilot-transcript", path, { before: first.cursor! });
    expect(older.turns[0]?.parts[0]).toEqual({ kind: "text", text: "prompt 0" });
    appendFileSync(path, '{"type":"user.message","data":');
    expect(transcriptPage("copilot-transcript", path).turns).toEqual(first.turns);
    appendFileSync(path, '{"content":"completed partial prompt"}}\n' + line("session.resume", { selectedModel: "fixture-model" }) + prompt("after resume") + answer("still here"));
    const resumed = transcriptPage("copilot-transcript", path);
    expect(resumed.history_id).toBe(first.history_id);
    expect(resumed.turns.at(-1)?.parts[0]).toEqual({ kind: "text", text: "still here", phase: "final_answer" });
    expect(transcriptPage("copilot-transcript", path, { before: first.cursor! }).turns).toEqual(older.turns);
    writeFileSync(path, start + prompt("replacement"));
    expect(() => transcriptPage("copilot-transcript", path, { before: first.cursor! })).toThrow(HistoryChanged);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("fetches only a bounded complete output for the selected native call ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-output-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, start + prompt("tool")
      + line("assistant.message", { content: "", toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: {} }] })
      + line("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: "x".repeat(5000) } })
      + line("tool.execution_complete", { toolCallId: "unrelated", success: true, result: { content: "hidden" } }));
    const part = transcriptPage("copilot-transcript", path).turns.at(-1)?.parts[0];
    const ref = part?.kind === "tool" ? part.output_ref : undefined;
    expect(ref).toMatch(/^call-1@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/);
    expect(transcriptToolOutput("copilot-transcript", path, ref!)).toBe("x".repeat(5000));
    expect(transcriptToolOutput("copilot-transcript", path, "call-1")).toBe("x".repeat(5000));
    expect(transcriptToolOutput("copilot-transcript", path, "../secret")).toBeNull();
    expect(transcriptToolOutput("copilot-transcript", path, "unrelated")).toBeNull();
    const alias = join(dir, "alias.jsonl");
    symlinkSync(path, alias);
    expect(() => transcriptPage("copilot-transcript", alias)).toThrow(ConversationUnavailable);
    expect(transcriptToolOutput("copilot-transcript", alias, "call-1")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("reads a complete Copilot tool result at EOF across read chunks, but refuses malformed or oversized EOF records", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-output-eof-"));
  const path = join(dir, "events.jsonl");
  try {
    const request = start + line("assistant.message", { toolRequests: [{ toolCallId: "eof-call", name: "shell" }] });
    const complete = line("tool.execution_complete", { toolCallId: "eof-call", success: true, result: { content: "z".repeat(70_000) } }).trimEnd();
    writeFileSync(path, request + complete);
    const part = transcriptPage("copilot-transcript", path).turns.at(-1)?.parts[0];
    const ref = part?.kind === "tool" ? part.output_ref : undefined;
    expect(ref).toMatch(/^eof-call@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/);
    expect(transcriptToolOutput("copilot-transcript", path, ref!)).toBe("z".repeat(70_000));
    expect(transcriptToolOutput("copilot-transcript", path, "eof-call")).toBe("z".repeat(70_000));
    writeFileSync(path, request + complete.slice(0, -1));
    expect(transcriptToolOutput("copilot-transcript", path, "eof-call")).toBeNull();
    writeFileSync(path, request + line("tool.execution_complete", { toolCallId: "eof-call", result: { content: "z".repeat(9_000_000) } }).trimEnd());
    expect(transcriptToolOutput("copilot-transcript", path, "eof-call")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("retains root Copilot model and effort controls across the head and cold latest-page gap in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-cold-metadata-"));
  const path = join(dir, "events.jsonl");
  const fillGap = () => {
    const turn = prompt("filler") + line("assistant.message", { content: "f".repeat(32_000), phase: "final_answer" });
    // Each control is now more than a 16 MiB page away from the next cold read.
    appendFileSync(path, turn.repeat(540));
  };
  try {
    writeFileSync(path, line("session.start", { sessionId: session, selectedModel: "initial", reasoningEffort: "high" })
      + line("system.message", { content: "padding".repeat(10_000) })
      + line("session.model_change", { newModel: "child-model", reasoningEffort: "high", agentId: "child" }, "child")
      + line("session.model_change", { newModel: "low-model", reasoningEffort: "low" })
      + line("session.model_change", { newModel: "latest-model" }));
    fillGap();
    forgetTranscriptState();
    expect(transcriptPage("copilot-transcript", path).metadata).toEqual({ model: "latest-model", reasoning_effort: "low" });
    appendFileSync(path, line("session.resume", { selectedModel: "child-model", reasoningEffort: "high", agentId: "child" }, "child")
      + line("session.resume", { selectedModel: "resumed-model", reasoningEffort: "medium" })
      + line("session.resume", { selectedModel: "latest-resumed-model" }));
    fillGap();
    forgetTranscriptState();
    expect(transcriptPage("copilot-transcript", path).metadata).toEqual({ model: "latest-resumed-model", reasoning_effort: "medium" });
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("skips oversized unrelated records and bounds selected output before parsing", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-large-output-"));
  const path = join(dir, "events.jsonl");
  try {
    const request = line("assistant.message", { toolRequests: [{ toolCallId: "chosen", name: "shell" }] });
    writeFileSync(path, start + request
      + line("tool.execution_complete", { toolCallId: "other", result: { content: "u".repeat(10_000_000) } })
      + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "v".repeat(2_100_000) } }));
    expect(transcriptToolOutput("copilot-transcript", path, "chosen")).toBe(`${"v".repeat(2_000_000)}\n… trimmed`);
    expect(transcriptToolOutput("copilot-transcript", path, "../invalid")).toBeNull();
    writeFileSync(path, start + request + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "w".repeat(10_000_000) } })
      + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "incorrect fallback" } }));
    expect(transcriptToolOutput("copilot-transcript", path, "chosen")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("bounds total tool-output scans even when a reference is missing or beyond the limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-output-scan-"));
  const path = join(dir, "events.jsonl");
  try {
    const request = line("tool.execution_start", { toolCallId: "chosen", toolName: "shell" });
    const output = line("tool.execution_complete", { toolCallId: "chosen", result: { content: "found" } });
    writeFileSync(path, start + request + output);
    expect(transcriptToolOutput("copilot-transcript", path, "chosen")).toBe("found");
    writeFileSync(path, start + line("system.message", { content: "padding".repeat(1024 * 1024) }).repeat(6) + request + output);
    expect(transcriptToolOutput("copilot-transcript", path, "chosen")).toBeNull();
    expect(transcriptToolOutput("copilot-transcript", path, "missing")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("reads old paginated and recent Copilot outputs across a large append without scanning the gap", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-offsets-"));
  const path = join(dir, "events.jsonl");
  const request = (id: string) => line("assistant.message", { toolRequests: [{ toolCallId: id, name: "shell" }] });
  const result = (id: string, content: string) => line("tool.execution_complete", { toolCallId: id, result: { content } });
  try {
    writeFileSync(path, start + prompt("old") + request("old-call") + result("old-call", "old ".repeat(1300))
      + Array.from({ length: 55 }, (_, i) => prompt(`later ${i}`) + answer(`reply ${i}`)).join(""));
    const latest = transcriptPage("copilot-transcript", path);
    const older = transcriptPage("copilot-transcript", path, { before: latest.cursor! });
    const oldRef = older.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool")?.output_ref;
    expect(oldRef).toMatch(/^old-call@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/);
    appendFileSync(path, (line("system.message", { content: "f".repeat(32_000) })).repeat(1100)
      + prompt("recent") + request("recent-call") + result("recent-call", "recent ".repeat(900)));
    expect(statSync(path).size).toBeGreaterThan(32 * 1024 * 1024);
    const recent = transcriptPage("copilot-transcript", path);
    const recentRef = recent.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool")?.output_ref;
    expect(recentRef).toMatch(/^recent-call@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/);
    expect(transcriptToolOutput("copilot-transcript", path, oldRef!)).toBe("old ".repeat(1300));
    expect(transcriptToolOutput("copilot-transcript", path, recentRef!)).toBe("recent ".repeat(900));
    expect(transcriptToolOutput("copilot-transcript", path, "recent-call")).toBeNull();
    expect(transcriptPage("copilot-transcript", path, { before: latest.cursor! }).turns).toEqual(older.turns);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("rejects offset refs after rewrite-and-growth, malformed records, and forged or orphan results", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-offset-integrity-"));
  const path = join(dir, "events.jsonl");
  const request = line("tool.execution_start", { toolCallId: "picked", toolName: "shell" });
  const result = (content: string) => line("tool.execution_complete", { toolCallId: "picked", result: { content } });
  try {
    writeFileSync(path, start + prompt("request") + request + result("first ".repeat(900)));
    const part = transcriptPage("copilot-transcript", path).turns.at(-1)?.parts[0];
    if (part?.kind !== "tool" || !part.output_ref) throw new Error("missing tool ref");
    const oldRef = part.output_ref;
    expect(transcriptToolOutput("copilot-transcript", path, oldRef)).toBe("first ".repeat(900));
    expect(transcriptToolOutput("copilot-transcript", path, oldRef.replace(/.$/, (last) => last === "0" ? "1" : "0"))).toBeNull();
    writeFileSync(path, start + prompt("request") + request + result("other ".repeat(900)) + prompt("more"));
    expect(transcriptToolOutput("copilot-transcript", path, oldRef)).toBeNull();
    writeFileSync(path, start + prompt("request") + request + result("first ".repeat(900)).slice(0, -5) + "\n");
    expect(transcriptToolOutput("copilot-transcript", path, oldRef)).toBeNull();
    writeFileSync(path, start + prompt("request") + line("tool.execution_complete", { toolCallId: "picked", result: { content: "hidden".repeat(900) } }));
    expect(transcriptPage("copilot-transcript", path).turns.some((turn) => turn.parts.some((item) => item.kind === "tool"))).toBe(false);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("reuses peer claims across conversation and tool reads while rechecking the pane process", async () => {
  const own = await logFixture([]);
  const peer = await logFixture([]);
  const ownPane = "copilot-own";
  const peerPane = "copilot-peer";
  const calls: string[] = [];
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } });
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => {
    calls.push(paneId);
    return { pane_id: paneId, foreground_processes: [{ pid: paneId === ownPane ? own.pid : peer.pid, name: "copilot", argv: ["copilot"] }] };
  });
  const environment = spyOn(omo, "processEnviron").mockImplementation((pid) => pid === own.pid ? own.environment : peer.environment);
  const snapshot = {
    panes: [ownPane, peerPane].map((pane_id) => ({ pane_id, agent: "copilot", cwd: own.root })),
    agents: [],
  } as unknown as SessionSnapshot;
  const snapshots = spyOn(herdr, "sessionSnapshot").mockResolvedValue(snapshot);
  try {
    appendFileSync(own.log, register(session));
    appendFileSync(peer.log, register(other));
    const transcript = join(own.root, "session-state", session, "events.jsonl");
    const contents = start + prompt("own history")
      + line("tool.execution_start", { toolCallId: "chosen", toolName: "shell" })
      + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "output ".repeat(1000) } });
    writeFileSync(transcript, contents);
    const conversation = await paneConversation(ownPane);
    expect(conversation.source).toBe("copilot-transcript");
    expect(calls.filter((pane) => pane === peerPane)).toHaveLength(1);
    expect(calls.filter((pane) => pane === ownPane)).toHaveLength(2);
    const part = conversation.turns.at(-1)?.parts.at(-1);
    if (part?.kind !== "tool" || !part.output_ref) throw new Error("tool output ref missing");
    calls.length = 0;
    expect(await toolOutput(ownPane, part.output_ref)).toBe("output ".repeat(1000));
    expect(calls.filter((pane) => pane === peerPane)).toHaveLength(1);
    expect(calls.filter((pane) => pane === ownPane)).toHaveLength(2);
    const selectFile = copilotStore.copilotTranscriptFile;
    for (const eraseAfter of [1, 2]) {
      let selections = 0;
      const disappearing = spyOn(copilotStore, "copilotTranscriptFile").mockImplementation((...args) => {
        const selected = selectFile(...args);
        if (selected === transcript && ++selections === eraseAfter) rmSync(transcript);
        return selected;
      });
      try {
        await expect(paneConversation(ownPane)).rejects.toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
        expect(selections).toBe(eraseAfter);
      } finally {
        disappearing.mockRestore();
        writeFileSync(transcript, contents);
      }
    }
    calls.length = 0;
    info.mockImplementation(async (paneId) => {
      calls.push(paneId);
      if (paneId === ownPane && calls.filter((pane) => pane === ownPane).length === 2) return { pane_id: paneId, foreground_processes: [] };
      return { pane_id: paneId, foreground_processes: [{ pid: paneId === ownPane ? own.pid : peer.pid, name: "copilot", argv: ["copilot"] }] };
    });
    await expect(paneConversation(ownPane)).rejects.toThrow(ConversationUnavailable);
  } finally {
    snapshots.mockRestore(); environment.mockRestore(); info.mockRestore(); rpc.mockRestore();
    forgetTranscriptState();
    await own.close(); await peer.close();
  }
});

it.skipIf(process.platform !== "linux")("retries a failed Copilot process lookup without retaining revoked or peer-conflicting history", async () => {
  const own = await logFixture([]);
  const peer = await logFixture([]);
  const transcript = join(own.root, "session-state", session, "events.jsonl");
  const snapshot = {
    panes: ["own", "peer"].map((pane_id) => ({ pane_id, agent: "copilot", cwd: own.root })),
    agents: [],
  } as unknown as SessionSnapshot;
  const snapshots = spyOn(herdr, "sessionSnapshot").mockResolvedValue(snapshot);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } });
  const environment = spyOn(omo, "processEnviron").mockImplementation((pid) => pid === own.pid ? own.environment : peer.environment);
  let failure: (() => void) | null = null;
  let ownCalls = 0;
  let empty = false;
  let unavailable = false;
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => {
    if (paneId === "own") {
      ownCalls++;
      if (unavailable) throw new Error("synthetic ongoing process lookup failure");
      if (failure !== null) {
        const change = failure;
        failure = null;
        change();
        throw new Error("synthetic process lookup failure");
      }
      if (empty) return { pane_id: paneId, foreground_processes: [] };
    }
    return { pane_id: paneId, foreground_processes: [{ pid: paneId === "own" ? own.pid : peer.pid, name: "copilot", argv: ["copilot"] }] };
  });
  try {
    appendFileSync(own.log, register(session));
    appendFileSync(peer.log, register(other));
    writeFileSync(transcript, start + prompt("current history"));
    const shown = await paneConversation("own");
    ownCalls = 0;
    failure = () => {};
    const recovered = await paneConversation("own", undefined, { history_id: shown.history_id });
    expect(recovered.history_id).toBe(shown.history_id);
    expect(recovered.turns).toEqual(shown.turns);
    expect(ownCalls).toBe(3); // failed lookup, retry, and post-read ownership check
    for (const change of [
      () => { empty = true; },
      () => { appendFileSync(own.log, register(session, "Unregistering")); },
      () => { appendFileSync(peer.log, register(session)); },
    ]) {
      empty = false;
      appendFileSync(own.log, register(session));
      appendFileSync(peer.log, register(other));
      failure = change;
      await expect(paneConversation("own", undefined, { history_id: shown.history_id })).rejects.toBeInstanceOf(ConversationUnavailable);
    }
    empty = false;
    appendFileSync(peer.log, register(session));
    writeFileSync(join(own.root, "session-state", other, "events.jsonl"), line("session.start", { sessionId: other }) + prompt("changed history"));
    failure = () => { appendFileSync(own.log, register(other)); };
    const changed = await paneConversation("own", undefined, { history_id: shown.history_id });
    expect(changed.history_id).not.toBe(shown.history_id);
    expect(changed.turns[0]?.parts[0]).toEqual({ kind: "text", text: "changed history" });
    unavailable = true;
    ownCalls = 0;
    await expect(paneConversation("own")).rejects.toMatchObject({ diagnostic: "copilot_process_lookup_failed", message: "no_session_path" });
    expect(ownCalls).toBe(2);
    unavailable = false;
    empty = true;
    ownCalls = 0;
    await expect(paneConversation("own")).rejects.toMatchObject({ diagnostic: "copilot_process_set_unproved", message: "no_session_path" });
    expect(ownCalls).toBe(1);
  } finally {
    info.mockRestore(); environment.mockRestore(); rpc.mockRestore(); snapshots.mockRestore();
    forgetTranscriptState();
    await own.close(); await peer.close();
  }
});

it.skipIf(process.platform !== "linux")("reads a Copilot pane at the page size the chat asks for", async () => {
  const own = await logFixture([]);
  const snapshot = { panes: [{ pane_id: "sized", agent: "copilot", cwd: own.root }], agents: [] } as unknown as SessionSnapshot;
  const snapshots = spyOn(herdr, "sessionSnapshot").mockResolvedValue(snapshot);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } });
  const environment = spyOn(omo, "processEnviron").mockImplementation(() => own.environment);
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => ({ pane_id: paneId, foreground_processes: [{ pid: own.pid, name: "copilot", argv: ["copilot"] }] }));
  const asked = (conversation: { turns: { role: string; parts: unknown[] }[] }) =>
    conversation.turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0]);
  try {
    appendFileSync(own.log, register(session));
    writeFileSync(join(own.root, "session-state", session, "events.jsonl"), start
      + prompt("first") + answer("one") + prompt("second") + answer("two") + prompt("third") + answer("three"));
    expect(asked(await paneConversation("sized"))).toHaveLength(3);
    const newest = await paneConversation("sized", undefined, { prompts: 1 });
    expect(asked(newest)).toEqual([{ kind: "text", text: "third" }]);
    const older = await paneConversation("sized", undefined, { before: newest.cursor!, prompts: 1 });
    expect(asked(older)).toEqual([{ kind: "text", text: "second" }]);
  } finally {
    info.mockRestore(); environment.mockRestore(); rpc.mockRestore(); snapshots.mockRestore();
    forgetTranscriptState();
    await own.close();
  }
});

it.skipIf(process.platform !== "linux")("does not retain the old history when the session switches while a failed read rechecks its peers", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-recheck-"));
  const transcript = (id: string) => join(root, "session-state", id, "events.jsonl");
  for (const id of [session, other]) {
    mkdirSync(join(root, "session-state", id), { recursive: true });
    writeFileSync(transcript(id), start + prompt(id));
  }
  mkdirSync(join(root, "logs"));
  const log = join(root, "logs", `process-100-${process.pid}.log`);
  // The lifecycle log counts only while this process holds it open, as Copilot does.
  const held = fs.openSync(log, "a");
  appendFileSync(log, register(session));
  let failing = false;
  let failed = false;
  let switched = false;
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } });
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => {
    // The peer check of the recheck, after the read failed, is where the switch lands.
    if (paneId === "peer") {
      if (failed && !switched) { appendFileSync(log, register(other)); switched = true; }
      return { pane_id: paneId, foreground_processes: [] };
    }
    return { pane_id: paneId, foreground_processes: [{ pid: process.pid, name: "copilot", argv: ["copilot"] }] };
  });
  const environment = spyOn(omo, "processEnviron").mockReturnValue([`COPILOT_HOME=${root}`]);
  const snapshots = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: ["own", "peer"].map((pane_id) => ({ pane_id, agent: "copilot", cwd: root })), agents: [],
  } as unknown as SessionSnapshot);
  const readSync = fs.readSync;
  const reads = spyOn(fs, "readSync").mockImplementation(((fd: number, ...rest: [NodeJS.ArrayBufferView, number, number, number | null]) => {
    if (failing && rest[2] > 65536 && fs.readlinkSync(`/proc/self/fd/${fd}`) === transcript(session)) {
      failed = true;
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return readSync(fd, ...rest);
  }) as typeof fs.readSync);
  try {
    const shown = await paneConversation("own");
    expect(shown.source).toBe("copilot-transcript");
    appendFileSync(transcript(session), answer("long ".repeat(15000)));
    failing = true;
    // A client that names no history keeps its fallback, with no recheck that herdr can fail.
    const answered = await herdr.sessionSnapshot();
    snapshots.mockImplementation(async () => { throw new Error("herdr is busy"); });
    snapshots.mockResolvedValueOnce(answered);
    await expect(paneConversation("own")).rejects.toMatchObject({ name: "ConversationUnavailable", message: "transcript_missing" });
    expect(switched).toBe(false);
    snapshots.mockResolvedValue(answered);
    // the switch must land in the next request's recheck, not in its first resolution
    failed = false;
    await expect(paneConversation("own", undefined, { history_id: shown.history_id })).rejects.toMatchObject({ name: "ConversationUnavailable" });
    expect(switched).toBe(true);
  } finally {
    reads.mockRestore(); snapshots.mockRestore(); environment.mockRestore(); info.mockRestore(); rpc.mockRestore();
    fs.closeSync(held); forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux").each([false, true])("does not retain the old history when a peer claims its session during the failed read's recheck (peer replaced: %p)", async (replaced) => {
  const root = mkdtempSync(join(tmpdir(), "copilot-peer-recheck-"));
  const transcript = join(root, "session-state", session, "events.jsonl");
  mkdirSync(join(root, "session-state", session), { recursive: true });
  mkdirSync(join(root, "logs"));
  writeFileSync(transcript, start + prompt("history"));
  const ownLog = join(root, "logs", `process-100-${process.pid}.log`);
  const held = fs.openSync(ownLog, "a");
  appendFileSync(ownLog, register(session));
  // A peer Copilot that holds its own lifecycle log open, on another session.
  const copilot = async () => {
    const child = Bun.spawn([process.execPath, "-e", `require("node:fs").openSync(process.argv[1] + "/logs/process-100-" + process.pid + ".log", "a"); console.log("ready"); process.stdin.resume();`, root], { stdin: "pipe", stdout: "pipe" });
    expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("ready");
    const log = join(root, "logs", `process-100-${child.pid}.log`);
    appendFileSync(log, register(other));
    return { child, log };
  };
  const peer = await copilot();
  // With `replaced`, the peer pane's Copilot exits and a new one there claims the session.
  const successor = await copilot();
  let active = peer;
  let failing = false;
  let failed = false;
  let ownChecks = 0;
  let switched = false;
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: { foreground_processes: [] } });
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => {
    // The recheck's last own-process call comes after the peers were asked: the peer claims the session then.
    if (failed && paneId === "own" && ++ownChecks === 2) {
      if (replaced) { peer.child.kill(); await peer.child.exited; active = successor; }
      appendFileSync(active.log, register(session));
      switched = true;
    }
    return { pane_id: paneId, foreground_processes: [{ pid: paneId === "own" ? process.pid : active.child.pid, name: "copilot", argv: ["copilot"] }] };
  });
  const environment = spyOn(omo, "processEnviron").mockReturnValue([`COPILOT_HOME=${root}`]);
  const snapshots = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: ["own", "peer"].map((pane_id) => ({ pane_id, agent: "copilot", cwd: root })), agents: [],
  } as unknown as SessionSnapshot);
  const readSync = fs.readSync;
  const reads = spyOn(fs, "readSync").mockImplementation(((fd: number, ...rest: [NodeJS.ArrayBufferView, number, number, number | null]) => {
    if (failing && rest[2] > 65536 && fs.readlinkSync(`/proc/self/fd/${fd}`) === transcript) {
      failed = true;
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
    return readSync(fd, ...rest);
  }) as typeof fs.readSync);
  try {
    const shown = await paneConversation("own");
    expect(shown.source).toBe("copilot-transcript");
    appendFileSync(transcript, answer("long ".repeat(15000)));
    failing = true;
    await expect(paneConversation("own", undefined, { history_id: shown.history_id })).rejects.toMatchObject({ name: "ConversationUnavailable" });
    expect(switched).toBe(true);
  } finally {
    reads.mockRestore(); snapshots.mockRestore(); environment.mockRestore(); info.mockRestore(); rpc.mockRestore();
    fs.closeSync(held);
    for (const { child } of [peer, successor]) { child.kill(); await child.exited; }
    forgetTranscriptState();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("uses only the process home and a canonical regular file with the matching native header", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-store-"));
  const custom = join(root, "custom");
  const defaultHome = join(root, "user");
  const legacy = join(root, "legacy");
  const fixture = (home: string) => {
    const directory = join(home, "session-state", session);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "events.jsonl"), start + prompt("safe"));
    return join(directory, "events.jsonl");
  };
  let stop: (() => Promise<number>) | undefined;
  try {
    const chosen = fixture(custom);
    const defaultFile = fixture(join(defaultHome, ".copilot"));
    const legacyFile = fixture(legacy);
    const child = Bun.spawn(["node", "-e", `
      const { openSync, closeSync } = require("node:fs");
      const { join } = require("node:path");
      const homes = process.argv.slice(1);
      for (const home of homes) openSync(join(home, "session-state", "${session}", "inuse." + process.pid + ".hold"), "w");
      let extra;
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
        for (let at; (at = input.indexOf("\\n")) !== -1;) {
          const command = input.slice(0, at); input = input.slice(at + 1);
          if (command === "extra") extra = openSync(join(homes[0], "session-state", "${session.slice(0, -2)}02", "inuse." + process.pid + ".hold"), "w");
          if (command === "close") closeSync(extra);
          console.log("ok");
        }
      });

      console.log("ready");
    `, custom, join(defaultHome, ".copilot"), legacy], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    stop = () => { child.kill(); return child.exited; };
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const pid = child.pid;
    const command = async (value: string) => {
      child.stdin.write(`${value}\n`);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ok");
    };
    expect([...heldSessions(pid, join(custom, "session-state"))!]).toEqual([session]);
    expect(copilotTranscriptFile(session, [`HOME=${defaultHome}`, `COPILOT_HOME=${custom}`], ["copilot"], pid)).toBe(chosen);
    expect(copilotTranscriptFile(session, null, ["copilot"], pid)).toBeNull();
    expect(copilotTranscriptFile("../bad", [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=relative`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    writeFileSync(chosen, start.replace(session, "12aa83d8-48bc-41f2-a498-7055c5c44a02"));
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toEqual({ sessionId: session, path: chosen });
    expect(copilotUnwrittenSession(null, ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=relative`], ["copilot"], pid)).toBeNull();
    for (const args of [["--resume", session], [`--resume=${session}`], ["--continue"], ["-r", session]]) {
      expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot", ...args], pid)).toBeNull();
    }
    symlinkSync(join(root, "missing.jsonl"), chosen);
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    symlinkSync(legacyFile, chosen);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    mkdirSync(chosen);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen, { recursive: true });
    expect(await Bun.spawn(["mkfifo", chosen], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    writeFileSync(chosen, start);
    const extra = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
    mkdirSync(join(custom, "session-state", extra));
    await command("extra");
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    await command("close");
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toEqual({ sessionId: session, path: chosen });
    writeFileSync(chosen, "");
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    writeFileSync(chosen, start);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBe(chosen);
    expect(copilotTranscriptFile(session, [`HOME=${defaultHome}`], ["copilot"], pid)).toBe(defaultFile);
    expect(copilotTranscriptFile(session, [`HOME=${defaultHome}`, `COPILOT_HOME=${custom}`], ["copilot", "--config-dir", legacy], pid)).toBe(legacyFile);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("keeps report-and-marker fallback for a complete CLI log without lifecycle events", async () => {
  const fixture = await logFixture([session]);
  const { root, log, pid, environment, binding } = fixture;
  const path = join(root, "session-state", session, "events.jsonl");
  try {
    writeFileSync(path, start + prompt("existing conversation"));
    const argv = ["copilot", `--resume=${session}`];
    for (const content of ["", "2026-10-23T00:00:00.000Z [INFO] CLI started\n"]) {
      writeFileSync(log, content);
      expect(binding()).toBeNull();
      expect(copilotTranscriptFile(session, environment, argv, pid)).toBe(path);
      expect(copilotTranscriptFile(null, environment, argv, pid)).toBeNull();
      expect(copilotTranscriptFile(other, environment, argv, pid)).toBeNull();
    }
    writeFileSync(log, register(session, "Unregistering"));
    expect(copilotTranscriptFile(session, environment, argv, pid)).toBeNull();
    writeFileSync(log, "x".repeat(16 * 1024 * 1024) + "\n");
    expect(copilotTranscriptFile(session, environment, argv, pid)).toBeNull();
    writeFileSync(log, "2026-10-23T00:00:00.000Z [INFO] CLI started");
    expect(copilotTranscriptFile(session, environment, argv, pid)).toBeNull();
    writeFileSync(log, register(session));
    expect(binding()?.sessionId).toBe(session);
    writeFileSync(log, "2026-10-23T00:00:00.000Z [INFO] CLI restarted\n");
    expect(copilotTranscriptFile(session, environment, argv, pid)).toBeNull();
    expect(copilotTranscriptFile(session, environment, argv, pid)).toBeNull();
    await fixture.command("extra");
    expect(copilotTranscriptFile(session, environment, argv, pid)).toBeNull();
  } finally { await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("keeps marker fallback through ordinary partial lines but rejects pending and completed revocation", async () => {
  const fixture = await logFixture([session]);
  const { root, log, environment, pid } = fixture;
  const path = join(root, "session-state", session, "events.jsonl");
  const read = () => copilotTranscriptFile(session, environment, ["copilot"], pid);
  try {
    writeFileSync(path, start + prompt("existing conversation"));
    appendFileSync(log, "CLI started\n");
    expect(read()).toBe(path);
    for (const tail of ["ordinary partial line", "2026-10-24T00:00:00.000Z [INFO] Writing session"]) {
      appendFileSync(log, tail);
      expect(read()).toBe(path);
      expect(read()).toBe(path);
      appendFileSync(log, "\n");
      expect(read()).toBe(path);
    }
    appendFileSync(log, register(session, "Unregistering").trimEnd());
    expect(read()).toBeNull();
    appendFileSync(log, "\nordinary complete line\n");
    expect(read()).toBeNull();
    expect(read()).toBeNull();
  } finally { await fixture.close(); }
});

for (const scenario of ["one append", "two appends", "rewrite"] as const) {
  it.skipIf(process.platform !== "linux")(`revalidates marker fallback after ${scenario} during the first log read`, async () => {
    const fixture = await logFixture([session]);
    const { log, environment, pid } = fixture;
    const realRead = fs.readSync;
    let remaining = scenario === "one append" ? 1 : 2;
    function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
    function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
    function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
      const count = typeof offset === "number" ? realRead(fd, buffer, offset, length!, position ?? null) : realRead(fd, buffer, offset);
      if (remaining > 0 && fs.readlinkSync(`/proc/self/fd/${fd}`) === log) {
        remaining--;
        appendFileSync(log, "concurrent ordinary append\n");
      }
      return count;
    }
    let reads: ReturnType<typeof spyOn<typeof fs, "readSync">> | undefined;
    try {
      appendFileSync(log, "CLI started\n");
      reads = spyOn(fs, "readSync").mockImplementation(concurrentRead);
      const raced = copilotProcessSession(environment, ["copilot"], pid);
      expect(remaining).toBe(0);
      if (scenario === "one append") expect(raced).toMatchObject({ sessionId: session, logged: false });
      else expect(raced).toBeNull();
      reads.mockRestore();
      if (scenario === "rewrite") {
        writeFileSync(log, "replaced initial log\n");
        expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
        appendFileSync(log, register(session));
      }
      expect(copilotProcessSession(environment, ["copilot"], pid)).toMatchObject({ sessionId: session, logged: scenario === "rewrite" });
      appendFileSync(log, register(session, "Unregistering"));
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
    } finally { reads?.mockRestore(); await fixture.close(); }
  });
}

for (const seen of ["an unregister", "another session's register"] as const) {
  it.skipIf(process.platform !== "linux")(`keeps ${seen} seen during a raced first read when the log is rewritten to its first prefix`, async () => {
    const fixture = await logFixture([session]);
    const { log, environment, pid } = fixture;
    const realRead = fs.readSync;
    // the unregister lands during the first read, so the second read's own bytes include it and
    // only the ordinary append during that second read makes it conflict
    const appends = [seen === "an unregister" ? register(session, "Unregistering") : register(crypto.randomUUID()), "concurrent ordinary append\n"];
    function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
    function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
    function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
      const count = typeof offset === "number" ? realRead(fd, buffer, offset, length!, position ?? null) : realRead(fd, buffer, offset);
      const next = appends[0];
      if (next !== undefined && fs.readlinkSync(`/proc/self/fd/${fd}`) === log) {
        appends.shift();
        appendFileSync(log, next);
      }
      return count;
    }
    let reads: ReturnType<typeof spyOn<typeof fs, "readSync">> | undefined;
    try {
      appendFileSync(log, "CLI started\n");
      reads = spyOn(fs, "readSync").mockImplementation(concurrentRead);
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
      expect(appends).toHaveLength(0);
      reads.mockRestore();
      // the second raced read saw the unregister; a rewrite that keeps only the first read's bytes
      // must not bring the marker fallback back
      writeFileSync(log, "CLI started\nrewritten line\n");
      expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
    } finally { reads?.mockRestore(); await fixture.close(); }
  });
}

it.skipIf(process.platform !== "linux")("does not take a log rewritten during a raced bootstrap's next read as its continuation", async () => {
  const fixture = await logFixture([session]);
  const { log, environment, pid } = fixture;
  const realRead = fs.readSync;
  const appends = [register(session, "Unregistering"), "concurrent ordinary append\n"];
  let rewrite = false;
  function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
  function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
  function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
    const count = typeof offset === "number" ? realRead(fd, buffer, offset, length!, position ?? null) : realRead(fd, buffer, offset);
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === log) {
      const next = appends.shift();
      if (next !== undefined) appendFileSync(log, next);
      else if (rewrite) {
        rewrite = false;
        // in place, after this call's first read of the log: the bytes it got are no longer the file
        writeFileSync(log, "rewritten\n" + "o".repeat(200) + "\n");
      }
    }
    return count;
  }
  let reads: ReturnType<typeof spyOn<typeof fs, "readSync">> | undefined;
  try {
    appendFileSync(log, "CLI started\n");
    reads = spyOn(fs, "readSync").mockImplementation(concurrentRead);
    expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
    expect(appends).toHaveLength(0);
    rewrite = true;
    expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
    expect(rewrite).toBe(false);
    reads.mockRestore();
    expect(copilotProcessSession(environment, ["copilot"], pid)).toBeNull();
  } finally { reads?.mockRestore(); await fixture.close(); }
});

for (const registered of [false, true]) {
  it.skipIf(process.platform !== "linux")(`revalidates ${registered ? "registered" : "marker"} evidence after temporary descriptor read failure`, async () => {
    const fixture = await logFixture([session]);
    const { log, environment, pid } = fixture;
    const read = () => copilotProcessSession(environment, ["copilot"], pid);
    const realLink = fs.readlinkSync;
    let fail = false;
    function currentLink(path: fs.PathLike, options?: fs.EncodingOption): string;
    function currentLink(path: fs.PathLike, options: fs.BufferEncodingOption): Buffer<ArrayBuffer>;
    function currentLink(path: fs.PathLike, options?: fs.EncodingOption | fs.BufferEncodingOption): string | Buffer<ArrayBuffer>;
    function currentLink(path: fs.PathLike, options?: fs.EncodingOption | fs.BufferEncodingOption): string | Buffer<ArrayBuffer> {
      const encoding = typeof options === "object" ? options?.encoding : options;
      const target = encoding === "buffer" ? realLink(path, "buffer") : realLink(path, encoding);
      if (fail && String(path).startsWith(`/proc/${pid}/fd/`) && target.toString() === log) {
        throw Object.assign(new Error("fixture temporary descriptor read failure"), { code: "EIO" });
      }
      return target;
    }
    let links: ReturnType<typeof spyOn<typeof fs, "readlinkSync">> | undefined;
    try {
      appendFileSync(log, registered ? register(session) : "CLI started\n");
      const original = read();
      expect(original?.sessionId).toBe(session);
      links = spyOn(fs, "readlinkSync").mockImplementation(currentLink);
      fail = true;
      expect(read()).toBeNull();
      fail = false;
      const recovered = read();
      expect(recovered?.sessionId).toBe(session);
      expect(recovered?.logged).toBe(registered);
      if (original?.logged && recovered?.logged) expect(recovered.generation).toBe(original.generation);
      fail = true;
      appendFileSync(log, register(session, "Unregistering"));
      expect(read()).toBeNull();
      fail = false;
      expect(read()).toBeNull();
      writeFileSync(log, "rewritten ordinary log\n");
      expect(read()).toBeNull();
    } finally { links?.mockRestore(); await fixture.close(); }
  });

  it.skipIf(process.platform !== "linux")(`revalidates ${registered ? "registered" : "marker"} evidence after temporary stat failure`, async () => {
    const fixture = await logFixture([session]);
    const { log, environment, pid } = fixture;
    const read = () => copilotProcessSession(environment, ["copilot"], pid);
    const realStat = fs.statSync;
    const clock = spyOn(Date, "now");
    let fail = false;
    function currentStat(path: fs.PathLike, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
    function currentStat(path: fs.PathLike, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
    function currentStat(path: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
    function currentStat(path: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
      if (fail && path === log) throw Object.assign(new Error("fixture temporary stat failure"), { code: "ENOENT" });
      const stat = realStat(path, options);
      if (!stat) throw new Error("fixture stat unexpectedly missing");
      return stat;
    }
    let stats: ReturnType<typeof spyOn<typeof fs, "statSync">> | undefined;
    try {
      appendFileSync(log, registered ? register(session) : "CLI started\n");
      const stat = realStat(log);
      clock.mockReturnValue(Math.ceil(Math.max(stat.mtimeMs, stat.ctimeMs)) + 5000);
      const original = read();
      expect(original?.sessionId).toBe(session);
      stats = spyOn(fs, "statSync").mockImplementation(currentStat);
      fail = true;
      expect(read()).toBeNull();
      fail = false;
      const recovered = read();
      expect(recovered?.sessionId).toBe(session);
      expect(recovered?.logged).toBe(registered);
      if (original?.logged && recovered?.logged) expect(recovered.generation).toBe(original.generation);
      appendFileSync(log, register(session, "Unregistering"));
      fail = true;
      expect(read()).toBeNull();
      fail = false;
      expect(read()).toBeNull();
      appendFileSync(log, "ordinary append after unregister\n");
      expect(read()).toBeNull();
    } finally { stats?.mockRestore(); clock.mockRestore(); await fixture.close(); }
  });

  for (const writes of [1, 2]) {
    it.skipIf(process.platform !== "linux")(`recovers ${registered ? "registered" : "marker"} continuity after ${writes} concurrent log appends`, async () => {
      const fixture = await logFixture([session]);
      const { root, log, environment, pid } = fixture;
      const path = join(root, "session-state", session, "events.jsonl");
      const read = () => copilotProcessSession(environment, ["copilot"], pid);
      const realRead = fs.readSync;
      let remaining = writes;
      function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
      function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
      function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
        const count = typeof offset === "number" ? realRead(fd, buffer, offset, length!, position ?? null) : realRead(fd, buffer, offset);
        if (position === 0 && remaining > 0 && fs.readlinkSync(`/proc/self/fd/${fd}`) === log) {
          remaining--;
          appendFileSync(log, "concurrent ordinary append\n");
        }
        return count;
      }
      let reads: ReturnType<typeof spyOn<typeof fs, "readSync">> | undefined;
      try {
        writeFileSync(path, start + prompt("existing conversation"));
        appendFileSync(log, registered ? register(session) : "CLI started\n");
        const original = read();
        expect(original?.sessionId).toBe(session);
        reads = spyOn(fs, "readSync").mockImplementation(concurrentRead);
        const raced = read();
        expect(remaining).toBe(0);
        if (writes === 1) expect(raced?.sessionId).toBe(session);
        else expect(raced).toBeNull();
        const recovered = read();
        expect(recovered?.sessionId).toBe(session);
        expect(recovered?.logged).toBe(registered);
        if (original?.logged && recovered?.logged) expect(recovered.generation).toBe(original.generation);
        appendFileSync(log, register(session, "Unregistering"));
        expect(read()).toBeNull();
        appendFileSync(log, "ordinary append after unregister\n");
        expect(read()).toBeNull();
      } finally { reads?.mockRestore(); await fixture.close(); }
    });
  }
}

it.skipIf(process.platform !== "linux")("does not fall back to a stale marker when the first log read races and its descriptor disappears", async () => {
  const fixture = await logFixture([session]);
  const { root, log, environment, pid } = fixture;
  const path = join(root, "session-state", session, "events.jsonl");
  const read = () => copilotTranscriptFile(session, environment, ["copilot"], pid);
  const realRead = fs.readSync;
  const realLink = fs.readlinkSync;
  let missing = false;
  function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number;
  function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadSyncOptions): number;
  function concurrentRead(fd: number, buffer: NodeJS.ArrayBufferView, offset?: number | fs.ReadSyncOptions, length?: number, position?: fs.ReadPosition | null): number {
    const count = typeof offset === "number" ? realRead(fd, buffer, offset, length!, position ?? null) : realRead(fd, buffer, offset);
    if (!missing && position === 0 && realLink(`/proc/self/fd/${fd}`) === log) {
      appendFileSync(log, "concurrent ordinary append\n");
      missing = true;
    }
    return count;
  }
  function currentLink(path: fs.PathLike, options?: fs.EncodingOption): string;
  function currentLink(path: fs.PathLike, options: fs.BufferEncodingOption): Buffer<ArrayBuffer>;
  function currentLink(path: fs.PathLike, options?: fs.EncodingOption | fs.BufferEncodingOption): string | Buffer<ArrayBuffer>;
  function currentLink(path: fs.PathLike, options?: fs.EncodingOption | fs.BufferEncodingOption): string | Buffer<ArrayBuffer> {
    const encoding = typeof options === "object" ? options?.encoding : options;
    const target = encoding === "buffer" ? realLink(path, "buffer") : realLink(path, encoding);
    if (missing && String(path).startsWith(`/proc/${pid}/fd/`) && target.toString() === log) {
      throw Object.assign(new Error("fixture log descriptor closed"), { code: "ENOENT" });
    }
    return target;
  }
  let reads: ReturnType<typeof spyOn<typeof fs, "readSync">> | undefined;
  let links: ReturnType<typeof spyOn<typeof fs, "readlinkSync">> | undefined;
  try {
    writeFileSync(path, start + prompt("stale held conversation"));
    appendFileSync(log, register(other));
    reads = spyOn(fs, "readSync").mockImplementation(concurrentRead);
    links = spyOn(fs, "readlinkSync").mockImplementation(currentLink);
    expect(read()).toBeNull();
    expect(missing).toBe(true);
    reads.mockRestore();
    links.mockRestore();
    await fixture.command("close");
    expect(read()).toBeNull();
    await fixture.command("open");
    writeFileSync(log, "ordinary complete line\n");
    expect(read()).toBeNull();
    appendFileSync(log, register(session));
    expect(read()).toBe(path);
  } finally { reads?.mockRestore(); links?.mockRestore(); await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("bypasses unchanged metadata after a failed read and revalidates the full prefix", async () => {
  const fixture = await logFixture([]);
  const { log, binding } = fixture;
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const timestamps = fixedLogTimestamps(log, now - 5000);
  const realStat = fs.statSync;
  let fail = false;
  function currentStat(path: fs.PathLike, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
  function currentStat(path: fs.PathLike, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
  function currentStat(path: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
  function currentStat(path: fs.PathLike, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
    if (fail && path === log) throw Object.assign(new Error("fixture temporary stat failure"), { code: "EIO" });
    const stat = realStat(path, options);
    if (!stat) throw new Error("fixture stat unexpectedly missing");
    return stat;
  }
  const stats = spyOn(fs, "statSync").mockImplementation(currentStat);
  try {
    writeFileSync(log, register(session));
    const original = binding();
    expect(original?.sessionId).toBe(session);
    fail = true;
    expect(binding()).toBeNull();
    fail = false;
    writeFileSync(log, register(other));
    expect(binding()?.sessionId).toBe(other);
    expect(binding()?.generation).not.toBe(original?.generation);
  } finally { stats.mockRestore(); timestamps.mockRestore(); clock.mockRestore(); await fixture.close(); }
});

for (const scenario of ["rewrite", "gap"] as const) {
  it.skipIf(process.platform !== "linux")(`recovers foreground discovery after a log ${scenario}`, async () => {
    const fixture = await logFixture([]);
    const { log, binding } = fixture;
    let modifiedAt = Date.now();
    const rewrite = (content: string) => {
      writeFileSync(log, content);
      // Same-size writes can share an inode timestamp tick. Make each changed
      // stat explicit: unchanged identity and stat deliberately reuse evidence.
      modifiedAt += 1000;
      fs.utimesSync(log, modifiedAt / 1000, modifiedAt / 1000);
    };
    try {
      appendFileSync(log, register(session));
      const original = binding();
      expect(original?.sessionId).toBe(session);
      if (scenario === "rewrite") {
        rewrite(register(other));
        expect(binding()?.sessionId).toBe(other);
        rewrite(register(session));
        expect(binding()?.sessionId).toBe(session);
        expect(binding()?.generation).not.toBe(original?.generation);
        rewrite(register(other) + "unrelated\n");
        expect(binding()?.sessionId).toBe(other);
        const replaced = binding();
        appendFileSync(log, "ordinary append\n");
        expect(binding()?.generation).toBe(replaced?.generation);
      } else {
        appendFileSync(log, "unrelated\n".repeat(2 * 1024 * 1024));
        expect(binding()).toBeNull();
        appendFileSync(log, register(session).replace("Registering", "Unregistering") + register(other));
        expect(binding()?.sessionId).toBe(other);
        appendFileSync(log, "unrelated\n".repeat(2 * 1024 * 1024) + register(session));
        expect(binding()?.sessionId).toBe(session);
        expect(binding()?.generation).not.toBe(original?.generation);
      }
    } finally { await fixture.close(); }
  });
}

it.skipIf(process.platform !== "linux")("detects a growing mid-log rewrite with unchanged boundary bytes", async () => {
  const fixture = await logFixture([]);
  const { log, binding } = fixture;
  try {
    const padding = "ordinary line\n".repeat(6000);
    writeFileSync(log, padding + register(session) + padding);
    const original = binding();
    expect(original?.sessionId).toBe(session);
    writeFileSync(log, padding + register(other) + padding + "append\n");
    expect(binding()?.sessionId).toBe(other);
    expect(binding()?.generation).not.toBe(original?.generation);
  } finally { await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("reuses unchanged lifecycle log checks without reading the prefix again", async () => {
  const fixture = await logFixture([]);
  const { log, binding } = fixture;
  const reads = spyOn(fs, "readSync");
  const clock = spyOn(Date, "now");
  const ageLog = () => {
    const stat = fs.statSync(log);
    clock.mockReturnValue(Math.ceil(Math.max(stat.mtimeMs, stat.ctimeMs)) + 5000);
  };
  try {
    appendFileSync(log, register(session));
    ageLog();
    const original = binding();
    expect(original?.sessionId).toBe(session);
    reads.mockClear();
    expect(binding()?.generation).toBe(original?.generation);
    expect(reads.mock.calls).toHaveLength(0);
    clock.mockReturnValue(Date.now() - 1000);
    expect(binding()?.sessionId).toBe(session);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    reads.mockClear();
    expect(binding()?.sessionId).toBe(session);
    expect(reads.mock.calls).toHaveLength(0);
    for (const tail of ["ordinary partial line", register(other).trimEnd()]) {
      appendFileSync(log, tail);
      ageLog();
      const partial = binding();
      expect(partial?.sessionId).toBe(tail.startsWith("ordinary") ? session : undefined);
      reads.mockClear();
      expect(binding()?.generation).toBe(partial?.generation);
      expect(reads.mock.calls).toHaveLength(0);
      appendFileSync(log, "\n");
    }
    expect(binding()?.sessionId).toBe(other);
  } finally { clock.mockRestore(); reads.mockRestore(); await fixture.close(); }
});

/** Only the owned log's timestamp reporting changes; reads, size and identity stay real. */
function fixedLogTimestamps(log: string, mtime: number, ctime = mtime) {
  const identity = fs.statSync(log, { bigint: true });
  const realFstat = fs.fstatSync;
  function tickStat(fd: number, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
  function tickStat(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
  function tickStat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
  function tickStat(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
    const stat = realFstat(fd, options);
    if (stat.dev === identity.dev && stat.ino === identity.ino) {
      Object.assign(stat, {
        mtimeNs: BigInt(mtime) * 1_000_000n, ctimeNs: BigInt(ctime) * 1_000_000n,
        mtimeMs: BigInt(mtime), ctimeMs: BigInt(ctime), mtime: new Date(mtime), ctime: new Date(ctime),
      });
    }
    return stat;
  }
  return spyOn(fs, "fstatSync").mockImplementation(tickStat);
}

for (const age of [2000, 3000]) {
  it.skipIf(process.platform !== "linux")(`checks the unchanged-log timestamp boundary at exactly ${age}ms`, async () => {
    const fixture = await logFixture([]);
    const { log, binding } = fixture;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const stats = fixedLogTimestamps(log, now - age);
    const reads = spyOn(fs, "readSync");
    try {
      writeFileSync(log, register(session));
      const original = binding();
      expect(original?.sessionId).toBe(session);
      reads.mockClear();
      expect(binding()?.generation).toBe(original?.generation);
      if (age === 2000) expect(reads.mock.calls.length).toBeGreaterThan(0);
      else expect(reads.mock.calls).toHaveLength(0);
    } finally { reads.mockRestore(); stats.mockRestore(); clock.mockRestore(); await fixture.close(); }
  });
}

for (const recent of ["mtime", "ctime", "both"] as const) {
  it.skipIf(process.platform !== "linux")(`rechecks an immediate same-size rewrite with racy ${recent} without utimes`, async () => {
    const fixture = await logFixture([]);
    const { log, binding } = fixture;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    // Real same-size writes share a deterministic timestamp tick.
    const stats = fixedLogTimestamps(log, recent === "ctime" ? now - 5000 : now, recent === "mtime" ? now - 5000 : now);
    try {
      writeFileSync(log, register(session));
      const original = binding();
      expect(original?.sessionId).toBe(session);
      writeFileSync(log, register(other));
      // A later request cannot make the earlier, racily clean check trustworthy.
      clock.mockReturnValue(now + 5000);
      const replacement = binding();
      expect(replacement?.sessionId).toBe(other);
      expect(replacement?.generation).not.toBe(original?.generation);
      for (let request = 0; request < 100; request += 1) expect(binding()?.sessionId).toBe(other);
    } finally { stats.mockRestore(); clock.mockRestore(); await fixture.close(); }
  });
}

it.skipIf(process.platform !== "linux")("refuses lifecycle logs past the hash cap without reading them or falling back to a held marker", async () => {
  const fixture = await logFixture([session]);
  const { log, binding, environment, pid, root } = fixture;
  const reads = spyOn(fs, "readSync");
  try {
    const path = join(root, "session-state", session, "events.jsonl");
    writeFileSync(path, start + prompt("old session"));
    appendFileSync(log, register(session));
    expect(binding()?.sessionId).toBe(session);
    const fd = fs.openSync(log, "r+");
    try { fs.ftruncateSync(fd, 64 * 1024 * 1024); } finally { fs.closeSync(fd); }
    appendFileSync(log, "\n" + register(other));
    reads.mockClear();
    expect(binding()).toBeNull();
    expect(copilotTranscriptFile(session, environment, ["copilot"], pid)).toBeNull();
    expect(reads.mock.calls).toHaveLength(0);
    writeFileSync(log, register(other));
    expect(binding()?.sessionId).toBe(other);
  } finally { reads.mockRestore(); await fixture.close(); }
});

it.each([
  { toolRequests: ["unreadable request"] },
  { content: "", toolRequests: { toolCallId: "call", name: "shell" } },
  { content: "readable prose", toolRequests: [null] },
  { toolRequests: [{}] },
  { toolRequests: [{ toolCallId: 123, name: "shell" }] },
  { toolRequests: [{ toolCallId: "../invalid", name: "shell" }] },
  { toolRequests: [{ toolCallId: "call", name: 123 }] },
  { toolRequests: [{ toolCallId: "call", name: "shell", arguments: [] }] },
])("rejects unsupported tool request containers and entries: %j", (data) => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-unreadable-tool-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, start + line("assistant.message", data));
    expect(() => transcriptPage("copilot-transcript", path)).toThrow(ConversationUnavailable);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  line("user.message", { content: [{ type: "text", text: "unsupported" }] }),
  line("assistant.message", { content: [{ type: "text", text: "unsupported" }] }),
  line("user.message", {}),
  JSON.stringify({ type: "assistant.message", data: [] }) + "\n",
  "malformed complete record\n",
])("rejects unreadable history instead of returning an empty native chat: %s", (record) => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-unreadable-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, start);
    expect(transcriptPage("copilot-transcript", path).turns).toEqual([]);
    appendFileSync(path, record);
    expect(() => transcriptPage("copilot-transcript", path)).toThrow("transcript_unreadable");
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("keeps complete bindings through safe partial lines but blocks unfinished switches", async () => {
  const fixture = await logFixture([]);
  const { log, binding } = fixture;
  try {
    appendFileSync(log, register(session));
    const original = binding();
    for (const tail of ["ordinary partial line", "2026-10-24T00:00:00.000Z [INFO] Writing session"]) {
      appendFileSync(log, tail);
      expect(binding()?.generation).toBe(original?.generation);
      expect(binding()?.sessionId).toBe(session);
      appendFileSync(log, "\n");
      expect(binding()?.sessionId).toBe(session);
    }
    appendFileSync(log, register(other).trimEnd());
    expect(binding()).toBeNull();
    appendFileSync(log, "\n");
    expect(binding()?.sessionId).toBe(other);
  } finally { await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("recovers from an ambiguous unregister only after a fresh registration", async () => {
  const fixture = await logFixture([]);
  const { log, binding } = fixture;
  try {
    appendFileSync(log, register(session) + register(other) + register(session, "Unregistering"));
    expect(binding()).toBeNull();
    expect(binding()).toBeNull();
    appendFileSync(log, "ordinary append\n");
    expect(binding()).toBeNull();
    appendFileSync(log, register(session));
    expect(binding()?.sessionId).toBe(session);
    appendFileSync(log, register(session, "Unregistering"));
    expect(binding()).toBeNull();
    appendFileSync(log, register(other));
    expect(binding()?.sessionId).toBe(other);
  } finally { await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("keeps an initially incomplete log unavailable after its descriptor closes", async () => {
  const fixture = await logFixture([session]);
  const { root, log, environment, pid } = fixture;
  const path = join(root, "session-state", session, "events.jsonl");
  try {
    writeFileSync(path, start + prompt("existing conversation"));
    const read = () => copilotTranscriptFile(session, environment, ["copilot"], pid);
    writeFileSync(log, register(session, "Unregistering").trimEnd());
    expect(read()).toBeNull();
    await fixture.command("close");
    expect(read()).toBeNull();
    await fixture.command("open");
    writeFileSync(log, "ordinary complete line\n");
    expect(read()).toBeNull();
    expect(read()).toBeNull();
    appendFileSync(log, register(session));
    expect(read()).toBe(path);
  } finally { await fixture.close(); }
});

it.skipIf(process.platform !== "linux")("follows process-owned foreground evidence through fork and switch-back with multiple holds", async () => {
  const fixture = await logFixture([session, other]);
  const { root, log, environment: options, pid, binding } = fixture;
  const args = ["copilot", "--resume", session];
  try {
    for (const id of [session, other]) writeFileSync(join(root, "session-state", id, "events.jsonl"), line("session.start", { sessionId: id }) + prompt(id));
    appendFileSync(log, register(session));
    expect(heldSessions(pid, join(root, "session-state"))?.size).toBe(2);
    expect(binding()?.sessionId).toBe(session);
    expect(copilotTranscriptFile(null, options, args, pid)).toBe(join(root, "session-state", session, "events.jsonl"));
    for (let n = 0; n < 17; n++) {
      appendFileSync(log, `unrelated ${".".repeat(1024 * 1024)}\n`);
      expect(binding()?.sessionId).toBe(session);
    }
    expect(binding()?.sessionId).toBe(session);
    appendFileSync(log, register(session, "Unregistering") + register(other));
    expect(binding()?.sessionId).toBe(other);
    expect(copilotTranscriptFile(session, options, args, pid)).toBeNull();
    expect(copilotTranscriptFile(other, options, args, pid)).toBe(join(root, "session-state", other, "events.jsonl"));
    appendFileSync(log, register(other, "Unregistering") + register(session));
    expect(binding()?.sessionId).toBe(session);
    appendFileSync(log, "ordinary partial line");
    expect(binding()?.sessionId).toBe(session);
    appendFileSync(log, "\n");
    expect(binding()?.sessionId).toBe(session);
    appendFileSync(log, register(other).trimEnd());
    expect(binding()).toBeNull();
    expect(copilotTranscriptFile(session, options, args, pid)).toBeNull();
  } finally { await fixture.close(); }
});

it("keeps a recorded turn whole when the pictures Copilot interned in it pass the page window (#2478)", () => {
  // the real recorded turn, with two interned pictures (Copilot 1.0.105's `session.binary_asset`) between its
  // tool call and the call's result, together more than one page window of bytes
  const recorded = readFileSync(new URL("./fixtures/copilot-recorded.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
  const complete = recorded.findIndex((record) => record.includes('"tool.execution_complete"'));
  const picture = (n: number) => JSON.stringify({ type: "session.binary_asset", data: { assetId: `sha256:${String(n).repeat(64)}`, type: "image", mimeType: "image/png", byteLength: 6_700_000, data: "A".repeat(9 * 1024 * 1024) }, id: crypto.randomUUID(), timestamp: "2026-01-01T00:00:00.000Z", parentId: null });
  const dir = mkdtempSync(join(tmpdir(), "copilot-page-split-"));
  const path = join(dir, "events.jsonl");
  try {
    // an earlier turn first, so the pictured turn starts mid-file and an older page has something to hold
    const earlier = recorded.filter((record) => /"type":"(user\.message|assistant\.message)"/.test(record) && !record.includes("toolRequests\":[{"))
      .map((record) => record.replace("Recorded fixture text.", "Earlier turn."));
    writeFileSync(path, [recorded[0]!, ...earlier, ...recorded.slice(1, complete), picture(1), picture(2), ...recorded.slice(complete)].join("\n") + "\n");
    // more than a page window (TRANSCRIPT_WINDOW_BYTES, 16 MiB)
    expect(statSync(path).size).toBeGreaterThan(16 * 1024 * 1024);
    const whole = parseCopilotTranscript(readFileSync(path, "utf8"));
    expect(whole.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // one page at a prompt each: the newest holds the pictured turn whole, the older one the turn before it
    const latest = transcriptPage("copilot-transcript", path, { prompts: 1 });
    expect(latest.turns).toEqual(whole.slice(2));
    expect(latest.turns[1]?.parts[0]).toMatchObject({ kind: "tool", name: "shell", output: "Recorded fixture text." });
    expect(latest.cursor).not.toBeNull();
    const older = transcriptPage("copilot-transcript", path, { before: latest.cursor!, prompts: 1 });
    expect(older.turns).toEqual(whole.slice(0, 2));
    // while the turn is live, a poll reads what was appended, not the turn again
    const appended = JSON.stringify({ type: "assistant.message", data: { content: "Appended answer.", toolRequests: [], phase: "final_answer" }, id: crypto.randomUUID(), timestamp: "2026-01-01T00:00:01.000Z", parentId: null }) + "\n";
    appendFileSync(path, appended);
    let read = 0;
    const realRead = fs.readSync;
    const counting = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = (realRead as (...args: Parameters<typeof fs.readSync>) => number)(...args);
      read += count;
      return count;
    }) as typeof fs.readSync);
    let grown: ReturnType<typeof transcriptPage>;
    try { grown = transcriptPage("copilot-transcript", path, { prompts: 1 }); } finally { counting.mockRestore(); }
    // the spy sees the page's own reads: the appended record is read, and nothing much besides
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(64 * 1024);
    expect(grown.turns).toEqual(parseCopilotTranscript(readFileSync(path, "utf8")).slice(2));
    expect(grown.turns.at(-1)?.parts.at(-1)).toEqual({ kind: "text", text: "Appended answer.", phase: "final_answer" });
    // a file written anew rather than appended to is read whole again
    const rewritten = readFileSync(path, "utf8").replace("Appended answer.", "Rewritten answer");
    writeFileSync(path, rewritten);
    expect(transcriptPage("copilot-transcript", path, { prompts: 1 }).turns).toEqual(parseCopilotTranscript(rewritten).slice(2));
    // a newer prompt appended between polls with more than a window after it: its turn is the newest page
    const later = recorded.find((record) => record.includes('"user.message"'))!.replace("Recorded fixture text.", "Later prompt.");
    appendFileSync(path, [later, picture(3), picture(4)].join("\n") + "\n");
    const afterLater = parseCopilotTranscript(readFileSync(path, "utf8"));
    expect(transcriptPage("copilot-transcript", path, { prompts: 1 }).turns).toEqual(afterLater.slice(-1));
    // a line on disk shaped like the page's own stand-in for a picture is no record: the strict reader refuses it
    expect(() => parseCopilotTranscript(`\u0000copilot-set-aside:12\n${recorded[1]}\n`)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
