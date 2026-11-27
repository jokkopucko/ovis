import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { listView } from "../../shared/account-list.ts";
import { JOIN_LINE_PREFIX, readJoinLine } from "../../shared/account-list-join.ts";
import { listWorld, type WorldDevice } from "../lib/account/accountList.test-helpers.ts";
import * as invites from "../lib/account/listInvite.ts";
import { INVITE_S } from "../lib/account/listInvite.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { AccountRelayPanel } from "./ConnectStart.tsx";
import { agentCommand, InvitePc } from "./InvitePc.tsx";

type World = ReturnType<typeof listWorld>;

let page: Page;
let copied: string[] = [];
let actionDone: Promise<unknown> | undefined;
let restoreActions: () => void;

/** the buttons a person reads, by their words: the switch has a name of its own and no words */
const buttons = (): string[] => [...page.container.querySelectorAll('button:not([role="switch"])')].map((node) => node.textContent?.trim() ?? "");
const press = async (action: string): Promise<void> => {
  actionDone = undefined;
  await act(async () => {
    page.one(`button[data-action="${action}"]`).click();
    if (!actionDone) throw new Error(`No operation for ${action}`);
    await actionDone;
  });
};
const text = () => [...page.container.querySelectorAll('[data-testid="invite-pc"]')].map((node) => node.textContent).join(" ");
const rows = () => [...page.container.querySelectorAll("li")].map((node) => `${node.getAttribute("data-invite-state")}: ${node.textContent}`);
const shown = (mark: string) => page.container.querySelector(`[${mark}=""]`)?.textContent ?? undefined;
const copies = () => [...page.container.querySelectorAll("button")].filter((node) => node.textContent === "Copy");

