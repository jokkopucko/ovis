/**
 * Byte ceilings for what another PC's bridge (or the bundle release) answers. A timeout bounds
 * how long an answer may take, not how much of it is held, so every buffered answer is read
 * through `readCapped`: its bytes are counted as they arrive and the stream is cancelled at the
 * first byte past the ceiling, before anything is decoded. These are the sizes this app supports
 * for each answer, not a guess at what a bridge will send.
 */
const KiB = 1024;
const MiB = 1024 * KiB;
export const REMOTE_LIMITS = {
  bridgeIdentity: 64 * KiB,
  bridgeError: 8 * KiB,
  health: 64 * KiB,
  ownUpdates: 64 * KiB,
  bundleManifest: MiB,
  sessionSnapshot: 64 * MiB,
  proxy: 64 * MiB,
  /** a watching device's pane/prompt, parsed here so its hidden fields can be removed */
  watchedPrompt: MiB,
} as const;

/** Fixed messages: neither carries the URL, the token or any of the answer. */
export class RemoteResponseTooLarge extends Error {
  constructor() { super("The other PC's answer was larger than this app accepts"); this.name = "RemoteResponseTooLarge"; }
}
export class RemoteResponseInvalid extends Error {
  constructor() { super("The other PC's answer could not be read"); this.name = "RemoteResponseInvalid"; }
}

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * The answer's bytes, at most `limit` of them. A Content-Length past the limit is refused
 * before reading; otherwise the bytes are counted as they stream in (after any decompression),
 * whatever the header says, and the stream is cancelled as soon as they pass the limit.
 */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await discard(response); throw new RemoteResponseTooLarge(); }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new RemoteResponseTooLarge(); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Parses capped bytes; a parse failure says so without echoing them. */
export function parseJson<T>(bytes: Uint8Array): T {
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch { throw new RemoteResponseInvalid(); }
}

export async function readCappedJson<T>(response: Response, limit: number): Promise<T> {
  return parseJson<T>(await readCapped(response, limit));
}
