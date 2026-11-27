import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { ListReason } from "./ListReason.tsx";

describe("why this PC lets nobody of its account's list in, in Settings", () => {
  let page: Page;
  let answer: () => Response | Promise<Response>;

  beforeEach(() => {
    page = openPage("http://127.0.0.1:7317/");
    Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0" });
    Object.defineProperty(page.window.navigator, "maxTouchPoints", { configurable: true, value: 0 });
    Object.defineProperty(page.window.document, "hidden", { configurable: true, value: false });
    setTransport({ ...nativeTransport, fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input), "http://127.0.0.1:7317").pathname;
      return path === "/api/account/status" ? answer() : Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    }) as typeof nativeTransport.fetch });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    setTransport(nativeTransport);
  });

  const shown = async (): Promise<string | null> => {
    await page.render(<SettingsProvider><ListReason /></SettingsProvider>);
    await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
    return page.container.querySelector('[data-testid="list-reason"]')?.textContent ?? null;
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
    await page.render(null);
    answer = () => Response.json({ account: "acct_1", list: { pinned_list: "ab".repeat(32), standing: "in", reason: null } });
    expect(await shown()).toBeNull();
  });

  it("reads at once when the page shows again after skipping its reads while hidden", async () => {
    let reads = 0;
    answer = () => { reads++; return Response.json({ account: "acct_1" }); };
    jest.useFakeTimers();
    expect(await shown()).toBeNull();
    expect(reads).toBe(1);
    Object.defineProperty(page.window.document, "hidden", { configurable: true, value: true });
    await act(async () => { jest.advanceTimersByTime(15_000); });
    expect(reads).toBe(1);
    answer = () => { reads++; return Response.json({ account: "acct_1", list: { pinned_list: "ab".repeat(32), standing: "in", reason: "A device waits behind an entry this PC signed earlier." } }); };
    Object.defineProperty(page.window.document, "hidden", { configurable: true, value: false });
    await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    await act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
    expect(reads).toBe(2);
    expect(page.container.querySelector('[data-testid="list-reason"]')?.textContent).toContain("waits behind an entry");
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
    expect(page.container.querySelectorAll('[data-testid="list-reason"]').length).toBe(0);
  });
});
