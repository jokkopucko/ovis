import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { t } from "./i18n.ts";

/** A remote PC's read crosses the machine proxy as well, so it gets twice the local deadline. */
export function chatReadDeadlineMs(machineId: string): number {
  return machineId === LOCAL_MACHINE ? 15_000 : 30_000;
}

/**
 * Covers headers and body; even an implementation ignoring abort cannot hold the reader. A missed
 * deadline rejects with a `TimeoutError`, the name userErrorMessage reads as a timeout.
 */
export async function withChatReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The read was cancelled.", "AbortError");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(signal?.reason ?? new DOMException("The read was cancelled.", "AbortError"));
      controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new DOMException(t("Chat read timed out."), "TimeoutError")); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([read(controller.signal), deadline, cancelled]); }
  finally {
    clearTimeout(timer!);
    if (cancel !== undefined) signal?.removeEventListener("abort", cancel);
  }
}
