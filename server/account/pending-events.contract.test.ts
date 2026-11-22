import { expect, test } from "bun:test";
import { DEVICE_COOKIE } from "../auth.ts";
import { isJsonObject } from "../http.ts";
import { bounded } from "../relay/test-helpers.ts";
import { withHeaders } from "../websocket.test-helpers.ts";
import { provingDevice } from "./key-proof.test-helpers.ts";
import { firstPairingRead, memberRow, pairingPc, type Pc } from "./pairing.test-helpers.ts";

async function* sseEvents(response: Response): AsyncGenerator<unknown> {
  if (!response.ok || response.body === null) throw new Error(`SSE rejected: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffered += decoder.decode(chunk.value, { stream: true });
      for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (block.startsWith("data: ")) yield JSON.parse(block.slice(6));
      }
    }
  } finally { reader.releaseLock(); }
}

function socketEvents(url: string, headers: Record<string, string>, made: Pc): ReadableStream<unknown> {
  const socket = withHeaders(headers)(url);
  made.closes.push(() => socket.close());
  return new ReadableStream({
    start(controller) {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "machine-events", enabled: true })));
      socket.addEventListener("message", ({ data }) => {
        const frame: unknown = JSON.parse(String(data));
        if (isJsonObject(frame) && frame.type === "machine-event") controller.enqueue(frame.event);
      });
      socket.addEventListener("close", () => controller.close());
    },
  });
}

// A preferences event is a fence on the same document: anything already sent precedes it.
async function throughPreferences(next: () => Promise<{ readonly done?: boolean; readonly value?: unknown }>, revision: unknown): Promise<unknown[]> {
  const pending: unknown[] = [];
  for (;;) {
    const { done, value } = await next();
    if (done) throw new Error("Machine event stream ended before the preferences fence");
    if (!isJsonObject(value)) continue;
    if (value.type === "pending-redemptions") pending.push(value.pending);
    if (value.type === "preferences" && isJsonObject(value.preferences) && value.preferences.revision === revision) return pending;
  }
}

for (const transport of ["SSE", "WebSocket"] as const) {
  test(`S31/T71: late ${transport} drive subscribers see waiting keys and changes, watch subscribers see neither`, async () => {
    const made = await pairingPc({ rows: [(await memberRow("acct_1")).row], server: { accountOpensAll: true, platform: "linux" } });
    const abort = new AbortController();
    try {
      await firstPairingRead(made);
      const observer = made.devices.pair(made.devices.startPairing().code, "Observer", "watch");
      if (!observer) throw new Error("Could not pair the watch fixture");
      expect(made.devices.match(observer.token)?.role).toBe("watch");
      const paired = await provingDevice(made, await made.offerCode());
      await paired.pending;

      const base = `http://127.0.0.1:${made.app.port}`;
      const open = async (headers: Record<string, string>) => {
        if (transport === "WebSocket") {
          const reader = socketEvents(`ws://127.0.0.1:${made.app.port}/ws`, headers, made).getReader();
          return () => reader.read();
        }
        const events = sseEvents(await fetch(`${base}/api/machines/events`, { headers, signal: abort.signal }));
        return () => events.next();
      };
      const drive = await open({});
      const watch = await open({ cookie: `${DEVICE_COOKIE}=${observer.token}` });
      const initial = await made.local("/api/preferences");
      const revision = initial.body.revision;
      expect(typeof revision).toBe("number");
      // The initial preferences arrive before pairings; a new revision fences the snapshot.
      const [driveBefore, watchBefore] = await bounded(Promise.all([throughPreferences(drive, revision), throughPreferences(watch, revision)]), 2_000);
      const fence = async (language: string) => {
        const written = await made.local("/api/preferences", { method: "PUT", body: { settings: { language } } });
        expect(written.status).toBe(200);
        return bounded(Promise.all([throughPreferences(drive, written.body.revision), throughPreferences(watch, written.body.revision)]), 2_000);
      };
      const [driveSnapshot, watchSnapshot] = await fence("ko");
      expect([...driveBefore, ...driveSnapshot]).toEqual([[expect.objectContaining({ fingerprint: paired.fingerprint })]]);
      expect([...watchBefore, ...watchSnapshot]).toEqual([]);

      paired.link.stop();
      await bounded(paired.link.closed, 2_000);
      const [driveChanges, watchChanges] = await fence("en");
      expect(driveChanges).toEqual([[]]);
      expect(watchChanges).toEqual([]);
    } finally {
      abort.abort();
      await made.close();
    }
  });
}