beforeEach(() => {
  page = openPage("https://app.ovis.sh/");
  copied = [];
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
  Object.defineProperty(page.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  const { makeInvite, revokeInvite } = invites;
  const make = spyOn(invites, "makeInvite").mockImplementation((...args) => (actionDone = makeInvite(...args)));
  const revoke = spyOn(invites, "revokeInvite").mockImplementation((...args) => (actionDone = revokeInvite(...args)));
  restoreActions = () => { make.mockRestore(); revoke.mockRestore(); };
});

afterEach(async () => {
  await page.close();
  restoreActions();
});

async function mounted(): Promise<{ w: World; first: WorldDevice }> {
  const w = listWorld();
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  await page.render(createElement(SettingsProvider, { children: createElement(InvitePc, { list: first.list, now: () => w.clock.now }) }));
  return { w, first };
}

describe("invites for a PC, on a device that may write its account's list", () => {
  it("makes, by default, an invite whose PC asks and waits for Add on a device: the switch for a PC that joins by itself is off", async () => {
    const { w } = await mounted();
    const auto = page.one('[role="switch"]');
    expect(auto.getAttribute("aria-checked")).toBe("false");
    // the warning belongs to the switch, and is not said while it is off
    expect(text()).not.toContain("without asking you");
    await press("make-invite");
    const read = await readJoinLine(shown("data-invite-line")!, { service: w.origin, followsLists: true });
    expect(listView(w.held().state).invites.map((row) => [row.key, row.uses, row.auto])).toEqual([[read.key, 1, false]]);
    expect(text()).toContain("press Add for it on a device of your account");
    expect(text()).not.toContain("without asking you");
  });

  it("with the switch on, makes an invite a PC joins with by itself, and says under the switch what that means", async () => {
    const { w } = await mounted();
    await act(async () => { page.one('[role="switch"]').click(); });
    expect(page.one('[role="switch"]').getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Anyone who gets this line in the next 15 minutes can add a PC to your account without asking you.");
    await press("make-invite");
    const read = await readJoinLine(shown("data-invite-line")!, { service: w.origin, followsLists: true });
    expect(listView(w.held().state).invites.map((row) => [row.key, row.uses, row.auto])).toEqual([[read.key, 1, true]]);
  });

  it("shows an invite's line and the one line for an agent with the account's id, and copies each", async () => {
    const { w } = await mounted();
    expect(buttons()).toEqual(["Make an invite"]);
    expect(text()).toContain("It works once.");
    await act(async () => { page.one('[role="switch"]').click(); });
    await press("make-invite");
    const line = shown("data-invite-line")!;
    expect(line.startsWith(JOIN_LINE_PREFIX)).toBe(true);
    const read = await readJoinLine(line, { service: w.origin, followsLists: true });
    expect(listView(w.held().state).invites.map((row) => [row.key, row.uses, row.auto])).toEqual([[read.key, 1, true]]);
    // the one line an agent runs names the whole account id and never holds the invite
    expect(shown("data-invite-command")).toBe(agentCommand(w.account));
    // the installer of this release takes no invite: it installs, and then `ovis join` joins with the file (docs/relay.md)
    expect(agentCommand(w.account)).toBe(`curl -fsSL https://ovis.sh/install.sh | sh && ~/.local/bin/ovis join --invite-file ~/ovis-invite.txt --account ${w.account}`);
    expect(text()).toContain("For an agent");
    expect(rows()).toEqual([`open: Invite · Expires in ${INVITE_S / 60} minRevoke`]);
    expect(copies()).toHaveLength(2);
    await act(async () => { copies()[0]!.click(); });
    await act(async () => { copies()[0]!.click(); });
    expect(copied).toEqual([line, agentCommand(w.account)]);
  });

  it("counts the minutes down, and once the time is over shows the invite as expired with no line and nothing to revoke", async () => {
    const { w, first } = await mounted();
    await press("make-invite");
    w.clock.now += 9 * 60_000 + 30_000;
    await page.render(createElement(SettingsProvider, { children: createElement(InvitePc, { list: first.list, now: () => w.clock.now }) }));
    expect(rows()).toEqual(["open: Invite · Expires in 5 minRevoke"]);
    w.clock.now += 5 * 60_000;
    await page.render(createElement(SettingsProvider, { children: createElement(InvitePc, { list: first.list, now: () => w.clock.now }) }));
    expect(rows()).toEqual(["expired: Invite · Expired"]);
    expect(shown("data-invite-line")).toBeUndefined();
    expect(shown("data-invite-command")).toBeUndefined();
    // and an hour on it is listed no more
    w.clock.now += 61 * 60_000;
    await page.render(createElement(SettingsProvider, { children: createElement(InvitePc, { list: first.list, now: () => w.clock.now }) }));
    expect(rows()).toEqual([]);
  });

  it("revokes an open invite: its line goes, and the row says so", async () => {
    const { w } = await mounted();
    await press("make-invite");
    const key = listView(w.held().state).invites[0]!.key;
    await press("revoke-invite");
    expect(listView(w.held().state).invites.map((row) => [row.key, row.refusal])).toEqual([[key, "invite_revoked"]]);
    expect(rows()).toEqual(["revoked: Invite · Revoked"]);
    expect(shown("data-invite-line")).toBeUndefined();
  });

  it("says that it is not known yet where the entry went out and the list could not be read, and shows the very line once Make an invite settles it", async () => {
    const { w, first } = await mounted();
    const id = w.held().id;
    let reads = true;
    first.wire.answer = async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path.endsWith("/entries")) { const answer = await w.fake.fetch(request); reads = false; return answer; }
      return !reads && request.method === "GET" && path.startsWith(`/v2/lists/${id}`) ? Response.json({ error: { code: "unavailable", message: "" } }, { status: 503 }) : null;
    };
    await press("make-invite");
    expect(text()).toContain("It is not known yet whether the invite was made. Press Make an invite to check.");
    expect(shown("data-invite-line")).toBeUndefined();
    reads = true;
    await press("make-invite");
    const line = shown("data-invite-line");
    expect(line?.startsWith(JOIN_LINE_PREFIX)).toBe(true);
    // the line of the invite the list holds, and no second invite
    expect(listView(w.held().state).invites.map((row) => row.key)).toEqual([(await readJoinLine(line!, { service: w.origin, followsLists: true })).key]);
  });

  it("says why no invite was made, and shows no line", async () => {
    const { first } = await mounted();
    first.wire.answer = (request) => new URL(request.url).pathname === "/v1/pc-invites" ? Response.json({ error: { code: "invites_full", message: "Revoke an open invite first" } }, { status: 409 }) : null;
    await press("make-invite");
    expect(text()).toContain("Your account has as many open invites as it can. Revoke one first.");
    expect(shown("data-invite-line")).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it("draws nothing on a device that may not write the list", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    await page.render(createElement(SettingsProvider, { children: createElement(InvitePc, { list: second.list }) }));
    expect([...page.container.querySelectorAll('[data-testid="invite-pc"]')]).toEqual([]);
  });
});

describe("the signed-in relay tab of Add PC", () => {
  const code = { start() {}, submit() {}, cancel() {}, state: { active: false, looking: false, failure: null } };
  const drawn = async (userAgent: string, list: WorldDevice["list"] | null): Promise<number> => {
    Object.defineProperty(page.window.navigator, "userAgent", { value: userAgent, configurable: true });
    setPageAccountList(list);
    try {
      await page.render(createElement(SettingsProvider, { children: createElement(AccountRelayPanel, { code }) }));
      const found = [...page.container.querySelectorAll('[data-testid="invite-pc"]')].length;
      await page.render(null);
      return found;
    } finally { setPageAccountList(null); }
  };

  it("offers invites on every device that may write the list, whatever app or browser it is, and nowhere else", async () => {
    const w = listWorld();
    const first = await w.device({ label: "Dana's phone" });
    await first.list.sync();
    const second = await w.device({ label: "Dana's tablet" });
    await second.list.sync();
    // the hosted app in a browser, the phone apps' WebViews, and the Mac app's marker: none of them is asked about
    for (const agent of [
      "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 OvisMac/1.0",
    ]) {
      expect(await drawn(agent, first.list)).toBe(1);
      // a device that waits to be let in, and a page with no list (a PC's own page)
      expect(await drawn(agent, second.list)).toBe(0);
      expect(await drawn(agent, null)).toBe(0);
    }
  });
});
