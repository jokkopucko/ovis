import { expect, it } from "bun:test";
import { PANE_SUMMARY_MAX_IDS, type PaneSummaries } from "../shared/pane-summary.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

it("the demo answers each asked pane's summary from its own chats, with the server's errors", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?pane-summary";
    await import(transport);
    const demo = (globalThis as any).window;
    const ask = (ids: string[]): Promise<Response> => demo.fetch(`/api/pane/summary?${new URLSearchParams(ids.map((id) => ["pane_id", id]))}`);
    const snapshot = (await (await demo.fetch("/api/session")).json()).snapshot as SessionSnapshot;
    const claude = snapshot.panes.find((pane) => pane.agent === "claude")!.pane_id;
    const response = await ask([claude, "nowhere"]);
    expect(response.status).toBe(200);
    const body = await response.json() as PaneSummaries;
    expect(Date.parse(body.server_time)).toBeGreaterThan(0);
    expect(Object.keys(body.summaries)).toEqual([claude, "nowhere"]);
    expect(body.summaries[claude]?.text).toBeTruthy();
    expect(body.summaries["nowhere"]).toBeNull();
    const code = async (answer: Response) => [answer.status, ((await answer.json()) as { error: { code: string } }).error.code];
    expect(await code(await ask([]))).toEqual([400, "missing_pane_id"]);
    expect(await code(await ask(Array.from({ length: PANE_SUMMARY_MAX_IDS + 1 }, (_, index) => `w:p${index}`)))).toEqual([400, "too_many_panes"]);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
