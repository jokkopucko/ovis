/**
 * `ovis-server approval-hook --socket <address> --launch-file <path>`: the command an agent Ovis starts runs for each approval
 * its hook asks (server/approvals/hub.ts). It sends the event on stdin to the hub at `address` (a unix socket, a named
 * pipe on Windows) and prints the hub's answer. No hub, a refusal, an answer not sealed with this launch's key, or any
 * other failure prints nothing and exits 0, which the agent reads as no decision: its own dialog stands. It has no time
 * limit of its own; the agent's hook timeout ends it.
 *
 * The key is read from its file (0600, in the hub's 0700 folder), never from the command line: Claude Code writes a hook's
 * command and arguments into its transcript and its compact summary (2.1.330), where the key would be readable. A key
 * file that cannot be read is no hub: nothing printed.
 *
 * The key never goes over the wire. The request carries the key's digest and the event sealed with the key (AES-GCM),
 * and the answer comes back sealed with it, bound to the request's nonce: a listener at the address that does not hold
 * the key (another account's, once Ovis stopped, as anyone can make a named pipe of a free name) can neither read the
 * command nor answer it.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

/** The most of a line either side sends: an event, sealed and encoded, and its envelope. */
export const LINE_MAX = 2 * 1024 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const keyDigest = (key: string): string => createHash("sha256").update(key).digest("hex");
export const newNonce = (): string => randomBytes(16).toString("hex");
export const isNonce = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** A key of its own for sealing, apart from the digest that names the launch. */
const sealingKey = (key: string): Buffer => createHmac("sha256", key).update("ovis approvals seal").digest();
/** What a sealed text is bound to: which side sent it, in which exchange. */
const boundTo = (side: "request" | "answer", nonce: string): Buffer => Buffer.from(JSON.stringify([side, nonce]));

export function seal(key: string, side: "request" | "answer", nonce: string, text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(key), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(boundTo(side, nonce));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/** The text sealed under this key, side and nonce, or null for anything else. */
export function unseal(key: string, side: "request" | "answer", nonce: string, sealed: unknown): string | null {
  if (typeof sealed !== "string") return null;
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(key), bytes.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(boundTo(side, nonce));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** One JSON object per line, or null for a line that is not one. */
export function lineObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function relayOptions(argv: readonly string[]): { socket: string; launchFile: string } | null {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 && typeof argv[at + 1] === "string" && argv[at + 1] !== "" ? argv[at + 1]! : null;
  };
  const socket = value("--socket"), launchFile = value("--launch-file");
  return socket === null || launchFile === null ? null : { socket, launchFile };
}

/**
 * Whether Bun was told to load a module before this one (its flags, or BUN_OPTIONS): code from wherever the agent runs
 * the hook. Such a run answers nothing. A bunfig.toml's preload does not show here; the hook's command keeps Bun from
 * reading the working folder's (relayCommand in server/approvals/hub.ts).
 */
export const preloaded = (execArgv: readonly string[]): boolean => execArgv.some((arg) => /^(?:-r|--preload|--require|--import)(?:=|$)/.test(arg));

/** The hub's answer to `event`, unsealed, or null for none. */
export function relay(address: string, key: string, event: string): Promise<string | null> {
  const nonce = newNonce();
  return new Promise((resolve) => {
    let received = "";
    let done = false;
    const finish = (answer: string | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(answer);
    };
    const socket = connect(address);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ launch: keyDigest(key), nonce, sealed: seal(key, "request", nonce, event) })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length > LINE_MAX) return finish(null);
      const end = received.indexOf("\n");
      if (end < 0) return;
      finish(unseal(key, "answer", nonce, lineObject(received.slice(0, end))?.["sealed"]));
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export async function runApprovalRelay(): Promise<void> {
  if (preloaded(process.execArgv)) return;
  // loaded only for it: an approval's hook waits on nothing it does not need
  if (process.argv.includes("--statusline")) return (await import("./statusline.ts")).runStatusline(process.argv.slice(2));
  const options = relayOptions(process.argv.slice(2));
  if (options === null) {
    console.error("usage: ovis-server approval-hook --socket <address> --launch-file <path>");
    process.exit(2);
  }
  let key: string;
  try { key = readFileSync(options.launchFile, "utf8"); } catch { return; }
  if (key === "") return;
  const answer = await relay(options.socket, key, await Bun.stdin.text());
  if (answer !== null) process.stdout.write(answer);
}

if (import.meta.main) await runApprovalRelay();
