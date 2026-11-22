import { expect, test } from "bun:test";
import { readFilePreviewText, SOURCE_PREVIEW_BYTES, SOURCE_PREVIEW_LINES } from "./filePreviewText.ts";

const encoder = new TextEncoder();
const chunked = (chunks: Uint8Array[], onCancel?: () => void) => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
  cancel() { onCancel?.(); },
}));

test("an HTTP error never becomes preview text, and its body is cancelled", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
  await expect(readFilePreviewText(response, 10)).rejects.toThrow("could not be opened");
  expect(cancelled).toBe(true);
});

test("a peer ignoring Range cannot grow the preview beyond the byte budget", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcdef")); }, cancel() { cancelled = true; } }));
  expect(await readFilePreviewText(response, 4)).toEqual({ text: "abcd", truncated: true });
  expect(cancelled).toBe(true);
});

test("UTF-8 splits survive and a budget does not invent a partial final character", async () => {
  const encoded = new TextEncoder().encode("한글");
  const response = () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoded.slice(0, 2)); controller.enqueue(encoded.slice(2)); controller.close();
  } }));
  expect(await readFilePreviewText(response(), 10)).toEqual({ text: "한글", truncated: false });
  expect(await readFilePreviewText(response(), 4)).toEqual({ text: "한", truncated: true });
});

test("cancellation and a stalled body deadline release the reader even if cancellation stalls", async () => {
  let cancelled = 0;
  const response = () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
  await expect(readFilePreviewText(response(), 10, { timeoutMs: 10 })).rejects.toThrow("timed out");
  const abort = new AbortController();
  const pending = readFilePreviewText(response(), 10, { signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toThrow("aborted");
  expect(cancelled).toBe(2);
});

test("partialOnTimeout keeps what arrived before the deadline as a cut prefix", async () => {
  const encoder = new TextEncoder();
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("one\ntwo\nthr")); } }), { status: 206, headers: { "content-range": "bytes 0-99/1000" } });
  expect(await readFilePreviewText(stalled(), 100, { timeoutMs: 10, maxLines: 10, partialOnTimeout: true }))
    .toEqual({ text: "one\ntwo\n", truncated: true, truncatedBy: "time", total: 1000, lines: 2 });
  await expect(readFilePreviewText(new Response(new ReadableStream()), 100, { timeoutMs: 10, partialOnTimeout: true })).rejects.toThrow("timed out");
  await expect(readFilePreviewText(stalled(), 100, { timeoutMs: 10 })).rejects.toThrow("timed out");
});

test("a partial range exposes truncation and rejects malformed range metadata", async () => {
  const partial = new Response("abc", { status: 206, headers: { "content-range": "bytes 0-2/6" } });
  expect(await readFilePreviewText(partial, 10)).toEqual({ text: "abc", truncated: true, total: 6 });
  await expect(readFilePreviewText(new Response("abc", { status: 206 }), 10)).rejects.toThrow("range");
});

test("a 206 cut at the budget names the whole size, and a 200 of exactly the budget is complete", async () => {
  const ranged = new Response("abcd", { status: 206, headers: { "content-range": "bytes 0-3/10" } });
  expect(await readFilePreviewText(ranged, 4)).toEqual({ text: "abcd", truncated: true, total: 10 });
  const exact = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcd")); controller.close(); } }));
  expect(await readFilePreviewText(exact, 4)).toEqual({ text: "abcd", truncated: false });
  const longer = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abcd")); controller.enqueue(new TextEncoder().encode("e")); } }));
  expect(await readFilePreviewText(longer, 4)).toEqual({ text: "abcd", truncated: true });
});

test("an empty range is an empty file, but other 416 responses remain errors", async () => {
  let cancelled = false;
  const empty = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 416, headers: { "content-range": "bytes */0" } });
  expect(await readFilePreviewText(empty, 10))
    .toEqual({ text: "", truncated: false, total: 0 });
  expect(cancelled).toBe(true);
  for (const headers of [new Headers(), new Headers({ "content-range": "bytes */99" })]) {
    await expect(readFilePreviewText(new Response(null, { status: 416, headers }), 10)).rejects.toThrow("could not be opened");
  }
});

test("a partial file ends at its last whole line without trimming a complete file", async () => {
  const part = new Response("a\nb\nhal", { status: 206, headers: { "content-range": "bytes 0-6/100" } });
  expect(await readFilePreviewText(part, 7)).toEqual({ text: "a\nb\n", truncated: true, total: 100 });
  expect(await readFilePreviewText(new Response("a\nb\nhal"), 7)).toEqual({ text: "a\nb\nhal", truncated: false });
  const complete = new Response("one\ntwo", { status: 206, headers: { "content-range": "bytes 0-6/7" } });
  expect(await readFilePreviewText(complete, 10)).toEqual({ text: "one\ntwo", truncated: false, total: 7 });
});

