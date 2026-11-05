import { expect, test } from "bun:test";
import { chatReadDeadlineMs, withChatReadDeadline } from "./chatReadDeadline.ts";

test("a stalled header aborts and releases the serialized reader", async () => {
  let signal: AbortSignal | undefined;
  await expect(withChatReadDeadline((next) => { signal = next; return new Promise(() => {}); }, 10)).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  expect(await withChatReadDeadline(async () => "next read", 10)).toBe("next read");
});

test("the same deadline covers the body and ignores a late result", async () => {
  let resolve!: (value: string) => void;
  const late = new Promise<string>((done) => { resolve = done; });
  const read = withChatReadDeadline(async () => { await Promise.resolve("headers"); return await late; }, 10);
  await expect(read).rejects.toThrow("timed out");
  resolve("obsolete");
  expect(await withChatReadDeadline(async () => "current", 10)).toBe("current");
});

test("success and HTTP failures preserve the original result or error", async () => {
  const error = new Error("HTTP 401");
  await expect(withChatReadDeadline(async () => { throw error; }, 10)).rejects.toBe(error);
  const result = { turns: [] };
  expect(await withChatReadDeadline(async () => result, 10)).toBe(result);
});

test("a remote PC's read, which crosses the machine proxy, waits twice as long as a local one", () => {
  expect(chatReadDeadlineMs("local")).toBe(15_000);
  expect(chatReadDeadlineMs("studio-mac")).toBe(30_000);
});

test("a replaced screen releases an uncooperative read immediately and aborts its transport", async () => {
  const screen = new AbortController();
  let transport: AbortSignal | undefined;
  const late = Promise.withResolvers<string>();
  const pending = withChatReadDeadline((signal) => { transport = signal; return late.promise; }, 30_000, screen.signal);
  screen.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(transport?.aborted).toBe(true);
  late.resolve("obsolete");
  expect(await withChatReadDeadline(async () => "current", 10)).toBe("current");
});

test("an already cancelled screen starts no read, and settled reads remove their abort listener", async () => {
  const screen = new AbortController();
  const add = screen.signal.addEventListener.bind(screen.signal);
  const remove = screen.signal.removeEventListener.bind(screen.signal);
  const listeners: EventListenerOrEventListenerObject[] = [];
  const removed: EventListenerOrEventListenerObject[] = [];
  screen.signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => { if (listener) { listeners.push(listener); add(type, listener, options); } };
  screen.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => { if (listener) { removed.push(listener); remove(type, listener, options); } };
  expect(await withChatReadDeadline(async () => "done", 10, screen.signal)).toBe("done");
  const failure = new Error("refused");
  await expect(withChatReadDeadline(async () => { throw failure; }, 10, screen.signal)).rejects.toBe(failure);
  expect(removed).toEqual(listeners);
  const pending = withChatReadDeadline(() => new Promise(() => {}), 30_000, screen.signal);
  screen.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(removed).toEqual(listeners);
  let started = false;
  await expect(withChatReadDeadline(async () => { started = true; }, 10, screen.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(started).toBe(false);
  expect(removed).toEqual(listeners);
});
