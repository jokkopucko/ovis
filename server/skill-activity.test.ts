import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexTranscriptParser, parseCodexTranscript } from "./codex.ts";
import { parseClaudeTranscript } from "./conversation.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import { codexReadCall, codexReadSkills, hermesSkillPrompt, selectedSkill, skillInvocationPrompt, skillPromptMessage } from "./skill-activity.ts";
import { parseHermesRows } from "./hermes.ts";
import { parseGrokTranscript } from "./grok.ts";
import { parseAgyTranscript } from "./agy.ts";
import { devinConversation, forgetDevinState } from "./devin.ts";
import { turnSkills } from "../src/lib/skillActivity.ts";
import type { ConversationTurn, SkillActivity } from "../shared/protocol.ts";
import { splitTurn, workFailed, workSummary } from "../src/lib/workBlocks.ts";

const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const response = (payload: unknown) => ({ type: "response_item", timestamp: "2026-09-27T00:00:01Z", payload });
const prompt = response({ type: "message", role: "user", content: [{ type: "input_text", text: "Please review" }] });
const envelope = "<skill>\n<name>review</name>\n<path>/skills/review/SKILL.md</path>\nPRIVATE INSTRUCTIONS\n</skill>";
const selected = response({ type: "message", role: "user", content: [{ type: "input_text", text: envelope }] });
const call = (id: string, skill: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] } });
const result = (id: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: isError ? "Unavailable" : "Launching skill", is_error: isError }] } });

test("Claude records skill request, invocation and failure without claiming task completion", () => {
  const first = parseClaudeTranscript(lines([call("one", "plugin:review")]));
  expect(turnSkills(first[0]!.parts)).toEqual([{ name: "plugin:review", evidence: "invocation", status: "requested" }]);
  const complete = parseClaudeTranscript(lines([call("one", "plugin:review"), result("one"), call("two", "deploy"), result("two", true)]));
  expect(turnSkills(complete[0]!.parts)).toEqual([
    { name: "plugin:review", evidence: "invocation", status: "loaded" },
    { name: "deploy", evidence: "invocation", status: "failed" },
  ]);
  expect(workSummary(complete[0]!.parts)).toBe("2 skills");
  expect(workFailed(complete[0]!.parts)).toBe(1);
  expect(complete[0]?.parts[0]).toMatchObject({ kind: "tool", summary: "plugin:review", input: expect.stringContaining("plugin:review") });
  const mention = parseClaudeTranscript(lines([{ type: "assistant", message: { content: [{ type: "text", text: "Maybe use review" }, { type: "tool_use", name: "Read", input: { file_path: "/notes/review.txt" } }] } }]));
  expect(turnSkills(mention[0]!.parts)).toEqual([]);
});