test("a short range retains the body total and drops an incomplete UTF-8 sequence", async () => {
  const part = new Response(new TextEncoder().encode("xä").slice(0, 2), { status: 206, headers: { "content-range": "bytes 0-1/4096" } });
  expect(await readFilePreviewText(part, 10)).toEqual({ text: "x", truncated: true, total: 4096 });
});

test("the source budgets are named and the line budget is opt-in", async () => {
  expect(SOURCE_PREVIEW_BYTES).toBe(8 * 1024 * 1024);
  expect(SOURCE_PREVIEW_LINES).toBe(200_000);
  await expect(readFilePreviewText(new Response("a"), 10, { maxLines: 0 })).rejects.toThrow("Invalid preview limit");
  expect(await readFilePreviewText(new Response("a\nb\n"), 10)).toEqual({ text: "a\nb\n", truncated: false });
});

test("line budget edges: exactly N lines is complete, one more is a line truncation", async () => {
  const read = (body: string, maxLines: number, size = 2) => {
    const bytes = encoder.encode(body);
    const parts: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += size) parts.push(bytes.slice(at, at + size));
    return readFilePreviewText(chunked(parts), 1000, { maxLines });
  };
  expect(await read("a\nb\nc\n", 3)).toEqual({ text: "a\nb\nc\n", truncated: false, lines: 3 });
  expect(await read("a\nb\nc", 3)).toEqual({ text: "a\nb\nc", truncated: false, lines: 3 });
  expect(await read("a\nb\nc\nd", 3)).toEqual({ text: "a\nb\nc\n", truncated: true, truncatedBy: "lines", lines: 3 });
  expect(await read("a\nb\nc\n\n", 3)).toEqual({ text: "a\nb\nc\n", truncated: true, truncatedBy: "lines", lines: 3 });
  expect(await read("a\n\n\n", 10)).toEqual({ text: "a\n\n\n", truncated: false, lines: 3 });
});

test("byte budget edges report bytes, even with a line budget set", async () => {
  expect(await readFilePreviewText(chunked([encoder.encode("abcd")]), 4, { maxLines: 10 })).toEqual({ text: "abcd", truncated: false, lines: 1 });
  expect(await readFilePreviewText(chunked([encoder.encode("abcde")]), 4, { maxLines: 10 })).toEqual({ text: "abcd", truncated: true, truncatedBy: "bytes", lines: 1 });
  const ranged = new Response("abcd", { status: 206, headers: { "content-range": "bytes 0-3/10" } });
  expect(await readFilePreviewText(ranged, 4, { maxLines: 10 })).toEqual({ text: "abcd", truncated: true, truncatedBy: "bytes", total: 10, lines: 1 });
});

test("a multibyte character split across chunks survives the line budget", async () => {
  const encoded = encoder.encode("한\n글\nx\n");
  const result = await readFilePreviewText(chunked([encoded.slice(0, 2), encoded.slice(2, 6), encoded.slice(6)]), 1000, { maxLines: 2 });
  expect(result).toEqual({ text: "한\n글\n", truncated: true, truncatedBy: "lines", lines: 2 });
});

test("many empty lines stop at the line budget and the excess stream is cancelled", async () => {
  let cancelled = false;
  let pulls = 0;
  const block = encoder.encode("\n".repeat(64 * 1024));
  const endless = new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(block); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const result = await readFilePreviewText(endless, SOURCE_PREVIEW_BYTES, { maxLines: SOURCE_PREVIEW_LINES });
  expect(result.truncated).toBe(true);
  expect(result.truncatedBy).toBe("lines");
  expect(result.lines).toBe(SOURCE_PREVIEW_LINES);
  expect(result.text).toBe("\n".repeat(SOURCE_PREVIEW_LINES));
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(10);
});

test("a byte cut keeps an exact prefix of the source", async () => {
  const source = "가\n".repeat(100);
  const bytes = encoder.encode(source);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += 7) parts.push(bytes.slice(at, at + 7));
  const result = await readFilePreviewText(chunked(parts), 10, { maxLines: SOURCE_PREVIEW_LINES });
  expect(result).toEqual({ text: "가\n가\n", truncated: true, truncatedBy: "bytes", lines: 2 });
  expect(source.startsWith(result.text)).toBe(true);
});
