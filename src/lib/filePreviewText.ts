/** Text shows its first part: this also bounds parsing and highlighting in the viewer. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;

export const SOURCE_PREVIEW_BYTES = 8 * 1024 * 1024;
export const SOURCE_PREVIEW_LINES = 200_000;

export interface FilePreviewText {
  text: string;
  truncated: boolean;
  total?: number;
  truncatedBy?: "bytes" | "lines" | "time";
  lines?: number;
}

function countLines(text: string): number {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  return text.length > 0 && !text.endsWith("\n") ? count + 1 : count;
}

/** Range is a request, not a client memory limit: a peer can ignore it or a file can grow. */
export async function readFilePreviewText(response: Response, limit: number, options: { signal?: AbortSignal; timeoutMs?: number; maxLines?: number; partialOnTimeout?: boolean } = {}): Promise<FilePreviewText> {
  const discard = () => { void response.body?.cancel().catch(() => {}); };
  // An empty file has no first byte to send for Range. Discard any error body, never render it.
  if (response.status === 416 && response.headers.get("content-range")?.trim() === "bytes */0") {
    discard();
    return { text: "", truncated: false, total: 0 };
  }
  if (!response.ok) { discard(); throw new Error("The file could not be opened."); }
  if (!Number.isSafeInteger(limit) || limit < 1) { discard(); throw new Error("Invalid preview limit."); }
  const maxLines = options.maxLines;
  if (maxLines !== undefined && (!Number.isSafeInteger(maxLines) || maxLines < 1)) { discard(); throw new Error("Invalid preview limit."); }
  const range = response.status === 206 ? /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "") : null;
  if (response.status === 206 && (!range || Number(range[1]) >= Number(range[2]))) { discard(); throw new Error("Invalid file range."); }
  const reader = response.body?.getReader();
  // a 206 names the file's whole size, so a cut there can say how much is shown
  const total = range ? { total: Number(range[2]) } : {};
  const budgeted = (result: FilePreviewText, by: "bytes" | "lines" | "time"): FilePreviewText =>
    maxLines === undefined ? result : { ...result, ...(result.truncated ? { truncatedBy: by } : {}), lines: countLines(result.text) };
  if (!reader) return budgeted({ text: "", truncated: range !== null, ...total }, "bytes");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const finish = (truncated: boolean, by: "bytes" | "lines" | "time" = "bytes"): FilePreviewText => {
    const newline = text.lastIndexOf("\n");
    return budgeted({ text: truncated ? (newline < 0 ? text : text.slice(0, newline + 1)) : text + decoder.decode(), truncated, ...total }, by);
  };
  let lineCount = 0;
  let stopped: Error | undefined;
  let reject!: (error: Error) => void;
  const interruption = new Promise<never>((_, fail) => { reject = fail; });
  const stop = (error: Error) => { stopped = error; reject(error); void reader.cancel().catch(() => {}); };
  const aborted = () => stop(new Error("File preview aborted."));
  const timedOut = new Error("File preview timed out.");
  const timer = setTimeout(() => stop(timedOut), options.timeoutMs ?? 5_000);
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (options.signal?.aborted) { aborted(); await interruption; }
    while (true) {
      const { value, done } = await Promise.race([reader.read(), interruption]);
      if (stopped) throw stopped;
      if (done) return finish(range !== null && bytes < Number(range[2]));
      const remaining = limit - bytes;
      let slice = value.subarray(0, remaining);
      let by: "bytes" | "lines" = "bytes";
      if (maxLines !== undefined) {
        // count newline bytes in place: a multi-million-line body is never split into line strings
        for (let at = slice.indexOf(10); at >= 0; at = slice.indexOf(10, at + 1)) {
          if (++lineCount >= maxLines) { slice = slice.subarray(0, at + 1); by = "lines"; break; }
        }
      }
      text += decoder.decode(slice, { stream: true });
      bytes += slice.byteLength;
      if (by === "lines" || bytes >= limit) {
        let more = value.byteLength > slice.byteLength || (range !== null && Number(range[2]) > bytes);
        // a 200 that ends exactly at the budget is the whole file: look for one more chunk before calling it cut
        if (!more && range === null) {
          const next = await Promise.race([reader.read(), interruption]);
          if (stopped) throw stopped;
          more = !next.done;
        }
        // Never wait on a remote cancellation promise, or a hostile/stalled body can hold the UI.
        void reader.cancel().catch(() => {});
        return finish(more, by);
      }
    }
  } catch (error) {
    if (error === timedOut && options.partialOnTimeout && bytes > 0) return finish(true, "time");
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); reader.releaseLock();
  }
}