test("Codex selected instructions become assistant skill evidence, not a user bubble or exposed prompt", () => {
  const turns = parseCodexTranscript(lines([prompt, selected, selected, response({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Reviewed" }] })]));
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turnSkills(turns[1]!.parts)).toEqual([{ name: "review", path: "/skills/review/SKILL.md", evidence: "instructions", status: "loaded" }]);
  expect(JSON.stringify(turns)).not.toContain("PRIVATE INSTRUCTIONS");
  expect(splitTurn(turns[1]!.parts).answer).toEqual([{ kind: "text", text: "Reviewed", phase: "final_answer" }]);
  const mixed = parseCodexTranscript(lines([response({ type: "message", role: "user", content: [{ type: "input_text", text: "Actual prompt" }, { type: "input_text", text: envelope }] })]));
  expect(mixed.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(selectedSkill("Please explain " + envelope)).toBeNull();
  expect(selectedSkill(envelope.slice(0, -8))).toBeNull();
  expect(selectedSkill("<skills_instructions>available skills</skills_instructions>")).toBeNull();
});

test("Codex native completed read events work through code-mode wrappers, deduplicate and survive incremental snapshots", () => {
  const completed = { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-one", parsed_cmd: [{ type: "read", path: "/skills/review/SKILL.md" }], exit_code: 0, status: "completed" } } };
  const parser = createCodexTranscriptParser();
  parser.write(lines([prompt]));
  const before = parser.snapshot();
  parser.write(lines([completed, completed]));
  const after = parser.snapshot();
  expect(after).toEqual(parseCodexTranscript(lines([prompt, completed])));
  expect(after[1]!.parts).toHaveLength(1);
  expect(before).toHaveLength(1);
  expect(codexReadSkills({ ...completed.payload.item, parsed_cmd: [{ type: "unknown", cmd: "echo /skills/review/SKILL.md" }] })).toEqual([]);
  expect(codexReadSkills({ ...completed.payload.item, exit_code: 1, status: "failed" })[0]?.status).toBe("failed");
  expect(codexReadSkills({ ...completed.payload.item, status: "in_progress" })).toEqual([]);
});

test("Codex literal read calls update immutable snapshots on success/failure and ignore shell lookalikes", () => {
  const read = response({ type: "function_call", name: "exec_command", call_id: "one", arguments: JSON.stringify({ cmd: "cat '/skills/review/SKILL.md'" }) });
  const done = response({ type: "function_call_output", call_id: "one", output: "Process exited with code 1\nNo such file" });
  const parser = createCodexTranscriptParser();
  parser.write(lines([prompt, read]));
  const pending = parser.snapshot();
  expect(turnSkills(pending[1]!.parts)[0]?.status).toBe("requested");
  parser.write(lines([done]));
  expect(turnSkills(parser.snapshot()[1]!.parts)[0]?.status).toBe("failed");
  expect(turnSkills(pending[1]!.parts)[0]?.status).toBe("requested");
  for (const cmd of ["echo /skills/review/SKILL.md", "rg SKILL.md /skills", "cat $ROOT/review/SKILL.md", "cat /skills/review/SKILL.md > /tmp/out", "printf 'cat /skills/review/SKILL.md'", "cat /notes/README.md", "git diff -- /skills/review/SKILL.md"]) {
    expect(codexReadCall("exec_command", { cmd })).toBeNull();
  }
  expect(codexReadCall("exec_command", { cmd: "sed -n '1,220p' /skills/review/SKILL.md" })?.name).toBe("review");
});

test("skill evidence is scoped to each turn and clear removes previous Claude skill activity", () => {
  const clear = { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } };
  expect(parseClaudeTranscript(lines([call("one", "review"), result("one"), clear]))).toEqual([]);
  const turns = parseCodexTranscript(lines([prompt, selected, response({ type: "message", role: "user", content: "Another request" }), response({ type: "message", role: "assistant", content: "No skill" })]));
  expect(turnSkills(turns.at(-1)!.parts)).toEqual([]);
});

test("late native read events from another Codex turn do not attach to the current answer", () => {
  const turns = parseCodexTranscript(lines([
    { type: "event_msg", payload: { type: "task_started", turn_id: "current" } },
    prompt,
    { type: "event_msg", payload: { type: "item_completed", turn_id: "old", item: { type: "CommandExecution", id: "late", status: "completed", exit_code: 0, parsed_cmd: [{ type: "read", path: "/skills/old/SKILL.md" }] } } },
    response({ type: "message", role: "assistant", content: "Current answer" }),
  ]));
  expect(turnSkills(turns.at(-1)!.parts)).toEqual([]);
});

test("Codex tool and native read records count one skill and keep the tool output", () => {
  const turns = parseCodexTranscript(lines([
    prompt,
    response({ type: "function_call", name: "exec_command", call_id: "read", arguments: '{"cmd":"cat /skills/review/SKILL.md"}' }),
    { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "native-read", status: "completed", exit_code: 0, parsed_cmd: [{ type: "read", path: "/skills/review/SKILL.md" }] } } },
    response({ type: "function_call_output", call_id: "read", output: "Process exited with code 0\nInstructions" }),
  ]));
  expect(turns[1]!.parts).toHaveLength(1);
  expect(turnSkills(turns[1]!.parts)).toHaveLength(1);
  expect(workSummary(turns[1]!.parts)).toBe("1 skill");
  expect(turns[1]!.parts[0]).toMatchObject({ output: expect.stringContaining("Instructions"), skill: { status: "loaded" } });
});

const invoked = (name: string, location = `/home/u/.omo/skills/${name}/SKILL.md`) =>
  `The user explicitly invoked the "${name}" skill. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions.\n\n<skill-instruction name="${name}" location="${location}">\nReferences are relative to /home/u/.omo/skills/${name}.\n\nPRIVATE ${name} INSTRUCTIONS\n</skill-instruction>`;
const loaded = (name: string): SkillActivity => ({ name, path: `/home/u/.omo/skills/${name}/SKILL.md`, evidence: "instructions", status: "loaded" });
const piUser = (text: string) => ({ type: "message", timestamp: "2026-10-02T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const piAnswer = (text: string) => ({ type: "message", timestamp: "2026-10-02T00:00:05Z", message: { role: "assistant", content: [{ type: "text", text }] } });

test("an omo/omp skill invocation reads as the request, with the skill on it", () => {
  const text = `${invoked("ulw-research")}\n\n<user-request>\n  compare the three apps\n</user-request>`;
  expect(skillInvocationPrompt(text)).toEqual({ skills: [loaded("ulw-research")], request: "compare the three apps" });
  const turns = parseOmpTranscript(lines([piUser(text), piAnswer("On it.")]));
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turns[0]!.parts).toEqual([{ kind: "text", text: "compare the three apps" }, { kind: "skill", skill: loaded("ulw-research") }]);
  expect(turnSkills(turns[1]!.parts)).toEqual([]);
  expect(JSON.stringify(turns)).not.toContain("PRIVATE");
  expect(splitTurn(turns[1]!.parts).answer).toEqual([{ kind: "text", text: "On it." }]);
});

test("chained skill invocations and a request-less one", () => {
  const chained = `${invoked("a")}\n\n${invoked("b")}`;
  expect(skillInvocationPrompt(chained)).toEqual({ skills: [loaded("a"), loaded("b")], request: "" });
  expect(parseOmpTranscript(lines([piUser(chained)]))[0]!.parts).toEqual([{ kind: "text", text: "/skill:a /skill:b" }, { kind: "skill", skill: loaded("a") }, { kind: "skill", skill: loaded("b") }]);
});

test("the legacy <skill> form, and text that only looks like an invocation, as pi reads them", () => {
  expect(skillInvocationPrompt('<skill name="x" location="/s/x/SKILL.md">\nBODY\n</skill>\n\nplease')).toEqual({ skills: [{ name: "x", path: "/s/x/SKILL.md", evidence: "instructions", status: "loaded" } satisfies SkillActivity], request: "please" });
  // a name that differs from its block, trailing text outside <user-request>, a broken chain: the user's text as typed
  expect(skillInvocationPrompt(invoked("a").replace('name="a" location', 'name="b" location'))).toBeNull();
  expect(skillInvocationPrompt(`${invoked("a")}\n\nmore`)).toBeNull();
  expect(skillInvocationPrompt(`${invoked("a")}\n\nThe user explicitly invoked the "b" skill.`)).toBeNull();
  expect(skillInvocationPrompt("The user explicitly invoked nothing")).toBeNull();
  expect(parseOmpTranscript(lines([piUser(`${invoked("a")}\n\nmore`)]))[0]!.parts[0]).toMatchObject({ kind: "text", text: expect.stringContaining("PRIVATE a") });
});

test("the skill stays on its message wherever the transcript is cut: parsed apart, the record is whole", () => {
  const text = `${invoked("ulw-research")}\n\n<user-request>\ncompare\n</user-request>`;
  const settled = parseOmpTranscript(lines([piUser(text)]));
  const live = parseOmpTranscript(lines([piUser("also check the docs"), piAnswer("On it.")]));
  expect([...settled, ...live].map((turn) => turn.role)).toEqual(["user", "user", "assistant"]);
  expect(turnSkills(settled[0]!.parts)).toEqual([loaded("ulw-research")]);
  expect(turnSkills(live[1]!.parts)).toEqual([]);
});

test("a standalone .md skill (pi --skill review.md) is a skill too", () => {
  const text = invoked("review", "/home/u/skills/review.md");
  expect(skillInvocationPrompt(text)).toEqual({ skills: [{ name: "review", path: "/home/u/skills/review.md", evidence: "instructions", status: "loaded" }], request: "" });
});

for (const agent of ["omp", "gjc"]) {
  test(`${agent}'s recorded skill-prompt becomes one user invocation without a notice`, async () => {
    const fixture = await Bun.file(new URL(`./fixtures/skill-invocations/${agent}.jsonl`, import.meta.url)).text();
    const turns = parseOmpTranscript(fixture);
    const users = turns.filter((turn) => turn.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.parts).toEqual([
      { kind: "text", text: "/skill:probe-skill hello" },
      { kind: "skill", skill: { name: "probe-skill", path: expect.stringMatching(/\/probe-skill\/SKILL\.md$/), evidence: "instructions", status: "loaded" } },
    ]);
    expect(turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "notice")).toEqual([]);
  });
}

test("a skill-prompt without args still records its invocation", () => {
  expect(skillPromptMessage({ type: "custom_message", customType: "skill-prompt", details: { name: "probe-skill" } })).toEqual({
    request: "/skill:probe-skill",
    skills: [{ name: "probe-skill", evidence: "instructions", status: "loaded" }],
  });
});

test("unmatched custom messages retain their existing notice", () => {
  const turns = parseOmpTranscript(lines([{ type: "custom_message", customType: "background-job", content: "<system-notice>done</system-notice>", display: true }]));
  expect(turns[0]?.parts).toEqual([{ kind: "notice", text: "done", source: "background-job" }]);
});

test("malformed skill details leave the recorded content as a notice", () => {
  const turns = parseOmpTranscript(lines([{ type: "custom_message", customType: "skill-prompt", content: "unmatched", details: { name: "bad\nname" } }]));
  expect(turns[0]?.parts).toEqual([{ kind: "notice", text: "unmatched", source: "skill-prompt" }]);
});

for (const [fixture, request, names] of [
  ["hermes", "/probe-skill hello", ["probe-skill"]],
  ["hermes-bundle", "/probe-bundle hello", ["probe-skill", "probe-skill-two"]],
] as const) {
  test(`${fixture}'s scaffold becomes the user command and loaded skill parts`, async () => {
    const content = await Bun.file(new URL(`./fixtures/skill-invocations/${fixture}.txt`, import.meta.url)).text();
    const parsed = hermesSkillPrompt(content);
    expect(parsed?.request).toBe(request);
    expect(parsed?.skills.map((skill) => skill.name)).toEqual([...names]);
    const turns = parseHermesRows([{ id: 1, role: "user", content, tool_call_id: null, tool_calls: null, tool_name: null, reasoning: null, timestamp: 1 }]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.parts).toEqual([
      { kind: "text", text: request },
      ...names.map((name) => ({ kind: "skill" as const, skill: { name, path: expect.stringMatching(new RegExp(`/${name}/SKILL\\.md$`)), evidence: "instructions" as const, status: "loaded" as const } })),
    ]);
  });

  test(`${fixture} keeps body instruction markers out of the user command`, async () => {
    const content = await Bun.file(new URL(`./fixtures/skill-invocations/${fixture}.txt`, import.meta.url)).text();
    const withBodyMarker = content.replace("\n[Skill directory:", "\n\nThe user has provided the following instruction alongside the skill invocation: body-only\n\nUser instruction: body-only\n[Skill directory:");
    expect(hermesSkillPrompt(withBodyMarker)?.request).toBe(request);
  });

  test(`${fixture} without a user instruction still parses a body that quotes the instruction marker`, async () => {
    const content = await Bun.file(new URL(`./fixtures/skill-invocations/${fixture}.txt`, import.meta.url)).text();
    const bare = content.replace("\n\nThe user has provided the following instruction alongside the skill invocation: hello", "").replace("\n\nUser instruction: hello", "");
    const quoted = bare.replace("\n[Skill directory:", "\n\nThe user has provided the following instruction alongside the skill invocation: body-only\n[Skill directory:");
    expect(hermesSkillPrompt(quoted)?.request).toBe(request.replace(" hello", ""));
  });

  test(`${fixture} without a user instruction keeps only the command`, async () => {
    const content = await Bun.file(new URL(`./fixtures/skill-invocations/${fixture}.txt`, import.meta.url)).text();
    const withoutInstruction = content.replace("\n\nThe user has provided the following instruction alongside the skill invocation: hello", "").replace("\n\nUser instruction: hello", "");
    expect(hermesSkillPrompt(withoutInstruction)?.request).toBe(request.replace(" hello", ""));
  });
}

test("Hermes leaves unmatched and incomplete scaffolds raw", () => {
  const content = '[IMPORTANT: The user has invoked the "probe-skill" skill';
  expect(hermesSkillPrompt(content)).toBeNull();
  const turns = parseHermesRows([{ id: 1, role: "user", content, tool_call_id: null, tool_calls: null, tool_name: null, reasoning: null, timestamp: 1 }]);
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: content }]);
});

