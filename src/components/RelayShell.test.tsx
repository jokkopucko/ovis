import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPage, reactProps, type Page } from "../lib/page.fixture.ts";
import type { AccountList } from "../lib/account/accountList.ts";
import { LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { endPairCodeComposition, typePairCode } from "../lib/pairCodeInput.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { signInLink } from "./ConnectPhoneDialog.tsx";
import { keyIdGroups } from "./KeyId.tsx";
import * as AccountJoinRequestsModule from "./AccountJoinRequests.tsx";
import { ADD_PC_FROM_KEY } from "./MachineSidebar.tsx";
import * as NewPcNoticesModule from "./NewPcNotices.tsx";
import { leaveAddEntry, RelayShell, type RelayShellProps } from "./RelayShell.tsx";
import * as UnconfirmedPcNoticesModule from "./UnconfirmedPcNotices.tsx";

const EXPECTED = "0123456789abcdef0123456789abcdef";
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
let staticPage: Page | undefined;
afterEach(async () => {
  const page = staticPage;
  staticPage = undefined;
  await page?.close();
});

const render = (shown: RelayShellProps): string => {
  if (staticPage === undefined) {
    staticPage = openPage("https://app.ovis.sh/");
    staticPage.window.happyDOM.setViewport({ width: 390, height: 844 });
  }
  return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
};
describe("the front page's account part", () => {
  // the dashboard is a page opened on purpose, by its address: a front page with none is Add a PC
  const pc = (server_id: string, name: string, state: "paired" | "needs-approval" | "offline" | "needs-update", paired = state === "paired") => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired });

  it("offers GitHub alone until the service is set up for Apple", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Apple");
  });

  const saved = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];

  const tabsOf = (html: string) => [...html.matchAll(/<button type="button" aria-pressed="(true|false)" data-tab="(\w+)">([^<]+)</g)].map(([, pressed, tab, label]) => [tab, label, pressed]);
  const panelOf = (html: string, tab: string): string => /<div class="connect-start-panel" data-tab-panel="(\w+)">/.exec(html)?.[1] === tab ? html.slice(html.indexOf(`data-tab-panel="${tab}"`)) : "";
  const viewOf = (html: string): string | null => /data-view="([\w-]+)"/.exec(shownOf(html))?.[1] ?? null;
  const titleOf = (html: string): string | undefined => html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
  // each row of My PCs: where it leads and its words (name, way, state), its Forget left out
  const rowsOf = (html: string) => [...html.matchAll(/<a class="relay-add-saved-pc" href="([^"]+)">([\s\S]*?)<\/a>/g)].map(([, href, inner]) => [href, inner!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " ")]);
  const ways = (html: string) => [...html.matchAll(/<button type="button" class="relay-add-way" data-action="([\w-]+)"/g)].map(([, action]) => action);

  it("opens signed out with no PC saved here on Connect a PC: the three tabs, Ovis relay chosen, the sign-in inside it and no list", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-account-state="signed-out"');
    expect(viewOf(html)).toBe("add-pc");
    expect(titleOf(html)).toBe("Connect a PC");
    expect(html.match(/<h1/g)).toHaveLength(1);
    // the front page itself: nothing to go back to
    expect(html).not.toContain('aria-label="Back"');
    expect(tabsOf(html)).toEqual([["relay", "Ovis relay", "true"], ["tailscale", "Tailscale", "false"], ["ssh", "SSH", "false"]]);
    const relay = panelOf(html, "relay");
    const buttons = [...relay.matchAll(/<button type="button" class="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?(Continue with [^<]+)</g)].map(([, kind, label]) => [kind, label]);
    expect(buttons).toEqual([["btn account-provider", "Continue with GitHub"], ["btn account-provider", "Continue with Apple"]]);
    expect(relay.indexOf("Continue with Apple")).toBeLessThan(relay.indexOf("First time? Your account is made right away."));
    // a browser has no scanner: the code instead, folded to one line
    expect(ways(relay)).toEqual([]);
    expect(relay).toMatch(/<button type="button" class="connect-address-link" data-action="add-code" aria-expanded="false">Pair with a code<\/button>/);
    expect(html).not.toContain("Your PCs, anywhere.");
    expect(html).not.toContain("Sign in to your Ovis account");
    expect(html).not.toContain("Start without signing in");
    expect(html).not.toContain("relay-shell-pc");
    expect(html).not.toContain("relay-add-saved");
    expect(html).not.toContain("acct_");
  });

  it("opens signed out on My PCs once this device saved a PC, its pairings by their pages and Add PC under them, the sign-in behind it", () => {
    const two = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(viewOf(two)).toBe("my-pcs");
    expect(titleOf(two)).toBe("Your PCs");
    expect(rowsOf(two)).toEqual([[`/s/${"a".repeat(32)}/`, "p620 Relay"], [`/s/${"b".repeat(32)}/`, "nuc Relay"]]);
    expect(shownOf(two)).not.toContain("Continue with GitHub");
    expect(shownOf(two)).not.toContain("data-tab=");
    expect(two).toMatch(/<div class="my-pcs-add"><button type="button" class="btn btn-primary" data-action="add-pc">(<svg[\s\S]*?<\/svg>)?Add PC<\/button><\/div><\/div>/);
    expect(two).not.toContain("<details");
    // a sign-in that ended says so here too, where the list is
    const ended = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")], account: { kind: "signed-out", error: "Your sign-in ended." } }), scoped: false, onSignIn: none });
    expect(ended).toContain('role="alert">Your sign-in ended.');
    // with no account service, the list of this device's pairings stays as it was
    const accountless = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")] }), scoped: false });
    expect(accountless).toContain(`href="/s/${"a".repeat(32)}/"`);
    expect(viewOf(accountless)).toBeNull();
  });

  it("returns to Connect a PC after sign-out when nothing is saved here, and stays on My PCs when something is", () => {
    const devices = [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")];
    const signedIn = render({ ...props({ kind: "list", devices, account: { kind: "signed-in", provider: "github", error: null, pcs: [pc("a".repeat(32), "p620", "paired")] } }), scoped: false, onSignIn: none });
    expect(viewOf(signedIn)).toBe("my-pcs");
    expect(shownOf(signedIn)).not.toContain("Continue with GitHub");
    const after = render({ ...props({ kind: "list", devices, account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(viewOf(after)).toBe("my-pcs");
    expect(after).not.toContain("Sign out");
    const none_ = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(tabsOf(none_).map(([tab, , pressed]) => [tab, pressed])).toEqual([["relay", "true"], ["tailscale", "false"], ["ssh", "false"]]);
    expect(panelOf(none_, "relay")).toContain("Continue with GitHub");
  });

  it("opens signed in with no PC on My PCs with nothing listed, saying what to do on the PC, and Add PC", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none });
    expect(html).toContain('data-account-state="signed-in"');
    expect(viewOf(html)).toBe("my-pcs");
    expect(titleOf(html)).toBe("Your PCs");
    expect(shownOf(html).match(/<h1/g)).toHaveLength(1);
    expect(shownOf(html)).not.toContain("data-tab=");
    expect(html).toContain("Sign in with the same account on the PC where Ovis runs");
    expect(rowsOf(html)).toEqual([]);
    expect(html).toContain('data-action="add-pc"');
    expect(shownOf(html)).not.toContain("Continue with");
  });

  it("says of a PC what this device found first: its Ovis too old, a check that found it off or on, then the account's word", () => {
    const join = { server_public_key: "k", relay: "wss://relay.example" };
    const outdated = Object.assign(saved("a".repeat(32), "old-desk"), { observed_version: { version: "0.4.0", outdated: true } });
    const pcStatus = new Map([["a".repeat(32), { kind: "answered", route: "relay", rttMs: 40 }], ["c".repeat(32), { kind: "offline", reason: "pc" }], ["d".repeat(32), { kind: "answered", route: "relay", rttMs: 40 }]] as const);
    // desk's heartbeat is recent, but the relay just found it off; attic's heartbeat is old, but it just answered
    const account = { kind: "signed-in" as const, provider: "github" as const, error: null, pcs: [{ ...pc("c".repeat(32), "desk", "needs-approval"), join }, { ...pc("d".repeat(32), "attic", "offline"), join }] };
    const html = render({ ...props({ kind: "list", devices: [outdated], account }), scoped: false, onSignIn: none, pcStatus });
    expect(rowsOf(html)).toEqual([[`/s/${"a".repeat(32)}/`, "old-desk Relay Update needed"], [`/s/${"c".repeat(32)}/`, "desk Relay Off"], [`/s/${"d".repeat(32)}/`, "attic Relay On"]]);
    // signed out the same: the saved version is this device's own word
    const out = render({ ...props({ kind: "list", devices: [outdated], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, pcStatus });
    expect(rowsOf(out)).toEqual([[`/s/${"a".repeat(32)}/`, "old-desk Relay Update needed"]]);
  });

  it("says of a PC that the account's list does not hold that it is not in the list yet, and of a list this device cannot read, above the rows", () => {
    const join = { server_public_key: "k", relay: "wss://relay.example" };
    const pcs = [{ ...pc("c".repeat(32), "desk", "needs-approval"), join, byList: true as const }, { ...pc("d".repeat(32), "old-box", "needs-approval"), join, notInList: true as const }];
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs } }), scoped: false, onSignIn: none });
    expect(rowsOf(html)).toEqual([[`/s/${"c".repeat(32)}/`, "desk Relay On"], [`/s/${"d".repeat(32)}/`, "old-box Relay Not in your account&#x27;s list yet On"]]);
    expect(html).not.toContain("data-list-unread");
    // a copy only a newer app reads, and one that does not read: one line each, and every row marked
    const marked = [{ ...pc("c".repeat(32), "desk", "needs-approval"), join, notInList: true as const }, { ...pc("d".repeat(32), "old-box", "needs-approval"), join, notInList: true as const }];
    const newer = render({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs: marked, list: "newer" } }), scoped: false, onSignIn: none });
    expect(newer).toContain("This device cannot read your account&#x27;s list. Update the app.");
    expect(rowsOf(newer).map(([, text]) => text)).toEqual(["desk Relay Not in your account&#x27;s list yet On", "old-box Relay Not in your account&#x27;s list yet On"]);
    const damaged = render({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs: marked, list: "damaged" } }), scoped: false, onSignIn: none });
    expect(damaged).toMatch(/data-list-unread="damaged"[^>]*>This device cannot read your account&#x27;s list\. Sign out and in again on this device, then allow it from another device\.</);
  });

  it("lists on My PCs this device's own PCs and then the account's it can open, each once, by way and state, whatever the address", () => {
    const devices = [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")];
    const pcStatus = new Map([["a".repeat(32), { kind: "answered", route: "relay", rttMs: 40 }], ["b".repeat(32), { kind: "offline", reason: "pc" }]] as const);
    const join = { server_public_key: "k", relay: "wss://relay.example" };
    // a row with no way to join (no key or relay in the directory) is no link: its page would open on nothing
    const account = { kind: "signed-in" as const, provider: "github" as const, error: null, pcs: [pc("a".repeat(32), "p620", "paired"), { ...pc("c".repeat(32), "desk", "needs-approval"), join }, { ...pc("d".repeat(32), "attic", "offline"), join }, { ...pc("f".repeat(32), "old-box", "needs-update"), join }, pc("e".repeat(32), "keyless", "needs-approval")] };
    const html = render({ ...props({ kind: "list", devices, account }), scoped: false, onSignIn: none, pcStatus });
    expect(html).not.toContain("keyless");
    const failed = render({ ...props({ kind: "list", devices, account: { ...account, error: "The account service did not answer." } }), scoped: false, onSignIn: none, onRefreshAccount: none });
    expect(failed).toMatch(/role="alert">The account service did not answer\. <button[^>]*>Try again<\/button>/);
    expect(html).toContain('data-account-state="signed-in"');
    expect(viewOf(html)).toBe("my-pcs");
    expect(titleOf(html)).toBe("Your PCs");
    expect(shownOf(html)).not.toContain("data-tab=");
    expect(rowsOf(html)).toEqual([[`/s/${"a".repeat(32)}/`, "p620 Relay On"], [`/s/${"b".repeat(32)}/`, "nuc Relay Off"], [`/s/${"c".repeat(32)}/`, "desk Relay On"], [`/s/${"d".repeat(32)}/`, "attic Relay Off"], [`/s/${"f".repeat(32)}/`, "old-box Relay Update needed"]]);
    // a PC this device is not let into yet is on or off like any other: its own page asks for the approval
    expect(html).not.toContain("Needs approval");
    // the old control page's address is the same front page
    (window.location as { hash: string }).hash = "#pcs";
    expect(render({ ...props({ kind: "list", devices, account }), scoped: false, onSignIn: none, pcStatus })).toBe(html);
  });

  it("opens a pairing link straight into pairing, without the sign-in", () => {
    const html = render({ ...props({ kind: "confirm", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-relay-state="confirm"');
    expect(html).toContain("Pair with Desk?");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("Sign in to your Ovis account");
  });

  it("says how each saved PC answered the latest check, with Check now above the list", () => {
    const device = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
    const pcStatus = new Map([
      ["a".repeat(32), { kind: "answered", route: "lan", rttMs: 9 }],
      ["b".repeat(32), { kind: "answered", route: "relay", relay: "wss://relay-ap.ovis.sh", rttMs: 148 }],
      ["c".repeat(32), { kind: "offline", reason: "pc" }],
    ] as const);
    const html = render({ ...props({ kind: "list", devices: [device("a".repeat(32), "home"), device("b".repeat(32), "office"), device("c".repeat(32), "laptop")] }), scoped: false, pcStatus, onCheckPcs: none });
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("homeAnswers · Same Wi-Fi, direct · 9 ms");
    expect(text).toContain("officeAnswers · Seoul relay · 148 ms");
    expect(html).toContain('<span class="connection-slow">148 ms</span>');
    expect(text).toContain("laptopMachine offlineIts Ovis relay or power is off, it has no network, or Ovis is not running on it.");
    expect(html.indexOf("Check now")).toBeLessThan(html.indexOf("home"));
    expect(text).not.toContain("Connected");
  });

  it("asks for the number the new PC shows instead of showing one, and says so when it was wrong", () => {
    const typed = render(props({ kind: "compare", name: "desk2", digits: "123456", confirmed: false, typed: true }));
    expect(typed).toContain("Type the number desk2 shows");
    expect(typed).not.toContain("123 456");
    expect(typed).toContain('name="digits"');
    const wrong = render(props({ kind: "compare", name: "desk2", digits: "", confirmed: false, typed: true, wrong: true }));
    expect(wrong).toContain("That is not the number desk2 shows");
    expect(wrong).not.toContain('name="digits"');
  });

});

describe("the hosted front page", () => {
  const pc = (server_id: string, name: string, state: MyPc["state"], over: Partial<MyPc> = {}): MyPc => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired: state === "paired", linked: true, ...over });
  const device = (server_id: string, name: string, relay: string) => ({ server_id, server_public_key: "k", relay, name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const AP = "wss://relay-ap.ovis.sh";
  const GLOBAL = "wss://relay.ovis.sh";
  const ids = { desk: "a".repeat(32), mac: "b".repeat(32), mini: "c".repeat(32), home: "d".repeat(32) };
  const four = (): MyPc[] => [
    pc(ids.desk, "Desk PC", "paired", { last_seen_at: new Date().toISOString() }),
    pc(ids.mac, "MacBook", "paired", { listed: false, linked: false }),
    pc(ids.mini, "Mac mini", "needs-approval", { added_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } }),
    pc(ids.home, "Home server", "offline", { paired: true, last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString() }),
  ];
  const devices = () => [device(ids.desk, "Desk PC", AP), device(ids.mac, "MacBook", AP), device(ids.home, "Home server", GLOBAL)];
  const signedIn = (pcs: MyPc[] | null, extra: Partial<RelayShellProps> = {}): RelayShellProps => ({ ...props({ kind: "list", devices: devices(), account: { kind: "signed-in", provider: "github", error: null, pcs } }), scoped: false, onSignIn: none, ...extra });

  describe("in a browser", () => {
    let browser: Page;
    const descriptors = new Map<string, PropertyDescriptor | undefined>();

    beforeEach(() => {
      browser = openPage("https://app.ovis.sh/");
      descriptors.set("Capacitor", Object.getOwnPropertyDescriptor(globalThis, "Capacitor"));
      browser.window.happyDOM.settings.navigation.disableMainFrameNavigation = true;
      Object.defineProperty(browser.window.navigator, "onLine", { configurable: true, writable: true, value: true });
      // Keep the history boundary inert unless the test records a particular history action.
      Object.assign(browser.window.history, { pushState() {}, replaceState() {}, back() {} });
      Object.defineProperty(browser.window, "innerWidth", { configurable: true, value: 1440 });
      Object.defineProperty(browser.window, "requestAnimationFrame", { configurable: true, writable: true, value: () => 1 });
      const matchMedia = (query: string) => ({ media: query, matches: false, addEventListener() {}, removeEventListener() {} });
      Object.defineProperty(browser.window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
      Object.defineProperty(browser.window, "setTimeout", { configurable: true, value: (...args: Parameters<typeof setTimeout>) => setTimeout(...args) });
      Object.defineProperty(browser.window, "clearTimeout", { configurable: true, value: clearTimeout });
      for (const [key, value] of Object.entries({
        localStorage: browser.window.localStorage, sessionStorage: browser.window.sessionStorage, matchMedia,
        HTMLElement: browser.window.HTMLElement, HTMLInputElement: browser.window.HTMLInputElement,
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
        IntersectionObserver: browser.window.IntersectionObserver, Event: browser.window.Event, CustomEvent: browser.window.CustomEvent,
      })) {
        descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
    });

    afterEach(async () => {
      try {
        await browser.render(null);
        // Let the sheet leave its history entry while this window is still here.
        await act(async () => { for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });
      } finally {
        try { await browser.close(); } finally {
          for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
          }
          descriptors.clear();
        }
      }
    });

    const mount = async (shown: RelayShellProps) => {
      await browser.render(null);
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
    };
    const all = <E extends Element = HTMLElement,>(selector: string, root: Element = document.body): E[] => [...root.querySelectorAll<E>(selector)];
    const element = <E extends Element = HTMLElement,>(selector: string, root?: Element): E => one(selector, all<E>(selector, root));
    const dialogs = () => all('[role="dialog"]');
    const dialog = () => one("dialogs", dialogs());
    const textOf = (node: Element): string => node.textContent ?? "";
    const shown = (node: Element): boolean => node.closest("[hidden]") === null;
    const buttons = (label: string) => all("button").filter((node) => textOf(node).trim() === label && shown(node));
    const submit = async (form: Element, value: string) => {
      await browser.type(element<HTMLInputElement>('input:not([type="hidden"])', form), value);
      await act(async () => { Reflect.apply(form.dispatchEvent, form, [new browser.window.Event("submit", { bubbles: true, cancelable: true })]); });
    };
    const clickLink = (link: Element): boolean => {
      const event = new browser.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      Reflect.apply(link.dispatchEvent, link, [event]);
      return event.defaultPrevented;
    };
    const trackFocus = (focused: string[]): void => {
      // The first focus can happen during mount. The page restores the shared prototype on close.
      const focus = browser.window.HTMLElement.prototype.focus;
      Object.defineProperty(browser.window.HTMLElement.prototype, "focus", { configurable: true, value: function (this: HTMLElement, options?: FocusOptions) {
        focused.push(this.localName === "button" ? String(this.getAttribute("data-action") ?? this.getAttribute("aria-label")) : this.localName);
        Reflect.apply(focus, this, [options]);
      } });
    };
    const button = (label: string) => { const found = buttons(label); if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`); return found[0]!; };

    it("puts up the card of a change that still waits when another change is refused for it, and the card acts on that request alone", async () => {
      const first = { account: "acct", list: "5c".repeat(32), key: "member", on: { seq: 3, hash: "aa".repeat(32) }, place: { seq: 4, hash: "bb".repeat(32) }, for: "allow:k", at: 1 };
      const calls: string[] = [];
      let waits: typeof first | null = first;
      setPageAccountList({
        waiting: async () => waits, cancel: async (given: typeof first) => { calls.push(`cancel ${given.place.hash}`); },
        sync: async () => { calls.push("sync"); throw new Error("nothing is sent in this test"); },
        subscribe: () => () => {}, view: () => ({ account: null, reached: false, status: { at: "off" }, devices: [], pcs: [] }),
        // Add PC's relay tab asks every page list whether this device may write it (InvitePc): this one may not
        writer: () => null,
      } as unknown as AccountList);
      const cards = () => all('[data-testid="list-allow-notice"]');
      const refusedElsewhere = async (): Promise<void> => { await act(async () => { browser.window.dispatchEvent(new browser.window.Event(LIST_WRITE_WAITING_EVENT)); await Promise.resolve(); await Promise.resolve(); }); };
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: () => {} });
        expect(cards()).toHaveLength(0);
        // a Remove on this screen was refused because an earlier change still waits
        await refusedElsewhere();
        expect(cards().map(textOf).join("")).toContain("An earlier change is still waiting");
        // Cancel lets go of the request the card was put up for
        await act(async () => { button("Cancel").click(); await Promise.resolve(); await Promise.resolve(); });
        expect([calls, cards().length]).toEqual([[`cancel ${first.place.hash}`], 0]);
        // put up again; another change took the place meanwhile: Try again on this card sends nothing of it
        await refusedElsewhere();
        waits = { ...first, place: { seq: 4, hash: "cc".repeat(32) }, for: "remove-pc:x" };
        await act(async () => { button("Try again").click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect([calls, cards().length]).toEqual([[`cancel ${first.place.hash}`], 0]);
      } finally { setPageAccountList(null); }
    });

    describe("a pairing's step frame", () => {
      const offer = { v: 1 as const, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" };
      const backOf = () => all<HTMLButtonElement>('button[class="relay-step-back"]');
      const stepOf = () => all('div[class="relay-step-progress"]')[0]?.getAttribute("data-step") ?? null;

      it("cancels the pairing from its round Back on the confirm, the comparison and the connection, each named for what it does", async () => {
        const steps: [RelayShellProps["state"], string, number][] = [
          [{ kind: "confirm", offer, account: "unlisted" }, "Back", 1],
          [{ kind: "compare", name: "Desk", digits: "123456", confirmed: false }, "Back", 2],
          [{ kind: "connecting", name: "Desk", pairing: true }, "Cancel", 2],
          [{ kind: "connecting", name: "Desk", approved: true, pairing: true }, "Cancel", 3],
        ];
        for (const [state, label, step] of steps) {
          let cancelled = 0;
          await mount({ ...props(state), onCancel: () => { cancelled++; } });
          const back = backOf();
          expect(back.map((button) => button.getAttribute("aria-label"))).toEqual([label]);
          await act(async () => { back[0]!.click(); });
          expect(cancelled).toBe(1);
          expect(stepOf()).toBe(String(step));
          await browser.render(null);
        }
      });

      it("moves the focus to the heading when the press takes the focused button away", async () => {
        const focused: string[] = [];
        trackFocus(focused);
        const draw = (confirmed: boolean) => createElement(SettingsProvider, { children: createElement(RelayShell, props({ kind: "compare", name: "Desk", digits: "123456", confirmed })) });
        await browser.render(draw(false));
        expect(focused).toEqual([]);
        await browser.render(draw(true));
        expect(focused).toEqual(["h1"]);
        expect(textOf(element("h1"))).toBe("Approve on the PC if it shows the same number");
      });

      it("drops the round Back once this phone confirmed the digits, leaving the comparison's own Cancel", async () => {
        let cancelled = 0;
        await mount({ ...props({ kind: "compare", name: "Desk", digits: "123456", confirmed: true }), onCancel: () => { cancelled++; } });
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBe("2");
        await act(async () => { button("Cancel").click(); });
        expect(cancelled).toBe(1);
      });

      it("says the PC approved, on screen and to a screen reader, once the account steps go on", async () => {
        // the live region takes its words from the frame after it mounts (useAnnouncedText)
        (window as unknown as { requestAnimationFrame: (run: () => void) => number }).requestAnimationFrame = (run) => { run(); return 1; };
        await mount(props({ kind: "connecting", name: "Desk", approved: true, pairing: true }));
        const said = "Approved. Desk opens in a moment.";
        expect(all('p[class="relay-shell-copy"]').map(textOf)).toEqual([said]);
        expect(textOf(element('[role="status"][class="visually-hidden"]'))).toBe(said);
        const bar = element('[role="progressbar"]');
        expect([bar.getAttribute("aria-label"), bar.getAttribute("aria-valuetext")]).toEqual(["Pair", "Step 3 of 3"]);
      });

      it("keeps the ready checkpoint on the card, offers no Back once the pairing failed, and draws the failure without a step", async () => {
        // a saved PC's enrollment retry reaches ready too: it is not drawn as a pairing step
        await mount(props({ kind: "ready", name: "Desk", server_id: EXPECTED, enrollment: "local" }));
        expect(all('[class="relay-step"]')).toEqual([]);
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBeNull();
        await browser.render(null);
        await mount(props({ kind: "failed", failure: "pair-declined", name: "Desk", detail: null, server_id: EXPECTED, pairing: true }));
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBeNull();
      });

      it("keeps a saved PC opening again on the card: no steps, no sheep, its own Cancel", async () => {
        let cancelled = 0;
        await mount({ ...props({ kind: "connecting", name: "Desk" }), onCancel: () => { cancelled++; } });
        expect(all('[class="relay-step"]')).toEqual([]);
        expect(all("span").filter((node) => String(node.className).startsWith("sheep-"))).toEqual([]);
        await act(async () => { button("Cancel").click(); });
        expect(cancelled).toBe(1);
        await browser.render(null);
        await mount(props({ kind: "failed", failure: "pc-offline", name: "Desk", detail: null, server_id: EXPECTED }));
        expect(all('[class="relay-step"]')).toEqual([]);
        expect(all("span").filter((node) => String(node.className).startsWith("sheep-"))).toEqual([]);
      });
    });

    it("goes on in the sheet over the PC's own page for the join it started: the link's question, the digits, and the sheet's own Step 4 of 4 ready phase; a plain visit keeps the screens", async () => {
      const offer = { v: 1 as const, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" };
      let paired = 0;
      await mount({ ...props({ kind: "confirm", offer }), onPair: () => { paired += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().getAttribute("data-add-pc-phase")).toBe("confirm");
      expect(all("h1")).toHaveLength(0);
      await act(async () => { button("Pair").click(); });
      expect(paired).toBe(1);
      await browser.render(null);
      const typed: (string | undefined)[] = [];
      await mount({ ...props({ kind: "compare", name: "Mac mini", digits: "123456", confirmed: false, typed: true }), onMatch: (digits) => { typed.push(digits); }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().getAttribute("data-add-pc-phase")).toBe("compare");
      const form = element<HTMLFormElement>("form", dialog());
      await submit(form, "123 456");
      expect(typed).toEqual(["123456"]);
      await browser.render(null);
      let openedPc = 0;
      await mount({ ...props({ kind: "ready", name: "Mac mini", server_id: ids.mini }), onOpenPc: () => { openedPc += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().getAttribute("data-add-pc-mode")).toBe("new");
      expect(dialog().getAttribute("data-add-pc-phase")).toBe("ready");
      expect(all('div[role="progressbar"]', dialog()).map((n) => n.getAttribute("aria-valuenow"))).toEqual(["4"]);
      expect(all("li", dialog()).map((n) => n.getAttribute("data-step"))).toEqual(["done", "done", "done", "done"]);
      await act(async () => { button("Open PC").click(); });
      expect(openedPc).toBe(1);
      await browser.render(null);
      await mount({ ...props({ kind: "confirm", offer }), sheetJoin: { mode: "join", server_id: ids.desk } });
      expect(dialogs()).toHaveLength(0);
      expect(textOf(element("h1"))).toBe("Pair with Mac mini?");
    });

    it("shows how the sheet's join failed in the sheet, with Try again, only for that PC, and suppresses raw close-code details in the RelayShell failure path", async () => {
      let retried = 0;
      const offline = { kind: "failed", failure: "pc-offline", name: "Mac mini", detail: "The relay closed the connection (0)" } as const;
      await mount({ ...props({ ...offline, server_id: ids.mini }), onRetry: () => { retried += 1; }, sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialog().getAttribute("data-add-pc-phase")).toBe("failed");
      expect(textOf(dialog())).toContain("Machine offline");
      expect(textOf(dialog())).not.toContain("The relay closed the connection (0)");
      await act(async () => { button("Try again").click(); });
      expect(retried).toBe(1);
      await browser.render(null);
      for (const state of [{ ...offline, server_id: ids.desk }, offline]) {
        await mount({ ...props(state), sheetJoin: { mode: "join", server_id: ids.mini } });
        expect(dialogs()).toHaveLength(0);
        expect(textOf(element("h1"))).toBe("Machine offline");
        expect(textOf(document.body)).not.toContain("The relay closed the connection (0)");
        await browser.render(null);
      }
      await mount({ ...props({ kind: "failed", failure: "identity-changed", name: "Mac mini", detail: null, server_id: ids.mini }), sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialogs()).toHaveLength(0);
      expect(button("Forget this PC")).toBeDefined();
    });

    const one = <E extends Element,>(what: string, found: E[]): E => { if (found.length !== 1) throw new Error(`${found.length} ${what} on screen`); return found[0]!; };
    const tab = (way: string) => one(`${way} tabs`, all<HTMLButtonElement>(`button[data-tab="${way}"]`).filter(shown));
    const panel = () => one("tab panels", all("div[data-tab-panel]").filter(shown)).getAttribute("data-tab-panel");
    const views = () => all("div[data-view]").filter(shown).map((node) => node.getAttribute("data-view"));
    const view = () => { const on = views(); if (on.length !== 1) throw new Error(`views on screen: ${on.join(", ")}`); return on[0]!; };
    const action = (name: string) => one(`${name} buttons`, all<HTMLButtonElement>(`button[data-action="${name}"]`).filter(shown));
    const back = () => all<HTMLButtonElement>('button[aria-label="Back"]').filter(shown);
    const title = () => textOf(one("h1 headings", all("h1").filter(shown)));
    /** Add PC at the end of My PCs: the connect tabs, with Back to the list */
    const openAdd = async () => {
      expect(view()).toBe("my-pcs");
      await act(async () => { action("add-pc").click(); });
      expect(view()).toBe("add-pc");
      expect(title()).toBe("Add PC");
    };
    const rowTexts = () => all("li[data-pc-way]").filter(shown).map((node) => [node.getAttribute("data-pc-way"), textOf(node)] as const);
    /** where there is no scanner, the code is one small line that opens its field in place; its Pair hands the code on */
    const typeCode = async (code: string) => {
      const line = action("add-code");
      expect([line.className, line.getAttribute("aria-expanded")]).toEqual(["connect-address-link", "false"]);
      expect(all<HTMLInputElement>('input[name="code"]')).toHaveLength(0);
      await act(async () => { line.click(); });
      const form = element<HTMLFormElement>("form[data-code-form]");
      const field = reactProps(element<HTMLInputElement>("input", form));
      expect([field.onInput, field.onCompositionEnd]).toEqual([typePairCode, endPairCodeComposition]);
      expect(all<HTMLButtonElement>('button[type="submit"]', form).map(textOf)).toEqual(["Pair"]);
      await submit(form, code);
    };
    /** a wide screen (a desktop browser): My PCs and Add a PC side by side */
    /** the window's width as media queries read it, which a test can move across 1024 px as a rotation or a resize does */
    const screen = (() => {
      const changed = new Map<(event: { matches: boolean }) => void, string>();
      let wideNow = false;
      const matching = (query: string): boolean => query === "(min-width: 1024px)" && wideNow;
      const install = (): void => {
        (window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
          get matches() { return matching(query); },
          addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { changed.set(listener, query); },
          removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => { changed.delete(listener); },
        });
      };
      return { install, set: (wide: boolean) => { wideNow = wide; for (const [listener, query] of [...changed]) listener({ matches: matching(query) }); } };
    })();
    const wide = () => { screen.install(); screen.set(true); };
    const many = (count: number) => Array.from({ length: count }, (_, index) => device(index.toString(16).padStart(2, "0").repeat(16), `pc-${index}`, AP));

    it("opens on the relay tab again after a sign-out that follows another tab and a sign-in", async () => {
      const signedOut = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none };
      await mount(signedOut);
      await act(async () => { tab("ssh").click(); });
      expect(panel()).toBe("ssh");
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) }));
      expect(view()).toBe("my-pcs");
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, signedOut) }));
      expect(title()).toBe("Connect a PC");
      expect(panel()).toBe("relay");
      expect(tab("relay").getAttribute("aria-pressed")).toBe("true");
    });

    it("opens Add PC from the end of My PCs, its Back returning to the list, and a sign-in made there lands on the list", async () => {
      const signedOut = { ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none };
      await mount(signedOut);
      expect(title()).toBe("Your PCs");
      expect(back()).toHaveLength(0);
      await openAdd();
      expect(panel()).toBe("relay");
      expect(buttons("Continue with GitHub")).toHaveLength(1);
      // no list under the ways to add one
      expect(all("[data-pc-way]").filter(shown)).toHaveLength(0);
      await act(async () => { back()[0]!.click(); });
      expect(view()).toBe("my-pcs");
      await openAdd();
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, { ...signedOut, state: { kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signing-in", provider: "github" } } }) }));
      expect(view()).toBe("add-pc");
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) }));
      expect(view()).toBe("my-pcs");
      expect(rowTexts().map(([way]) => way)).toEqual(["relay", "relay", "relay", "relay"]);
    });

    it("opens a typed address from the Tailscale tab's field, and from the SSH tab's behind Add by address, each with Connect", async () => {
      const opened: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { opened.push(href); };
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      for (const [way, typed] of [["tailscale", "my-pc.tailnet.ts.net"], ["ssh", "https://my-pc.example.com"]] as const) {
        await act(async () => { tab(way).click(); });
        expect(panel()).toBe(way);
        if (way === "ssh") {
          // a browser has no SSH: the tab is Add by address alone, a text link to the field
          expect(all<HTMLInputElement>("input")).toHaveLength(0);
          await act(async () => { button("Add by address").click(); });
        }
        const fields = all<HTMLInputElement>("input");
        expect(fields).toHaveLength(1);
        expect(all<HTMLButtonElement>('button[class="btn account-provider"]')).toHaveLength(0);
        const form = element<HTMLFormElement>("form");
        await submit(form, typed);
      }
      expect(opened).toEqual(["https://my-pc.tailnet.ts.net/", "https://my-pc.example.com/"]);
    });

    it("keeps a code typed in the relay tab's folded field through its lookup and a failure to correct, and its Cancel clears it", async () => {
      const calls: string[] = [];
      const draw = (shown: RelayShellProps) => browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
      const front: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none,
        onCodeStart: () => { calls.push("start"); }, onCodeSubmit: (code) => { calls.push(`submit ${code}`); }, onCancel: () => { calls.push("cancel"); void draw(front); } };
      await mount(front);
      await typeCode("ABCDE-1234");
      expect(calls).toEqual(["start", "submit ABCDE-1234"]);
      const field = () => element<HTMLInputElement>("form[data-code-form] input");
      // the field keeps its own open state, which a field mounted again would have lost (closed): so it is the same field
      const same = () => action("add-code").getAttribute("aria-expanded") === "true" && field() !== undefined;
      // looking, then a failure the person can correct: the same field, still holding what was typed, on the same page
      await draw({ ...front, state: { kind: "code-looking" } });
      expect(same()).toBe(true);
      expect(view()).toBe("add-pc");
      expect(textOf(element("[data-code-form]"))).toContain("Looking for the PC…");
      await draw({ ...front, state: { kind: "code-entry", failure: "not-a-code" } });
      expect(view()).toBe("add-pc");
      expect(same()).toBe(true);
      expect(all('[role="alert"]').map(textOf)).toContain("A code has ten letters and digits, like 7K3QD-M2XHA.");
      // its Cancel ends the code, which brings the tabs back with the field closed
      await act(async () => { one("button", all<HTMLButtonElement>("button", element("[data-code-form]")).filter((node) => textOf(node) === "Cancel")).click(); });
      expect(calls.at(-1)).toBe("cancel");
      expect(title()).toBe("Connect a PC");
      expect(all("[data-code-form]")).toHaveLength(0);
      // a code found goes on to its own screen; back on the front page, the field is closed
      await typeCode("ABCDE-12345");
      await draw({ ...front, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } });
      expect(all("h1").map(textOf)).toEqual(["Does Mac mini's screen show this ID?"]);
      await draw(front);
      expect(all("[data-code-form]")).toHaveLength(0);
    });

    it("reads the account's PCs again when a notice changed them (a PC confirmed or removed), so Your PCs shows it at once", async () => {
      let refreshed = 0;
      await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onRefreshAccount: () => { refreshed += 1; } });
      expect(refreshed).toBe(0);
      await act(async () => { browser.window.dispatchEvent(new browser.window.Event("ovis:account-pcs-changed")); });
      expect(refreshed).toBe(1);
    });

    it("pairs with a code from Add PC's relay tab, signed in with no PC: the lookup in the field, the PC it found in the pairing dialog, over the tabs it closes back to", async () => {
      const calls: string[] = [];
      const draw = (shown: RelayShellProps) => browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
      const shown: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none,
        onCodeStart: () => { calls.push("start"); }, onCodeSubmit: (code: string) => { calls.push(`submit ${code}`); }, onCancel: () => { calls.push("cancel"); void draw(shown); } };
      await mount(shown);
      await openAdd();
      expect(panel()).toBe("relay");
      // what to do on the PC comes first, the code under it
      const relayText = textOf(element('[data-tab-panel="relay"]'));
      expect(relayText.indexOf("Turn on Ovis on the PC and sign in with the same account.")).toBe(0);
      expect(relayText).toContain("Pair with a code");
      await typeCode("ABCDE-12345");
      expect(calls).toEqual(["start", "submit ABCDE-12345"]);
      await draw({ ...shown, state: { kind: "code-looking" } });
      expect(dialogs()).toHaveLength(0);
      await draw({ ...shown, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } });
      expect(dialog().getAttribute("data-pair-dialog")).toBe("compare");
      await act(async () => { button("Cancel").click(); });
      expect(calls.at(-1)).toBe("cancel");
      expect(dialogs()).toHaveLength(0);
      expect(view()).toBe("add-pc");
      expect(all("[data-code-form]")).toHaveLength(0);
    });

    it("opens an account with no PC yet on My PCs' empty state, whose Add PC opens the tabs and comes back to it", async () => {
      await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none });
      expect(all("[data-approval-wait]")).toHaveLength(0);
      expect(textOf(element('[data-view="my-pcs"]'))).toContain("Sign in with the same account on the PC where Ovis runs");
      await openAdd();
      await act(async () => { back()[0]!.click(); });
      expect(view()).toBe("my-pcs");
    });

    it("tells of the account's news on My PCs (a new PC with its one-tap removal, a join request, a PC to confirm), and not on Add PC's tabs", async () => {
      // These components can mount without any current notice to draw. Mark their real output for this test.
      const { NewPcNotices } = NewPcNoticesModule;
      const { AccountJoinRequests } = AccountJoinRequestsModule;
      const { UnconfirmedPcNotices } = UnconfirmedPcNoticesModule;
      await mock.module("./NewPcNotices.tsx", () => ({ NewPcNotices: () => <><span data-notice-probe="new-pc" /><NewPcNotices /></> }));
      await mock.module("./AccountJoinRequests.tsx", () => ({ AccountJoinRequests: () => <><span data-notice-probe="join-requests" /><AccountJoinRequests /></> }));
      await mock.module("./UnconfirmedPcNotices.tsx", () => ({ UnconfirmedPcNotices: (props: Parameters<typeof UnconfirmedPcNotices>[0]) => <><span data-notice-probe="unconfirmed-pc" /><UnconfirmedPcNotices {...props} /></> }));
      try {
        await mount(signedIn(four()));
        const notices = () => ["new-pc", "join-requests", "unconfirmed-pc"].map((name) => all(`[data-notice-probe="${name}"]`).filter(shown).length);
        expect(notices()).toEqual([1, 1, 1]);
        await openAdd();
        expect(notices()).toEqual([0, 0, 0]);
      } finally {
        await mock.module("./NewPcNotices.tsx", () => ({ NewPcNotices }));
        await mock.module("./AccountJoinRequests.tsx", () => ({ AccountJoinRequests }));
        await mock.module("./UnconfirmedPcNotices.tsx", () => ({ UnconfirmedPcNotices }));
      }
    });

    it("keeps My PCs and Add a PC side by side on a wide screen: the list on the left, the tabs always open on the right, no Add PC button", async () => {
      wide();
      await mount(signedIn(four()));
      expect(all("div[data-view]").map((node) => node.getAttribute("data-view"))).toEqual(["my-pcs", "add-pc"]);
      expect(all<HTMLButtonElement>('button[data-action="add-pc"]')).toHaveLength(0);
      expect(all("h1").map(textOf)).toEqual(["Your PCs"]);
      expect(all("h2").map(textOf)).toContain("Add PC");
      expect(back()).toHaveLength(0);
      expect(panel()).toBe("relay");
      await act(async () => { tab("ssh").click(); });
      expect(panel()).toBe("ssh");
      expect(rowTexts()).toHaveLength(4);
    });

    it("keeps Connect a PC one centred card on a wide screen, signed out with nothing saved here", async () => {
      wide();
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      expect(all("div[data-view]").map((node) => [node.getAttribute("data-view"), node.className])).toEqual([["add-pc", "connect-add connect-add-front"]]);
      expect(title()).toBe("Connect a PC");
    });

    it("finds a PC by name past eight, says so when none matches, and on a wide screen keeps to the PCs on or off", async () => {
      const search = () => all<HTMLInputElement>('input[type="search"]');
      const listed = (count: number, extra: Partial<RelayShellProps> = {}) => ({ ...props({ kind: "list", devices: many(count), account: { kind: "signed-in", provider: "github", error: null, pcs: [] } }), scoped: false, onSignIn: none, ...extra }) satisfies RelayShellProps;
      await mount(listed(8));
      expect(search()).toHaveLength(0);
      await browser.render(null);
      const off = new Map(many(9).filter((_, index) => index % 2 === 1).map((pc) => [pc.server_id, { kind: "offline", reason: "pc" } as const]));
      await mount(listed(9, { pcStatus: off }));
      expect(search().map((node) => node.getAttribute("aria-label"))).toEqual(["Search PC names"]);
      // no chips on a phone
      expect(all<HTMLButtonElement>("button[data-show]")).toHaveLength(0);
      await browser.type(search()[0]!, "PC-1");
      expect(rowTexts().map(([, text]) => text.split("Relay")[0])).toEqual(["pc-1"]);
      await browser.type(search()[0]!, "zzz");
      expect(rowTexts()).toHaveLength(0);
      expect(textOf(element('[data-view="my-pcs"]'))).toContain("No PC matches.");
      await browser.render(null);
      wide();
      await mount(listed(9, { pcStatus: off }));
      const chips = () => all<HTMLButtonElement>("button[data-show]");
      expect(chips().map((node) => [textOf(node), node.getAttribute("aria-pressed")])).toEqual([["All", "true"], ["On", "false"], ["Off", "false"]]);
      await act(async () => { chips()[2]!.click(); });
      expect(rowTexts().map(([, text]) => text.split("Relay")[0])).toEqual(["pc-1", "pc-3", "pc-5", "pc-7"]);
    });

    it("says it is opening a PC of the phone app's own, with Cancel only where the app can stop it, and pressing it stops the open", async () => {
      for (const canCancel of [true, false]) {
        const called: string[] = [];
        const opened = Promise.withResolvers<unknown>();
        const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
          isNativePlatform: () => true, getPlatform: () => canCancel ? "android" : "ios",
          PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", ...(canCancel ? ["cancelOpen"] : [])].map((name) => ({ name })) }],
          nativePromise: async (plugin: string, method: string) => {
            called.push(`${plugin}.${method}`);
            if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net"], names: { "https://desk.tail1e211e.ts.net": "Desk" } };
            if (method === "open") return await opened.promise;
            return {};
          },
        } });
        try {
          await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
          await act(async () => { one('button[class="relay-add-saved-pc"]', all<HTMLButtonElement>('button[class="relay-add-saved-pc"]').filter(shown)).click(); });
          const status = () => all("[data-opening]").filter(shown);
          if (canCancel) {
            expect(status().map(textOf)).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
            await act(async () => { element("button", status()[0]!).click(); });
            expect(status()).toHaveLength(0);
            expect(called).toContain("HerdrShell.cancelOpen");
          } else {
            // iOS has no way to stop an open: the status says what it opens, with nothing to press
            expect(status().map(textOf)).toEqual(["Opening desk.tail1e211e.ts.net…"]);
            await act(async () => { opened.resolve({}); await opened.promise; });
            expect(status()).toHaveLength(0);
            expect(called).not.toContain("HerdrShell.cancelOpen");
          }
          await browser.render(null);
        } finally {
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      }
    });

    it("opens one PC at a time: a second tap while the app is asked about Tailscale drops the first, one already opening holds the next, and leaving drops a late answer", async () => {
      let tailscale = Promise.withResolvers<{ on?: boolean }>();
      const called: string[] = [];
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "cancelOpen"].map((name) => ({ name })) }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
          if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317"], names: { "https://desk.tail1e211e.ts.net": "Desk" } };
          if (method === "tailscale") return await tailscale.promise;
          if (method === "open") return await new Promise(() => {});
          return {};
        },
      } });
      const opens = () => called.filter((call) => call.startsWith("HerdrShell.open "));
      const row = (way: string) => element("button.relay-add-saved-pc", one(`li[data-pc-way="${way}"]`, all(`li[data-pc-way="${way}"]`).filter(shown)));
      const status = () => all("[data-opening]").filter(shown).map(textOf);
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { row("tailscale").click(); });
        // the tap says so at once, while the app is asked whether Tailscale is on
        expect(status()).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
        expect(opens()).toEqual([]);
        await act(async () => { row("address").click(); });
        expect(opens()).toEqual(["HerdrShell.open http://192.168.0.5:7317/"]);
        expect(status()).toEqual(["Opening 192.168.0.5:7317…Cancel"]);
        await act(async () => { tailscale.resolve({ on: true }); await tailscale.promise; });
        expect(opens()).toEqual(["HerdrShell.open http://192.168.0.5:7317/"]);
        // while one opens, another tap opens nothing
        await act(async () => { row("tailscale").click(); });
        expect(opens()).toHaveLength(1);
        expect(called.filter((call) => call === "HerdrShell.tailscale")).toHaveLength(1);
        await browser.render(null);
        expect(called).toContain("HerdrShell.cancelOpen");
        // leaving while the app is asked: its late answer opens nothing
        tailscale = Promise.withResolvers<{ on?: boolean }>();
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { row("tailscale").click(); });
        await browser.render(null);
        await act(async () => { tailscale.resolve({ on: true }); await tailscale.promise; });
        expect(opens()).toHaveLength(1);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("waits for the Tailscale answer only so long, takes only an explicit off as off, and says so when the app cannot open an address at all", async () => {
      for (const [mode, methods] of [["silent", ["getState", "open", "tailscale"]], ["unsaid", ["getState", "open", "tailscale"]], ["no-open", ["getState", "tailscale"]]] as const) {
        const called: string[] = [];
        const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
          isNativePlatform: () => true, getPlatform: () => "android",
          PluginHeaders: [{ name: "HerdrShell", methods: methods.map((name) => ({ name })) }],
          nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
            called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
            if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net"], names: {} };
            if (method === "tailscale") return mode === "silent" ? await new Promise(() => {}) : {};
            return {};
          },
        } });
        try {
          await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
          await act(async () => { one('button[class="relay-add-saved-pc"]', all<HTMLButtonElement>('button[class="relay-add-saved-pc"]').filter(shown)).click(); });
          const settled = () => called.some((call) => call.startsWith("HerdrShell.open ")) || all('[role="alert"]').filter(shown).length > 0;
          // bounded: an app that never answers is taken as on once the short wait is over
          const deadline = Date.now() + 4_000;
          while (!settled()) {
            if (Date.now() > deadline) throw new Error(`${mode}: the open neither went ahead nor said why`);
            await act(async () => { await Promise.race([new Promise(() => {}), Bun.sleep(25)]); });
          }
          expect(all("[data-tailscale-off]")).toHaveLength(0);
          if (mode === "no-open") {
            expect(all('[role="alert"]').filter(shown).map(textOf)).toContain("This app cannot open a PC by its address. Update the Ovis app.");
            expect(called.some((call) => call.startsWith("HerdrShell.open "))).toBe(false);
          } else expect(called).toContain("HerdrShell.open https://desk.tail1e211e.ts.net/");
          await browser.render(null);
        } finally {
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      }
    });

    it("shows the one open in progress in both panes on a wide screen, and Add a PC's own form opens nothing more meanwhile", async () => {
      wide();
      const called: string[] = [];
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "cancelOpen"].map((name) => ({ name })) }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
          if (method === "getState") return { saved: ["http://192.168.0.5:7317"], names: {} };
          if (method === "open") return await new Promise(() => {});
          return {};
        },
      } });
      try {
        await mount(signedIn(four()));
        await act(async () => { element<HTMLButtonElement>('button[class="relay-add-saved-pc"]', element('li[data-pc-way="address"]')).click(); });
        await act(async () => { tab("tailscale").click(); });
        const form = element<HTMLFormElement>("form", element('[data-tab-panel="tailscale"]'));
        await submit(form, "other.tail1e211e.ts.net");
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual(["HerdrShell.open http://192.168.0.5:7317/"]);
        const status = () => all("[data-opening]").map(textOf);
        expect(status()).toEqual(["Opening 192.168.0.5:7317…Cancel", "Opening 192.168.0.5:7317…Cancel"]);
        // either Cancel stops the one open
        await act(async () => { element<HTMLButtonElement>("button", element("[data-opening]", element('[data-tab-panel="tailscale"]'))).click(); });
        expect(called.filter((call) => call === "HerdrShell.cancelOpen")).toHaveLength(1);
        expect(status()).toEqual([]);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("says it is opening a PC scanned on the plain wait and on a removed PC's screen too", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["open", "cancelOpen"].map((name) => ({ name })) }, { name: "CapacitorBarcodeScanner", methods: [{ name: "scanBarcode" }] }],
        nativePromise: async (_plugin: string, method: string) => {
          if (method === "scanBarcode") return { ScanResult: "https://desk.tail1e211e.ts.net" };
          if (method === "open") return await new Promise(() => {});
          return {};
        },
      } });
      try {
        for (const screen of [{ ...props({ kind: "connecting", name: "Mac", pairing: true }), sheetJoin: { mode: "join" as const, server_id: ids.mini }, launchJoin: true },
          { ...props({ kind: "failed", failure: "revoked", name: "Mac", detail: null, server_id: ids.mini }), signedIn: true, onAskAgain: none }]) {
          await mount(screen);
          await act(async () => { action("approval-wait-qr").click(); });
          await act(async () => { await Promise.resolve(); });
          expect(all("[data-opening]").map(textOf)).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
          await browser.render(null);
        }
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("explains why the phone app could not open a PC from the app's reason, the Tailscale hint for a tailnet one, and tells of an SSH PC whose address another app took", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: [{ name: "getState" }, { name: "open" }] }],
        nativePromise: async (_plugin: string, method: string) => {
          if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net"], names: {}, kind: "ssh-port", failure: "127.0.0.1:41234" };
          if (method === "open") throw Object.assign(new Error("unknown-host"), { code: "unknown-host" });
          return {};
        },
      } });
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        const alerts = () => all('[role="alert"]').map(textOf);
        expect(alerts().join(" ")).toContain("Another app on this phone took the address the SSH PC opens on (127.0.0.1:41234)");
        await act(async () => { element<HTMLButtonElement>('button[class="relay-add-saved-pc"]').click(); });
        expect(alerts()).toContain("desk.tail1e211e.ts.net was not found. Check the name, or open the address Ovis shows under Settings → Devices and PCs → Add a connection on the PC. This is a Tailscale address, and Tailscale may be off on this phone: turn it on in the Tailscale app.");
        expect(alerts()).not.toContain("unknown-host");
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    describe("with no internet on the device", () => {
      const offline = (off: boolean): void => {
        (navigator as { onLine?: boolean }).onLine = !off;
        browser.window.dispatchEvent(new browser.window.Event(off ? "offline" : "online"));
      };
      const alerts = () => all('[role="alert"]').filter(shown).map(textOf);
      const unreached = "The account service could not be reached. The PCs this device is paired with still work.";
      const offlinePage = (extra: Partial<RelayShellProps> = {}): RelayShellProps => ({
        ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", pcs: [], error: unreached, known: [{ server_id: ids.mac, name: "hasang-uui-MacBookPro" }] } }), scoped: false, onSignIn: none, ...extra,
      });

      it("says in one line that the phone is offline, with Try again, never that the account service is down, and lists every PC it knows", async () => {
        const called: string[] = [];
        let opened = Promise.withResolvers<unknown>();
        const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
          isNativePlatform: () => true, getPlatform: () => "android",
          PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "tailscale"].map((name) => ({ name })) }],
          nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
            called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
            if (method === "getState") return { saved: ["https://macbookpro.tail1e211e.ts.net:17317"], names: {} };
            if (method === "tailscale") return { on: true };
            if (method === "open") return await opened.promise;
            return {};
          },
        } });
        let refreshed = 0, checked = 0;
        try {
          offline(true);
          await mount(offlinePage({ onRefreshAccount: () => { refreshed++; }, onCheckPcs: () => { checked++; } }));
          expect(alerts()).toEqual(["This phone is not connected to the internet. Try again"]);
          expect(textOf(document.body)).not.toContain("account service");
          // the account's PC it listed last stays, by its page, and the PC the app saved by its Tailscale address
          const relay = element<HTMLAnchorElement>("a", element('li[data-pc-way="relay"]'));
          expect(relay.getAttribute("href")).toBe(`/s/${ids.mac}/`);
          expect(textOf(relay)).toBe("hasang-uui-MacBookPro" + "Relay");
          // a tap says the phone is offline: no name that was not found, no Tailscale that may be off
          let held = 0;
          await act(async () => { if (clickLink(relay)) held++; });
          expect(held).toBe(1);
          expect(alerts()).toContain("Connect this phone to the internet to open the PC.");
          const tailscale = () => element<HTMLButtonElement>('button[class="relay-add-saved-pc"]', element('li[data-pc-way="tailscale"]'));
          await act(async () => { tailscale().click(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open ") || call === "HerdrShell.tailscale")).toEqual([]);
          expect(alerts().filter((text) => text.includes("not found") || text.includes("Tailscale may be off"))).toEqual([]);
          // Try again reads it all again
          await act(async () => { one("button", all<HTMLButtonElement>("button").filter((node) => textOf(node) === "Try again" && shown(node))).click(); });
          expect([refreshed, checked, called.filter((call) => call === "HerdrShell.getState").length]).toEqual([1, 1, 2]);

          // the network back: the line goes, and the screen reads the account, the app's PCs and the relay's again by itself
          await act(async () => { offline(false); });
          expect(alerts().filter((text) => text.includes("internet"))).toEqual([]);
          expect([refreshed, checked, called.filter((call) => call === "HerdrShell.getState").length]).toEqual([2, 2, 3]);
          // online, the account's own failure says so again, as before
          expect(alerts()).toContain(`${unreached} Try again`);

          // an open the network dropped under says the phone went offline, not why the PC did not answer
          await act(async () => { tailscale().click(); });
          await act(async () => { await Promise.resolve(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual(["HerdrShell.open https://macbookpro.tail1e211e.ts.net:17317/"]);
          (navigator as { onLine?: boolean }).onLine = false;
          await act(async () => { opened.reject(Object.assign(new Error("unknown-host"), { code: "unknown-host" })); await opened.promise.catch(() => undefined); });
          expect(alerts()).toContain("Connect this phone to the internet to open the PC.");
          opened = Promise.withResolvers<unknown>();
        } finally {
          (navigator as { onLine?: boolean }).onLine = true;
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      });

      it("opens nothing when the device went offline while the app was asked whether Tailscale is on, and ends that attempt", async () => {
        const called: string[] = [];
        const tailscale = Promise.withResolvers<{ on?: boolean }>();
        const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
          isNativePlatform: () => true, getPlatform: () => "android",
          PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "tailscale"].map((name) => ({ name })) }],
          nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
            called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
            if (method === "getState") return { saved: ["https://macbookpro.tail1e211e.ts.net:17317"], names: {} };
            if (method === "tailscale") return await tailscale.promise;
            if (method === "open") return await new Promise(() => {});
            return {};
          },
        } });
        try {
          await mount(offlinePage());
          await act(async () => { element<HTMLButtonElement>('button[class="relay-add-saved-pc"]', element('li[data-pc-way="tailscale"]')).click(); });
          expect(all("[data-opening]").filter(shown)).toHaveLength(1);
          (navigator as { onLine?: boolean }).onLine = false;
          await act(async () => { tailscale.resolve({ on: true }); await tailscale.promise; });
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
          expect(all("[data-opening]").filter(shown)).toHaveLength(0);
          expect(alerts()).toContain("Connect this phone to the internet to open the PC.");
        } finally {
          (navigator as { onLine?: boolean }).onLine = true;
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      });

      type Ask = { readonly url: string; readonly answer: ReturnType<typeof Promise.withResolvers<Response>> };
      /** fetch as the screen's asks reach it, each answered by the test (settle); `restore` puts the real one back */
      const heldAsks = (): { readonly asks: Ask[]; restore(): void } => {
        const asks: Ask[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(async (input: Request | string | URL): Promise<Response> => {
          const answer = Promise.withResolvers<Response>();
          asks.push({ url: String(input), answer });
          return await answer.promise;
        }, { preconnect: realFetch.preconnect });
        return { asks, restore: () => { globalThis.fetch = realFetch; } };
      };
      const settle = async (ask: Ask, answered: boolean): Promise<void> => {
        await act(async () => {
          // any answer is a network, an error status too (a static host has no /api/health)
          if (answered) ask.answer.resolve(new Response(null, { status: 404 }));
          // no answer within CHECK_NETWORK_MS: the ask's own timeout ends it
          else ask.answer.reject(new DOMException("The operation timed out.", "TimeoutError"));
          await ask.answer.promise.catch(() => undefined);
          for (let turn = 0; turn < 3; turn++) await Promise.resolve();
        });
      };

      // a Galaxy Z Flip6's WebView said navigator.onLine === false all along on working Wi-Fi (app 1.0.7); a shell built
      // with no account service (OVIS_ACCOUNT_SERVICE_URL=off) asks its own origin instead, under /api/, which no worker answers
      for (const [asked, service, url] of [
        ["the account service", "https://account.example", "https://account.example/v1/providers"],
        ["its own origin, with no account service,", null, "https://app.ovis.sh/api/health"],
      ] as const) it(`believes ${asked} over a WebView that says offline: its answer takes the line away and a row opens, asked again on each open`, async () => {
        if (service !== null) {
          const meta = document.createElement("meta");
          meta.setAttribute("name", "ovis-account-service");
          meta.setAttribute("content", service);
          document.head.append(meta);
        }
        const { asks, restore } = heldAsks();
        const relayRow = () => element<HTMLAnchorElement>("a", element('li[data-pc-way="relay"]'));
        const assigned: string[] = [];
        (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
        try {
          offline(true);
          await mount(offlinePage());
          // the screen asks on its own as it starts watching; no answer: the device is offline, as before
          expect(asks.map((ask) => ask.url)).toEqual([url]);
          await settle(asks[0]!, false);
          expect(alerts()).toEqual(["This device is not connected to the internet. Try again"]);
          // a tap asks, and Try again while that ask is out replaces it: the tap waits for Try again's answer, which takes
          // the line away, and goes to the PC's page
          let held = 0;
          await act(async () => { if (clickLink(relayRow())) held++; });
          await act(async () => { one("button", all<HTMLButtonElement>("button").filter((node) => textOf(node) === "Try again" && shown(node))).click(); });
          expect([held, asks.length, assigned]).toEqual([1, 3, []]);
          await settle(asks[1]!, true);
          expect(assigned).toEqual([]);
          await settle(asks[2]!, true);
          expect(alerts().filter((text) => text.includes("internet"))).toEqual([]);
          expect(assigned).toEqual([`/s/${ids.mac}/`]);
          // a later tap asks once more rather than trusting that answer, and goes there once it answers
          await act(async () => { if (clickLink(relayRow())) held++; });
          expect([held, asks.length]).toEqual([2, 4]);
          await settle(asks[3]!, true);
          expect(assigned).toHaveLength(2);
          // the network gone since, with the flag still false: the next tap's ask goes unanswered, and the row says so
          await act(async () => { if (clickLink(relayRow())) held++; });
          await settle(asks[4]!, false);
          expect(assigned).toHaveLength(2);
          expect(alerts()).toContain("Connect this device to the internet to open the PC.");
        } finally {
          restore();
          offline(false);
        }
      });

      it("holds a tap on a paired PC of a page with no account until the network answers, and shows the offline line when it does not", async () => {
        const { asks, restore } = heldAsks();
        const assigned: string[] = [];
        (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
        const row = () => element<HTMLAnchorElement>('a[class="relay-shell-pc"]');
        try {
          offline(true);
          await mount({ ...props({ kind: "list", devices: [device(ids.mac, "MacBook", AP)] }), scoped: false });
          await settle(asks[0]!, true);
          expect(alerts()).toEqual([]);
          // the earlier answer is not trusted: the tap asks again, and no answer opens nothing and says the device is offline
          let held = 0;
          await act(async () => { if (clickLink(row())) held++; });
          expect([held, asks.length]).toEqual([1, 2]);
          await settle(asks[1]!, false);
          expect([assigned, alerts()]).toEqual([[], ["This device is not connected to the internet. Try again"]]);
          await act(async () => { if (clickLink(row())) held++; });
          await settle(asks[2]!, true);
          expect(assigned).toEqual([`/s/${ids.mac}/`]);
        } finally {
          restore();
          offline(false);
        }
      });

      it("says this device, in a browser, and opens nothing while it is offline", async () => {
        // no network at all: even the page's own origin does not answer
        const asked: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(async (input: Request | string | URL): Promise<Response> => {
          asked.push(String(input));
          throw new TypeError("Failed to fetch");
        }, { preconnect: realFetch.preconnect });
        const assigned: string[] = [];
        (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
        offline(true);
        try {
          await mount(offlinePage());
          await act(async () => { for (let turn = 0; turn < 3; turn++) await Promise.resolve(); });
          expect(alerts()).toEqual(["This device is not connected to the internet. Try again"]);
          let held = 0;
          await act(async () => { if (clickLink(element<HTMLAnchorElement>("a", element('li[data-pc-way="relay"]')))) held++; });
          await act(async () => { for (let turn = 0; turn < 3; turn++) await Promise.resolve(); });
          expect(held).toBe(1);
          expect(alerts()).toContain("Connect this device to the internet to open the PC.");
          expect([new Set(asked), assigned]).toEqual([new Set(["https://app.ovis.sh/api/health"]), []]);
          // online, a row opens its page as before
          await act(async () => { offline(false); });
          await act(async () => { if (clickLink(element<HTMLAnchorElement>("a", element('li[data-pc-way="relay"]')))) held++; });
          expect(held).toBe(1);
        } finally {
          globalThis.fetch = realFetch;
          (navigator as { onLine?: boolean }).onLine = true;
        }
      });
    });

    it("goes back to the PC the phone app still has open while the person chooses another, marking it In use now, whatever way it connects", async () => {
      for (const [current, mark, canGoBack] of [["https://desk.tail1e211e.ts.net", "DeskTailscale", true], [`https://app.ovis.sh/s/${ids.home}/`, "Home serverRelay", true], ["https://desk.tail1e211e.ts.net", "DeskTailscale", false]] as const) {
        const called: string[] = [];
        const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
          isNativePlatform: () => true, getPlatform: () => "android",
          PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", ...(canGoBack ? ["backToCurrent"] : [])].map((name) => ({ name })) }],
          nativePromise: async (plugin: string, method: string) => {
            called.push(`${plugin}.${method}`);
            return method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net"], names: { "https://desk.tail1e211e.ts.net": "Desk" }, choosing: true, current } : {};
          },
        } });
        try {
          await mount(signedIn(four()));
          expect(rowTexts().map(([, text]) => text.replace(/Forget$/, ""))).toContain(`${mark}In use now`.replace("DeskTailscale", "DeskTailscaledesk.tail1e211e.ts.net"));
          const backs = all<HTMLButtonElement>("button[aria-label]").filter((node) => node.getAttribute("aria-label")?.startsWith("Back to "));
          expect(backs.length).toBe(canGoBack ? 1 : 0);
          if (canGoBack) {
            await act(async () => { backs[0]!.click(); });
            expect(called).toContain("HerdrShell.backToCurrent");
          }
          await browser.render(null);
        } finally {
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      }
    });

    it("draws the front page's controls when the phone app does not answer what it saved, and lists what a late answer brings", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      const answer = Promise.withResolvers<unknown>();
      let asked = 0;
      const app = (methods: string[]) => ({
        isNativePlatform: () => true, getPlatform: () => "ios",
        PluginHeaders: [{ name: "HerdrShell", methods: methods.map((name) => ({ name })) }],
        nativePromise: async (_plugin: string, method: string) => { if (method === "getState") { asked += 1; return await answer.promise; } return {}; },
      });
      const signedOut = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none } satisfies RelayShellProps;
      try {
        // an app with no getState is asked nothing: the controls are there at once
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: app(["open"]) });
        await mount(signedOut);
        expect(asked).toBe(0);
        expect(view()).toBe("add-pc");
        await browser.render(null);
        // one whose getState never settles: the controls once the short wait is over, and a late answer lists its PCs
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: app(["getState", "open"]) });
        await mount(signedOut);
        expect(asked).toBe(1);
        expect(all("[data-view]")).toHaveLength(0);
        // the wait is bounded: the controls come by themselves well within it
        const deadline = Date.now() + 5_000;
        while (all("[data-view]").length === 0) {
          if (Date.now() > deadline) throw new Error("the front page stayed blank while the app did not answer");
          await act(async () => { await Promise.race([answer.promise, Bun.sleep(25)]); });
        }
        expect(view()).toBe("add-pc");
        expect(buttons("Continue with GitHub")).toHaveLength(1);
        await act(async () => { answer.resolve({ saved: ["https://desk.tail1e211e.ts.net"], names: {} }); await answer.promise; });
        expect(view()).toBe("my-pcs");
        expect(rowTexts().map(([way]) => way)).toEqual(["tailscale"]);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("keeps a PC's own page on that PC's sign-in whatever the phone saved, and its Back on a relay with no accounts", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: [{ name: "getState" }, { name: "open" }] }],
        nativePromise: async (_plugin: string, method: string) => method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net"], names: {} } : {},
      } });
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), onSignIn: none });
        expect(view()).toBe("add-pc");
        expect(title()).toBe("Connect a PC");
        expect(buttons("Continue with GitHub")).toHaveLength(1);
        await browser.render(null);
        let backed = 0;
        await mount({ ...props({ kind: "empty" }), onBack: () => { backed += 1; } });
        expect(view()).toBe("add-pc");
        await act(async () => { back()[0]!.click(); });
        expect(backed).toBe(1);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("gives Add PC an entry of its own in the history, and moves the focus to its heading and back to Add PC", async () => {
      const pushed: unknown[] = [];
      (window.history as unknown as { pushState: (state: unknown) => void }).pushState = (state) => { pushed.push(state); };
      const focused: string[] = [];
      trackFocus(focused);
      await mount(signedIn(four()));
      expect(pushed).toHaveLength(0);
      await act(async () => { action("add-pc").click(); });
      expect(view()).toBe("add-pc");
      expect(pushed).toHaveLength(1);
      expect(focused.at(-1)).toBe("h1");
      await act(async () => { back()[0]!.click(); });
      expect(view()).toBe("my-pcs");
      expect(focused.at(-1)).toBe("add-pc");
      // a tab is no step of the history
      await act(async () => { action("add-pc").click(); });
      await act(async () => { tab("ssh").click(); });
      expect(pushed).toHaveLength(2);
    });

    it("keeps the code line beside the QR way in the phone app, signed out and signed in, both held while a sign-in is under way", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "CapacitorBarcodeScanner", methods: [{ name: "scanBarcode" }] }],
        nativePromise: async () => ({}),
      } });
      const ways = () => [action("scan-qr"), action("add-code")].map((node) => [node.getAttribute("data-action"), node.disabled === true]);
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(ways()).toEqual([["scan-qr", false], ["add-code", false]]);
        await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, { ...props({ kind: "empty", account: { kind: "signing-in", provider: "google" } }), scoped: false, onSignIn: none }) }));
        expect(ways()).toEqual([["scan-qr", true], ["add-code", true]]);
        await browser.render(null);
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none });
        await openAdd();
        expect(ways()).toEqual([["scan-qr", false], ["add-code", false]]);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("offers Open Tailscale for a saved Tailscale PC while the phone app says Tailscale is off, instead of waiting for its open to fail", async () => {
      for (const on of [false, true]) {
        const called: string[] = [];
        const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
          isNativePlatform: () => true, getPlatform: () => "android",
          PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "openTailscale"].map((name) => ({ name })) }],
          nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
            called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
            if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net"], names: { "https://desk.tail1e211e.ts.net": "Desk" } };
            if (method === "tailscale") return { on };
            return {};
          },
        } });
        try {
          await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
          await act(async () => { element<HTMLButtonElement>('button[class="relay-add-saved-pc"]').click(); });
          const card = () => all("[data-tailscale-off]");
          if (on) {
            expect(card()).toHaveLength(0);
            expect(called).toContain("HerdrShell.open https://desk.tail1e211e.ts.net/");
          } else {
            expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
            expect(called.some((call) => call.startsWith("HerdrShell.open "))).toBe(false);
            await act(async () => { element("button", card()[0]!).click(); });
            expect(called).toContain("HerdrShell.openTailscale");
          }
          await browser.render(null);
        } finally {
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      }
    });

    it("keeps the chosen tab, the list's search and an open in progress across the 1024 px line, both ways", async () => {
      screen.install();
      screen.set(false);
      const called: string[] = [];
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "cancelOpen"].map((name) => ({ name })) }],
        nativePromise: async (plugin: string, method: string) => {
          called.push(`${plugin}.${method}`);
          if (method === "getState") return { saved: ["http://192.168.0.5:7317"], names: {} };
          if (method === "open") return await new Promise(() => {});
          return {};
        },
      } });
      try {
        await mount({ ...props({ kind: "list", devices: many(9), account: { kind: "signed-in", provider: "github", error: null, pcs: [] } }), scoped: false, onSignIn: none });
        const search = () => one("searches", all<HTMLInputElement>('input[type="search"]'));
        await browser.type(search(), "192");
        await act(async () => { element<HTMLButtonElement>('button[class="relay-add-saved-pc"]', element('li[data-pc-way="address"]')).click(); });
        await openAdd();
        await act(async () => { tab("ssh").click(); });
        await act(async () => { screen.set(true); });
        expect(views()).toEqual(["my-pcs", "add-pc"]);
        expect(panel()).toBe("ssh");
        expect(search().value).toBe("192");
        await act(async () => { screen.set(false); });
        expect(view()).toBe("add-pc");
        expect(panel()).toBe("ssh");
        // nothing was mounted again: the open goes on, never cancelled by the move
        expect(all("[data-opening]").filter(shown).map(textOf)).toEqual(["Opening 192.168.0.5:7317…Cancel"]);
        expect(called).not.toContain("HerdrShell.cancelOpen");
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("leaves the pairing dialog the top of the history when the window narrows again under it, and gives Add PC its entry once the dialog closes", async () => {
      screen.install();
      screen.set(false);
      const pushed: unknown[] = [];
      (window.history as unknown as { pushState: (state: unknown) => void }).pushState = (state) => { pushed.push(state); };
      const draw = (shown_: RelayShellProps) => browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, shown_) }));
      const front: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onCancel: () => { void draw(front); } };
      await mount(front);
      await openAdd();
      expect(pushed).toHaveLength(1);
      await act(async () => { screen.set(true); });
      await typeCode("ABCDE-12345");
      await draw({ ...front, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } });
      expect(dialog().getAttribute("data-pair-dialog")).toBe("compare");
      await act(async () => { screen.set(false); });
      expect(pushed).toHaveLength(1);
      await act(async () => { button("Cancel").click(); });
      expect(dialogs()).toHaveLength(0);
      expect(view()).toBe("add-pc");
      expect(pushed).toHaveLength(2);
    });

    it("goes back from My PCs to the relay PC the app keeps open while the person chooses, signed out with nothing saved in this browser", async () => {
      const called: string[] = [];
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      const scope = `https://app.ovis.sh/s/${ids.home}/`;
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "backToCurrent"].map((name) => ({ name })) }],
        nativePromise: async (plugin: string, method: string) => { called.push(`${plugin}.${method}`); return method === "getState" ? { saved: [scope], names: {}, choosing: true, current: scope } : {}; },
      } });
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(view()).toBe("my-pcs");
        const backs = all<HTMLButtonElement>('button[aria-label="Back to this PC"]').filter(shown);
        expect(backs).toHaveLength(1);
        await act(async () => { backs[0]!.click(); });
        expect(called).toContain("HerdrShell.backToCurrent");
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("marks only the scope the app keeps open on a self-hosted relay's origin, and names it on Back", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      const desk = `https://relay.example/s/${"e".repeat(32)}/`, laptop = `https://relay.example/s/${"f".repeat(32)}/`;
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "backToCurrent"].map((name) => ({ name })) }],
        nativePromise: async (_plugin: string, method: string) => method === "getState" ? { saved: [desk, laptop], names: { [desk]: "Desk", [laptop]: "Laptop" }, choosing: true, current: laptop } : {},
      } });
      try {
        await mount(signedIn(four()));
        expect(rowTexts().filter(([, text]) => text.includes("In use now")).map(([, text]) => text.split("Address")[0])).toEqual(["Laptop"]);
        expect(all<HTMLButtonElement>('button[aria-label="Back to Laptop"]').filter(shown)).toHaveLength(1);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("says a failed sign-in once on a wide screen, beside the sign-in it can try again", async () => {
      wide();
      await mount({ ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: "The sign-in did not finish." } }), scoped: false, onSignIn: none });
      const alerts = all('[role="alert"]').filter((node) => shown(node) && textOf(node).includes("The sign-in did not finish."));
      expect(alerts).toHaveLength(1);
      expect(all("*", element('[data-view="add-pc"]')).filter((node) => node === alerts[0])).toHaveLength(1);
    });

    /** a phone app whose plugins answer as `answer` says, every call written down */
    const app = (headers: { name: string; methods?: string[] }[], answer: (method: string, options: Record<string, unknown>) => unknown) => {
      const called: string[] = [];
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: headers.map(({ name, methods }) => ({ name, methods: (methods ?? []).map((method) => ({ name: method })) })),
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
          return await answer(method, options);
        },
      } });
      return called;
    };
    const withApp = async (run: () => Promise<void>) => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      try { await run(); } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    };
    const statusShown = () => all("[data-opening]").filter(shown).map(textOf);
    const savedRow = (way: string) => element<HTMLButtonElement>('button[class="relay-add-saved-pc"]', element(`li[data-pc-way="${way}"]`));

    it("keeps an open the person started in view when they go on to Add PC: its status follows, and only then does the app open it", async () => {
      await withApp(async () => {
        const tailscale = Promise.withResolvers<{ on?: boolean }>();
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "cancelOpen"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net"], names: {} } : method === "tailscale" ? tailscale.promise : method === "open" ? new Promise(() => {}) : {});
        await mount(signedIn(four()));
        await act(async () => { savedRow("tailscale").click(); });
        await openAdd();
        expect(statusShown()).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
        await act(async () => { tailscale.resolve({ on: true }); await tailscale.promise; });
        expect(called).toContain("HerdrShell.open https://desk.tail1e211e.ts.net/");
        expect(statusShown()).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
      });
    });

    it("starts no open for a QR read after the control that scanned it is gone", async () => {
      await withApp(async () => {
        const scanned = Promise.withResolvers<{ ScanResult: string }>();
        const called = app([{ name: "HerdrShell", methods: ["open"] }, { name: "CapacitorBarcodeScanner", methods: ["scanBarcode"] }], (method) => method === "scanBarcode" ? scanned.promise : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { action("scan-qr").click(); });
        await act(async () => { tab("ssh").click(); });
        await act(async () => { scanned.resolve({ ScanResult: "https://desk.tail1e211e.ts.net" }); await scanned.promise; });
        expect(called.filter((call) => call.startsWith("HerdrShell.open"))).toEqual([]);
        expect(statusShown()).toEqual([]);
      });
    });

    it("keeps an open running when the tab that started it gives way to another, on a wide screen", async () => {
      wide();
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "cancelOpen"] }], (method) => method === "getState" ? { saved: [], names: {} } : method === "open" ? new Promise(() => {}) : {});
        await mount(signedIn(four()));
        await act(async () => { tab("tailscale").click(); });
        const form = element<HTMLFormElement>("form", element('[data-tab-panel="tailscale"]'));
        await submit(form, "other.tail1e211e.ts.net");
        await act(async () => { tab("ssh").click(); });
        expect(called).not.toContain("HerdrShell.cancelOpen");
        // still in view, beside the list and on the tab now chosen
        expect(statusShown()).toEqual(["Opening other.tail1e211e.ts.net…Cancel", "Opening other.tail1e211e.ts.net…Cancel"]);
      });
    });

    it("ends an open the app never answers once its deadline passes, says why, and takes the next tap", async () => {
      jest.useFakeTimers();
      try {
        await withApp(async () => {
          const called = app([{ name: "HerdrShell", methods: ["getState", "open"] }], (method) => method === "getState" ? { saved: ["http://192.168.0.5:7317", "http://192.168.0.6:7317"], names: {} } : method === "open" ? new Promise(() => {}) : {});
          await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
          const rows = () => all('li[data-pc-way="address"]').map((node) => element<HTMLButtonElement>('button[class="relay-add-saved-pc"]', node));
          await act(async () => { rows()[0]!.click(); });
          expect(statusShown()).toEqual(["Opening 192.168.0.5:7317…"]);
          await act(async () => { rows()[1]!.click(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open"))).toHaveLength(1);
          await act(async () => { jest.advanceTimersByTime(30_000); });
          expect(statusShown()).toEqual([]);
          expect(all('[role="alert"]').filter(shown).map(textOf).join(" ")).toContain("192.168.0.5:7317 did not answer within 20 seconds.");
          await act(async () => { rows()[1]!.click(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open"))).toEqual(["HerdrShell.open http://192.168.0.5:7317/", "HerdrShell.open http://192.168.0.6:7317/"]);
        });
      } finally { jest.useRealTimers(); }
    });

    it("asks the app whether Tailscale is on, when it comes back, only from a Tailscale tab that is on screen", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "tailscale"] }], (method) => method === "getState" ? { saved: [], names: {} } : method === "tailscale" ? { on: true } : {});
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        await mount(signedIn(four()));
        await openAdd();
        await act(async () => { tab("tailscale").click(); });
        const asked = () => called.filter((call) => call === "HerdrShell.tailscale").length;
        expect(asked()).toBe(1);
        await act(async () => { back()[0]!.click(); });
        await act(async () => { browser.window.document.dispatchEvent(new browser.window.Event("visibilitychange")); });
        expect(asked()).toBe(1);
        await openAdd();
        // on screen again: asked once, and again when the app comes back
        expect(asked()).toBe(2);
        await act(async () => { browser.window.document.dispatchEvent(new browser.window.Event("visibilitychange")); });
        expect(asked()).toBe(3);
      });
    });

    it("ends a code's lookup when the person leaves it: folding its field, Add PC's Back, another tab, the comparison's Cancel or a sign-in, after which its result changes nothing", async () => {
      const compare = { kind: "code-compare" as const, offer: { v: 1 as const, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } };
      // folding its field, Add PC's Back, another tab
      const leave: (() => Promise<void>)[] = [
        async () => { await act(async () => { action("add-code").click(); }); },
        async () => { await act(async () => { back()[0]!.click(); }); },
        async () => { await act(async () => { tab("tailscale").click(); }); },
      ];
      for (const go of leave) {
        const calls: string[] = [];
        const draw = (shown_: RelayShellProps) => browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, shown_) }));
        const page: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onCancel: () => { calls.push("cancel"); } };
        await mount(page);
        await openAdd();
        await typeCode("ABCDE-12345");
        await draw({ ...page, state: { kind: "code-looking" } });
        // the field is read-only while it looks
        expect(element<HTMLInputElement>('input[name="code"]').readOnly).toBe(true);
        await go();
        expect(calls).toEqual(["cancel"]);
        // the shell, cancelled, reads the front page again
        await draw(page);
        // a result that arrives after: nothing opens over the page
        await draw({ ...page, state: compare });
        expect(dialogs()).toHaveLength(0);
        await draw(page);
        await browser.render(null);
      }
      // the comparison's Cancel, while the front page the shell reads again is still on its way: the dialog stays closed
      const calls: string[] = [];
      const page: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onCancel: () => { calls.push("cancel"); } };
      await mount(page);
      await openAdd();
      await typeCode("ABCDE-12345");
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, { ...page, state: compare }) }));
      expect(dialog().getAttribute("data-pair-dialog")).toBe("compare");
      await act(async () => { button("Cancel").click(); });
      expect(calls).toEqual(["cancel"]);
      expect(dialogs()).toHaveLength(0);
      await browser.render(null);
      // a sign-in started over a failed code ends the code first
      const signed: string[] = [];
      const out: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: () => { signed.push("sign-in"); }, onCancel: () => { signed.push("cancel"); } };
      await mount(out);
      await typeCode("x");
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, { ...out, state: { kind: "code-entry", failure: "not-a-code" } }) }));
      expect(element<HTMLInputElement>('input[name="code"]').readOnly).toBe(false);
      await act(async () => { button("Continue with GitHub").click(); });
      expect(signed).toEqual(["cancel", "sign-in"]);
    });

    it("moves the focus to Add PC's title when Add PC opens it, never when the window narrows under it", async () => {
      screen.install();
      screen.set(false);
      const focused: string[] = [];
      trackFocus(focused);
      await mount(signedIn(four()));
      await act(async () => { action("add-pc").click(); });
      expect(focused.filter((each) => each === "h1")).toHaveLength(1);
      await act(async () => { screen.set(true); });
      await act(async () => { screen.set(false); });
      expect(focused.filter((each) => each === "h1")).toHaveLength(1);
    });

    it("keeps a failed sign-in in view on another tab, on a wide screen and on a phone, said once", async () => {
      const failing = { ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: "The sign-in did not finish." } }), scoped: false, onSignIn: none } satisfies RelayShellProps;
      const said = () => all('[role="alert"]').filter((node) => shown(node) && textOf(node).includes("The sign-in did not finish.")).length;
      wide();
      await mount(failing);
      expect(said()).toBe(1);
      await act(async () => { tab("tailscale").click(); });
      expect(said()).toBe(1);
      await browser.render(null);
      screen.set(false);
      await mount(failing);
      expect(said()).toBe(1);
      await openAdd();
      expect(said()).toBe(1);
      await act(async () => { tab("ssh").click(); });
      expect(said()).toBe(1);
    });

    it("never says Needs approval: an account PC this device is not let into yet is On or Off like any other", async () => {
      await mount(signedIn(four()));
      expect(rowTexts()).toEqual([["relay", "Desk PCRelayOn"], ["relay", "MacBookRelay"], ["relay", "Home serverRelayOff"], ["relay", "Mac miniRelayOn"]]);
      expect(textOf(document.body)).not.toContain("Needs approval");
    });

    it("lists the phone app's own PCs on My PCs after the relay's, each opened at its own address, Forget on a Tailscale or address one, and no list on the tabs", async () => {
      const called: string[] = [];
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "open", "forget"].map((name) => ({ name })) }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
          if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317", "http://127.0.0.1:41234"], names: { "https://desk.tail1e211e.ts.net": "Desk", "http://127.0.0.1:41234": "lab-linux" } };
          return {};
        },
      } });
      try {
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "MacBook", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        expect(view()).toBe("my-pcs");
        // the relay's PC first, then the app's: Tailscale, then the others in the order the app saved them
        expect(rowTexts()).toEqual([["relay", "MacBookRelay"], ["tailscale", "DeskTailscaledesk.tail1e211e.ts.net"], ["address", "192.168.0.5:7317Address"], ["ssh", "lab-linuxSSH127.0.0.1:41234"]]);
        expect(element<HTMLAnchorElement>('a[class="relay-add-saved-pc"]').getAttribute("href")).toBe(`/s/${ids.mac}/`);
        const rows = () => all("li[data-pc-way]").filter((node) => node.getAttribute("data-pc-way") !== "relay");
        for (const [index, opens] of ["https://desk.tail1e211e.ts.net/", "http://192.168.0.5:7317/", "http://127.0.0.1:41234/"].entries()) {
          await act(async () => { element("button.relay-add-saved-pc", rows()[index]!).click(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open")).at(-1)).toBe(`HerdrShell.open ${opens}`);
        }
        await act(async () => { action("account-menu").click(); });
        await act(async () => { element<HTMLButtonElement>('button[data-item="forget-pcs"]').click(); });
        const deskRow = element('li[data-tailnet-pc="https://desk.tail1e211e.ts.net"]');
        await act(async () => { element('button[data-action="forget-pc"]', deskRow).click(); });
        expect(called).toContain("HerdrShell.forget https://desk.tail1e211e.ts.net");
        expect(called.filter((call) => call === "HerdrShell.getState")).toHaveLength(2);
        await act(async () => { action("forget-done").click(); });
        await openAdd();
        for (const way of ["tailscale", "ssh"]) {
          await act(async () => { tab(way).click(); });
          expect(all("[data-pc-way]").filter(shown)).toHaveLength(0);
        }
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("scans a PC's QR from Add PC's relay tab in the phone app, and keeps the address field under Open Tailscale on the Tailscale tab while Tailscale is off", async () => {
      const assigned: string[] = [];
      const called: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
      let tailscaleOn = true;
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: ["getState", "tailscale", "openTailscale", "open"].map((name) => ({ name })) }, { name: "CapacitorBarcodeScanner" }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.url === "string" ? ` ${options.url}` : ""}`);
          if (method === "getState") return { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317", "http://100.101.1.2:7317"], names: { "https://desk.tail1e211e.ts.net": "Desk" } };
          if (method === "tailscale") return { on: tailscaleOn };
          if (method === "scanBarcode") return { ScanResult: `https://app.ovis.sh/s/${ids.mini}/#offer=abc` };
          return {};
        },
      } });
      try {
        const page = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none } satisfies RelayShellProps;
        await mount(page);
        expect(rowTexts().map(([way, text]) => [way, text.replace(/Forget$/, "")])).toEqual([["tailscale", "DeskTailscaledesk.tail1e211e.ts.net"], ["tailscale", "100.101.1.2:7317Tailscale"], ["address", "192.168.0.5:7317Address"]]);
        await openAdd();
        // the code line too, beside the QR way: the PC offers both
        expect(all<HTMLButtonElement>('button[data-action="add-code"]')).toHaveLength(1);
        await act(async () => { action("scan-qr").click(); });
        expect(assigned).toEqual([`https://app.ovis.sh/s/${ids.mini}/#offer=abc`]);
        await act(async () => { tab("tailscale").click(); });
        expect(all<HTMLInputElement>("input")).toHaveLength(1);
        expect(all("[data-tailnet-pc]").filter(shown)).toHaveLength(0);
        await browser.render(null);
        tailscaleOn = false;
        await mount(page);
        await openAdd();
        await act(async () => { tab("tailscale").click(); });
        // a home Wi-Fi address opens without Tailscale: its field stays, under the card
        const tailscalePanel = element('[data-tab-panel="tailscale"]');
        const [card, field] = [element("[data-tailscale-off]", tailscalePanel), element("input", tailscalePanel)];
        const order = all("*", tailscalePanel).filter((node) => node === card || node === field);
        expect(order).toEqual([card, field]);
        await act(async () => { button("Open Tailscale").click(); });
        expect(called).toContain("HerdrShell.openTailscale");
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("opens an account PC's standing QR scanned from the relay tab, and still refuses another app's pairing link", async () => {
      const assigned: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { assigned.push(href); };
      let scanned = "";
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "CapacitorBarcodeScanner" }],
        nativePromise: async (_plugin: string, method: string) => method === "scanBarcode" ? { ScanResult: scanned } : {},
      } });
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none });
        await openAdd();
        const scan = async (qr: string): Promise<string> => {
          scanned = qr;
          await act(async () => { element<HTMLButtonElement>('button[data-action="scan-qr"]').click(); });
          return all('[role="alert"]').map(textOf).join("");
        };
        expect(await scan(signInLink("https://app.ovis.sh", ids.mini, "github"))).toBe("");
        expect(await scan(signInLink("https://app.ovis.sh", ids.desk, null))).toBe("");
        expect(assigned).toEqual([`https://app.ovis.sh/s/${ids.mini}/#sign-in=github`, `https://app.ovis.sh/s/${ids.desk}/`]);
        expect(await scan(`https://other.example/s/${ids.mini}/#offer=abc`)).toBe("This pairing link is not this app's. Scan the QR code your PC shows.");
        expect(await scan("https://app.ovis.sh/#sign-in=github")).toBe("That is not an http or https address.");
        expect(await scan(`https://app.ovis.sh/s/${ids.mini}/#pcs`)).toBe("That is not an http or https address.");
        // only the PC's own page: none of the files under its scope, no deeper path, no query, no other fragment
        for (const other of [`/s/${ids.mini}/sw.js`, `/s/${ids.mini}/manifest.webmanifest#sign-in=github`, `/s/${ids.mini}/x/`, `/s/${ids.mini}//`, `/s/${ids.mini}/%2F`, `/s/${ids.mini}`,
          `/s/${ids.mini}/?pcs`, `/s/${ids.mini}/?next=1#sign-in=github`, `/s/${ids.mini}/#sign-in=`, `/s/${ids.mini}/#sign-in=unknown`, `/s/${ids.mini}/#sign-in=github&pcs`]) {
          expect(await scan(`https://app.ovis.sh${other}`)).toBe("That is not an http or https address.");
        }
        expect(assigned).toHaveLength(2);
        // what opens is the PC's page built from its scope, not the address as scanned
        expect(await scan(`https://someone@app.ovis.sh/s/${ids.mini}/#sign-in=google`)).toBe("");
        expect(assigned.at(-1)).toBe(`https://app.ovis.sh/s/${ids.mini}/#sign-in=google`);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("hands SSH from the SSH tab's first field to the phone app's own SSH screen, with Add by address under it, and offers no SSH in a browser", async () => {
      const called: string[] = [];
      const shown = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none } satisfies RelayShellProps;
      const sshField = () => element<HTMLInputElement>('input[name="address"]');
      const submitSsh = async (typed: string) => {
        const form = element<HTMLFormElement>("form");
        await submit(form, typed);
      };
      await mount(shown);
      await openAdd();
      await act(async () => { tab("ssh").click(); });
      expect(all<HTMLInputElement>("input")).toHaveLength(0);
      expect(button("Add by address").className).toBe("connect-address-link");
      await browser.render(null);
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "HerdrShell", methods: [{ name: "open" }, { name: "openSshSetup" }] }, { name: "OvisSsh", methods: [{ name: "add" }] }],
        nativePromise: async (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          called.push(`${plugin}.${method}${typeof options.target === "string" ? ` ${options.target}` : ""}`);
          return {};
        },
      } });
      try {
        await mount(shown);
        await openAdd();
        await act(async () => { tab("ssh").click(); });
        expect(textOf(element("label"))).toBe("SSH");
        expect(sshField().placeholder).toBe("user@host");
        await submitSsh("pi@192.168.0.20:2222");
        expect(called.filter((call) => call !== "HerdrShell.getState")).toEqual(["HerdrShell.openSshSetup pi@192.168.0.20:2222"]);
        // the hosted page never adds an SSH PC itself: the app's own page does, after the person confirms there
        expect(called.some((line) => line.startsWith("OvisSsh."))).toBe(false);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("opens My PCs when asked by its address (/#add), and types a code in its Add PC signed out, coming back to it after", async () => {
      (window.location as { hash?: string }).hash = "#add";
      sessionStorage.setItem(ADD_PC_FROM_KEY, `/s/${ids.desk}/`);
      const shown = { ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, addEntry: true };
      await mount(shown);
      expect(title()).toBe("Your PCs");
      expect(back()).toHaveLength(1);
      await openAdd();
      await typeCode("ABCDE-12345");
      // the lookup and a failure stay in Add PC's own field
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-entry", failure: "no-pc" } }) }));
      expect(view()).toBe("add-pc");
      expect(all<HTMLInputElement>('input[name="code"]')).toHaveLength(1);
      // Cancel: back on Add PC, whose Back is the list that still goes back to the PC
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
      expect(view()).toBe("add-pc");
      await act(async () => { back()[0]!.click(); });
      expect(view()).toBe("my-pcs");
      expect(back()).toHaveLength(1);
    });

    it("takes a code typed in /#add's Add PC on to the pairing dialog once it found its PC, signed in too", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const shown = { ...signedIn(four()), addEntry: true };
      await mount(shown);
      await openAdd();
      await typeCode("ABCDE-12345");
      await browser.render(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } }) }));
      expect(dialog().getAttribute("data-pair-dialog")).toBe("compare");
    });

    it("marks on /#add the PC it was opened from In use now instead of its state, and its Back goes back to that PC, leaving My PCs without one", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const went: string[] = [];
      (window.history as { back: () => void }).back = () => { went.push("back"); };
      sessionStorage.setItem(ADD_PC_FROM_KEY, `/s/${ids.home}/`);
      await mount({ ...signedIn(four()), addEntry: true });
      expect(title()).toBe("Your PCs");
      expect(rowTexts()).toEqual([["relay", "Desk PCRelayOn"], ["relay", "MacBookRelay"], ["relay", "Home serverRelayIn use now"], ["relay", "Mac miniRelayOn"]]);
      // the mark serves that one opening alone
      expect(sessionStorage.getItem(ADD_PC_FROM_KEY)).toBeNull();
      await act(async () => { back()[0]!.click(); });
      expect(went).toEqual(["back"]);
      // the front page it leaves for is My PCs, with no Back and no mark, and never the dashboard
      expect(back()).toHaveLength(0);
      expect(title()).toBe("Your PCs");
      expect(rowTexts().map(([, text]) => text)).toContain("Home serverRelayOff");
    });

    const forgets = () => all<HTMLButtonElement>('button[data-action="forget-pc"]').filter(shown);
    const openers = () => all(':is(a, button)[class="relay-add-saved-pc"]').filter(shown);
    const forgetPcs = async () => {
      await act(async () => { action("account-menu").click(); });
      await act(async () => { element<HTMLButtonElement>('button[data-item="forget-pcs"]').click(); });
    };

    it("carries no Forget on a row; the menu's Forget PCs, signed out too, puts Forget in place of each forgettable row's chevron, opens no row, and Done ends it", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317", "http://127.0.0.1:41234"], names: { "https://desk.tail1e211e.ts.net": "Desk", "http://127.0.0.1:41234": "lab-linux" } } : {});
        const forgot: string[] = [];
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "MacBook", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: (serverId) => { forgot.push(serverId); } });
        // nothing to forget by mistake on a row, whose name has the row to itself
        expect(all<HTMLButtonElement>("button").filter((node) => textOf(node) === "Forget" && shown(node))).toHaveLength(0);
        expect(openers()).toHaveLength(4);
        await forgetPcs();
        // the SSH PC goes from the app's own screen, with its keys: no Forget here, as before
        expect(forgets().map((node) => node.getAttribute("aria-label"))).toEqual(["Forget MacBook", "Forget Desk", "Forget 192.168.0.5:7317"]);
        expect(openers()).toHaveLength(0);
        expect(all('[class="relay-shell-pc-glyph"]').filter(shown)).toHaveLength(0);
        // what Forget does stays as it was, row by row
        await act(async () => { forgets()[0]!.click(); });
        await act(async () => { forgets()[1]!.click(); });
        expect(forgot).toEqual([ids.mac]);
        expect(called).toContain("HerdrShell.forget https://desk.tail1e211e.ts.net");
        await act(async () => { action("forget-done").click(); });
        expect(forgets()).toHaveLength(0);
        expect(openers()).toHaveLength(4);
        expect(all<HTMLButtonElement>('button[data-action="add-pc"]').filter(shown)).toHaveLength(1);
      });
    });

    it("asks once more, in the row, before it forgets the PC in use, and offers no Forget PCs with nothing to forget", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317"], names: { "https://desk.tail1e211e.ts.net": "Desk" }, choosing: true, current: "http://192.168.0.5:7317" } : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await forgetPcs();
        const inUse = () => forgets().find((node) => node.getAttribute("aria-label") === "Forget 192.168.0.5:7317")!;
        const ask = () => all("[data-forget-ask]").filter(shown);
        await act(async () => { inUse().click(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([]);
        expect(ask().map(textOf)).toEqual(["This is the PC in use now. Forget it?ForgetCancel"]);
        await act(async () => { one("Cancel", all("button", ask()[0]!).filter((node) => textOf(node) === "Cancel")).click(); });
        expect(ask()).toHaveLength(0);
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([]);
        await act(async () => { inUse().click(); });
        await act(async () => { one("Forget", all("button", ask()[0]!).filter((node) => textOf(node) === "Forget")).click(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual(["HerdrShell.forget http://192.168.0.5:7317"]);
        await browser.render(null);
        // only an SSH PC saved: nothing this screen forgets, so no menu signed out
        app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) => method === "getState" ? { saved: ["http://127.0.0.1:41234"], names: {} } : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(view()).toBe("my-pcs");
        expect(all<HTMLButtonElement>('button[data-action="account-menu"]').filter(shown)).toHaveLength(0);
      });
    });

    it("says, in Forget PCs, in Forget's place, why a row has none: an account PC, an SSH PC", async () => {
      await withApp(async () => {
        app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net", "http://127.0.0.1:41234"], names: { "http://127.0.0.1:41234": "lab-linux" } } : {});
        const mac = pc(ids.mac, "hasang-uui-MacBookPro", "paired", { paired: false, linked: false, last_seen_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } });
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs: [mac] } }), scoped: false, onSignIn: none });
        const reasons = () => all("[data-kept]").filter(shown).map((node) => [node.getAttribute("data-kept"), textOf(node)]);
        expect(reasons()).toEqual([]);
        await forgetPcs();
        expect(forgets().map((node) => node.getAttribute("aria-label"))).toEqual(["Forget desk"]);
        // in Forget's place, in a few words: the row keeps its height
        expect(reasons()).toEqual([["account", "Account PC"], ["ssh", "SSH PC"]]);
        expect(all("[data-kept]").filter(shown).map((node) => node.parentElement?.className)).toEqual(["my-pc", "my-pc"]);
      });
    });

    it("claims no account PC is on while the account cannot be read", async () => {
      const mac = pc(ids.mac, "hasang-uui-MacBookPro", "paired", { paired: false, linked: false, last_seen_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } });
      const page = (error: string | null) => ({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error, pcs: [mac] } }), scoped: false, onSignIn: none });
      await mount(page(null));
      expect(rowTexts()).toEqual([["relay", "hasang-uui-MacBookProRelayOn"]]);
      await browser.render(null);
      await mount(page("The account service could not be reached. The PCs this device is paired with still work."));
      expect(rowTexts()).toEqual([["relay", "hasang-uui-MacBookProRelay"]]);
    });

    const lines = () => all("[data-way-line]").filter(shown).map((line) => {
      let after = line.nextElementSibling;
      while (after !== null && !after.matches("button, [data-kept], span")) after = after.nextElementSibling;
      const end = after === null ? "" : textOf(after);
      return [line.getAttribute("data-way-line"), textOf(line), end];
    });
    const tail = "https://macbookpro.tail1e211e.ts.net:17317", scope = `https://app.ovis.sh/s/${ids.mac}/`, desk = "https://desk.tail1e211e.ts.net", sshMac = "http://127.0.0.1:47317";

    it("lists a PC saved by the relay and by its Tailscale address as one row, both ways tagged, always opened by the relay whatever loaded last", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale"] }], (method) =>
          method === "getState" ? { saved: [tail, scope, desk], names: { [desk]: "hasang-uui-MacBookPro" }, ids: { [tail]: ids.mac } } : method === "tailscale" ? { on: true } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        // the Mac once, by the relay's name, with no address (it opens by the relay); a PC saved with no ID stays its own
        // row, whatever its name
        expect(rowTexts()).toEqual([["relay", "hasang-uui-MacBookProRelay · Tailscale"], ["tailscale", "hasang-uui-MacBookProTailscaledesk.tail1e211e.ts.net"]]);
        // its Tailscale page loaded last in the app, and still the row is the relay's page
        expect(openers()[0]!.localName).toBe("a");
        expect(openers()[0]!.getAttribute("href")).toBe(`/s/${ids.mac}/`);
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
      });
    });

    it("never lets an address that claims a relay PC's ID name it or give it a state", async () => {
      await withApp(async () => {
        app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: [tail], names: { [tail]: "not-the-mac" }, ids: { [tail]: ids.mac }, choosing: true, current: tail } : {});
        const unnamed = { ...device(ids.mac, "x", AP), name: undefined } as unknown as ReturnType<typeof device>;
        await mount({ ...props({ kind: "list", devices: [unnamed], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        // the Tailscale page the app keeps open is that address's, not the relay PC's: no In use now on it, and no name
        expect(rowTexts()).toEqual([["relay", "Unnamed PCRelay · Tailscale"]]);
        expect(openers()[0]!.getAttribute("href")).toBe(`/s/${ids.mac}/`);
      });
    });

    it("lists the ways of a row of several one to a line in Forget PCs, each forgotten on its own, or why not", async () => {
      await withApp(async () => {
        // relay pairing + Tailscale address
        let called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : {});
        const forgot: string[] = [];
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: (serverId) => { forgot.push(serverId); } });
        await forgetPcs();
        expect(lines()).toEqual([["relay", "Relay", "Forget"], ["tailscale", "Tailscalemacbookpro.tail1e211e.ts.net:17317", "Forget"]]);
        expect(forgets().map((node) => node.getAttribute("aria-label"))).toEqual(["Forget hasang-uui-MacBookPro · Relay", "Forget hasang-uui-MacBookPro · Tailscale"]);
        await act(async () => { forgets()[1]!.click(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([`HerdrShell.forget ${tail}`]);
        expect(forgot).toEqual([]);
        await act(async () => { forgets()[0]!.click(); });
        expect(forgot).toEqual([ids.mac]);
        await browser.render(null);

        // relay pairing + SSH: the SSH way goes from the app's own screen, with its keys
        called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: [sshMac], names: {}, ids: { [sshMac]: ids.mac } } : {});
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        await forgetPcs();
        expect(lines()).toEqual([["relay", "Relay", "Forget"], ["ssh", "SSH127.0.0.1:47317", "SSH PC"]]);
        await browser.render(null);

        // an account PC + Tailscale address: the account's way says so, the address is forgotten on its own
        called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : {});
        const mac = pc(ids.mac, "hasang-uui-MacBookPro", "paired", { paired: false, linked: false, last_seen_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } });
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs: [mac] } }), scoped: false, onSignIn: none });
        await forgetPcs();
        expect(lines()).toEqual([["relay", "Relay", "Account PC"], ["tailscale", "Tailscalemacbookpro.tail1e211e.ts.net:17317", "Forget"]]);
        await act(async () => { forgets()[0]!.click(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([`HerdrShell.forget ${tail}`]);
      });
    });

    it("forgets one of two address ways of one ID at a time, each from its own line, the other staying", async () => {
      await withApp(async () => {
        const lan = "http://192.168.0.5:7317";
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: [tail, lan], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac } } : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await forgetPcs();
        expect(lines()).toEqual([["tailscale", "Tailscalemacbookpro.tail1e211e.ts.net:17317", "Forget"], ["address", "Address192.168.0.5:7317", "Forget"]]);
        await act(async () => { forgets()[1]!.click(); });
        // no question for one way of a PC not in use, and only that way goes
        expect(all("[data-forget-ask]").filter(shown)).toHaveLength(0);
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([`HerdrShell.forget ${lan}`]);
      });
    });

    it("asks once more before it forgets the relay way of the PC in use, and only that way", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: [tail, scope], names: {}, ids: { [tail]: ids.mac }, choosing: true, current: scope } : {});
        const forgot: string[] = [];
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: (serverId) => { forgot.push(serverId); } });
        await forgetPcs();
        const ask = () => all("[data-forget-ask]").filter(shown);
        await act(async () => { forgets()[0]!.click(); });
        expect(ask().map(textOf)).toEqual(["This is the PC in use now. Forget it?ForgetCancel"]);
        expect(forgot).toEqual([]);
        await act(async () => { one("Forget", all("button", ask()[0]!).filter((node) => textOf(node) === "Forget")).click(); });
        expect(forgot).toEqual([ids.mac]);
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([]);
      });
    });

    it("offers a row's other saved way by name when its open fails: a row of saved ways, and a relay PC's own page", async () => {
      await withApp(async () => {
        const lan = "http://192.168.0.5:7317";
        const called = app([{ name: "HerdrShell", methods: ["getState", "open"] }], (method, options) =>
          method === "getState" ? { saved: [tail, lan], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac } }
            : method === "open" && options.url === `${tail}/` ? Promise.reject(Object.assign(new Error("unknown-host"), { code: "unknown-host" })) : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(rowTexts()).toEqual([["tailscale", "macbookproTailscale · Addressmacbookpro.tail1e211e.ts.net:17317"]]);
        await act(async () => { openers()[0]!.click(); });
        await act(async () => { await Promise.resolve(); });
        const offer = () => all<HTMLButtonElement>('button[data-action="open-other-way"]').filter(shown);
        // it names the host it opens, whole: the person sees what answers, not only that it is "the PC at its address"
        expect(offer().map((node) => [node.getAttribute("aria-label"), textOf(node)])).toEqual([["Open 192.168.0.5:7317 (Address)", "AddressOpen 192.168.0.5:7317"]]);
        await act(async () => { offer()[0]!.click(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${tail}/`, `HerdrShell.open ${lan}/`]);
        await browser.render(null);

        // the relay PC's own page, whose open over the relay failed: the Tailscale address the app saved it by
        const again = app([{ name: "HerdrShell", methods: ["getState", "open"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "failed", failure: "pc-offline", name: "hasang-uui-MacBookPro", detail: null, server_id: ids.mac }) });
        await act(async () => { await Promise.resolve(); });
        expect(offer().map((node) => [node.getAttribute("aria-label"), textOf(node)])).toEqual([["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"]]);
        await act(async () => { offer()[0]!.click(); });
        expect(again.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${tail}/`]);
        await browser.render(null);
        // a key that is not the PC's offers no other way
        app([{ name: "HerdrShell", methods: ["getState", "open"] }], (method) => method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : {});
        await mount({ ...props({ kind: "failed", failure: "identity-changed", name: "hasang-uui-MacBookPro", detail: null, server_id: ids.mac }) });
        expect(offer()).toHaveLength(0);
      });
    });

    // device pass r14 (b): on Android with Tailscale off, the relay failure card's other-way button did nothing at all
    it("ends the other way's open of a Tailscale address in the Tailscale-off card while the phone's Tailscale is off: a relay PC's own page, and My PCs", async () => {
      await withApp(async () => {
        const lan = "http://192.168.0.5:7317";
        const offer = () => all<HTMLButtonElement>('button[data-action="open-other-way"]').filter(shown);
        const card = () => all("[data-tailscale-off]").filter(shown);
        const settle = async () => { for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); }); };
        // the relay PC's own page, whose open over the relay failed, offers the Tailscale address the app saved it by
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "openTailscale"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : method === "tailscale" ? { on: false } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "failed", failure: "pc-offline", name: "hasang-uui-MacBookPro", detail: null, server_id: ids.mac }) });
        await settle();
        expect(card()).toHaveLength(0);
        await act(async () => { offer()[0]!.click(); });
        await settle();
        // as a Tailscale row of My PCs does with Tailscale off: the line and Open Tailscale, nothing opened
        expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
        await act(async () => { element("button", card()[0]!).click(); });
        expect(called).toContain("HerdrShell.openTailscale");
        await browser.render(null);

        // My PCs: a row of two saved ways opens by the one that loaded last; that open fails, and the Tailscale way it offers meets Tailscale off
        const again = app([{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "openTailscale"] }], (method, options) =>
          method === "getState" ? { saved: [lan, tail], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac } } : method === "tailscale" ? { on: false }
            : method === "open" && options.url === `${lan}/` ? Promise.reject(Object.assign(new Error("unknown-host"), { code: "unknown-host" })) : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { openers()[0]!.click(); });
        await settle();
        expect(offer().map((node) => node.getAttribute("aria-label"))).toEqual(["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)"]);
        await act(async () => { offer()[0]!.click(); });
        await settle();
        expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
        expect(again.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${lan}/`]);
      });
    });

    const moreWays = () => all<HTMLButtonElement>('button[data-action="more-ways"]').filter(shown);
    const wayButtons = () => all<HTMLButtonElement>('button[data-action="open-other-way"]').filter(shown);
    const wayLines = () => wayButtons().map((node) => [node.getAttribute("aria-label"), textOf(node)]);

    for (const screenWide of [false, true]) {
      it(`lists a row's other saved ways behind its More ways, closed at first, each line its tag and whole host opening that way; the row still opens by the relay (${screenWide ? "wide" : "phone"})`, async () => {
        if (screenWide) wide();
        await withApp(async () => {
          const lan = "http://192.168.0.5:7317";
          const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale"] }], (method) =>
            method === "getState" ? { saved: [tail, lan, desk], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac } } : method === "tailscale" ? { on: true } : method === "open" ? new Promise(() => {}) : {});
          await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP), device(ids.desk, "Desk PC", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
          const rows = rowTexts();
          expect(rows).toEqual([["relay", "hasang-uui-MacBookProRelay · Tailscale · Address"], ["relay", "Desk PCRelay"], ["tailscale", "deskTailscaledesk.tail1e211e.ts.net"]]);
          // one disclosure, on the row of several ways alone, closed, named for its PC
          expect(moreWays().map((node) => [node.getAttribute("aria-label"), node.getAttribute("aria-expanded")])).toEqual([["More ways to open hasang-uui-MacBookPro", "false"]]);
          expect(wayLines()).toEqual([]);
          // what it controls is there while closed too, hidden
          const controlled = () => all("[id]").filter((node) => node.id === moreWays()[0]!.getAttribute("aria-controls")).map((node) => node.hidden);
          expect(controlled()).toEqual([true]);
          // the row's own tap is still the relay's page
          expect(openers()[0]!.localName).toBe("a");
          expect(openers()[0]!.getAttribute("href")).toBe(`/s/${ids.mac}/`);
          await act(async () => { moreWays()[0]!.click(); });
          expect(moreWays()[0]!.getAttribute("aria-expanded")).toBe("true");
          expect(controlled()).toEqual([false]);
          // each other way, one to a line: its tag and the host it opens, whole, in its accessible name too
          expect(wayLines()).toEqual([
            ["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"],
            ["Open 192.168.0.5:7317 (Address)", "AddressOpen 192.168.0.5:7317"],
          ]);
          // opening the list opens nothing; the relay row keeps its name, its way tags and where it leads
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
          expect(openers()[0]!.getAttribute("href")).toBe(`/s/${ids.mac}/`);
          await act(async () => { wayButtons()[1]!.click(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${lan}/`]);
          // closed again, the rows read as they did
          await act(async () => { moreWays()[0]!.click(); });
          expect(wayLines()).toEqual([]);
          expect(rowTexts()).toEqual(rows);
        });
      });
    }

    it("lists, on a row of saved ways alone, the ways other than the one its tap opens", async () => {
      await withApp(async () => {
        const lan = "http://192.168.0.5:7317";
        // the address way loaded last: the row's tap opens it, so More ways lists the Tailscale one alone
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale"] }], (method) =>
          method === "getState" ? { saved: [lan, tail], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac } } : method === "tailscale" ? { on: true } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { moreWays()[0]!.click(); });
        expect(wayLines()).toEqual([["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"]]);
        await act(async () => { wayButtons()[0]!.click(); });
        for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${tail}/`]);
      });
    });

    it("shows, on a row of saved ways alone, the way the app keeps open, whose row goes back to it, and lists the others under More ways", async () => {
      await withApp(async () => {
        const lan = "http://192.168.0.5:7317";
        // the address loaded last, but the app keeps the Tailscale way open while the person chooses another
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: [lan, tail], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac }, choosing: true, current: tail } : method === "tailscale" ? { on: true } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(rowTexts()).toEqual([["tailscale", "macbookproTailscale · Addressmacbookpro.tail1e211e.ts.net:17317In use now"]]);
        await act(async () => { moreWays()[0]!.click(); });
        expect(wayLines()).toEqual([["Open 192.168.0.5:7317 (Address)", "AddressOpen 192.168.0.5:7317"]]);
        await act(async () => { openers()[0]!.click(); });
        expect(called).toContain("HerdrShell.backToCurrent");
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
      });
    });

    it("ends a More ways line's open of a Tailscale address in the Tailscale-off card while the phone's Tailscale is off, as a Tailscale row does", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale", "openTailscale"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : method === "tailscale" ? { on: false } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        const card = () => all("[data-tailscale-off]").filter(shown);
        await act(async () => { moreWays()[0]!.click(); });
        await act(async () => { wayButtons()[0]!.click(); });
        for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); });
        expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
      });
    });

    it("offers Forget PCs in the signed-in menu too", async () => {
      await mount({ ...signedIn(four()), onForgetSaved: none });
      await forgetPcs();
      expect(forgets().map((node) => node.getAttribute("aria-label"))).toEqual(["Forget Desk PC", "Forget MacBook", "Forget Home server"]);
    });

    it("goes back to the PC in use when its row is tapped, as Back does, rather than opening that PC again", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const went: string[] = [];
      (window.history as { back: () => void }).back = () => { went.push("back"); };
      sessionStorage.setItem(ADD_PC_FROM_KEY, `/s/${ids.home}/`);
      await mount({ ...signedIn(four()), addEntry: true });
      const inUse = () => element('[class="relay-add-saved-pc"]', one("li", all("li").filter((node) => textOf(node).includes("In use now"))));
      expect(inUse().localName).toBe("button");
      await act(async () => { inUse().click(); });
      expect(went).toEqual(["back"]);
      await browser.render(null);
      // the PC the phone app keeps open while the person chooses another: back to it
      (window.location as { hash?: string }).hash = "";
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net"], names: { "https://desk.tail1e211e.ts.net": "Desk" }, choosing: true, current: "https://desk.tail1e211e.ts.net" } : {});
        await mount(signedIn(four()));
        await act(async () => { inUse().click(); });
        expect(called).toContain("HerdrShell.backToCurrent");
        expect(called.filter((call) => call.startsWith("HerdrShell.open"))).toEqual([]);
      });
    });

    it("says over the signed-out relay tab's sign-in what an account gives, and under its ways in that Tailscale and SSH need none", async () => {
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      const relay = textOf(element('[data-tab-panel="relay"]'));
      const at = (words: string) => relay.indexOf(words);
      expect(at("Reach your PCs from anywhere with your Ovis account")).toBeGreaterThanOrEqual(0);
      expect(at("Reach your PCs from anywhere with your Ovis account")).toBeLessThan(at("Continue with GitHub"));
      expect(at("Tailscale and SSH need no sign-in.")).toBeGreaterThan(at("Pair with a code"));
      await browser.render(null);
      // signed in, neither: there is no sign-in to explain
      await mount(signedIn(four()));
      await openAdd();
      const signedInRelay = textOf(element('[data-tab-panel="relay"]'));
      expect([signedInRelay.includes("Reach your PCs"), signedInRelay.includes("need no sign-in")]).toEqual([false, false]);
    });

  });
});

