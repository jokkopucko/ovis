import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { PairedDevice } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { DEVICES_CHANGED_EVENT } from "../lib/useRelay.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";

describe("reading the list again after this client's pairing joined the account (#3010)", () => {
  const row = (id: string, label: string): PairedDevice => ({ id, label, role: "drive", created_at: "", last_seen_at: "", current: id === "me" });
  const before = [row("me", "before the link")];
  const after = [row("me", "after the link")];
  let reads: Array<(devices: PairedDevice[]) => void> = [];
  let page: Page;

  beforeEach(() => {
    page = openPage();
    setTransport({ ...nativeTransport, fetch: async (input, init) => {
      if ((init?.method ?? "GET") !== "GET") return Response.json({ error: "rename refused" }, { status: 500 });
      return Response.json({ devices: await new Promise<PairedDevice[]>((resolve) => reads.push(resolve)) });
    } });
  });
  afterEach(async () => {
    await page.close();
    reads = [];
    setTransport(nativeTransport);
  });

  const turns = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
  const mount = async () => {
    await page.render(createElement(SettingsProvider, { children: createElement(DevicesPanel, { auth: null }) }));
  };
  const answer = async (read: number, devices: PairedDevice[]) => { await act(async () => { reads[read]!(devices); await turns(); }); };
  const changed = async () => { await act(async () => { page.window.dispatchEvent(new page.window.Event(DEVICES_CHANGED_EVENT)); }); };
  const text = () => page.container.textContent;

  it("shows a pending Not me only beside its device and keeps local Revoke available", async () => {
    const waiting = { ...row("victim", "Phone"), not_me_waiting: true as const };
    await mount();
    await answer(0, [...before, waiting]);
    expect(text()).toContain("Not me is waiting. Revoke this device to stop its access now.");
    expect(page.container.querySelectorAll('[aria-label="Revoke Phone"]')).toHaveLength(1);
    await changed();
    await answer(1, before);
    expect(text()).not.toContain("Not me is waiting.");
  });

  it("shows the list read after the link, even when the read before it answers last", async () => {
    await mount();
    await changed();
    expect(reads).toHaveLength(2);
    await answer(1, after);
    await answer(0, before);
    expect(text()).toContain("after the link");
    expect(text()).not.toContain("before the link");
  });

  it("keeps a warning on screen through that read", async () => {
    await mount();
    await answer(0, before);
    const rename = page.one('button[aria-label="Rename before the link"]');
    await act(async () => { rename.click(); });
    const form = page.one("form");
    await act(async () => { form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); await turns(); });
    expect(page.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const cancel = page.one('button[aria-label="Cancel"]');
    await act(async () => { cancel.click(); });
    await changed();
    await answer(1, after);
    expect(text()).toContain("after the link");
    expect(page.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
});
