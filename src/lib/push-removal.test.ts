import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";

import { removePushSubscription } from "./push.ts";

const endpoint = "https://push.example/kept-endpoint";
const originalBridge = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
const preconnect = globalThis.fetch.preconnect;
const fetchMock = spyOn(globalThis, "fetch");
afterAll(() => fetchMock.mockRestore());
let savedEndpoint: string | null;
let status: number;
let forgotten: boolean;

beforeEach(() => {
  savedEndpoint = endpoint;
  status = 204;
  forgotten = false;
  Object.defineProperty(globalThis, "Capacitor", {
    configurable: true,
    value: {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "OvisPush" }],
      nativePromise: async (_plugin: string, method: string, options: Record<string, unknown>) => {
        if (method === "getSubscription") {
          return { subscription: options.endpointOnly && savedEndpoint ? { endpoint: savedEndpoint } : null };
        }
        if (method === "unsubscribe") forgotten = true;
        return {};
      },
    },
  });
  fetchMock.mockImplementation(Object.assign(async () => new Response(null, { status }), { preconnect }));
});

afterEach(() => {
  fetchMock.mockClear();
  if (originalBridge) Object.defineProperty(globalThis, "Capacitor", originalBridge);
  else Reflect.deleteProperty(globalThis, "Capacitor");
});

it("deletes the PC subscription when the native keys are damaged", async () => {
  await removePushSubscription();
  expect(fetchMock).toHaveBeenCalledWith("/api/push/subscribe", expect.objectContaining({
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  }));
  expect(forgotten).toBe(true);
});

it("keeps the native endpoint when the PC refuses removal", async () => {
  status = 503;
  await expect(removePushSubscription()).rejects.toThrow();
  expect(forgotten).toBe(false);
});

it("does not contact the PC when there is no native endpoint", async () => {
  savedEndpoint = null;
  await removePushSubscription();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(forgotten).toBe(false);
});
