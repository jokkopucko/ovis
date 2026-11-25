import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { ListReason } from "./ListReason.tsx";

const text = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(text).join("");

describe("why this PC lets nobody of its account's list in, in Settings", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let answer: () => Response | Promise<Response>;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7317/" }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 },
      addEventListener: () => {}, removeEventListener: () => {},
    } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false, querySelector: () => null, documentElement: { lang: "", dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
    setTransport({ ...nativeTransport, fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://127.0.0.1:7317").pathname;
      return path === "/api/account/status" ? answer() : Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    }) as typeof nativeTransport.fetch });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    setTransport(nativeTransport);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const shown = async (): Promise<string | null> => {
    await act(async () => { renderer = create(<SettingsProvider><ListReason /></SettingsProvider>); });
    await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
    const found = renderer!.root.findAll((node) => node.props["data-testid"] === "list-reason");
    return found.length === 0 ? null : text(found[0]!);
  };

  it("says what the PC pinned to its list says of itself", async () => {
    answer = () => Response.json({ account: "acct_1", list: { pinned_list: "ab".repeat(32), standing: "in", reason: "A device this PC lets into your account's list waits behind an entry this PC signed earlier, until 2026-11-25T07:00:00.000Z." } });
    expect(await shown()).toContain("waits behind an entry this PC signed earlier");
  });

  it("says what a PC that cannot read its own account state says", async () => {
    answer = () => Response.json({ error: { code: "strict", message: "strict", reason: "account-pc.json cannot be trusted: unknown version" } }, { status: 403 });
    expect(await shown()).toContain("account-pc.json cannot be trusted");
  });

  it("shows nothing for a PC that follows no list, or one with nothing to say", async () => {
    answer = () => Response.json({ account: "acct_1" });
    expect(await shown()).toBeNull();
    await act(async () => { renderer?.unmount(); });
    answer = () => Response.json({ account: "acct_1", list: { pinned_list: "ab".repeat(32), standing: "in", reason: null } });
    expect(await shown()).toBeNull();
  });

  it("keeps the newest read when an older one answers after it", async () => {
    let release: (response: Response) => void = () => {};
    const late = new Promise<Response>((resolve) => { release = resolve; });
    let reads = 0;
    answer = () => ++reads === 1 ? late : Response.json({ account: "acct_1" });
    jest.useFakeTimers();
    expect(await shown()).toBeNull();
    await act(async () => { jest.advanceTimersByTime(15_000); });
    expect(reads).toBe(2);
    await act(async () => { release(Response.json({ error: { code: "strict", message: "strict", reason: "account-pc.json cannot be trusted" } }, { status: 403 })); });
    await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
    expect(renderer!.root.findAll((node) => node.props["data-testid"] === "list-reason").length).toBe(0);
  });
});
