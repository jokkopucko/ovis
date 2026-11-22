import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callBroker } from "../../../server/browser-mcp.ts";
import type { BrowserContent } from "../../../shared/browser-broker.ts";

/**
 * The agents' socket of the built-in browser in a real Electron (Linux, without a display): a call
 * works only with a pane's token while its file holds it, sees only that pane's tabs, never reads a
 * password, waits while the person holds the tab, and acts on the page as input would.
 */
const linux = process.platform === "linux";
const PASSWORD = "hunter2-secret";
const UNLABELED = "unlabeled-secret-value";
let root: string;
let site: ReturnType<typeof Bun.serve>;
let run: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
const submitted: string[] = [];
let onSubmitted: (() => void) | null = null;
let lines: AsyncIterator<string>;

const FORM = `<!doctype html><title>Form</title><h1>Sign in</h1>
<button id="b" style="position:absolute;left:20px;top:80px;width:120px;height:40px" onclick="window.presses = (window.presses || 0) + 1; document.title = 'clicked ' + window.presses">Press me</button>
<form action="/submitted" style="position:absolute;left:20px;top:160px"><input name="q" aria-label="Search"><input type="password" aria-label="Password" value="${PASSWORD}"></form>
<div style="position:absolute;left:20px;top:240px"><input value="${UNLABELED}"><textarea>${UNLABELED}</textarea><div contenteditable="true">${UNLABELED}</div></div>
<a href="/popup-page" target="_blank" style="position:absolute;left:20px;top:320px">Open more</a>`;

async function* stdoutLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffered = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      yield buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
    }
  }
}

async function until(prefix: string): Promise<string> {
  for (;;) {
    const next = await lines.next();
    if (next.done) throw new Error(`The harness ended before ${prefix}`);
    if (next.value.startsWith(prefix)) return next.value;
  }
}

const tokens = { a: "a".repeat(40), b: "b".repeat(40) };
const call = (pane: keyof typeof tokens, tool: string, args: Record<string, unknown> = {}) => callBroker(join(root, "socket", "broker.sock"), join(root, "tokens", `${pane}.token`), tool, args);
const words = (content: BrowserContent[]) => content.map((part) => part.type === "text" ? part.text : "").join("\n");

beforeAll(async () => {
  if (!linux) return;
  root = mkdtempSync(join(tmpdir(), "ovis-browser-broker-"));
  mkdirSync(join(root, "tokens"));
  for (const [pane, token] of Object.entries(tokens)) writeFileSync(join(root, "tokens", `${pane}.token`), token, { mode: 0o600 });
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/submitted") { submitted.push(url.search); onSubmitted?.(); }
      return new Response(url.pathname === "/form" ? FORM : "<title>Done</title>ok", { headers: { "content-type": "text/html" } });
    },
  });
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "browserBroker.harness.ts")], outdir: join(root, "build"), target: "node", format: "cjs", external: ["electron"] });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const electron = resolve(import.meta.dir, "..", "node_modules", "electron", "dist", "electron");
  run = Bun.spawn([electron, "--no-sandbox", "--ozone-platform=headless", "--disable-gpu", join(root, "build", "browserBroker.harness.js")], {
    env: { ...process.env, OVIS_TEST_ROOT: root, OVIS_TEST_PORT: String(site.port), ELECTRON_ENABLE_LOGGING: "" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 60_000,
  });
  lines = stdoutLines(run.stdout)[Symbol.asyncIterator]();
  await until("READY");
});

