/**
 * The one guard of a locked PC (docs/account.md, "Strict mode"), asked where access is decided and nowhere else. While
 * this PC's log holds a lock, a request gets in only as a row whose key was approved on this PC's screen (`origin.from`
 * `pc`) or as PC-local: a loopback window that gave local proof on the confirm page. The access token, Portal, a
 * Tailscale login and the open LAN count for nothing. While the log cannot be read (strict) only PC-local gets in, so
 * the owner repairs the PC at its screen or with `ovis recover`.
 */
import type { Access } from "./access.ts";

export interface LockScope { readonly locked: boolean; readonly strict: boolean }

export function lockBoundary(access: Access, scope: LockScope, request: {
  localProof: boolean;
  /**
   * The request came from this PC's own programs, as the server itself knows (the bridge credential, the machine
   * profile's owner socket), never from what the request says. They keep working, and gain no screen act by it.
   */
  ownProgram?: boolean;
  originOf(rowId: string): { from: string; how: string } | null;
}): Access {
  if (access.level !== "full" || (!scope.locked && !scope.strict)) return access;
  const pcLocal = access.via === "local" && (request.localProof || request.ownProgram === true);
  if (pcLocal) return access;
  const reason = scope.strict ? "strict" : "locked";
  if (scope.strict) return { level: "none", reason };
  const rowFromScreen = (access.via === "device" || access.via === "relay") && access.device !== undefined
    && request.originOf(access.device.id)?.from === "pc";
  return rowFromScreen ? access : { level: "none", reason };
}

/**
 * The lock taking effect (T46, S24): what a lock no longer lets in ends in the turn the screen's approval writes it.
 * Rows end through the store (endUnlockedRows); a connection or stream let in on another grant (the access token, a
 * loopback window, Portal, a Tailscale login, the open LAN) listens here.
 */
export class LockSignal {
  readonly #listeners = new Set<() => void>();
  /** how many locks were written in this run: what was admitted before one cannot see it once it opens */
  #fired = 0;
  get fired(): number { return this.#fired; }
  on(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  fire(): void {
    this.#fired++;
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * The lifetime of a connection or stream let in on a grant a lock refuses, taken when its request is admitted. A lock
 * written between that admission and the moment it opens (a WebSocket handshake in flight) ends it as it opens.
 */
export function untilLockFrom(signal: LockSignal): (close: () => void) => () => void {
  const admittedAt = signal.fired;
  return (close) => {
    if (signal.fired !== admittedAt) { close(); return () => {}; }
    return signal.on(close);
  };
}
