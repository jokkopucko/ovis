import type { SessionHistoryAgent, SessionHistoryResponse } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";

// Match the file_busy skill-list policy: five pauses, with Retry-After capped at one minute.
const BUSY_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

export async function readSessionHistory(
  read: () => Promise<SessionHistoryResponse>,
  agent: SessionHistoryAgent,
  options: {
    readonly signal: AbortSignal;
    readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<SessionHistoryResponse> {
  const wait = options.wait ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  }));
  for (let tries = 0; ; tries++) {
    options.signal.throwIfAborted();
    try {
      return await read();
    } catch (reason) {
      options.signal.throwIfAborted();
      const pause = BUSY_RETRY_MS[tries];
      if (agent !== "pi" || !(reason instanceof ApiError) || reason.status !== 503 || reason.code !== "session_history_busy" || pause === undefined) throw reason;
      await wait(Math.min(Math.max(pause, reason.retryAfterMs ?? 0), 60_000), options.signal);
    }
  }
}