test("Hermes leaves a bundle with a missing loaded skill raw", async () => {
  const fixture = await Bun.file(new URL("./fixtures/skill-invocations/hermes-bundle.txt", import.meta.url)).text();
  const content = fixture.slice(0, fixture.lastIndexOf('\n\n[Loaded as part of the "probe-bundle" skill bundle.]'));
  expect(hermesSkillPrompt(content)).toBeNull();
  const turns = parseHermesRows([{ id: 1, role: "user", content, tool_call_id: null, tool_calls: null, tool_name: null, reasoning: null, timestamp: 1 }]);
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: content }]);
});

const fixtureText = (name: string): Promise<string> => Bun.file(new URL(`./fixtures/skill-invocations/${name}`, import.meta.url)).text();
const probe = (status: SkillActivity["status"], evidence: SkillActivity["evidence"] = "instructions", path?: string): SkillActivity => ({ name: "probe-skill", ...(path ? { path } : {}), evidence, status });
const skillOf = (turns: ConversationTurn[]) => turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "skill" ? [part.skill] : part.kind === "tool" && part.skill ? [part.skill] : []));

test("Grok's TUI skill prompt is a requested skill on the prompt; a plain slash prompt is not", async () => {
  const turns = parseGrokTranscript(await fixtureText("grok.jsonl"));
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: "/probe-skill hello" }, { kind: "skill", skill: probe("requested", "invocation") }]);
  expect(skillOf(turns.slice(1))).toEqual([]);
  const printMode = JSON.stringify({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "/probe-skill hello" }, _meta: { promptIndex: 0 } } } });
  expect(parseGrokTranscript(printMode)[0]?.parts).toEqual([{ kind: "text", text: "/probe-skill hello" }]);
});

