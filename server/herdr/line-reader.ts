/**
 * The reader that splits herdr's and hc's byte streams into newline-terminated lines of bounded
 * size. It imports nothing, so any client of those streams can use it.
 */

/**
 * Splits incoming bytes into newline-terminated lines of at most `limit` bytes each.
 * herdr frames arrive split across reads, so a partial tail is kept as bytes and decoded only
 * once its line is complete, which keeps a UTF-8 character split between reads whole. A line
 * that passes `limit` before its newline is reported once through `onOversize`, its bytes are
 * dropped, and the reader ignores everything after it. A chunk is split, and its partial tail kept,
 * before any callback runs, so a callback that throws loses no other line: every line of the chunk
 * is still delivered, and the first throw is rethrown after the last. Exported for
 * server/herdr/seam.test.ts.
 */
export function makeLineReader(
  limit: number,
  onLine: (line: string, bytes: number) => void,
  onOversize: (bytes: number) => void,
): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let held = 0;
  let failed = false;
  return (chunk: Uint8Array) => {
    const lines: Uint8Array[] = [];
    let oversize: number | null = null;
    let start = 0;
    while (!failed && start < chunk.length) {
      const end = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
      if (held + piece.length > limit) {
        failed = true;
        oversize = held + piece.length;
        parts = [];
        held = 0;
        break;
      }
      if (end === -1) {
        // the socket may reuse its read buffer: keep a copy
        parts.push(piece.slice());
        held += piece.length;
        break;
      }
      lines.push(held === 0 ? piece : Buffer.concat([...parts, piece]));
      parts = [];
      held = 0;
      start = end + 1;
    }
    let thrown: { error: unknown } | null = null;
    for (const bytes of lines) {
      const line = decoder.decode(bytes).trim();
      if (line.length === 0) continue;
      try {
        onLine(line, bytes.length);
      } catch (error) {
        thrown ??= { error };
      }
    }
    if (oversize !== null) {
      try {
        onOversize(oversize);
      } catch (error) {
        thrown ??= { error };
      }
    }
    if (thrown) throw thrown.error;
  };
}
