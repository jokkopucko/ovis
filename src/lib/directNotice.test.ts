import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LanExposureNotice } from "../components/LanExposureNotice.tsx";
import { directHostOf, useDirectNotice } from "./directNotice.ts";
import { SettingsProvider } from "./settings.ts";

interface ProbeProps { scope: string; host: string | null | undefined; seen: { dismissed: boolean; dismiss: () => void }[] }

function Probe({ scope, host, seen }: ProbeProps) {
  seen.push(useDirectNotice(scope, host));
  return null;
}

describe("the same-Wi-Fi direct notice", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let renderer: ReactTestRenderer | undefined;
  const tabs: ReactTestRenderer[] = [];

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    records = new Map();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => void records.set(key, value), removeItem: (key: string) => void records.delete(key) },
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); for (const tab of tabs.splice(0)) tab.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function load(scope: string, host: string | null | undefined) {
    const seen: ProbeProps["seen"] = [];
    await act(async () => { renderer?.unmount(); renderer = create(createElement(Probe, { scope, host, seen })); });
    return { latest: () => seen.at(-1)!, answer: async (next: string | null | undefined) => { await act(async () => { renderer!.update(createElement(Probe, { scope, host: next, seen })); }); } };
  }

  it("stays dismissed on the next load for the same PC and address", async () => {
    const page = await load("", "192.168.0.10");
    expect(page.latest().dismissed).toBe(false);
    await act(async () => { page.latest().dismiss(); });
    expect(page.latest().dismissed).toBe(true);
    expect((await load("", "192.168.0.10")).latest().dismissed).toBe(true);
    expect((await load("pc-two", "192.168.0.10")).latest().dismissed).toBe(false);
  });

  it("comes back when the address changes", async () => {
    const page = await load("", "192.168.0.10");
    await act(async () => { page.latest().dismiss(); });
    await page.answer("192.168.0.22");
    expect(page.latest().dismissed).toBe(false);
  });

  it("comes back once direct is turned off and on again, but not after an unanswered read", async () => {
    const page = await load("", "192.168.0.10");
    await act(async () => { page.latest().dismiss(); });
    expect((await load("", undefined)).latest().dismissed).toBe(false);
    const again = await load("", "192.168.0.10");
    expect(again.latest().dismissed).toBe(true);
    await again.answer(null);
    await again.answer("192.168.0.10");
    expect(again.latest().dismissed).toBe(false);
  });

  async function tab(scope: string, host: string) {
    const seen: ProbeProps["seen"] = [];
    let own: ReactTestRenderer;
    await act(async () => { own = create(createElement(Probe, { scope, host, seen })); });
    tabs.push(own!);
    return { answer: async (next: string | null) => { await act(async () => { own.update(createElement(Probe, { scope, host: next, seen })); }); } };
  }

  it("keeps a dismissal another tab made or forgot while this one was open", async () => {
    const pcA = await load("pc-a", "192.168.0.10");
    await act(async () => { pcA.latest().dismiss(); });
    const pcB = await load("pc-b", "192.168.0.20");
    await act(async () => { pcB.latest().dismiss(); });
    const tabA = await tab("pc-a", "192.168.0.10");
    const tabB = await tab("pc-b", "192.168.0.20");
    await tabA.answer(null);
    await tabB.answer(null);
    await tabB.answer("192.168.0.20");
    expect((await load("pc-a", "192.168.0.10")).latest().dismissed).toBe(false);
  });
});

describe("what a health answer says about direct", () => {
  it("reads the direct address only from an answer that got in", () => {
    const signedIn = { required: false, authenticated: true };
    expect(directHostOf(null)).toBeUndefined();
    expect(directHostOf({ auth: signedIn, direct_exposure: { host: "192.168.0.10" } })).toBe("192.168.0.10");
    expect(directHostOf({ auth: signedIn })).toBeNull();
    // a signed-out answer never names exposure, so it says nothing about direct
    expect(directHostOf({ auth: { required: true, authenticated: false } })).toBeUndefined();
    expect(directHostOf({ auth: signedIn, lan_exposure: { host: "0.0.0.0" } })).toBeNull();
    expect(directHostOf({ auth: signedIn, lan_exposure: { host: "10.0.0.7", direct: true } })).toBe("10.0.0.7");
  });
});

describe("the exposure line", () => {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => { Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }); });
  afterEach(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });

  it("offers a dismiss on the direct notice only, never on the open-server warning", () => {
    const render = (direct: boolean) => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(LanExposureNotice, { host: "192.168.0.10", direct, onOpen: () => undefined, onDismiss: () => undefined }) }));
    expect(render(true)).toContain("aria-label=\"Dismiss\"");
    expect(render(false)).not.toContain("aria-label=\"Dismiss\"");
  });
});
