/**
 * Proof from this PC's own screen (docs/account.md, "Confirmed on this PC"): one named act, asked for by whoever
 * may ask, answered on a screen of this PC that no caller of Ovis' routes can supply, and used up once by the code
 * that does the act. Only two paths answer one: the desktop-owner channel, a descriptor the desktop app that started
 * this server holds the other end of, and the local confirm listener, a page on 127.0.0.1 of its own that is not
 * the server's dispatcher, the relay or any route. Every answer is in memory: a restart ends every open confirm.
 *
 * What it does not prove: that a person sat there. A program that runs as this PC's user, a terminal a device that
 * drives this PC opened included, can reach the listener and the descriptor as the owner does, and change the files
 * the acts write; Ovis has no boundary there.
 */
import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CONFIRM_MS } from "../../shared/account-devices-api.ts";
import { machineForwardingHeaders } from "../access.ts";
import { writePrivateState } from "../private-state.ts";

export type ScreenAction =
  | { kind: "lock" }
  | { kind: "unlock"; lock: string }
  | { kind: "end_block"; block: string }
  | { kind: "confirm_device"; row: string }
  | { kind: "approve_key"; pending: string; fingerprint: string }
  | { kind: "approve_replacement"; row: string; fingerprint: string }
  | { kind: "leave_account" }
  | { kind: "forget_removal"; key: string }
  | { kind: "forget_revoke"; revoke: string };

/** What the screen shows for an act; `fingerprint` is always the one the act itself names, for an act that admits a key. */
export interface ConfirmShown { title: string; lines: readonly string[]; fingerprint?: string }
export type ConfirmAnswer = "approved" | "declined" | "expired";
export interface OpenConfirm { id: string; action: ScreenAction; shown: ConfirmShown; expiresAt: number }

export { CONFIRM_MS };
export const CONFIRMS_OPEN_MAX = 16;
export const LOCAL_CONFIRM_FILE = "local-confirm.json";
const DESKTOP_OWNER_ARGUMENT = "--desktop-owner-fd";

interface Entry extends OpenConfirm { state: "open" | "approved" | "declined"; settle(answer: ConfirmAnswer): void; answered: Promise<ConfirmAnswer>; timer: ReturnType<typeof setTimeout> }

/** How a screen path answers; held only by this module, so nothing else can approve an act. */
const answerers = new WeakMap<LocalConfirms, (id: string, answer: "approved" | "declined") => boolean>();

export class ConfirmsFullError extends Error {}

export class LocalConfirms {
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    answerers.set(this, (id, answer) => this.#answer(id, answer));
  }