/** The markup on screen: each part kept mounted but hidden (the pane the layout does not show) left out. */
function shownOf(html: string): string {
  let out = html;
  for (let at = out.search(/<div [^>]*hidden=""/); at !== -1; at = out.search(/<div [^>]*hidden=""/)) {
    let depth = 0, end = at;
    for (const tag of out.slice(at).matchAll(/<div\b|<\/div>/g)) {
      depth += tag[0] === "</div>" ? -1 : 1;
      if (depth === 0) { end = at + tag.index + tag[0].length; break; }
    }
    out = out.slice(0, at) + out.slice(end);
  }
  return out;
}

const groupsOf = (html: string) => [...html.matchAll(/<span class="(key-id-group(?: key-id-differs)?)">([0-9a-f]{4})/g)].map(([, kind, group]) => [group, kind === "key-id-group key-id-differs"]);

describe("a key that is not the PC's", () => {
  it("splits an id into eight groups of four", () => {
    expect(keyIdGroups(EXPECTED)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
  });

  for (const state of [
    { kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } },
    { kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } },
  ] as const) {
    it(`shows the PC's id and the other key's, marking the groups that differ (${state.kind})`, () => {
      const html = render(props(state));
      expect(html).toContain('data-relay-state="identity-changed"');
      const [pcGroups, receivedGroups] = [groupsOf(html).slice(0, 8), groupsOf(html).slice(8)];
      expect(pcGroups.every(([, differs]) => differs === false)).toBe(true);
      expect(receivedGroups).toEqual([["0123", false], ["4567", false], ["ffff", true], ["cdef", false], ["0123", false], ["4567", false], ["89ab", false], ["eeee", true]]);
      expect(html.match(/visually-hidden">\s*differs</g)).toHaveLength(2);
    });
  }

  it("never calls an id the PC's: each is labelled by where it came from", () => {
    const forged = render(props({ kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } }));
    expect(forged).not.toContain("This PC&#x27;s ID");
    expect(forged).toContain("ID this link names");
    expect(forged).toContain("ID of the key this link carries");
    // a bad saved key under a genuine link is the saved key's, not the link's
    const changed = render(props({ kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } }));
    expect(changed).toContain("ID this phone paired with");
    expect(changed).toContain("ID of the key this phone saved");
    expect(changed).not.toContain("this link carries");
  });

  it("says a key that does not parse is not a valid key, and still shows the PC's id", () => {
    const html = render(props({ kind: "forged", name: null, mismatch: { expected: EXPECTED, received: null, from: "link" } }));
    expect(html).toContain("Not a valid key");
    expect(groupsOf(html)).toHaveLength(8);
  });
});

