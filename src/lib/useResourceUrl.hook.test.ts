import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { nativeTransport, setTransport } from "./transport.ts";
import { type ResourceUrlState, useResourceUrlState } from "./useResourceUrl.ts";

let page: Page;
let seen: ResourceUrlState[] = [];
function Probe({ path }: { path: string }) { seen.push(useResourceUrlState(path)); return null; }
const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };
const last = () => seen.at(-1);

beforeEach(() => { page = openPage(); });
afterEach(async () => {
  await page.close();
  seen = [];
  setTransport(nativeTransport);
});

it("gives a refused address as a failed state, not an unhandled rejection", async () => {
  const refusal = new TypeError("relay closed");
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: () => Promise.reject(refusal) });
  await page.render(createElement(Probe, { path: "/api/fs/file?path=a.png" }));
  await settle(() => last()?.error != null);
  // Then the caller sees the refusal (Bun's runner also fails an unhandled rejection)
  expect(last()).toEqual({ url: null, error: refusal });
});

it("is null while a later answer is on its way, then gives it", async () => {
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: async (path) => `mapped:${path}` });
  await page.render(createElement(Probe, { path: "/api/fs/file?path=a.png" }));
  expect(seen[0]).toEqual({ url: null, error: null });
  await settle(() => last()?.url != null);
  expect(last()).toEqual({ url: "mapped:/api/fs/file?path=a.png", error: null });
});

it("gives the native transport's address at once", async () => {
  await page.render(createElement(Probe, { path: "/api/fs/file?path=a.png" }));
  expect(seen[0]).toEqual({ url: "/api/fs/file?path=a.png", error: null });
});
