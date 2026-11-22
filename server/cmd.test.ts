import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentInfo } from "../shared/herdr-api.generated.ts";
import { cmdContextWindow, cmdSlug, cmdTranscriptInStore, unwrittenSession } from "./cmd.ts";
import { transcriptPage } from "./conversation.ts";
import { answerKeys, parseFallbackPrompt, parseInteractivePrompt } from "./prompt.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-cmd-store-"));
const project = join(root, "projects", cmdSlug(root));
mkdirSync(project, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const canSymlink = (() => {
  const probe = join(root, "symlink-capability");
  try { symlinkSync(project, probe, "dir"); rmSync(probe); return true; }
  catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
})();

const session = (name: string, body: unknown[] = []) => {
  const path = join(project, `${name}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: root },
    ...body,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
};

describe("Command Code's session store holds the transcript a pane reads", () => {
  it("names the project directory after the cwd", () => {
    expect(cmdSlug("/home/daigou/Projects/herdr-web-ui")).toBe("home-daigou-projects-herdr-web-ui");
    expect(cmdSlug("/home/daigou/Projects/Yaba-Definitive")).toBe("home-daigou-projects-yaba-definitive");
  });

  it("accepts a session file inside the store", () => {
    const path = session("inside");
    expect(cmdTranscriptInStore(path, project)).toBe(path);
  });

  it("refuses paths that leave the store", () => {
    const outside = join(root, "elsewhere.jsonl");
    writeFileSync(outside, "{}\n");
    expect(cmdTranscriptInStore(outside, project)).toBeNull();
    expect(cmdTranscriptInStore(join(project, "..", "elsewhere.jsonl"), project)).toBeNull();
    expect(cmdTranscriptInStore(project, project)).toBeNull();
    expect(cmdTranscriptInStore(join(root, "missing.jsonl"), project)).toBeNull();
  });

  it.skipIf(!canSymlink)("refuses a link out of the store", () => {
    const outside = join(root, "target.jsonl");
    writeFileSync(outside, "{}\n");
    const link = join(project, "link.jsonl");
    symlinkSync(outside, link);
    expect(cmdTranscriptInStore(link, project)).toBeNull();
  });

  it("refuses a directory and a file that is not jsonl", () => {
    mkdirSync(join(project, "dir.jsonl"), { recursive: true });
    expect(cmdTranscriptInStore(join(project, "dir.jsonl"), project)).toBeNull();
    writeFileSync(join(project, "notes.txt"), "{}\n");
    expect(cmdTranscriptInStore(join(project, "notes.txt"), project)).toBeNull();
  });

  it("names a session Command Code has not written yet only when its path is in the store", () => {
    expect(unwrittenSession(join(project, "fresh.jsonl"), project)).toEqual({ id: "fresh", path: join(project, "fresh.jsonl") });
    expect(unwrittenSession(session("written"), project)).toBeNull();
    expect(unwrittenSession(join(root, "missing.jsonl"), project)).toBeNull();
    expect(unwrittenSession(join(project, "fresh.txt"), project)).toBeNull();
  });
});

describe("Command Code session resolution", () => {
  const shellCwd = join(root, "shell-project");
  const agentCwd = join(root, "agent-project");
  const helperCwd = join(root, "helper-project");
  const store = join(root, ".commandcode", "projects", cmdSlug(agentCwd));
  const shellStore = join(root, ".commandcode", "projects", cmdSlug(shellCwd));
  mkdirSync(store, { recursive: true });
  mkdirSync(shellStore, { recursive: true });
  mkdirSync(join(root, ".commandcode", "projects", cmdSlug(helperCwd)), { recursive: true });
  const path = join(store, "reported.jsonl");
  const shellPath = join(shellStore, "shell.jsonl");
  writeFileSync(path, "{}\n");
  writeFileSync(shellPath, "{}\n");
  const fresh = join(store, "fresh.jsonl");
  const report = { agent: "cmd", source: "herdr:cmd", kind: "path", value: path };
  const agent = {
    agent: "cmd", cwd: shellCwd, foreground_cwd: agentCwd, agent_session: report,
    agent_status: "idle", focused: false, pane_id: "cmd-pane", revision: 1,
    tab_id: "tab", terminal_id: "terminal", workspace_id: "workspace",
  } satisfies AgentInfo;

  const cases: { name: string; changes: Partial<AgentInfo>; expected: unknown }[] = [
    { name: "resolves the process project when the shell is elsewhere", changes: {}, expected: { path } },
    { name: "resolves an unwritten session in the process project", changes: { agent_session: { ...report, value: fresh } }, expected: { unwritten: { id: "fresh", path: fresh } } },
    { name: "falls back when the process cwd is absent", changes: { cwd: agentCwd, foreground_cwd: null }, expected: { path } },
    { name: "falls back when the process cwd is empty", changes: { cwd: agentCwd, foreground_cwd: "" }, expected: { path } },
    { name: "resolves the cwd store when foreground validation fails", changes: { agent_session: { ...report, value: shellPath } }, expected: { path: shellPath } },
    { name: "resolves an unwritten session in the cwd store", changes: { agent_session: { ...report, value: join(shellStore, "fresh.jsonl") } }, expected: { unwritten: { id: "fresh", path: join(shellStore, "fresh.jsonl") } } },
    { name: "resolves B when an unrelated foreground helper reports C", changes: { cwd: agentCwd, foreground_cwd: helperCwd }, expected: { path } },
    { name: "rejects a session when neither reported cwd validates", changes: { foreground_cwd: helperCwd }, expected: null },
    { name: "rejects an unwritten session when neither cwd validates", changes: { foreground_cwd: helperCwd, agent_session: { ...report, value: fresh } }, expected: null },
    { name: "rejects another agent", changes: { agent: "pi" }, expected: null },
    { name: "rejects another session agent", changes: { agent_session: { ...report, agent: "pi" } }, expected: null },
    { name: "rejects an untrusted session source", changes: { agent_session: { ...report, source: "environment" } }, expected: null },
    { name: "rejects an id instead of a path", changes: { agent_session: { ...report, kind: "id" } }, expected: null },
    { name: "rejects a missing session report", changes: { agent_session: null }, expected: null },
    { name: "rejects a missing cwd", changes: { cwd: null, foreground_cwd: null }, expected: null },
  ];

  it.each(cases)("$name", async ({ changes, expected }) => {
    const script = `const { cmdTranscriptPath } = await import(${JSON.stringify(join(import.meta.dir, "cmd.ts"))});
      console.log(JSON.stringify(await cmdTranscriptPath("cmd-pane", { agent: ${JSON.stringify({ ...agent, ...changes })} })));`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(expected);
  });
});

// Command Code's own record shapes: a prompt, an assistant turn whose thinking and prose sit
// side by side, and the camelCase usage it records.
const conversation = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-10-19T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "fix the crash" }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-19T00:00:03.000Z", message: {
    role: "assistant", model: "stealth/cat-jam:free", stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, costUsd: 0 },
    content: [
      { type: "thinking", thinking: "the null check is missing" },
      { type: "text", text: "Guarded. The crash came from a null export." },
    ],
  } },
];

describe("Command Code transcripts render as chat", () => {
  it("reads prompts, thinking and the answer", () => {
    const page = transcriptPage("cmd-transcript", session("readable", conversation));
    expect(page.source).toBe("cmd-transcript");
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(page.turns[1]?.parts.some((part) => part.kind === "thinking")).toBe(true);
  });
});

describe("Command Code's context window comes from its catalog", () => {
  it("reads the window the catalog states and nothing else", () => {
    const catalog = join(root, "commandcode-models.json");
    writeFileSync(catalog, JSON.stringify({ version: 2, models: [
      { id: "stealth/cat-jam:free", contextWindow: 1048576 },
      { id: "no-window", contextWindow: 0 },
      { id: "text-window", contextWindow: "many" },
    ] }));
    expect(cmdContextWindow("stealth/cat-jam:free", catalog)).toBe(1048576);
    expect(cmdContextWindow("no-window", catalog)).toBeNull();
    expect(cmdContextWindow("text-window", catalog)).toBeNull();
    expect(cmdContextWindow("absent", catalog)).toBeNull();
    expect(cmdContextWindow("stealth/cat-jam:free", join(root, "missing.json"))).toBeNull();
  });
});

// The permission prompt, as Command Code's TUI draws it.
const permission = [
  "─".repeat(40), "",
  "Create File",
  "",
  "Do you want to create hello.txt?",
  "",
  "❯ 1. Yes",
  "  2. Yes, allow all edits this session [shift+tab]",
  "  3. No, tell Command Code what to do differently",
  "",
  "↑/↓ navigate · enter select · Run cmd --yolo to",
  "bypass all permissions (Docs ↗)",
].join("\n");

describe("Command Code's permission prompt is a card", () => {
  // command-code@1.88.0 dist/cli.mjs: Overlay, ShellPermissionPrompt,
  // PermissionFooter and getShellPermissionChoices. Static source, not an account session.
  const heading = "Execute Shell Command";
  const footer = "↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all permissions (Docs ↗)";
  const command = "printf first\nprintf second";
  const shell = [
    "─".repeat(40), "", heading,
    `Command Code needs to execute ${command}.`, "",
    "Press [ctrl+e] to explain this command", "",
    "❯ 1. Yes", "  2. Yes, don't ask again for `printf` commands in this project",
    "  3. No, tell Command Code what to do differently", "", footer,
  ].join("\n");

  it("makes the card stale when output above the permission overlay redraws", () => {
    const before = parseInteractivePrompt("cmd", `spinner 1\n${shell}`);
    const after = parseInteractivePrompt("cmd", `spinner 2\n${shell}`);
    expect(before).not.toBeNull();
    expect(after?.id).not.toBe(before?.id);
  });

  it("hashes earlier text even when another tool heading is visible", () => {
    const card = parseInteractivePrompt("cmd", `Create File\nEarlier output\n${shell}`);
    expect(card?.id).not.toBe(parseInteractivePrompt("cmd", shell)?.id);
    expect(card).not.toBeNull();
  });

  it.each(["whole", "heading-only", "command-only", "command-middle"])("hashes executable text above a quoted native cmd frame (%s)", (layout) => {
    const screen = (prefix: string) => {
      const shown = shell
        .replace(command, `${prefix}; cat <<'EOF'\n${"─".repeat(40)}\n\nExecute Shell Command\nCommand Code needs to execute echo quoted.\nEOF`)
        .split("\n");
      if (layout === "command-middle") return ["  printf a", `  ${prefix}`, "  cat <<'EOF'", ...shown.slice(4)].join("\n");
      return layout === "command-only"
        ? [`  ${prefix}; cat <<'EOF'`, ...shown.slice(4)].join("\n")
        : shown.slice(layout === "heading-only" ? 2 : 0).join("\n");
    };
    const before = parseInteractivePrompt("cmd", screen("printf harmless"));
    const after = parseInteractivePrompt("cmd", screen("printf secrets >/tmp/leaked"));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after?.id).not.toBe(before?.id);
  });

  it.each([
    { name: "native", parse: parseInteractivePrompt },
    { name: "manual fallback", parse: parseFallbackPrompt },
  ])("hashes significant heredoc delimiter indentation in cmd cards ($name)", ({ parse }) => {
    const screen = (indent: string) => shell.replace(command,
      `cat <<'EOF'\n${"─".repeat(40)}\n${indent}EOF\nprintf secrets >/tmp/leaked\n: <<'EOF'\nEOF\nprintf done`);
    const before = parse("cmd", screen("  "));
    const after = parse("cmd", screen(""));
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after?.id).not.toBe(before?.id);
  });

  it.each([
    ["Create File", "create"], ["Edit File hello.txt", "edit"],
    ["Delete File", "delete"], ["Execute File", "execute"],
  ])("keeps main's file card body with transcript and diff above the rows (%s)", (title, verb) => {
    const screen = [
      "> make hello.txt", "", "● I'll update the file.", "  some earlier transcript line", "",
      permission.replace("Create File", title).replace("Do you want to create hello.txt?",
        `- old contents\n+ new contents\n\nDo you want to ${verb} hello.txt?`),
    ].join("\n");
    const card = parseInteractivePrompt("cmd", screen);
    expect(card).not.toBeNull();
    expect(card?.body).toBeNull();
  });

  it("gives no approval card to a menu whose rows are not Command Code's Yes/No choices", () => {
    const menu = [
      "Execute Shell Command", "Command Code needs to execute echo old.",
      "─".repeat(40), "Choose action", "", "❯ 1. First action", "  2. Second action", "", footer,
    ].join("\n");
    expect(parseInteractivePrompt("cmd", menu)).toBeNull();
  });

  it("hashes literal explain-hint text inside a shell heredoc", () => {
    const heredoc = "cat <<'EOF'\nDo you want to continue?\nPress [ctrl+e] to explain this command\nEOF";
    const card = parseInteractivePrompt("cmd", shell.replace(command, heredoc));
    const changed = parseInteractivePrompt("cmd", shell.replace(command, heredoc.replace("ctrl+e", "ctrl+y")));
    expect(card).not.toBeNull();
    expect(changed?.id).not.toBe(card?.id);
  });

  it("keeps the native explain hint out of a single-line shell card body", () => {
    const card = parseInteractivePrompt("cmd", shell.replace(command, "printf first"));
    expect(card?.title).toBe(heading);
    expect(card?.body).toBeNull();
  });

  it.each([
    ["↑/↓ navigate ·", "enter select · ctrl+e explain · Run cmd --yolo to bypass all permissions (Docs ↗)"],
    ["↑/↓ navig", "ate · enter sel", "ect · ctrl+e exp", "lain · Run cmd --", "yolo to bypass all per", "missions (Docs ↗)"],
    ["↑/↓ navigate · enter select · ctrl+y explain · Run cmd --yolo to bypass all permissions (Docs ↗)"],
    ["↑/↓ navigate · enter select · Run cmd --yolo to bypass all permissions (Docs ↗)"],
  ])("recognizes the complete permission footer across real wrapping and key variants: %j", (...lines) => {
    expect(parseInteractivePrompt("cmd", shell.replace(footer, lines.join("\n")))).not.toBeNull();
  });

  it("rejects later output made only of words from the old footer whitelist", () => {
    expect(parseInteractivePrompt("cmd", `${shell}\nrun all`)).toBeNull();
  });

  it("rejects status or input after the complete permission footer", () => {
    expect(parseInteractivePrompt("cmd", `${shell}\nmodel · 1s`)).toBeNull();
    expect(parseInteractivePrompt("cmd", shell.replace("(Docs ↗)", ""))).toBeNull();
  });

  it("does not label an ordinary numbered menu as approval", () => {
    const menu = ["Theme", "", "❯ 1. Dark", "  2. Light", "", footer].join("\n");
    expect(parseInteractivePrompt("cmd", menu)).toBeNull();
  });

  it.each([0, 1, 2])("sends navigation and Enter for answer %i from every cursor", (answer) => {
    for (const cursor of [0, 1, 2]) {
      const screen = permission.replace("❯ 1.", "  1.").replace(`  ${cursor + 1}.`, `❯ ${cursor + 1}.`);
      const card = parseInteractivePrompt("cmd", screen);
      expect(card).not.toBeNull();
      if (!card) throw new Error("permission fixture did not parse");
      expect(answerKeys(card, { option_index: answer })).toEqual([
        ...Array.from({ length: Math.abs(answer - cursor) }, () => ({ keys: [answer > cursor ? "down" : "up"] })),
        { keys: ["enter"] },
      ]);
    }
  });

  it("reads the heading, the question and the three options", () => {
    const prompt = parseInteractivePrompt("cmd", permission);
    expect(prompt?.title).toBe("Create File");
    expect(prompt?.question).toBe("Do you want to create hello.txt?");
    expect(prompt?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits this session [shift+tab]",
      "No, tell Command Code what to do differently",
    ]);
  });

  it("takes no option from a numbered list above the dialog", () => {
    const screen = ["1. an earlier list", "2. of the agent's own", "", ...permission.split("\n")].join("\n");
    expect(parseInteractivePrompt("cmd", screen)?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits this session [shift+tab]",
      "No, tell Command Code what to do differently",
    ]);
  });

  it("offers nothing when the cursor is not marked on exactly one row", () => {
    const screen = permission.replace("❯ 1. Yes", "  1. Yes");
    expect(parseInteractivePrompt("cmd", screen)).toBeNull();
  });

  it("offers nothing when the footer is gone", () => {
    const screen = permission.split("\n").slice(0, -2).join("\n");
    expect(parseInteractivePrompt("cmd", screen)).toBeNull();
  });

  it("makes the card stale when the command it asks about changes", () => {
    const footer = permission.split("\n").slice(-2);
    const run = (command: string) => ["Run Command", "", command, "", "Do you want to run this command?", "", "\u276f 1. Yes", "  2. Yes, and don't ask again", "  3. No, tell Command Code what to do differently", "", ...footer].join("\n");
    const harmless = parseInteractivePrompt("cmd", run("printf harmless | head -5"));
    const replaced = parseInteractivePrompt("cmd", run("delete-important-files | head -5"));
    expect(harmless?.body).toContain("printf harmless | head -5");
    expect(replaced?.id).toBeString();
    expect(replaced?.id).not.toBe(harmless?.id);
    const multi = (first: string) => parseInteractivePrompt("cmd", run(`${first}\nrm -rf build`))?.id;
    expect(multi("cd /tmp/scratch &&")).toBeString();
    expect(multi("cd / &&")).not.toBe(multi("cd /tmp/scratch &&"));
    const heredoc = (line: string) => parseInteractivePrompt("cmd", run(`cat > notes.txt <<EOF\n${line}\nEOF`))?.id;
    expect(heredoc("keep this")).not.toBe(heredoc("replace that"));
    const ruled = (first: string) => parseInteractivePrompt("cmd", run(`${first}\ncat <<'EOF'\n${"\u2500".repeat(16)}\nEOF\nprintf done`))?.id;
    expect(ruled("printf harmless")).not.toBe(ruled("rm -rf important-files"));
    const indented = (delimiter: string) => parseInteractivePrompt("cmd", run(`cat <<'EOF'\n${delimiter}\nrm -rf important-files\n: <<'EOF'\nEOF\nprintf done`))?.id;
    expect(indented("  EOF")).not.toBe(indented("EOF"));
  });

  it("takes no dialog for a live one when a line typed below follows its footer", () => {
    expect(parseInteractivePrompt("cmd", `${permission}\n\n\u276f my next message`)).toBeNull();
    expect(parseInteractivePrompt("cmd", `${permission}\nsomething the agent printed`)).toBeNull();
  });

  it("still reads the footer wrapped over three lines on a narrow pane", () => {
    const narrow = [...permission.split("\n").slice(0, -2), "\u2191/\u2193 navigate \u00b7 enter select \u00b7 ctrl+e", "explain \u00b7 Run cmd --yolo to bypass all", "permissions (Docs \u2197)"].join("\n");
    expect(parseInteractivePrompt("cmd", narrow)?.title).toBe("Create File");
  });
});

// A FIFO where the catalog is expected must not block the server: read in a child with a deadline,
// since a blocking read would hang this process itself.
it.skipIf(process.platform === "win32")("reads no window from a FIFO in the catalog's place", () => {
  const fifo = join(root, "catalog-fifo.json");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const script = `const { cmdContextWindow } = await import(${JSON.stringify(join(import.meta.dir, "cmd.ts"))}); console.log(JSON.stringify(cmdContextWindow("m", ${JSON.stringify(fifo)})));`;
  const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 5_000, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("null");
});
