import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { nativeTransport, setTransport } from "./transport.ts";
import { type ResourceUrlState, useResourceUrlState } from "./useResourceUrl.ts";

let renderer: ReactTestRenderer | null = null;
let seen: ResourceUrlState[] = [];
function Probe({ path }: { path: string }) { seen.push(useResourceUrlState(path)); return null; }
/** Lets the transport's promise settle: a bounded number of turns, each inside act. */
const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };
const last = () => seen.at(-1);

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
afterAll(() => {
  if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  seen = [];
  setTransport(nativeTransport);
});

it("gives a refused address as a failed state, not an unhandled rejection", async () => {
  // Given a transport that refuses the resource
  const refusal = new TypeError("relay closed");
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: () => Promise.reject(refusal) });
  // When the hook asks for it
  await act(async () => { renderer = create(createElement(Probe, { path: "/api/fs/file?path=a.png" })); });
  await settle(() => last()?.error != null);
  // Then the caller sees the refusal (Bun's runner also fails an unhandled rejection)
  expect(last()).toEqual({ url: null, error: refusal });
});

it("is null while a later answer is on its way, then gives it", async () => {
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: async (path) => `mapped:${path}` });
  await act(async () => { renderer = create(createElement(Probe, { path: "/api/fs/file?path=a.png" })); });
  expect(seen[0]).toEqual({ url: null, error: null });
  await settle(() => last()?.url != null);
  expect(last()).toEqual({ url: "mapped:/api/fs/file?path=a.png", error: null });
});

it("gives the native transport's address at once", async () => {
  await act(async () => { renderer = create(createElement(Probe, { path: "/api/fs/file?path=a.png" })); });
  expect(seen[0]).toEqual({ url: "/api/fs/file?path=a.png", error: null });
});
