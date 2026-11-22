import type { OmoTask } from "../shared/protocol.ts";
import { PARENT_WINDOW, type ClaudeSubagentStatus } from "./claude-subagents.ts";
import { historyVersion, waitCommandHistory } from "./claude-command-history.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";

interface Scan { promise: Promise<OmoTask[]>; waiters: number; abort: AbortController }
const scans = new Map<string, Scan>();

export function scanClaudeTasks(session: NonNullable<ReturnType<ClaudeSubagentStatus["sessionOf"]>>, signal?: AbortSignal): Promise<OmoTask[]> {
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  const { path, live, startedAt: since, read } = session;
  const key = JSON.stringify([path, live, since, read]);
  let scan = scans.get(key);
  if (scan?.abort.signal.aborted) scan = undefined;
  if (scan === undefined) {
    const abort = new AbortController();
    const promise = (async () => {
      const tasks = await fileTask<OmoTask[]>({ op: "claude-tasks", path, live, since }, abort.signal);
      const version = historyVersion(path);
      if (!version || version.size <= PARENT_WINDOW || !tasks.some((task) => task.category === "shell" && (task.status === "running" || task.status === "lost"))) return tasks;
      const history = await waitCommandHistory(path, version.size, 10_000, abort.signal);
      if (abort.signal.aborted) throw new FileBusyError("the request was cancelled");
      return fileTask<OmoTask[]>({ op: "claude-tasks", path, live, since, history }, abort.signal);
    })();
    scan = { promise, waiters: 0, abort };
    scans.set(key, scan);
    const started = scan;
    const done = () => { if (scans.get(key) === started) scans.delete(key); };
    void promise.then(done, done);
  }
  const shared = scan;
  shared.waiters++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      if (--shared.waiters === 0) shared.abort.abort();
    };
    const cancel = () => { release(); reject(new FileBusyError("the request was cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    void shared.promise.then((tasks) => { release(); resolve(tasks); }, (error) => { release(); reject(error); });
  });
}
