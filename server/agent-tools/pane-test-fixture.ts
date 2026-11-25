import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/harness-tool.ts";
import type { PaneTerminal } from "./pane-proof.ts";

const CLI = join(import.meta.dir, "../../scripts/plugin-agent.ts");
export const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
export const callerArgv = (words: readonly string[]): string[] => [process.execPath, "-e", `const { runAgent } = await import(${JSON.stringify(CLI)}); process.exit(await runAgent(${JSON.stringify(words)}));`];
export const code = (reply: Record<string, unknown>): unknown => isRecord(reply.error) ? reply.error.code : undefined;

function parseReply(line: string): Record<string, unknown> {
  const reply: unknown = JSON.parse(line);
  if (!isRecord(reply)) throw new Error("invalid pane reply");
  return reply;
}

export function paneRuns(path: string) {
  const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error("missing pane runs");
  return rows.map((row: unknown) => {
    if (!isRecord(row) || !isRecord(row.run) || typeof row.run.id !== "string" || typeof row.run.self !== "string" || !Array.isArray(row.calls)) throw new Error("invalid pane run");
    return { id: row.run.id, self: row.run.self, calls: row.calls.length };
  });
}

export function paneCallers(state: () => string, opened: (terminal: PaneTerminal) => void) {
  const callerEnv = (hint?: string) => ({
    PATH: process.env["PATH"] ?? "", HOME: state(), OVIS_STATE_DIR: state(), ...(hint ? { HC_TERMINAL_ID: hint } : {}),
  });
  const register = (address: string, pid: number) => opened({ address, state: "live", pid, created_ms: pid, labels: {} });

  /** A pane root shell that starts the command after the test has registered the pane. */
  async function inPane(address: string, words: readonly string[], options: { hint?: string } = {}) {
    const shell = Bun.spawn(["/bin/sh", "-c", 'read go; "$@"; status=$?; exit $status', "pane", ...callerArgv(words)], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: callerEnv(options.hint) });
    register(address, shell.pid);
    shell.stdin.write("go\n"); await shell.stdin.end();
    return { reply: parseReply(await new Response(shell.stdout).text()), code: await shell.exited };
  }

  async function outside(words: readonly string[]) {
    const caller = Bun.spawn(callerArgv(words), { stdout: "pipe", stderr: "inherit", env: callerEnv() });
    return { code: await caller.exited, reply: parseReply(await new Response(caller.stdout).text()) };
  }

  /** A pane root shell that stays up between calls, running each command as its own child. */
  async function holdPane(address: string, hint?: string) {
    const shell = Bun.spawn(["/bin/sh", "-c", 'while read -r line; do eval "$line"; done'], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: callerEnv(hint) });
    register(address, shell.pid);
    const reader = shell.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const line = async () => {
      for (;;) {
        const at = buffered.indexOf("\n");
        if (at >= 0) { const out = buffered.slice(0, at); buffered = buffered.slice(at + 1); return out; }
        const { value, done } = await reader.read();
        if (done) throw new Error("pane shell ended");
        buffered += decoder.decode(value, { stream: true });
      }
    };
    const run = async (text: string, count: number) => {
      shell.stdin.write(`${text}\n`);
      await shell.stdin.flush();
      const out: Record<string, unknown>[] = [];
      while (out.length < count) out.push(parseReply(await line()));
      return out;
    };
    return {
      run,
      call: async (words: readonly string[]) => {
        const [reply] = await run(callerArgv(words).map(quote).join(" "), 1);
        if (!reply) throw new Error("no pane reply");
        return reply;
      },
      close: async () => { await shell.stdin.end(); await shell.exited; },
    };
  }
  return { callerEnv, inPane, outside, holdPane };
}