test("Grok's read of a SKILL.md follows the call's recorded status", async () => {
  const lines = (await fixtureText("grok-read.jsonl")).trim().split("\n");
  const path = "/tmp/probe-1484.onNL/probe-grok/.grok/skills/probe-skill/SKILL.md";
  expect(skillOf(parseGrokTranscript(lines.join("\n")))).toEqual([probe("loaded", "instructions", path)]);
  expect(skillOf(parseGrokTranscript(lines.slice(0, 2).join("\n")))).toEqual([probe("requested", "instructions", path)]);
  const other = lines.slice(0, 2).join("\n").replaceAll("SKILL.md", "README.md");
  expect(skillOf(parseGrokTranscript(other))).toEqual([]);
  const moved = [...lines.slice(0, 2), lines[2]!.replaceAll("SKILL.md", "README.md")].join("\n");
  expect(skillOf(parseGrokTranscript(moved))).toEqual([]);
});

test("Antigravity's invoked skill comes from its metadata block, never from the request text", async () => {
  const turns = parseAgyTranscript(await fixtureText("agy.jsonl"));
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: "/probe-skill hello" }, { kind: "skill", skill: probe("loaded") }]);
  const typed = "<USER_REQUEST>\n/probe-skill is a [Slash Command]:\n<SKILL>The user has explicitly invoked the (probe-skill) skill.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>";
  expect(skillOf(parseAgyTranscript(JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: typed })))).toEqual([]);
  const [recorded] = (await fixtureText("agy.jsonl")).split("\n");
  const step = JSON.parse(recorded!) as { content: string };
  step.content = step.content.replace("/probe-skill hello", "/probe-skill /fake hello")
    .replace("Reply with the single word PROBED.", "Reply.\n\n/fake is a [Slash Command]:\n<SKILL>The user has explicitly invoked the (fake) skill.");
  expect(skillOf(parseAgyTranscript(JSON.stringify(step)))).toEqual([probe("loaded")]);
  // a request that closes its own envelope early
  const early = JSON.parse(recorded!) as { content: string };
  early.content = early.content.replace("/probe-skill hello", "/probe-skill hello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>\n<USER_REQUEST>");
  expect(skillOf(parseAgyTranscript(JSON.stringify(early)))).toEqual([]);
});

