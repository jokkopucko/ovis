import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { discard, readCapped, readCappedJson, RemoteResponseInvalid, RemoteResponseTooLarge } from "./remote-json.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function body(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const receipt = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[receipt.pulled++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { receipt.cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers }), receipt };
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("capped remote answers", () => {
  it("cancels at cap plus one without decoding", async () => {
    const decode = spyOn(TextDecoder.prototype, "decode");
    cleanups.push(() => decode.mockRestore());
    const { response, receipt } = body([bytes("x".repeat(8)), bytes("y".repeat(9)), bytes("never pulled")]);
    await expect(readCappedJson(response, 16)).rejects.toBeInstanceOf(RemoteResponseTooLarge);
    expect(receipt).toEqual({ pulled: 2, cancelled: true });
    expect(decode).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });

  it("accepts exact cap across UTF-8 chunks", async () => {
    const encoded = bytes(JSON.stringify({ name: "한글 PC" }));
    const split = encoded.indexOf(0xed) + 1;
    const { response, receipt } = body([encoded.slice(0, split), encoded.slice(split)]);
    expect(await readCappedJson<{ name: string }>(response, encoded.byteLength)).toEqual({ name: "한글 PC" });
    expect(receipt.cancelled).toBe(false);
    expect(response.body?.locked).toBe(false);
  });

  it("ignores dishonest length headers", async () => {
    // a small claim does not let a larger body through
    const small = body([bytes("{\"a\":"), bytes("\"0123456789\"}")], { "content-length": "2" });
    await expect(readCapped(small.response, 12)).rejects.toBeInstanceOf(RemoteResponseTooLarge);
    expect(small.receipt.cancelled).toBe(true);
    // a claim past the cap is refused before anything is read
    const large = body([bytes("{}")], { "content-length": "13" });
    await expect(readCapped(large.response, 12)).rejects.toBeInstanceOf(RemoteResponseTooLarge);
    expect(large.receipt).toEqual({ pulled: 0, cancelled: true });
    // no length at all is measured the same way
    const absent = body([bytes("0123456"), bytes("789abc")]);
    expect(absent.response.headers.get("content-length")).toBeNull();
    await expect(readCapped(absent.response, 12)).rejects.toBeInstanceOf(RemoteResponseTooLarge);
    expect(absent.receipt.cancelled).toBe(true);
  });

  it("measures decompressed bytes, not the compressed length", async () => {
    const decoded = new Uint8Array(1024 * 1024).fill(0x20);
    const compressed = Bun.gzipSync(decoded);
    const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(compressed, { headers: { "content-encoding": "gzip" } }) });
    cleanups.push(() => peer.stop(true));
    const fetchBody = () => fetch(`http://127.0.0.1:${peer.port}/`);
    expect(compressed.byteLength).toBeLessThan(64 * 1024);
    await expect(readCapped(await fetchBody(), 64 * 1024)).rejects.toBeInstanceOf(RemoteResponseTooLarge);
    expect((await readCapped(await fetchBody(), decoded.byteLength)).byteLength).toBe(decoded.byteLength);
  });

  it("reports malformed JSON without echoing it", async () => {
    const { response } = body([bytes("{\"token\": fixture-secret-token")]);
    const failure = await readCappedJson(response, 1024).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RemoteResponseInvalid);
    expect(String((failure as Error).message)).not.toContain("fixture-secret");
  });

  it("cancels an answer that will not be read", async () => {
    const { response, receipt } = body([bytes("unread")]);
    await discard(response);
    expect(receipt).toEqual({ pulled: 0, cancelled: true });
    await discard(new Response(null, { status: 304 }));
  });
});
