import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { paneClose, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { TEST_SESSION } from "./test-herdr.ts";
import { shownRow } from "./shown-rows.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(process.env["OMP_COMPAT_APP_ROOT"] ?? repo);
const out = resolve(process.env["OMP_COMPAT_OUT"] ?? "/tmp/herdr-omp-compat/evidence");
const omp = resolve(process.env["OMP_BIN"] ?? "");
const ompVersion = process.env["OMP_VERSION"] ?? "unknown";
const childPath = process.env["PATH"] ?? "/usr/bin:/bin";
const herdr = process.env["OVIS_HERDR_BIN"] ?? Bun.which("herdr");
assert.ok(omp && omp !== resolve(""), "Set OMP_BIN to the exact isolated OMP release executable");
assert.ok(herdr, "herdr is required; run through scripts/check.ts admission");

const nativeResultPath = join(out, "native-result.json");
const appLogPath = join(out, "app-server.log");
const appErrorPath = join(out, "app-server.stderr.log");
const work = mkdtempSync(join(tmpdir(), "omp-question-compat-"));
const browserSession = `omp-${randomUUID().slice(0, 8)}`;
const execFileAsync = promisify(execFile);
mkdirSync(out, { recursive: true });
for (const file of ["report.json", "native-result.json", "terminal.txt", "desktop.png", "phone.png", "failure.png", "browser-failure.txt", "browser-errors.txt", "browser-dom.txt", "app-server.log", "app-server.stderr.log"]) {
  rmSync(join(out, file), { force: true });
}
const identity = {
  app_root: appRoot,
  app_revision: git(appRoot, "rev-parse", "HEAD"),
  app_version: JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version as string,
  parser_sha256: createHash("sha256").update(readFileSync(join(appRoot, "server/prompt.ts"))).digest("hex"),
  omp_version: ompVersion,
  omp_executable_version: run(omp, ["--version"]).split("\n")[0]?.trim(),
  herdr_version: run(herdr, ["--version"]).split("\n")[0]?.trim(),
  term: "xterm-256color",
  native_initial_viewport: [1280, 800],
  native_resize_viewport: [390, 1400],
};
assert.match(identity.omp_executable_version ?? "", new RegExp(`(?:^|/)${escapeRegExp(ompVersion)}(?:$|\\s)`),
  `OMP executable version must match resolved ${ompVersion}, got ${identity.omp_executable_version}`);

const questions = [
  { id: "route", header: "Transport", question: "Which route should carry the fictional session?", options: [
    { label: "Local socket", description: "Keeps the session on this PC." },
    { label: "Remote relay", description: "Uses the fictional remote endpoint." },
  ] },
  { id: "targets", header: "Targets", question: "Which synthetic targets should be checked?", multi: true, options: [
    { label: "Desktop", description: "Wide terminal layout." },
    { label: "Phone", description: "Narrow terminal layout." },
    { label: "Tablet", description: "Medium terminal layout." },
  ] },
  { id: "note", header: "Notes", question: "Add a fictional note for the report.", options: [
    { label: "Use the suggested note", description: "Keeps the synthetic report brief." },
    { label: "Use the fallback note", description: "Keeps a different synthetic report brief." },
  ] },
  { id: "wrap", header: "Narrow view", question: "Which fictional answer should remain readable when this question wraps across a narrow terminal?", options: [
    { label: "A fictional answer that wraps across the narrow native terminal", description: "A synthetic description that also wraps at narrow terminal widths." },
  ] },
];
const expected = [
  { id: "route", selected: ["Remote relay"] },
  { id: "targets", selected: ["Desktop", "Phone"] },
  { id: "note", custom: "fictional compatibility note" },
  { id: "wrap", selected: [questions[3]!.options[0]!.label] },
];

const provider = `
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { writeFileSync } from "node:fs";
const questions = ${JSON.stringify(questions)};
const expected = ${JSON.stringify(expected)};
export default function (pi) {
  pi.registerProvider("omp-compat", {
    baseUrl: "https://omp-compat.invalid/",
    apiKey: "fixture-only",
    api: "omp-compat-stream",
    models: [{ id: "native-questions", name: "Native question fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "ask");
        if (!result) {
          const toolCall = { type: "toolCall", id: "omp-compat-ask", name: "ask", arguments: { questions } };
          partial.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
          stream.push({ type: "done", reason: "toolUse", message: partial });
          return;
        }
        const actual = result.details?.results?.map(({ id, selectedOptions, customInput }) => ({ id, selectedOptions, ...(customInput === undefined ? {} : { customInput }) }));
        const wanted = expected.map((answer) => ({ id: answer.id, selectedOptions: answer.selected ?? [], ...(answer.custom === undefined ? {} : { customInput: answer.custom }) }));
        const ok = JSON.stringify(actual) === JSON.stringify(wanted);
        const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\\n");
        const record = { case: "native-ask-roundtrip", ok, expected: wanted, actual, tool_result: text, observed_at: new Date().toISOString() };
        writeFileSync(process.env.OMP_COMPAT_RESULT, JSON.stringify(record, null, 2) + "\\n");
        if (!ok) {
          const error = { ...partial, stopReason: "error", errorMessage: "Native OMP ask result did not match expected answers" };
          stream.push({ type: "error", reason: "error", error });
          return;
        }
        partial.content.push({ type: "text", text: "Native question compatibility answers verified." });
        partial.stopReason = "stop";
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "text_end", contentIndex: 0, content: "Native question compatibility answers verified.", partial });
        stream.push({ type: "done", reason: "stop", message: partial });
      });
      return stream;
    },
  });
}
`;

let workspaceId: string | undefined;
let paneId: string | undefined;
let appProcess: ReturnType<typeof Bun.spawn> | undefined;
let browserCli: string | undefined;
let browserEnvForCleanup: NodeJS.ProcessEnv | undefined;
const evidence: Record<string, unknown> = { ...identity, cases: [] as unknown[] };
try {
  writeFileSync(join(work, "provider.mjs"), provider);
  const cwd = join(work, "cwd");
  const ompHome = join(work, "home");
  const config = join(work, "config");
  const data = join(work, "data");
  const cache = join(work, "cache");
  for (const dir of [cwd, ompHome, config, data, cache, join(ompHome, ".omp", "agent")]) mkdirSync(dir, { recursive: true });
  const ws = await workspaceCreate({ cwd, label: "OMP question compatibility fixture" });
  workspaceId = ws.workspace.workspace_id;
  paneId = ws.root_pane.pane_id;
  const childEnv = [`PATH=${childPath}`, `HOME=${ompHome}`, `XDG_CONFIG_HOME=${config}`, `XDG_DATA_HOME=${data}`, `XDG_CACHE_HOME=${cache}`,
    `PI_CODING_AGENT_DIR=${join(ompHome, ".omp", "agent")}`, "PI_NO_TITLE=1", "OMP_SKIP_SETUP=1", "TERM=xterm-256color", "COLORTERM=truecolor",
    `OMP_COMPAT_RESULT=${nativeResultPath}`];
  const command = ["env", "-i", ...childEnv, omp, "--no-rules", "--no-skills", "--no-extensions", "--extension", join(work, "provider.mjs"),
    "--model", "omp-compat/native-questions", "--no-title", "--cwd", cwd,
    "Please run the synthetic native question compatibility scenario."].map(shellQuote).join(" ");

  const readyPath = join(work, "app-ready.json");
  const hostScript = join(work, "app-host.ts");
  writeFileSync(hostScript, `import { writeFileSync } from "node:fs";
import { createServer } from ${JSON.stringify(pathToFileURL(join(appRoot, "server/index.ts")).href)};
const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: ${JSON.stringify(join(work, "web-state"))}, registerBridge: false });
await app.statusReady;
writeFileSync(process.env.OMP_COMPAT_READY!, JSON.stringify({ port: app.port }));
process.on("SIGTERM", () => { app.stop(); process.exit(0); });
`);
  appProcess = Bun.spawn([process.execPath, hostScript], {
    env: {
      PATH: childPath, HOME: ompHome,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!, XDG_STATE_HOME: process.env.XDG_STATE_HOME!,
      HERDR_SOCKET: process.env.HERDR_SOCKET!, HERDR_TEST_SESSION: TEST_SESSION, OVIS_HERDR_BIN: herdr!,
      HERDR_TEST_DISPOSABLE_CONFIG: process.env.HERDR_TEST_DISPOSABLE_CONFIG!, OMP_COMPAT_READY: readyPath,
    },
    stdin: "ignore", stdout: Bun.file(appLogPath), stderr: Bun.file(appErrorPath),
  });
  await waitForFile(readyPath, 30_000);
  const appReady = JSON.parse(readFileSync(readyPath, "utf8")) as { port: number };
  const origin = `http://127.0.0.1:${appReady.port}/?view=chat&pane=${encodeURIComponent(paneId)}`;
  const cli = process.env["AGENT_BROWSER_BIN"] ?? Bun.which("agent-browser");
  assert.ok(cli, "agent-browser CLI is required for desktop and phone browser checks");
  const browserHome = join(work, "browser-home");
  const browserCache = join(work, "browser-cache");
  const browserEnv: NodeJS.ProcessEnv = { PATH: childPath, HOME: browserHome, XDG_CONFIG_HOME: join(work, "browser-config"), XDG_CACHE_HOME: browserCache, AGENT_BROWSER_SESSION: browserSession, AGENT_BROWSER_IDLE_TIMEOUT_MS: "0", AGENT_BROWSER_ARGS: "--no-sandbox" };
  mkdirSync(browserEnv.HOME!, { recursive: true }); mkdirSync(browserEnv.XDG_CONFIG_HOME!, { recursive: true }); mkdirSync(browserEnv.XDG_CACHE_HOME!, { recursive: true });
  const browserPath = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
  assert.ok(existsSync(browserPath), `Chromium is missing at ${browserPath}; install the lockfile browser with: bun node_modules/playwright-core/cli.js install --with-deps chromium`);
  browserEnv.AGENT_BROWSER_EXECUTABLE_PATH = browserPath;
  browserCli = cli;
  browserEnvForCleanup = browserEnv;
  const cases: Array<{ viewport: [number, number]; name: string }> = [
    { viewport: [1280, 800], name: "desktop" }, { viewport: [390, 844], name: "phone" },
  ];
  await browser(cli, browserEnv, ["set", "viewport", String(cases[0]!.viewport[0]), String(cases[0]!.viewport[1])]);
  await browser(cli, browserEnv, ["open", origin.replace("view=chat", "view=terminal")]);
  const initialRows = await waitForTerminalRows(cli, browserEnv, 15_000);
  await runAsync(herdr, ["--session", TEST_SESSION, "pane", "run", paneId, command], 15_000);
  let question = await waitForPrompt(origin, paneId, questions[0]!.question, 30_000);
  const initialScreen = await safeReadPane(herdr, TEST_SESSION, paneId);
  const initialBorder = initialScreen.split("\n").filter((line) => line.includes("╭─ Ask")).at(-1);
  assert.ok(initialBorder, "the native OMP Ask dialog must be visible after browser sizing");
  evidence.native_initial_pty = { columns: [...initialBorder].length, rows: initialRows };
  await browser(cli, browserEnv, ["click", ".view-switch button:nth-child(1)"]);
  for (let index = 0; index < questions.length; index += 1) {
    const fixture = questions[index]!;
    assert.equal(question.question, fixture.question, `OMP question ${index + 1} is parsed in order`);
    assert.deepEqual(question.options, fixture.options.map((option) => option), `OMP question ${index + 1} has exactly the expected options and descriptions`);
    await assertVisiblePrompt(cli, browserEnv, fixture.question, fixture.options);
    if (index === 0) await browser(cli, browserEnv, ["screenshot", join(out, "desktop.png")]);
    if (index === 3) {
      await browser(cli, browserEnv, ["set", "viewport", String(cases[1]!.viewport[0]), "1400"]);
      await browser(cli, browserEnv, ["click", ".app-header .lens-toggle"]);
      const nativeRows = await waitForTerminalRows(cli, browserEnv, 30_000);
      assert.ok(nativeRows > 24, `tall native terminal should expose more than 24 rows (got ${nativeRows})`);
      const nativeLayout = await waitForNativeLayout(herdr!, TEST_SESSION, paneId, 76, fixture.question, [...fixture.options.map((option) => option.label), "Other (type your own)"], 30_000);
      evidence.native_wrap_pty = { attached_columns: nativeLayout.columns, attached_rows: nativeRows, browser_viewport: [390, 1400] };
      await browser(cli, browserEnv, ["click", ".app-header .lens-toggle"]);
      await browser(cli, browserEnv, ["set", "viewport", String(cases[1]!.viewport[0]), String(cases[1]!.viewport[1])]);
      const drawerOpen = JSON.parse(await browser(cli, browserEnv, ["eval", "document.querySelector('#workspace-drawer.is-open') !== null"])) as boolean;
      if (drawerOpen) await browser(cli, browserEnv, ["eval", "document.querySelector('.drawer-close')?.click()"]);
      question = await waitForPrompt(origin, paneId, fixture.question, 30_000);
      assert.equal(question.question, fixture.question, "narrow terminal resize preserves the exact wrapped question");
      await assertVisiblePrompt(cli, browserEnv, fixture.question, fixture.options);
      await browser(cli, browserEnv, ["close"]);
      // The closed daemon can still be exiting; a new session must not reuse its socket.
      browserEnv.AGENT_BROWSER_SESSION = `${browserSession}-phone`;
      await browser(cli, browserEnv, ["set", "viewport", String(cases[1]!.viewport[0]), String(cases[1]!.viewport[1])]);
      await browser(cli, browserEnv, ["open", origin]);
      question = await waitForPrompt(origin, paneId, fixture.question, 30_000);
      assert.equal(question.question, fixture.question, "phone page opens on the exact current question");
      assert.deepEqual(question.options, fixture.options, "phone page opens with exactly the expected options and descriptions");
      await assertVisiblePrompt(cli, browserEnv, fixture.question, fixture.options);
      const layout = await waitForPhoneLayout(cli, browserEnv, 15_000);
      evidence.phone_sidebar = layout.sidebar;
      await browser(cli, browserEnv, ["screenshot", join(out, "phone.png")]);
    }
    (evidence.cases as unknown[]).push({ name: fixture.id, question: question.question, options: question.options, viewport: index < 3 ? cases[0]!.viewport : cases[1]!.viewport });
    if (fixture.id === "targets") {
      await browser(cli, browserEnv, ["check", ".prompt-card .prompt-card-option:nth-child(1) input"]);
      await browser(cli, browserEnv, ["check", ".prompt-card .prompt-card-option:nth-child(2) input"]);
      await browser(cli, browserEnv, ["click", ".prompt-card .prompt-card-submit"]);
    } else if (fixture.id === "note") {
      await browser(cli, browserEnv, ["fill", ".prompt-card-custom input", "fictional compatibility note"]);
      await browser(cli, browserEnv, ["click", ".prompt-card-custom button"]);
    } else {
      await browser(cli, browserEnv, ["click", `.prompt-card .prompt-card-options button.prompt-card-option:nth-child(${fixture.id === "route" ? 2 : 1})`]);
    }
    if (index + 1 < questions.length) question = await waitForPrompt(origin, paneId, questions[index + 1]!.question, 30_000, question.question);
    else {
      const review = await waitForPromptOrResult(origin, paneId, question.question, "Submit these answers?", nativeResultPath, 30_000);
      assert.ok(review, "OMP must expose its final Review answers card before completing the ask tool");
      assert.equal(review.title, "Review answers");
      assert.equal(review.question, "Submit these answers?");
      assert.deepEqual(review.options, [{ label: "Submit", description: null }, { label: "Cancel", description: null }]);
      await assertVisiblePrompt(cli, browserEnv, review.question, review.options);
      (evidence.cases as unknown[]).push({ name: "review-submit", question: review.question, options: review.options, viewport: cases[1]!.viewport });
      await browser(cli, browserEnv, ["click", ".prompt-card .prompt-card-options button.prompt-card-option:first-child"]);
    }
  }
  await waitForFile(nativeResultPath, 30_000);
  const nativeResult = JSON.parse(readFileSync(nativeResultPath, "utf8")) as { ok: boolean; tool_result: string; case: string };
  assert.equal(nativeResult.ok, true, `OMP's built-in ask tool result mismatch: ${nativeResult.tool_result}`);
  assert.equal(nativeResult.case, "native-ask-roundtrip");
  evidence.native_result_file = "native-result.json";
  evidence.native_result = nativeResult;
  evidence.status = "passed";
  console.log(`PASS native OMP ask result roundtrip (${identity.omp_version}; app ${identity.app_revision}; parser ${identity.parser_sha256.slice(0, 12)})`);
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
} finally {
  if (evidence.status === "failed" && browserCli && browserEnvForCleanup) {
    await browser(browserCli, browserEnvForCleanup, ["screenshot", join(out, "failure.png")]).catch(() => "");
    const snapshot = await browser(browserCli, browserEnvForCleanup, ["snapshot"]).catch((error) => String(error));
    writeFileSync(join(out, "browser-failure.txt"), snapshot);
    const dom = await browser(browserCli, browserEnvForCleanup, ["eval", "({title:document.title,url:location.href,body:document.body?.innerText?.slice(0,12000),promptCards:document.querySelectorAll('.prompt-card').length,conversationUnavailable:document.body?.innerText?.includes('Conversation unavailable')??false,terminalRows:document.querySelectorAll('.xterm-rows > div').length,terminalHeight:document.querySelector('.xterm-screen')?.getBoundingClientRect().height})"]).catch((error) => String(error));
    writeFileSync(join(out, "browser-dom.txt"), dom);
    const errors = await browser(browserCli, browserEnvForCleanup, ["errors"]).catch((error) => String(error));
    writeFileSync(join(out, "browser-errors.txt"), errors);
  }
  if (browserCli && browserEnvForCleanup) await browser(browserCli, browserEnvForCleanup, ["close"]).catch(() => "");
  if (appProcess) {
    appProcess.kill("SIGTERM");
    await Promise.race([appProcess.exited, Bun.sleep(5_000)]);
    if (appProcess.exitCode === null) appProcess.kill("SIGKILL");
  }
  writeFileSync(join(out, "terminal.txt"), paneId ? await safeReadPane(herdr!, TEST_SESSION, paneId) : "No OMP pane was created.\n");
  if (paneId) await paneClose(paneId).catch(() => undefined);
  if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
  if (existsSync(nativeResultPath)) evidence.native_result = JSON.parse(readFileSync(nativeResultPath, "utf8"));
  writeFileSync(join(out, "report.json"), JSON.stringify(evidence, null, 2) + "\n");
  rmSync(work, { recursive: true, force: true });
}

async function waitForPrompt(origin: string, pane: string, expectedQuestion: string, timeoutMs: number, previousQuestion?: string): Promise<InteractivePrompt> {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    const response = await fetch(`${new URL(origin).origin}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Prompt API failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { prompt: InteractivePrompt | null };
    if (body.prompt?.question === expectedQuestion) return body.prompt;
    if (body.prompt && body.prompt.question !== previousQuestion) throw new Error(`Unexpected parsed question while waiting for ${JSON.stringify(expectedQuestion)}: ${JSON.stringify(body.prompt.question)}`);
    last = await safeReadPane(herdr!, TEST_SESSION, pane);
    await Bun.sleep(500);
  }
  throw new Error(`OMP did not expose a parsed question before timeout. Last terminal output:\n${last}`);
}

async function waitForTerminalRows(binary: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<number> {
  const end = Date.now() + timeoutMs;
  let rows = 0;
  while (Date.now() < end) {
    rows = Number(await browser(binary, env, ["eval", `document.querySelectorAll(${JSON.stringify(shownRow())}).length`]));
    if (rows > 24) return rows;
    await Bun.sleep(250);
  }
  throw new Error(`The tall terminal attach did not grow beyond 24 rows (got ${rows})`);
}

async function waitForNativeLayout(binary: string, session: string, pane: string, below: number, expectedQuestion: string, expectedOptions: string[], timeoutMs: number): Promise<{ columns: number }> {
  const end = Date.now() + timeoutMs;
  let lastWidth: number | undefined;
  let last = "";
  while (Date.now() < end) {
    last = await safeReadPane(binary, session, pane);
    const askBorder = last.split("\n").filter((line) => line.includes("╭─ Ask")).at(-1);
    if (askBorder) {
      lastWidth = [...askBorder].length;
      const activeDialog = last.slice(last.lastIndexOf("╭─ Ask")).split("\n")
        .map((line) => line.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").replaceAll("█", ""))
        .join(" ").replace(/\s+/g, " ");
      if (lastWidth < below && activeDialog.includes(expectedQuestion) && expectedOptions.every((option) => activeDialog.includes(option))) {
        return { columns: lastWidth };
      }
    }
    await Bun.sleep(250);
  }
  throw new Error(`The owned OMP pane did not show the full wrapped question and every option below ${below} columns (last width ${lastWidth ?? "unavailable"}).\n${last}`);
}

async function waitForPhoneLayout(binary: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
  card: { left: number; right: number; width: number }; viewport: number; overflow: boolean;
  sidebar: { left: number; right: number; width: number; open: boolean; visible: boolean };
}> {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    last = await browser(binary, env, ["eval", "({card:(()=>{const r=document.querySelector('.prompt-card')?.getBoundingClientRect();return r?{left:r.left,right:r.right,width:r.width}:null})(),viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,sidebar:(()=>{const s=document.querySelector('.sidebar'),r=s?.getBoundingClientRect(),c=s&&getComputedStyle(s);return r?{left:r.left,right:r.right,width:r.width,open:s.classList.contains('is-open'),visible:c.visibility!=='hidden'&&r.width>0&&r.right>0&&r.left<innerWidth}:null})()})"]);
    const layout = JSON.parse(last) as {
      card: { left: number; right: number; width: number } | null; viewport: number; overflow: boolean;
      sidebar: { left: number; right: number; width: number; open: boolean; visible: boolean } | null;
    };
    if (layout.card && layout.sidebar && layout.card.width <= layout.viewport && !layout.overflow && !layout.sidebar.open
      && (!layout.sidebar.visible || layout.sidebar.right <= layout.card.left || layout.sidebar.left >= layout.card.right)) {
      return { ...layout, card: layout.card, sidebar: layout.sidebar };
    }
    await Bun.sleep(250);
  }
  throw new Error(`Phone layout did not settle with one visible card, no horizontal overflow, and a closed or unobscuring sidebar: ${last}`);
}

async function waitForPromptOrResult(origin: string, pane: string, previousQuestion: string, expectedQuestion: string, result: string, timeoutMs: number): Promise<InteractivePrompt | null> {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    const response = await fetch(`${new URL(origin).origin}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Prompt API failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { prompt: InteractivePrompt | null };
    if (body.prompt?.question === expectedQuestion) return body.prompt;
    if (body.prompt && body.prompt.question !== previousQuestion) throw new Error(`Unexpected parsed question while waiting for ${JSON.stringify(expectedQuestion)}: ${JSON.stringify(body.prompt.question)}`);
    if (existsSync(result)) return null;
    last = await safeReadPane(herdr!, TEST_SESSION, pane);
    await Bun.sleep(500);
  }
  throw new Error(`OMP did not expose the final Review answers card before timeout. Last terminal output:\n${last}`);
}

async function assertVisiblePrompt(binary: string, env: NodeJS.ProcessEnv, expectedQuestion: string, expectedOptions: InteractivePrompt["options"]): Promise<void> {
  let visible: { count: number; question?: string; options: Array<{ label?: string; description: string | null }> } = { count: 0, options: [] };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    visible = JSON.parse(await browser(binary, env, ["eval", "({count:document.querySelectorAll('.prompt-card').length,question:document.querySelector('.prompt-card-question')?.textContent?.trim(),options:[...document.querySelectorAll('.prompt-card-option')].map((row)=>({label:row.querySelector('.prompt-card-option-label')?.textContent?.trim(),description:row.querySelector('.prompt-card-option-description')?.textContent?.trim()??null}))})"])) as typeof visible;
    if (visible.count === 1 && visible.question === expectedQuestion && JSON.stringify(visible.options) === JSON.stringify(expectedOptions)) return;
    await Bun.sleep(250);
  }
  assert.equal(visible.count, 1, `browser should show exactly one prompt card: ${JSON.stringify(visible)}`);
  assert.equal(visible.question, expectedQuestion, "visible card shows the exact question");
  assert.deepEqual(visible.options, expectedOptions, "visible card shows exactly the expected labels and descriptions");
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { readFileSync(path); return; } catch { await Bun.sleep(250); }
  }
  throw new Error(`The fake provider did not verify OMP's ask result: ${path}`);
}

async function browser(binary: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(binary, args, { env, encoding: "utf8", timeout: 20_000 });
    return result.stdout.trim();
  } catch (error) {
    const cause = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`agent-browser ${args[0]} failed: ${cause.stderr || cause.stdout || cause.message}`);
  }
}

async function safeReadPane(binary: string, session: string, pane: string): Promise<string> {
  try {
    const result = await execFileAsync(binary, ["--session", session, "pane", "read", "--source", "visible", "--format", "text", pane], { encoding: "utf8", timeout: 5_000 });
    return result.stdout;
  } catch (error) {
    return `Unable to capture owned OMP pane: ${String(error)}`;
  }
}

async function runAsync(binary: string, args: string[], timeout: number): Promise<void> {
  try { await execFileAsync(binary, args, { encoding: "utf8", timeout }); }
  catch (error) {
    const cause = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`Command failed: ${binary} ${args.join(" ")}: ${cause.stderr || cause.stdout || cause.message}`);
  }
}

function run(binary: string, args: string[]): string {
  const result = execFileSync(binary, args, { encoding: "utf8", timeout: 10_000 });
  return result.trim();
}

function git(cwd: string, ...args: string[]): string { return run("git", ["-C", cwd, ...args]); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