  /** Puts one act on the PC's screen. Asking grants nothing: only an answer on the screen does. */
  request(action: ScreenAction, shown: ConfirmShown): { id: string; expiresAt: number } {
    this.#sweep();
    if ([...this.#entries.values()].filter((entry) => entry.state === "open").length >= CONFIRMS_OPEN_MAX) {
      throw new ConfirmsFullError("Too many acts wait for this PC's screen");
    }
    action = frozenCopy(action);
    const fingerprint = "fingerprint" in action ? action.fingerprint : undefined;
    shown = frozenCopy({ title: shown.title, lines: shown.lines, ...(fingerprint === undefined ? {} : { fingerprint }) });
    const id = randomBytes(16).toString("hex");
    const expiresAt = this.#now() + CONFIRM_MS;
    let settle!: (answer: ConfirmAnswer) => void;
    const answered = new Promise<ConfirmAnswer>((resolve) => { settle = resolve; });
    const timer = setTimeout(() => this.#end(id, "expired"), CONFIRM_MS);
    timer.unref?.();
    this.#entries.set(id, { id, action, shown, expiresAt, state: "open", settle, answered, timer });
    this.#changed();
    return { id, expiresAt };
  }

  pending(): OpenConfirm[] {
    this.#sweep();
    return [...this.#entries.values()].filter((entry) => entry.state === "open")
      .map(({ id, action, shown, expiresAt }) => ({ id, action, shown, expiresAt }));
  }

  /** How the screen answered `id`; an id that is not open, or that ran out, is `expired`. */
  answer(id: string): Promise<ConfirmAnswer> {
    this.#sweep();
    return this.#entries.get(id)?.answered ?? Promise.resolve("expired");
  }

  /** Uses up an approval of exactly `action`, once and before its confirm runs out. */
  consume(id: string, action: ScreenAction): boolean {
    this.#sweep();
    const entry = this.#entries.get(id);
    if (entry?.state !== "approved" || canonical(entry.action) !== canonical(action)) return false;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    return true;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Takes an act off the screen: what it asked for is gone. Its asker hears `expired`, and no answer to it counts. */
  withdraw(id: string): void {
    this.#end(id, "expired");
  }

  isOpen(id: string): boolean {
    this.#sweep();
    return this.#entries.get(id)?.state === "open";
  }

  #answer(id: string, answer: "approved" | "declined"): boolean {
    this.#sweep();
    const entry = this.#entries.get(id);
    if (entry?.state !== "open") return false;
    entry.state = answer;
    entry.settle(answer);
    this.#changed();
    return true;
  }

  #end(id: string, answer: ConfirmAnswer): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    entry.settle(answer);
    this.#changed();
  }

  #sweep(): void {
    const now = this.#now();
    for (const entry of [...this.#entries.values()]) if (now >= entry.expiresAt) this.#end(entry.id, "expired");
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch (error) { console.error(`A screen confirm listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
}

/** A copy the asker cannot change afterwards: the act shown is the act consumed. */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown) => {
    if (entry === null || typeof entry !== "object") return;
    Object.freeze(entry);
    for (const field of Object.values(entry)) freeze(field);
  };
  freeze(copy);
  return copy;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function answerOnScreen(confirms: LocalConfirms, id: string, answer: "approved" | "declined"): boolean {
  return answerers.get(confirms)?.(id, answer) ?? false;
}

/**
 * The descriptor the desktop app named with `--desktop-owner-fd <n>` (or `=<n>`), taken once before anything is
 * spawned: the argument is removed, and the descriptor is made close-on-exec so no child (herdr, the PTY host, a
 * terminal, an updater) holds it. It is an argument and not a variable because a variable would reach every child
 * (Bun.spawn passes the environment the process started with, whatever process.env says since). Anything but a
 * socket (the channel goes both ways on one descriptor), a descriptor that cannot be kept from children, or any system
 * but Linux, is no channel.
 */
export function takeDesktopOwnerFd(argv: string[]): number | null {
  const fd = desktopOwnerArgument(argv);
  if (fd === null) return null;
  try {
    if (!fstatSync(fd).isSocket()) return null;
  } catch { return null; }
  if (closeOnExec(fd)) return fd;
  // a socket that cannot be kept from children is closed, so no child holds it either
  try { closeSync(fd); } catch {}
  return null;
}

/**
 * For a process that is not the server (server/supervisor.ts): the argument is removed and the socket it names closed,
 * so it is neither passed on nor held by a child; a number that names no socket closes nothing. Only a directly
 * started `serve` takes the channel.
 */
export function dropDesktopOwnerFd(argv: string[]): void {
  const fd = desktopOwnerArgument(argv);
  if (fd === null) return;
  try {
    if (fstatSync(fd).isSocket()) closeSync(fd);
  } catch {}
}

/**
 * The first argument `serve` does not take, or undefined: it takes only the desktop app's `--desktop-owner-fd <n>` (or
 * `=<n>`), and is otherwise set up by its environment. server/main.ts refuses the rest, so a word meant for a command
 * (`serve --port 8080`) is not ignored by a server that starts anyway.
 */
export function unknownServeArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument.startsWith(`${DESKTOP_OWNER_ARGUMENT}=`)) continue;
    if (argument === DESKTOP_OWNER_ARGUMENT) {
      if (/^\d+$/.test(args[index + 1] ?? "")) index++;
      continue;
    }
    return argument;
  }
  return undefined;
}

function desktopOwnerArgument(argv: string[]): number | null {
  let value: string | undefined;
  for (let index = argv.length - 1; index >= 0; index--) {
    const argument = argv[index]!;
    if (argument === DESKTOP_OWNER_ARGUMENT) {
      const next = argv[index + 1];
      const numeric = next !== undefined && /^\d+$/.test(next);
      value ??= numeric ? next : "";
      argv.splice(index, numeric ? 2 : 1);
    } else if (argument.startsWith(`${DESKTOP_OWNER_ARGUMENT}=`)) {
      value ??= argument.slice(DESKTOP_OWNER_ARGUMENT.length + 1);
      argv.splice(index, 1);
    }
  }
  if (value === undefined || !/^\d{1,4}$/.test(value)) return null;
  const fd = Number(value);
  return fd < 3 ? null : fd;
}

function closeOnExec(fd: number): boolean {
  // fcntl is variadic: a fixed-argument binding is sound on Linux's ABIs, not on macOS arm64
  if (process.platform !== "linux") return false;
  try {
    const libc = dlopen("libc.so.6", { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    try {
      // F_SETFD = 2, F_GETFD = 1, FD_CLOEXEC = 1
      return libc.symbols.fcntl(fd, 2, 1) === 0 && (libc.symbols.fcntl(fd, 1, 0) & 1) === 1;
    } finally { libc.close(); }
  } catch { return false; }
}

/** The desktop-owner channel on a descriptor `takeDesktopOwnerFd` took. */
export function desktopOwnerFdChannel(fd: number): { input: ReadableStream<Uint8Array>; write(line: string): void } {
  return {
    input: Bun.file(fd).stream(),
    write: (line) => { writeSync(fd, line); },
  };
}

/**
 * The desktop app's end: told every open act, one JSON line `{"pending":[{id, action, shown}]}` per change, and
 * answering with `{"approve":"<id>"}` or `{"decline":"<id>"}`. Anything else it sends is ignored.
 */
export function desktopOwnerChannel(confirms: LocalConfirms, end: { input: ReadableStream<Uint8Array>; write(line: string): void }): { stop(): void } {
  let stopped = false;
  const tell = () => {
    if (stopped) return;
    try { end.write(`${JSON.stringify({ pending: confirms.pending().map(({ id, action, shown }) => ({ id, action, shown })) })}\n`); }
    catch (error) { stop(error instanceof Error ? error.message : String(error)); }
  };
  const unsubscribe = confirms.onChange(tell);
  const reader = end.input.getReader();
  const stop = (reason?: string) => {
    if (stopped) return;
    stopped = true;
    if (reason !== undefined) console.error(`The desktop app's confirm channel closed (${reason}); acts wait for the local confirm page`);
    unsubscribe();
    void reader.cancel().catch(() => {});
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const read = await reader.read().catch((error: unknown) => ({ done: true as const, value: undefined, error }));
      if (stopped) break;
      if (read.done) { stop("error" in read ? String(read.error) : "ended"); break; }
      const value = read.value;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        heard(confirms, buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
      if (buffered.length > 4096) buffered = "";
    }
  })();
  tell();
  return { stop };
}

function heard(confirms: LocalConfirms, line: string): void {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return; }
  if (message === null || typeof message !== "object") return;
  const { approve, decline } = message as { approve?: unknown; decline?: unknown };
  if (typeof approve === "string") answerOnScreen(confirms, approve, "approved");
  else if (typeof decline === "string") answerOnScreen(confirms, decline, "declined");
}

/**
 * How many times the socket table is read for one connection. The kernel hands /proc/net/tcp out a page per read and
 * resumes by position, so while other sockets come and go one read can miss a live row or show it twice; reading
 * again only asks the kernel again, and a row that is not there is never found.
 */
const TABLE_READS = 3;

/**
 * The uid that holds the client end of a TCP connection on loopback, from the kernel's socket table: the row whose
 * local port is the peer's and whose remote port is the listener's. Null when no read of the table finds it, and as
 * soon as one read shows rows on those ends that do not all name the same user: that read is an answer, nobody.
 */
export function peerUidOnLinux(listenerPort: number, peerPort: number,
  readTable: () => string = () => readFileSync("/proc/net/tcp", "utf8")): number | null {
  for (let read = 0; read < TABLE_READS; read++) {
    let text: string;
    try { text = readTable(); } catch { return null; }
    const uids = peerRowUids(text, listenerPort, peerPort);
    if (uids.length === 1) return uids[0]!;
    if (new Set(uids).size > 1) return null;
  }
  return null;
}

/** 127.0.0.1 as /proc/net/tcp writes it, in host (little-endian) order. */
const LOOPBACK_HEX = "0100007F";
/** TCP_ESTABLISHED as /proc/net/tcp writes the state. */
const ESTABLISHED = "01";

/**
 * The uid of the one established row whose local end is the peer's own 127.0.0.1:port and whose remote end is this
 * listener's 127.0.0.1:port; the listener takes only 127.0.0.1 peers, so another address on the same ports is someone
 * else, and two such rows name nobody.
 */
export function peerUidInTable(table: string, listenerPort: number, peerPort: number): number | null {
  const uids = peerRowUids(table, listenerPort, peerPort);
  // more than one connection on the same exact ends cannot be told apart: nobody
  return uids.length === 1 ? uids[0]! : null;
}

/** The uid of each established 127.0.0.1 row on exactly these ends (null where the uid is not a number). */
function peerRowUids(table: string, listenerPort: number, peerPort: number): (number | null)[] {
  const uids: (number | null)[] = [];
  for (const row of table.split("\n").slice(1)) {
    const fields = row.trim().split(/\s+/);
    if (fields.length < 8 || fields[3] !== ESTABLISHED) continue;
    const [localAddress, localPort] = fields[1]!.split(":");
    const [remoteAddress, remotePort] = fields[2]!.split(":");
    if (localAddress !== LOOPBACK_HEX || remoteAddress !== LOOPBACK_HEX) continue;
    if (Number.parseInt(localPort!, 16) !== peerPort || Number.parseInt(remotePort!, 16) !== listenerPort) continue;
    const uid = Number(fields[7]);
    uids.push(Number.isSafeInteger(uid) ? uid : null);
  }
  return uids;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/**
 * The local confirm listener: a page on 127.0.0.1 of its own, opened only where the system names the user behind a
 * connection (Linux), and taking only that user. It answers a request only when no proxy shows in it, its Host is
 * exactly this listener's address, and on an answer its Origin is exactly this listener's origin and it carries the
 * nonce its own page was given for that act. It sends no CORS header and reads no cookie. Its port is written only to
 * LOCAL_CONFIRM_FILE in the state folder, which only this user may read.
 */
export function openConfirmListener(confirms: LocalConfirms, options: {
  stateDir: string;
  platform?: NodeJS.Platform;
  peerUid?: (listenerPort: number, peerPort: number) => number | null;
}): { port: number; stop(): void } | null {
  const platform = options.platform ?? process.platform;
  const ownUid = process.getuid?.();
  if (platform !== "linux" || ownUid === undefined) return null;
  const peerUid = options.peerUid ?? peerUidOnLinux;
  const nonces = new Map<string, string>();
  const refuse = (message: string) => new Response(`<!doctype html><title>Ovis</title><p>${escapeHtml(message)}</p>`, { status: 403, headers: PAGE_HEADERS });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: 4096,
    async fetch(request, bun) {
      const port = server.port!;
      const origin = `http://127.0.0.1:${port}`;
      const peer = bun.requestIP(request);
      if (machineForwardingHeaders(request.headers) || request.headers.get("host") !== `127.0.0.1:${port}`) return refuse("Open this page on this PC itself.");
      if (peer === null || peer.address !== "127.0.0.1" || peerUid(port, peer.port) !== ownUid) return refuse("Open this page as this PC's own user.");
      for (const [nonce, id] of nonces) if (!confirms.isOpen(id)) nonces.delete(nonce);
      const url = new URL(request.url);
      const id = /^\/confirm\/([0-9a-f]{32})$/.exec(url.pathname)?.[1];
      if (request.method === "GET" && url.pathname === "/") return new Response(listPage(confirms.pending()), { headers: PAGE_HEADERS });
      if (id === undefined) return new Response("Not found", { status: 404, headers: PAGE_HEADERS });
      if (request.method === "GET") {
        const open = confirms.pending().find((entry) => entry.id === id);
        if (open === undefined) return new Response(donePage("This request is no longer waiting."), { status: 404, headers: PAGE_HEADERS });
        const nonce = randomBytes(24).toString("base64url");
        for (const [earlier, of] of nonces) if (of === id) nonces.delete(earlier);
        nonces.set(nonce, id);
        return new Response(confirmPage(open, nonce), { headers: PAGE_HEADERS });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: PAGE_HEADERS });
      if (request.headers.get("origin") !== origin) return refuse("Answer from this PC's own confirm page.");
      const form = new URLSearchParams(await request.text());
      const nonce = form.get("nonce") ?? "";
      if (nonces.get(nonce) !== id) return refuse("This page is out of date. Open the request again.");
      nonces.delete(nonce);
      const answer = form.get("answer");
      if (answer !== "approve" && answer !== "decline") return refuse("Choose Approve or Decline.");
      if (!answerOnScreen(confirms, id, answer === "approve" ? "approved" : "declined")) return refuse("This request is no longer waiting.");
      return new Response(donePage(answer === "approve" ? "Approved." : "Declined."), { headers: PAGE_HEADERS });
    },
  });
  const file = join(options.stateDir, LOCAL_CONFIRM_FILE);
  try {
    writePrivateState(file, { port: server.port });
  } catch (error) {
    server.stop(true);
    throw error;
  }
  return {
    port: server.port!,
    stop() {
      // The approval of the last standing unlock can close this listener. Finish its HTTP reply.
      server.stop();
      try { rmSync(file, { force: true }); }
      catch (error) { console.error(`${file} was not removed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  };
}

/**
 * Opens `url` (this listener's page) in a browser on this PC's own desktop, as `ovis confirm` does: on Linux, under X11
 * or Wayland only. False where there is no desktop to open it on, and where `xdg-open` could not be started (a desktop
 * without it): only a started opener counts as opened.
 */
export function openOnDesktop(url: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "linux" || !(Boolean(env["DISPLAY"]) || Boolean(env["WAYLAND_DISPLAY"]))) return Promise.resolve(false);
  return new Promise((resolve) => {
    const opener = spawn("xdg-open", [url], { stdio: "ignore", detached: true, env });
    opener.once("spawn", () => { opener.unref(); resolve(true); }).once("error", () => resolve(false));
  });
}

function listPage(open: readonly OpenConfirm[]): string {
  const items = open.map((entry) => `<li><a href="/confirm/${entry.id}">${escapeHtml(entry.shown.title)}</a></li>`).join("");
  return `<!doctype html><title>Ovis: confirm on this PC</title><h1>Waiting for this PC</h1>${items === "" ? "<p>Nothing is waiting.</p>" : `<ul>${items}</ul>`}`;
}

function confirmPage(open: OpenConfirm, nonce: string): string {
  const lines = open.shown.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const fingerprint = open.shown.fingerprint === undefined ? "" : `<p>Key fingerprint: <strong>${escapeHtml(open.shown.fingerprint)}</strong></p>`;
  return `<!doctype html><title>Ovis: ${escapeHtml(open.shown.title)}</title><h1>${escapeHtml(open.shown.title)}</h1>${lines}${fingerprint}`
    + `<form method="post"><input type="hidden" name="nonce" value="${nonce}">`
    + `<button name="answer" value="approve">Approve</button> <button name="answer" value="decline">Decline</button></form>`;
}

function donePage(message: string): string {
  return `<!doctype html><title>Ovis</title><p>${escapeHtml(message)}</p><p><a href="/">Back</a></p>`;
}
