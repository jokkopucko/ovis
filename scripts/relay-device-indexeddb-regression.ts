import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import type { RelayDevice } from "../src/lib/relay/device.ts";
import { chromePath } from "./chrome-path.ts";

const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("../src/lib/relay/device.ts", import.meta.url))], target: "browser" });
const module = build.outputs[0];
if (!build.success || module === undefined) throw new AggregateError(build.logs, "Could not build device store");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new URL(request.url).pathname === "/device.js"
  ? new Response(module, { headers: { "content-type": "text/javascript" } }) : new Response("<!doctype html><title>IndexedDB test</title>", { headers: { "content-type": "text/html" } }) });
try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const result = await page.evaluate(async () => {
      const modulePath = "/device.js";
      const { indexedDeviceStore: store }: typeof import("../src/lib/relay/device.ts") = await import(modulePath);
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const source: RelayDevice = { server_id: "source", server_public_key: "server-key", relay: "wss://relay.invalid", device_id: "device", private_key: pair.privateKey, public_spki: "device-key", label: "Phone" };
      const target = { ...source, server_id: "introduced" };
      await store.update(source.server_id, () => source);
      // The removal and target write overlap; the earlier readwrite transaction wins.
      const removal = store.remove(source.server_id);
      const introduced = store.update(target.server_id, () => target, { serverId: source.server_id, assert: (current) => {
        if (current === undefined) throw new DOMException("Source pairing was forgotten", "AbortError");
      } }).then(() => "saved", (error: unknown) => {
        if (error instanceof DOMException) return error.name;
        throw error;
      });
      await removal;
      return { outcome: await introduced, devices: (await store.list()).map((device) => device.server_id) };
    });
    assert.deepEqual(result, { outcome: "AbortError", devices: [] });
    console.log("PASS IndexedDB source removal: introduced pairing refused with AbortError, no devices saved");
  } finally {
    await browser.close();
  }
} finally {
  await server.stop(true);
}