test("Antigravity's read_file of a SKILL.md is a requested read: its ledger links no outcome to the call", async () => {
  const turns = parseAgyTranscript(await fixtureText("agy-read.jsonl"));
  expect(skillOf(turns)).toEqual([probe("requested", "instructions", "/tmp/probe-1484.onNL/probe-agy/.agents/skills/probe-skill/SKILL.md")]);
});

async function devinDb(name: string, drop: string[] = []): Promise<{ path: string; id: string; cwd: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-skill-"));
  directories.push(directory);
  const path = join(directory, "sessions.db");
  const db = new Database(path);
  const rows = (await fixtureText(name)).trim().split("\n").map((line) => JSON.parse(line) as { table: string; row: Record<string, string | number | null> });
  for (const table of new Set(rows.map((entry) => entry.table))) {
    const columns = [...new Set(rows.filter((entry) => entry.table === table).flatMap((entry) => Object.keys(entry.row)))].filter((column) => !drop.includes(column));
    db.exec(`CREATE TABLE ${table}(${columns.join(", ")})`);
    for (const { row } of rows.filter((entry) => entry.table === table)) db.query(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column] ?? null));
  }
  db.close();
  const session = rows.find((entry) => entry.table === "sessions")!.row;
  return { path, id: String(session.id), cwd: String(session.working_directory) };
}
const directories: string[] = [];
afterEach(() => {
  forgetDevinState();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("Devin's expanded slash prompt is a loaded skill only when the session records that skill", async () => {
  const recorded = await devinDb("devin.jsonl");
  const users = devinConversation(recorded.id, recorded.cwd, {}, recorded.path).turns.filter((turn) => turn.role === "user");
  expect(users.map((turn) => turn.parts)).toEqual([[{ kind: "text", text: "/probe-skill hello" }, { kind: "skill", skill: probe("loaded") }]]);
  const older = await devinDb("devin.jsonl", ["cogs_json"]);
  expect(skillOf(devinConversation(older.id, older.cwd, {}, older.path).turns)).toEqual([]);
});

test("Devin's skill tool call follows its recorded state", async () => {
  const recorded = await devinDb("devin-tool.jsonl");
  expect(skillOf(devinConversation(recorded.id, recorded.cwd, {}, recorded.path).turns)).toEqual([probe("loaded", "invocation")]);
  const db = new Database(recorded.path);
  db.exec("UPDATE tool_call_state SET tool_call_update_json = NULL");
  forgetDevinState();
  expect(skillOf(devinConversation(recorded.id, recorded.cwd, {}, recorded.path).turns)).toEqual([probe("loaded", "invocation")]);
  db.exec("UPDATE message_nodes SET chat_message = replace(chat_message, '\"success\":true', '\"success\":false') WHERE chat_message LIKE '%chisel/tool_result_meta%'");
  forgetDevinState();
  expect(skillOf(devinConversation(recorded.id, recorded.cwd, {}, recorded.path).turns)).toEqual([probe("failed", "invocation")]);
  db.exec("UPDATE sessions SET main_chain_id = (SELECT parent_node_id FROM message_nodes WHERE chat_message LIKE '%\"role\":\"tool\"%')");
  db.close();
  forgetDevinState();
  expect(skillOf(devinConversation(recorded.id, recorded.cwd, {}, recorded.path).turns)).toEqual([probe("requested", "invocation")]);
});
