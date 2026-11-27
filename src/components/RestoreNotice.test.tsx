import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { reloadRestoredAppPage } from "../lib/pageRestore.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RestoreNotice } from "./RestoreNotice.tsx";

let page: Page;
beforeEach(() => { page = openPage("https://app.ovis.sh/s/abc/"); });
afterEach(async () => { await page.close(); });

describe("the notice of a restored page whose reload waits for its unsent text", () => {
  it("says to copy the text, and its Reload app reloads once the text is kept or gone", async () => {
    const target = new EventTarget();
    const loads: string[] = [];
    let kept = false;
    reloadRestoredAppPage({ addEventListener: target.addEventListener.bind(target), location: { reload: () => { loads.push("reload"); } } }, () => true, () => kept);
    await page.render(createElement(SettingsProvider, { children: createElement(RestoreNotice) }));
    expect(page.container.childNodes).toHaveLength(0);
    await act(async () => { target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); });
    const notice = () => page.one('[data-restore-held]');
    expect(notice().textContent).toContain("Copy what you need, then reload.");
    await act(async () => { page.one<HTMLButtonElement>('[data-restore-held] button').click(); });
    expect(loads).toEqual([]);
    expect(notice().textContent).toContain("still not kept");
    kept = true;
    await act(async () => { page.one<HTMLButtonElement>('[data-restore-held] button').click(); });
    expect(loads).toEqual(["reload"]);
    expect(page.container.childNodes).toHaveLength(0);
  });
});
