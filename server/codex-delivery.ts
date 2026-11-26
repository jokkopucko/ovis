import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

const MAX_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 256;
const MAX_RECORDS = 4096;
const fingerprint = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fileId = (info: { dev: number; ino: number }): string => `${info.dev}:${info.ino}`;
const textOf = (text: string): string => text.replace(/\r\n?/gu, "\n").trimEnd();

export interface CodexDeliveryAnchor {
  path: string;
  file: string;
  session: string;
  size: number;
  tail: string;
}

async function bytesAt(fd: FileHandle, start: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await fd.read(bytes, read, length - read, start + read);
    if (result.bytesRead === 0) throw new Error("Codex transcript changed during read");
    read += result.bytesRead;
  }
  return bytes;
}

async function sessionOf(fd: FileHandle, size: number): Promise<string | null> {
  const head = await bytesAt(fd, 0, Math.min(size, 32 * 1024));
  const end = head.indexOf(10);
  if (end < 0) return null;
  const entry = JSON.parse(head.subarray(0, end).toString("utf8"));
  return entry.type === "session_meta" && typeof entry.payload?.id === "string" && entry.payload.id !== "" ? entry.payload.id : null;
}

async function tailOf(fd: FileHandle, size: number): Promise<string> {
  const start = Math.max(0, size - 512);
  return fingerprint(await bytesAt(fd, start, size - start));
}

/** Capture a bound native file before Enter; an incomplete or changing file supplies no evidence. */
export async function captureCodexDelivery(path: string): Promise<CodexDeliveryAnchor | null> {
  let fd: FileHandle | undefined;
  try {
    fd = await open(path, "r");
    const before = await fd.stat();
    if (!before.isFile() || before.size === 0 || (await bytesAt(fd, before.size - 1, 1))[0] !== 10) return null;
    const session = await sessionOf(fd, before.size);
    if (session === null) return null;
    const tail = await tailOf(fd, before.size), after = await fd.stat(), named = await stat(path);
    if (fileId(before) !== fileId(named) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    return { path, file: fileId(before), session, size: before.size, tail };
  } catch { return null; }
  finally { await fd?.close().catch(() => {}); }
}

type Attempt<T> = { pane: string; text: string; anchor: CodexDeliveryAnchor; at: number; value: T; clientId: string };
type NativeMessage = { clientId: string; start: number; at: number; text: string };
type UserEvent = {
  type?: unknown; thread_id?: unknown;
  item?: { type?: unknown; id?: unknown; client_id?: unknown; content?: unknown };
};

function nativeUserMessage(payload: UserEvent | null | undefined, session: string): { text: string; clientId: string } | null {
  const item = payload?.item;
  if (payload?.type !== "item_completed" || payload.thread_id !== session || item?.type !== "UserMessage"
    || typeof item.id !== "string" || !item.id || typeof item.client_id !== "string" || !item.client_id || !Array.isArray(item.content) || item.content.length === 0
    || !item.content.every((part) => part?.type === "text" && typeof part.text === "string")) return null;
  return { text: item.content.map((part) => part.text).join(""), clientId: item.client_id };
}

/**
 * Only turn/steer supplies our clientUserMessageId; a TUI Enter has no such receipt.
 */
export class CodexDeliveries<T> {
  private attempts = new Set<Attempt<T>>();
  invalidate(pane: string): void {
    for (const item of this.attempts) if (item.pane === pane) this.attempts.delete(item);
  }

  add(pane: string, text: string, anchor: CodexDeliveryAnchor | null, at: number, value: T, clientId: string): void {
    if (!anchor || !clientId || this.attempts.size >= MAX_ATTEMPTS) return;
    this.attempts.add({ pane, text: textOf(text), anchor, at, value, clientId });
  }

  values(pane: string): T[] { return [...this.attempts].filter((item) => item.pane === pane).map((item) => item.value); }

  async reconcile(pane: string, path: string, verifyProcess?: () => Promise<boolean>): Promise<T[]> {
    const attempts = [...this.attempts].filter((item) => item.pane === pane);
    if (attempts.length === 0) return [];
    let fd: FileHandle | undefined;
    try {
      fd = await open(path, "r");
      const before = await fd.stat(), session = await sessionOf(fd, before.size);
      const anchors = attempts.map((item) => item.anchor);
      const first = Math.min(...anchors.map((anchor) => anchor.size));
      if (session === null || before.size < first || before.size - first > MAX_BYTES) { this.invalidate(pane); return []; }
      for (const anchor of anchors) {
        if (anchor.path !== path || anchor.file !== fileId(before) || anchor.session !== session || before.size < anchor.size
          || anchor.tail !== await tailOf(fd, anchor.size)) { this.invalidate(pane); return []; }
      }
      const bytes = await bytesAt(fd, first, before.size - first);
      const records: NativeMessage[] = [];
      let offset = 0, lines = 0;
      for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, offset)) {
        if (++lines > MAX_RECORDS) { this.invalidate(pane); return []; }
        const start = first + offset, entry = JSON.parse(bytes.subarray(offset, end).toString("utf8"));
        offset = end + 1;
        // Codex can write model context and a legacy user event alongside one completed item.
        if (entry.type !== "event_msg") continue;
        const message = nativeUserMessage(entry.payload, session);
        if (message === null) continue;
        const at = Date.parse(entry.timestamp);
        if (Number.isFinite(at)) records.push({
          clientId: message.clientId,
          start, at, text: textOf(message.text),
        });
      }
      const after = await fd.stat(), named = await stat(path);
      if (fileId(before) !== fileId(named) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return [];
      for (const anchor of anchors) if (anchor.tail !== await tailOf(fd, anchor.size)) { this.invalidate(pane); return []; }
      const matching = attempts.filter((item) => {
        const same = records.filter((record) => record.clientId === item.clientId && record.start >= item.anchor.size && record.at >= item.at);
        return same.length === 1 && same[0]!.text === item.text;
      });
      if (matching.length === 0 || (verifyProcess && !await verifyProcess())) return [];
      const confirmed: T[] = [];
      for (const item of matching) if (this.attempts.delete(item)) confirmed.push(item.value);
      return confirmed;
    } catch (error) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
    finally { await fd?.close().catch(() => {}); }
  }
}