afterAll(async () => {
  if (!linux) return;
  run.stdin.write("quit\n");
  await run.exited;
  site.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function harness(line: string): Promise<void> {
  run.stdin.write(`${line}\n`);
  await until(`DONE ${line}`);
}

describe.skipIf(!linux)("the built-in browser's agent socket in Electron", () => {
  it("lets an agent use only its own tabs, never a password, and not while the person holds the tab", async () => {
    const A = `http://a.localhost:${site.port}`;
    expect(process.platform === "linux" && (statSync(join(root, "socket", "broker.sock")).mode & 0o777)).toBe(0o600);
    expect(statSync(join(root, "socket")).mode & 0o777).toBe(0o700);

    const stranger = await callBroker(join(root, "socket", "broker.sock"), join(root, "missing.token"), "browser_tabs", {});
    expect(stranger.isError).toBe(true);
    writeFileSync(join(root, "forged.token"), "f".repeat(40));
    expect(words((await callBroker(join(root, "socket", "broker.sock"), join(root, "forged.token"), "browser_tabs", {})).content)).toContain("not open to this agent");

    expect(words((await call("a", "browser_open", { url: `http://b.localhost:${site.port}/` })).content)).toContain("was not opened");
    const opened = await call("a", "browser_open", { url: `${A}/form?token=secret` });
    expect(opened.isError).toBeUndefined();
    const tab = JSON.parse(words(opened.content)) as { id: number; address: string; profile: string };
    expect(tab).toMatchObject({ address: `${A}/form`, profile: "agent" });

    expect(JSON.parse(words((await call("b", "browser_tabs")).content))).toEqual([]);
    expect(words((await call("b", "browser_snapshot", { tab: tab.id })).content)).toContain("No such tab of yours");

    const outline = words((await call("a", "browser_snapshot", { tab: tab.id })).content);
    expect(outline).toContain(`Address: ${A}/form`);
    expect(outline).toContain('heading "Sign in"');
    expect(outline).toMatch(/@e\d+ text input "Password"/);
    expect(outline).not.toContain(PASSWORD);
    expect(outline).not.toContain(UNLABELED);
    const ref = (label: string) => new RegExp(`(@e\\d+) [^\\n]*"${label}"`).exec(outline)?.[1];

    // two calls on the same ref both land; whether they overlap inside the app is up to its scheduling
    const both = await Promise.all([call("a", "browser_click", { tab: tab.id, ref: ref("Press me") }), call("a", "browser_click", { tab: tab.id, ref: ref("Press me") })]);
    expect(both.map((answer) => words(answer.content))).toEqual(["Clicked.", "Clicked."]);
    expect(words((await call("a", "browser_snapshot", { tab: tab.id })).content)).toContain("Title: clicked 2");
    expect(words((await call("a", "browser_screenshot", { tab: tab.id })).content)).toContain("not on the user's screen");

    const arrived = new Promise<void>((done, failed) => {
      const timer = setTimeout(() => failed(new Error("the form was never submitted")), 10_000);
      onSubmitted = () => { clearTimeout(timer); done(); };
    });
    expect(words((await call("a", "browser_type", { tab: tab.id, ref: ref("Search"), text: "hello there", submit: true })).content)).toBe("Typed.");
    await arrived;
    expect(submitted[0]).toStartWith("?q=hello+there");

    // a window the page opens is a tab of the same pane: listed for it, for no other
    // the form went to /submitted: back to the page with the link, and a fresh snapshot for its ref
    expect(words((await call("a", "browser_navigate", { tab: tab.id, url: `${A}/form` })).content)).toBe("Loading.");
    const linked = await new Promise<string>((done, failed) => {
      const deadline = Date.now() + 10_000;
      const look = async () => {
        const text = words((await call("a", "browser_snapshot", { tab: tab.id })).content);
        if (text.includes("Open more")) return done(text);
        if (Date.now() > deadline) return failed(new Error("the form page never came back"));
        setImmediate(() => void look());
      };
      void look();
    });
    const link = /(@e\d+) [^\n]*"Open more"/.exec(linked)?.[1];
    expect(words((await call("a", "browser_click", { tab: tab.id, ref: link })).content)).toBe("Clicked.");
    const popup = await new Promise<{ id: number; address: string }>((done, failed) => {
      const deadline = Date.now() + 10_000;
      const look = async () => {
        const mine = JSON.parse(words((await call("a", "browser_tabs")).content)) as { id: number; address: string }[];
        const found = mine.find((entry) => entry.address.endsWith("/popup-page"));
        if (found) return done(found);
        if (Date.now() > deadline) return failed(new Error("the opened window was never listed for its pane"));
        setImmediate(() => void look());
      };
      void look();
    });
    expect(JSON.parse(words((await call("b", "browser_tabs")).content))).toEqual([]);
    expect(words((await call("a", "browser_close", { tab: popup.id })).content)).toBe("Closed.");

    await harness(`hold ${tab.id}`);
    expect(words((await call("a", "browser_snapshot", { tab: tab.id })).content)).toContain("taken control");
    expect(JSON.parse(words((await call("a", "browser_tabs")).content))).toEqual([expect.objectContaining({ id: tab.id, held: true })]);

    rmSync(join(root, "tokens", "a.token"));
    writeFileSync(join(root, "a-again.token"), tokens.a);
    expect(words((await callBroker(join(root, "socket", "broker.sock"), join(root, "a-again.token"), "browser_tabs", {})).content)).toContain("not open to this agent");

    await harness("stop");
    expect(existsSync(join(root, "tokens", "b.token"))).toBe(false);
    expect(existsSync(join(root, "socket", "broker.sock"))).toBe(false);
  }, 60_000);
});
