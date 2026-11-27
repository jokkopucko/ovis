import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import type { AccountList } from "../lib/account/accountList.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MyPcs } from "./ConnectStart.tsx";

const ACCOUNT = "acct_owner";
const ids = { mini: "c".repeat(32), home: "d".repeat(32) };
const pc = (server_id: string, name: string): MyPc => ({ server_id, name, state: "needs-approval", last_seen_at: null, added_at: new Date().toISOString(), listed: true, paired: false, linked: false, join: { server_public_key: "k", relay: "wss://relay.ovis.sh" } });
const phone = { pcs: [], recent: [], current: null, sshPort: null, read: true, reread: () => {} } as never;
/** this phone's list, as far as My PCs asks it: a stand-in that the number dialog asks in vain */
const list = { writer: () => null, view: () => ({ account: ACCOUNT, status: { at: "off" }, reached: false, devices: [], pcs: [] }), subscribe: () => () => {} } as unknown as AccountList;
const postOf = (server_id: string) => ({ list: "f".repeat(64), endpoint: "e".repeat(64), server_id, key: "member-key", enc: "enc-key", card: "card", for: { kind: "add" as const } });

/** who is signed in here, as My PCs reads it */
const signedIn = async (): Promise<string | null> => ACCOUNT;
/** the pages a tap went to */
let assigned: string[] = [];
let page: Page;

/** each PC's row (its name, way and word) as it opens: the PC's own page by its link, or a press here */
const opens = (): [string, string][] => [...page.container.querySelectorAll('[class="relay-add-saved-pc"]')]
  .map((node) => [(node.textContent ?? "").replace(/\s+/g, " ").trim(), node.tagName === "A" ? `link ${node.getAttribute("href")}` : "press"]);

beforeEach(() => {
  page = openPage("https://app.ovis.sh/");
  Object.defineProperty(page.window.location, "assign", { configurable: true, value: (href: string) => { assigned.push(href); } });
  setPageAccountList(list);
  assigned = [];
});

afterEach(async () => {
  await page.close();
  setPageAccountList(null);
});

describe("My PCs on an account that keeps a signed list", () => {
  it("opens the number card for a PC that posted its keys for the list, never its own page's join; one that posted nothing opens as today", async () => {
    const asked: string[] = [];
    const listOf = async (account: string) => { asked.push(account); return { account, list, posts: [postOf(ids.mini)] }; };
    await page.render(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.mini, "Mac mini"), pc(ids.home, "Home server")], phone, listOf, signedIn }) }));
    expect(asked).toEqual([ACCOUNT]);
    expect(opens()).toEqual([["Mac miniRelayOn", "press"], ["Home serverRelayOn", `link /s/${ids.home}/`]]);
    const row = page.one('button[class="relay-add-saved-pc"]');
    await act(async () => { row.click(); });
    expect([...page.container.querySelectorAll('[data-testid="add-pc-number"]')].map((node) => node.getAttribute("data-pc-id"))).toEqual([ids.mini]);
  });

  it("opens the number card for the keys of a PC the move carried in with none, and leaves a PC whose keys another device signed to open as today", async () => {
    const listOf = async (account: string) => ({ account, list, posts: [{ ...postOf(ids.mini), for: { kind: "keys" as const } }, { ...postOf(ids.home), for: { kind: "signer" as const, signer: "tablet-key" } }] });
    await page.render(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.mini, "Mac mini"), pc(ids.home, "Home server")], phone, listOf, signedIn }) }));
    expect(opens()).toEqual([["Mac miniRelayOn", "press"], ["Home serverRelayOn", `link /s/${ids.home}/`]]);
    const row = page.one('button[class="relay-add-saved-pc"]');
    await act(async () => { row.click(); });
    const card = page.one('[data-testid="add-pc-number"]');
    expect([card.getAttribute("data-pc-id"), card.getAttribute("aria-label")]).toEqual([ids.mini, "Give this PC its keys in your account's list?"]);
  });

  it("while the list is not read yet, no account PC's row opens its own page: a tap reads the list, then opens the number card", async () => {
    const posted = { account: ACCOUNT, list, posts: [postOf(ids.mini)] };
    let reads = 0;
    // the first read never answers; the one a tap asks for does
    const listOf = (account: string) => ++reads === 1 ? new Promise<never>(() => {}) : Promise.resolve({ ...posted, account });
    await page.render(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.mini, "Mac mini"), pc(ids.home, "Home server")], phone, listOf, signedIn }) }));
    expect(opens()).toEqual([["Mac miniRelayOn", "press"], ["Home serverRelayOn", "press"]]);
    const row = [...page.container.querySelectorAll<HTMLButtonElement>('button[class="relay-add-saved-pc"]')].find((node) => node.textContent?.startsWith("Mac mini"));
    if (!row) throw new Error("Mac mini row did not render");
    await act(async () => { row.click(); });
    expect([...page.container.querySelectorAll('[data-testid="add-pc-number"]')].map((node) => node.getAttribute("data-pc-id"))).toEqual([ids.mini]);
    // read now: the PC that posted nothing opens its page as before
    expect(opens()).toEqual([["Mac miniRelayOn", "press"], ["Home serverRelayOn", `link /s/${ids.home}/`]]);
    expect(assigned).toEqual([]);
  });

  it("a read that failed leaves no link either: a tap reads again, and opens the PC's page only once the account says it keeps no list", async () => {
    let reads = 0;
    const listOf = async () => { if (++reads === 1) throw new Error("the list store did not answer"); return null; };
    await page.render(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.home, "Home server")], phone, listOf, signedIn }) }));
    expect(opens()).toEqual([["Home serverRelayOn", "press"]]);
    await act(async () => { page.one('button[class="relay-add-saved-pc"]').click(); });
    expect(assigned).toEqual([`/s/${ids.home}/`]);
    expect(opens()).toEqual([["Home serverRelayOn", `link /s/${ids.home}/`]]);
  });

  it("keeps every row as it is on an account with no list", async () => {
    const listOf = async () => null;
    await page.render(createElement(SettingsProvider, { children: createElement(MyPcs, { devices: [], accountPcs: [pc(ids.mini, "Mac mini")], phone, listOf, signedIn }) }));
    expect(opens()).toEqual([["Mac miniRelayOn", `link /s/${ids.mini}/`]]);
  });
});
