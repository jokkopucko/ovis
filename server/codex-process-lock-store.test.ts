import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processCodexHome } from "./codex.ts";

const thread = "01a19d71-a4ed-7fe3-b01c-8f4103953471";
const other = "01a1c13f-39cf-7db1-b730-db71be4a26a3";

it.skipIf(process.platform !== "linux").each([
  { label: "a resumed project rollout with its exclusive writer lock and no database", found: true },
  { label: "an open but unlocked writer file", unlocked: true, found: false },
  { label: "a shared writer lock", shared: true, found: false },
  { label: "a different thread's writer lock", mismatched: true, found: false },
  { label: "two stores with locked rollouts", ambiguous: true, found: false },
  { label: "a database store and a different locked store", databaseStore: true, found: false },
  { label: "a matching thread lock outside the rollout store", crossStore: true, found: false },
  { label: "a noninteractive locked rollout", source: "exec", found: false },
  { label: "a replaced writer lock path", replace: true, found: false },
  { label: "an explicit environment store overriding a locked rollout", explicit: true, found: true },
])("resolves $label", async ({ found, unlocked, shared, mismatched, ambiguous, source, replace, explicit, databaseStore, crossStore }) => {
  const root = mkdtempSync(join(tmpdir(), "ovis-codex-lock-store-"));
  const homes = [join(root, "project", ".codex"), ...(ambiguous ? [join(root, "other", ".codex")] : [])];
  const files: { rollout: string; lock: string }[] = [];
  for (const home of homes) {
    mkdirSync(join(home, "sessions", "2026", "11", "14"), { recursive: true });
    mkdirSync(join(home, "thread-writer-locks"));
    const rollout = join(home, "sessions", "2026", "11", "14", `rollout-${thread}.jsonl`);
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: thread, source: source ?? "cli" } }) + "\n");
    const lock = join(home, "thread-writer-locks", `${mismatched ? other : thread}.lock`);
    writeFileSync(lock, "");
    files.push({ rollout, lock });
  }
  if (crossStore) {
    const folder = join(root, "outside", "thread-writer-locks");
    mkdirSync(folder, { recursive: true });
    const lock = join(folder, `${thread}.lock`);
    renameSync(files[0]!.lock, lock);
    files[0]!.lock = lock;
  }
  const databases: string[] = [];
  if (databaseStore) {
    const home = join(root, "database-store");
    mkdirSync(join(home, "sessions"), { recursive: true });
    const database = join(home, "state_5.sqlite");
    const rollout = join(home, "sessions", `rollout-${other}.jsonl`);
    writeFileSync(database, "");
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: other, source: "cli" } }) + "\n");
    databases.push(database, rollout);
  }
  const named = join(root, "explicit");
  mkdirSync(named);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CODEX_HOME"));
  const child = Bun.spawn(["python3", "-u", "-c", [
    "import fcntl, json, os, sys",
    "files = json.loads(sys.argv[1])",
    "rollouts = [open(row['rollout']) for row in files]",
    "locks = [open(row['lock'], 'r+') for row in files]",
    "mode = sys.argv[2]",
    "databases = [open(path) for path in json.loads(sys.argv[3])]",
    "def acquire():",
    "    if mode != 'unlocked':",
    "        for file in locks: fcntl.flock(file, fcntl.LOCK_SH if mode == 'shared' else fcntl.LOCK_EX)",
    "acquire()",
    "print('ready', flush=True)",
    "for line in sys.stdin:",
    "    if line.strip() == 'unlock':",
    "        for file in locks: fcntl.flock(file, fcntl.LOCK_UN)",
    "    if line.strip() == 'lock': acquire()",
    "    print('done', flush=True)",
  ].join("\n"), JSON.stringify(files), unlocked ? "unlocked" : shared ? "shared" : "exclusive", JSON.stringify(databases)], {
    env: { ...env, ...(explicit ? { CODEX_HOME: named } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reply = lineReader(child.stdout);
    expect(await reply()).toBe("ready");
    if (replace) {
      renameSync(files[0]!.lock, `${files[0]!.lock}.old`);
      writeFileSync(files[0]!.lock, "replacement");
    }
    expect(await processCodexHome(child.pid)).toBe(explicit ? named : found ? homes[0]! : null);
    if (found && !explicit) {
      // The file stays open throughout: ownership must be rechecked, not inferred
      // from the pathname or cached from the previous successful lookup.
      child.stdin.write("unlock\n");
      await child.stdin.flush();
      expect(await reply()).toBe("done");
      expect(await processCodexHome(child.pid)).toBeNull();
      child.stdin.write("lock\n");
      await child.stdin.flush();
      expect(await reply()).toBe("done");
      expect(await processCodexHome(child.pid)).toBe(homes[0]!);
    }
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The child's replies, one whole line at a time. `python3 -u` writes a printed word and its newline
 * separately, so a pipe read can end between them: the newline alone is not the next reply.
 */
function lineReader(stdout: ReadableStream<Uint8Array>): () => Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return async () => {
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the lock holder exited after writing ${JSON.stringify(text)}`);
      text += decoder.decode(value, { stream: true });
    }
    const line = text.slice(0, text.indexOf("\n"));
    text = text.slice(line.length + 1);
    return line;
  };
}