describe("pairing with a typed code", () => {
  it("shows every group of the ID a code found before anything is paired", () => {
    const html = render(props({ kind: "code-compare", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", code: "123456", name: "Desk" } }));
    for (const group of keyIdGroups(EXPECTED)) expect(html).toContain(`>${group}<`);
    expect(html).toContain("It matches");
    expect(html).toContain('data-relay-state="code-compare"');
  });

  it("keeps the code in its field only, names the current path without legacy parentheticals, and says why the last one gave no PC", () => {
    const html = render(props({ kind: "code-entry", failure: "no-pc" }));
    expect(html).toMatch(/<input[^>]*name="code"/);
    expect(html).not.toMatch(/<input[^>]*name="code"[^>]*value=/);
    expect(html).toContain("Settings → Devices and PCs → Add a connection → Ovis relay");
    expect(html).not.toContain("older Ovis");
    expect(html).toContain("No PC shows this code");
  });
});

describe("a pairing's step frame", () => {
  it("shows a typed comparison's waiting card without digits, which only the PC holds", () => {
    const html = render(props({ kind: "compare", name: "Desk", digits: "", confirmed: true, typed: true }));
    expect(html).toContain("Approve on the PC if it shows the same number");
    expect(html).not.toContain("relay-shell-digits");
    expect(html).toContain("Approve this device on Desk within 90 seconds to finish.");
  });
});

describe("Back from Add a PC opened by its address", () => {
  const history = () => { const calls: string[] = []; return { calls, back: () => { calls.push("back"); }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { calls.push(`replace ${String(url)}`); } }; };
  it("goes back to the PC page that opened it, and otherwise stays, dropping #add", () => {
    const opened = history();
    leaveAddEntry(`/s/${"a".repeat(32)}/`, opened);
    expect(opened.calls).toEqual(["back"]);
    const linked = history();
    leaveAddEntry(null, linked);
    expect(linked.calls).toEqual(["replace /"]);
  });
});

describe("#16: the one plain screen a phone waits on after its sign-in", () => {
  const id = "a".repeat(32);
  const noTabsNoList = (html: string): void => {
    expect(shownOf(html)).not.toContain("data-tab=");
    expect(html).not.toContain("New PC added to your account");
    expect(html).not.toContain("Needs approval");
    expect(html).not.toContain("add-pc-sheet");
  };

  it("names the PC and what to press there while the join a launch asked waits, with the number when it shows one", () => {
    const waiting = render({ ...props({ kind: "connecting", name: "Mac", pairing: true }), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    expect(waiting).toContain('data-approval-wait="pc"');
    expect(waiting).toContain("Press [Allow] on Mac");
    expect(waiting).toContain("Or pair with a code");
    noTabsNoList(waiting);
    const first = render({ ...props({ kind: "compare", name: "Mac", digits: "123456", confirmed: true, alone: true, approveOn: "mac" }), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    expect(first).toContain("Press [Allow] on Mac");
    expect(first).toContain("123 456");
    // a PC that already has a member asks for the number typed on its own window
    const typed = render({ ...props({ kind: "compare", name: "Mac", digits: "123456", confirmed: true, alone: true }), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    expect(typed).toContain("Type this number on Mac");
    expect(typed).toContain("123 456");
  });

});

describe("#16 sweep, folded into My PCs: a signed-in front page with nothing on or nothing yet is My PCs, never a page of its own", () => {
  const id = "a".repeat(32);
  const mac = { server_id: id, name: "Mac", state: "offline" as const, last_seen_at: null, added_at: null, listed: true, paired: false, linked: false, join: { server_public_key: "k", relay: "wss://relay.example" } };
  const rows = (html: string) => [...html.matchAll(/<a class="relay-add-saved-pc" href="[^"]+">([\s\S]*?)<\/a>/g)].map(([, inner]) => inner!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " "));
  const signedIn = (pcs: MyPc[]) => ({ kind: "signed-in" as const, provider: "github" as const, error: null, pcs });
  const plain = (html: string): string | null => /data-approval-wait="([^"]+)"/.exec(html)?.[1] ?? null;
  const front = (state: RelayShellProps["state"], more: Partial<RelayShellProps> = {}) => render({ ...props(state), scoped: false, onSignIn: none, onWaitAgain: none, onFindPc: none, ...more });

  it("2: none of the account's PCs on lists them on My PCs as Off, with Check again (the sign-in's launch once more) over the list", () => {
    let asked = 0;
    const html = front({ kind: "empty", waitPc: true, offPc: "Mac", account: signedIn([mac]) }, { onWaitAgain: () => { asked += 1; } });
    expect(plain(html)).toBeNull();
    expect(html).toContain('data-view="my-pcs"');
    expect(rows(html)).toEqual(["Mac Relay Off"]);
    expect(html).toContain("data-none-online");
    expect(html.indexOf("Check again")).toBeLessThan(html.indexOf("relay-add-saved-pc"));
    expect(html).not.toContain("Sign in with the same account on the PC where Ovis runs");
    expect(asked).toBe(0);
  });

  it("3, 4: the PC this device opened is off (its relay too): My PCs lists it Off, under No PC is online with Check again", () => {
    const desk = { server_id: id, server_public_key: "k", relay: "wss://relay.example", name: "Desk", device_id: "0".repeat(16), label: "Phone" } as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
    const html = front({ kind: "list", devices: [desk], noneOnline: true, account: signedIn([]) }, { pcStatus: new Map([[id, { kind: "offline", reason: "pc" }]] as const) });
    expect(plain(html)).toBeNull();
    expect(html).toContain('data-view="my-pcs"');
    expect(rows(html)).toEqual(["Desk Relay Off"]);
    expect(html).toContain("No PC is online");
  });

  it("10: an account with no PC yet is My PCs with nothing listed, saying to sign in on the PC, and Add PC", () => {
    const html = front({ kind: "empty", account: signedIn([]) });
    expect(plain(html)).toBeNull();
    expect(html).toContain('data-view="my-pcs"');
    expect(rows(html)).toEqual([]);
    expect(html).toContain("Sign in with the same account on the PC where Ovis runs");
    expect(html).toContain('data-action="add-pc"');
    expect(shownOf(html)).not.toContain("data-tab=");
    expect(html).not.toContain("Other ways to connect");
  });

  it("13: a front page the person chose (Cancel, Back) is the same My PCs", () => {
    expect(front({ kind: "empty", account: signedIn([]) })).toContain('data-view="my-pcs"');
  });

  it("5, 9: the join a launch asked ends in one line: declined or removed with Ask again, the PC off with Check again", () => {
    const failed = (failure: string) => render({ ...props({ kind: "failed", failure, name: "Mac", detail: null, server_id: id } as RelayShellProps["state"]), sheetJoin: { mode: "join", server_id: id }, launchJoin: true });
    const declined = failed("pair-declined");
    expect(plain(declined)).toBe("declined");
    expect(declined).toContain("Not allowed. Ask again, then press [Allow] on Mac.");
    expect(declined).toContain('data-action="ask-again"');
    const unanswered = failed("pair-unanswered");
    expect(plain(unanswered)).toBe("unanswered");
    expect(unanswered).toContain("No answer from Mac");
    expect(unanswered).toContain('data-action="ask-again"');
    expect(unanswered).not.toContain("Not allowed");
    const removed = failed("revoked");
    expect(plain(removed)).toBe("removed");
    expect(removed).toContain("This device was removed from Mac. Ask again to join it.");
    // refused before anybody was asked (a PC in no account yet, one paused after too many tries): nobody declined it
    const refused = failed("pair-unavailable");
    expect(plain(refused)).toBe("refused");
    expect(refused).toContain("Mac cannot take this device yet");
    expect(refused).toContain('data-action="ask-again"');
    expect(refused).not.toContain("Not allowed");
    expect(refused).not.toContain("[Allow]");
    const off = failed("pc-offline");
    expect(plain(off)).toBe("off");
    expect(off).toContain('data-action="check-again"');
  });

  it("9: a signed-in device removed from a PC it had opened says so in one line, with Ask again", () => {
    const html = render({ ...props({ kind: "failed", failure: "revoked", name: "Mac", detail: null, server_id: id }), signedIn: true, onAskAgain: none });
    expect(plain(html)).toBe("removed");
    expect(html).toContain('data-action="ask-again"');
  });
});
