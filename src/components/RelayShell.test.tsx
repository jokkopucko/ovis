import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { AccountList } from "../lib/account/accountList.ts";
import { LIST_WRITE_WAITING_EVENT } from "../lib/account/listWrite.ts";
import type { MyPc } from "../lib/account/myPcs.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { signInLink } from "./ConnectPhoneDialog.tsx";
import { keyIdGroups } from "./KeyId.tsx";
import { AccountJoinRequests } from "./AccountJoinRequests.tsx";
import { ADD_PC_FROM_KEY } from "./MachineSidebar.tsx";
import { NewPcNotices } from "./NewPcNotices.tsx";
import { leaveAddEntry, RelayShell, type RelayShellProps } from "./RelayShell.tsx";
import { UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";

/** every tree a test draws, still mounted: the test's end unmounts each one, not only the last it kept */
const drawn = new Set<ReactTestRenderer>();
const create = (...args: Parameters<typeof createRenderer>): ReactTestRenderer => {
  const tree = createRenderer(...args);
  const unmount = tree.unmount.bind(tree);
  tree.unmount = () => { drawn.delete(tree); unmount(); };
  drawn.add(tree);
  return tree;
};

const EXPECTED = "0123456789abcdef0123456789abcdef";
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
const render = (shown: RelayShellProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
describe("the front page's account part", () => {
  // the dashboard is a page opened on purpose, by its address: a front page with none is Add a PC
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
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
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } });
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
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
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
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    let renderer: ReactTestRenderer | undefined;
    const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelector: () => null, querySelectorAll: () => [], getClientRects: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }), closest: () => null, addEventListener() {}, removeEventListener() {}, pauseAnimations() {}, unpauseAnimations() {} });

    beforeEach(() => {
      for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      const events = new EventTarget();
      const store = new Map<string, string>();
      const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
      const tab = new Map<string, string>();
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => tab.get(key) ?? null, setItem: (key: string, value: string) => { tab.set(key, value); }, removeItem: (key: string) => { tab.delete(key); }, key: () => null, length: 0, clear: () => tab.clear() } });
      const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      class HTMLElement { isConnected = true; focus(): void {} }
      class IntersectionObserver { observe(): void {} disconnect(): void {} }
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
      Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: IntersectionObserver });
      Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { href: "https://app.ovis.sh/", search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/" },
        history: { state: null, replaceState() {}, pushState() {}, back() {} },
        localStorage: storage, matchMedia, innerWidth: 1440,
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
        requestAnimationFrame: () => 1, cancelAnimationFrame() {},
        setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      } });
      Object.defineProperty(globalThis, "document", { configurable: true, value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [], createNodeMock: node },
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      } });
    });

    afterEach(async () => {
      // every tree goes, then what was left to run on a timer runs while this window is still here: a closed sheet (Add
      // a PC over My PCs) leaves its history entry a turn later (sheetHistory leaveSheet), whether it closed in the
      // test's last step or as its tree unmounted; run after the window went, it found another or none
      await act(async () => { for (const tree of [...drawn]) tree.unmount(); });
      renderer = undefined;
      await act(async () => { for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      descriptors.clear();
    });

    const mount = async (shown: RelayShellProps) => { await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }), { createNodeMock: node }); }); };
    const dialogs = () => renderer!.root.findAll((instance) => instance.props.role === "dialog");
    const dialog = () => { const found = dialogs(); if (found.length !== 1) throw new Error(`${found.length} dialogs`); return found[0]!; };
    const textOf = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : textOf(child)).join("");
    /** whether a node is on screen: no part it sits in is hidden (the pane the layout does not show stays mounted, hidden) */
    const shown = (node: ReactTestInstance): boolean => { for (let at: ReactTestInstance | null = node; at !== null; at = at.parent) if (at.props?.hidden === true) return false; return true; };
    const buttons = (label: string) => renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label && shown(node));
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
      const cards = () => renderer!.root.findAll((node) => node.props["data-testid"] === "list-allow-notice");
      const refusedElsewhere = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event(LIST_WRITE_WAITING_EVENT)); await Promise.resolve(); await Promise.resolve(); }); };
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: () => {} });
        expect(cards()).toHaveLength(0);
        // a Remove on this screen was refused because an earlier change still waits
        await refusedElsewhere();
        expect(cards().map(textOf).join("")).toContain("An earlier change is still waiting");
        // Cancel lets go of the request the card was put up for
        await act(async () => { button("Cancel").props.onClick(); await Promise.resolve(); await Promise.resolve(); });
        expect([calls, cards().length]).toEqual([[`cancel ${first.place.hash}`], 0]);
        // put up again; another change took the place meanwhile: Try again on this card sends nothing of it
        await refusedElsewhere();
        waits = { ...first, place: { seq: 4, hash: "cc".repeat(32) }, for: "remove-pc:x" };
        await act(async () => { button("Try again").props.onClick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect([calls, cards().length]).toEqual([[`cancel ${first.place.hash}`], 0]);
      } finally { setPageAccountList(null); }
    });

    describe("a pairing's step frame", () => {
      const offer = { v: 1 as const, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" };
      const backOf = (): ReactTestInstance[] => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "relay-step-back");
      const stepOf = (): unknown => renderer!.root.findAll((node) => node.type === "div" && node.props.className === "relay-step-progress")[0]?.props["data-step"] ?? null;

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
          expect(back.map((button) => button.props["aria-label"])).toEqual([label]);
          await act(async () => { back[0]!.props.onClick(); });
          expect(cancelled).toBe(1);
          expect(stepOf()).toBe(step);
          await act(async () => { renderer!.unmount(); });
        }
      });

      it("moves the focus to the heading when the press takes the focused button away", async () => {
        const focused: string[] = [];
        const nodes = (element: { type: unknown }) => element.type === "h1" ? { ...node(), focus: () => { focused.push("h1"); } } : node();
        const draw = (confirmed: boolean) => createElement(SettingsProvider, { children: createElement(RelayShell, props({ kind: "compare", name: "Desk", digits: "123456", confirmed })) });
        await act(async () => { renderer = create(draw(false), { createNodeMock: nodes as never }); });
        expect(focused).toEqual([]);
        Object.defineProperty(document, "activeElement", { configurable: true, value: null });
        await act(async () => { renderer!.update(draw(true)); });
        expect(focused).toEqual(["h1"]);
        expect(textOf(renderer!.root.find((n) => n.type === "h1"))).toBe("Approve on the PC if it shows the same number");
      });

      it("drops the round Back once this phone confirmed the digits, leaving the comparison's own Cancel", async () => {
        let cancelled = 0;
        await mount({ ...props({ kind: "compare", name: "Desk", digits: "123456", confirmed: true }), onCancel: () => { cancelled++; } });
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBe(2);
        await act(async () => { button("Cancel").props.onClick(); });
        expect(cancelled).toBe(1);
      });

      it("says the PC approved, on screen and to a screen reader, once the account steps go on", async () => {
        // the live region takes its words from the frame after it mounts (useAnnouncedText)
        (window as unknown as { requestAnimationFrame: (run: () => void) => number }).requestAnimationFrame = (run) => { run(); return 1; };
        await mount(props({ kind: "connecting", name: "Desk", approved: true, pairing: true }));
        const said = "Approved. Desk opens in a moment.";
        expect(renderer!.root.findAll((node) => node.type === "p" && node.props.className === "relay-shell-copy").map(textOf)).toEqual([said]);
        expect(textOf(renderer!.root.find((node) => node.props.role === "status" && node.props.className === "visually-hidden"))).toBe(said);
        const bar = renderer!.root.find((node) => node.props.role === "progressbar");
        expect([bar.props["aria-label"], bar.props["aria-valuetext"]]).toEqual(["Pair", "Step 3 of 3"]);
      });

      it("keeps the ready checkpoint on the card, offers no Back once the pairing failed, and draws the failure without a step", async () => {
        // a saved PC's enrollment retry reaches ready too: it is not drawn as a pairing step
        await mount(props({ kind: "ready", name: "Desk", server_id: EXPECTED, enrollment: "local" }));
        expect(renderer!.root.findAll((node) => node.props.className === "relay-step")).toEqual([]);
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBeNull();
        await act(async () => { renderer!.unmount(); });
        await mount(props({ kind: "failed", failure: "pair-declined", name: "Desk", detail: null, server_id: EXPECTED, pairing: true }));
        expect(backOf()).toEqual([]);
        expect(stepOf()).toBeNull();
      });

      it("keeps a saved PC opening again on the card: no steps, no sheep, its own Cancel", async () => {
        let cancelled = 0;
        await mount({ ...props({ kind: "connecting", name: "Desk" }), onCancel: () => { cancelled++; } });
        expect(renderer!.root.findAll((node) => node.props.className === "relay-step")).toEqual([]);
        expect(renderer!.root.findAll((node) => node.type === "span" && String(node.props.className).startsWith("sheep-"))).toEqual([]);
        await act(async () => { button("Cancel").props.onClick(); });
        expect(cancelled).toBe(1);
        await act(async () => { renderer!.unmount(); });
        await mount(props({ kind: "failed", failure: "pc-offline", name: "Desk", detail: null, server_id: EXPECTED }));
        expect(renderer!.root.findAll((node) => node.props.className === "relay-step")).toEqual([]);
        expect(renderer!.root.findAll((node) => node.type === "span" && String(node.props.className).startsWith("sheep-"))).toEqual([]);
      });
    });

    it("goes on in the sheet over the PC's own page for the join it started: the link's question, the digits, and the sheet's own Step 4 of 4 ready phase; a plain visit keeps the screens", async () => {
      const offer = { v: 1 as const, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" };
      let paired = 0;
      await mount({ ...props({ kind: "confirm", offer }), onPair: () => { paired += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("confirm");
      expect(renderer!.root.findAll((instance) => instance.type === "h1")).toHaveLength(0);
      await act(async () => { button("Pair").props.onClick(); });
      expect(paired).toBe(1);
      await act(async () => { renderer!.unmount(); });
      const typed: (string | undefined)[] = [];
      await mount({ ...props({ kind: "compare", name: "Mac mini", digits: "123456", confirmed: false, typed: true }), onMatch: (digits) => { typed.push(digits); }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("compare");
      const form = dialog().findByType("form");
      await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "123 456" }) } } }); });
      expect(typed).toEqual(["123456"]);
      await act(async () => { renderer!.unmount(); });
      let openedPc = 0;
      await mount({ ...props({ kind: "ready", name: "Mac mini", server_id: ids.mini }), onOpenPc: () => { openedPc += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      expect(dialog().props["data-add-pc-phase"]).toBe("ready");
      expect(dialog().findAll((n) => n.type === "div" && n.props.role === "progressbar").map((n) => n.props["aria-valuenow"])).toEqual([4]);
      expect(dialog().findAll((n) => n.type === "li").map((n) => n.props["data-step"])).toEqual(["done", "done", "done", "done"]);
      await act(async () => { button("Open PC").props.onClick(); });
      expect(openedPc).toBe(1);
      await act(async () => { renderer!.unmount(); });
      await mount({ ...props({ kind: "confirm", offer }), sheetJoin: { mode: "join", server_id: ids.desk } });
      expect(dialogs()).toHaveLength(0);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Pair with Mac mini?");
    });

    it("shows how the sheet's join failed in the sheet, with Try again, only for that PC, and suppresses raw close-code details in the RelayShell failure path", async () => {
      let retried = 0;
      const offline = { kind: "failed", failure: "pc-offline", name: "Mac mini", detail: "The relay closed the connection (0)" } as const;
      await mount({ ...props({ ...offline, server_id: ids.mini }), onRetry: () => { retried += 1; }, sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("failed");
      expect(textOf(dialog())).toContain("Machine offline");
      expect(textOf(dialog())).not.toContain("The relay closed the connection (0)");
      await act(async () => { button("Try again").props.onClick(); });
      expect(retried).toBe(1);
      await act(async () => { renderer!.unmount(); });
      for (const state of [{ ...offline, server_id: ids.desk }, offline]) {
        await mount({ ...props(state), sheetJoin: { mode: "join", server_id: ids.mini } });
        expect(dialogs()).toHaveLength(0);
        expect(textOf(renderer!.root.findByType("h1"))).toBe("Machine offline");
        expect(textOf(renderer!.root)).not.toContain("The relay closed the connection (0)");
        await act(async () => { renderer!.unmount(); });
      }
      await mount({ ...props({ kind: "failed", failure: "identity-changed", name: "Mac mini", detail: null, server_id: ids.mini }), sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialogs()).toHaveLength(0);
      expect(button("Forget this PC")).toBeDefined();
    });

    const one = (what: string, found: ReactTestInstance[]): ReactTestInstance => { if (found.length !== 1) throw new Error(`${found.length} ${what} on screen`); return found[0]!; };
    const tab = (way: string) => one(`${way} tabs`, renderer!.root.findAll((node) => node.type === "button" && node.props["data-tab"] === way && shown(node)));
    const panel = () => one("tab panels", renderer!.root.findAll((node) => node.type === "div" && typeof node.props["data-tab-panel"] === "string" && shown(node))).props["data-tab-panel"] as string;
    const views = () => renderer!.root.findAll((node) => node.type === "div" && typeof node.props["data-view"] === "string" && shown(node)).map((node) => node.props["data-view"] as string);
    const view = () => { const on = views(); if (on.length !== 1) throw new Error(`views on screen: ${on.join(", ")}`); return on[0]!; };
    const action = (name: string) => one(`${name} buttons`, renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === name && shown(node)));
    const back = () => renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Back" && shown(node));
    const title = () => textOf(one("h1 headings", renderer!.root.findAll((node) => node.type === "h1" && shown(node))));
    /** Add PC at the end of My PCs: the connect tabs, with Back to the list */
    const openAdd = async () => {
      expect(view()).toBe("my-pcs");
      await act(async () => { action("add-pc").props.onClick(); });
      expect(view()).toBe("add-pc");
      expect(title()).toBe("Add PC");
    };
    const rowTexts = () => renderer!.root.findAll((node) => node.type === "li" && typeof node.props["data-pc-way"] === "string" && shown(node)).map((node) => [node.props["data-pc-way"], textOf(node)]);
    /** where there is no scanner, the code is one small line that opens its field in place; its Pair hands the code on */
    const typeCode = async (code: string) => {
      const line = action("add-code");
      expect([line.props.className, line.props["aria-expanded"]]).toEqual(["connect-address-link", false]);
      expect(renderer!.root.findAll((node) => node.type === "input" && node.props.name === "code")).toHaveLength(0);
      await act(async () => { line.props.onClick(); });
      const form = renderer!.root.find((node) => node.type === "form" && node.props["data-code-form"] !== undefined);
      expect(form.findAll((node) => node.type === "button" && node.props.type === "submit").map(textOf)).toEqual(["Pair"]);
      await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: code }) } } }); });
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
      await act(async () => { tab("ssh").props.onClick(); });
      expect(panel()).toBe("ssh");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) })); });
      expect(view()).toBe("my-pcs");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedOut) })); });
      expect(title()).toBe("Connect a PC");
      expect(panel()).toBe("relay");
      expect(tab("relay").props["aria-pressed"]).toBe(true);
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
      expect(renderer!.root.findAll((node) => node.props["data-pc-way"] !== undefined && shown(node))).toHaveLength(0);
      await act(async () => { back()[0]!.props.onClick(); });
      expect(view()).toBe("my-pcs");
      await openAdd();
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...signedOut, state: { kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signing-in", provider: "github" } } }) })); });
      expect(view()).toBe("add-pc");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) })); });
      expect(view()).toBe("my-pcs");
      expect(rowTexts().map(([way]) => way)).toEqual(["relay", "relay", "relay", "relay"]);
    });

    it("opens a typed address from the Tailscale tab's field, and from the SSH tab's behind Add by address, each with Connect", async () => {
      const opened: string[] = [];
      (window.location as unknown as { assign: (href: string) => void }).assign = (href) => { opened.push(href); };
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      for (const [way, typed] of [["tailscale", "my-pc.tailnet.ts.net"], ["ssh", "https://my-pc.example.com"]] as const) {
        await act(async () => { tab(way).props.onClick(); });
        expect(panel()).toBe(way);
        if (way === "ssh") {
          // a browser has no SSH: the tab is Add by address alone, a text link to the field
          expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(0);
          await act(async () => { button("Add by address").props.onClick(); });
        }
        const fields = renderer!.root.findAll((node) => node.type === "input");
        expect(fields).toHaveLength(1);
        expect(renderer!.root.findAll((node) => node.type === "button" && node.props.className === "btn account-provider")).toHaveLength(0);
        const form = renderer!.root.find((node) => node.type === "form");
        await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: typed }) } } }); });
      }
      expect(opened).toEqual(["https://my-pc.tailnet.ts.net/", "https://my-pc.example.com/"]);
    });

    it("keeps a code typed in the relay tab's folded field through its lookup and a failure to correct, and its Cancel clears it", async () => {
      const calls: string[] = [];
      const draw = (shown: RelayShellProps) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, shown) })); });
      const front: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none,
        onCodeStart: () => { calls.push("start"); }, onCodeSubmit: (code) => { calls.push(`submit ${code}`); }, onCancel: () => { calls.push("cancel"); void draw(front); } };
      await mount(front);
      await typeCode("ABCDE-1234");
      expect(calls).toEqual(["start", "submit ABCDE-1234"]);
      const field = () => renderer!.root.find((node) => node.type === "form" && node.props["data-code-form"] !== undefined).findByType("input");
      // the field keeps its own open state, which a field mounted again would have lost (closed): so it is the same field
      const same = () => action("add-code").props["aria-expanded"] === true && field() !== undefined;
      // looking, then a failure the person can correct: the same field, still holding what was typed, on the same page
      await draw({ ...front, state: { kind: "code-looking" } });
      expect(same()).toBe(true);
      expect(view()).toBe("add-pc");
      expect(textOf(renderer!.root.find((node) => node.props["data-code-form"] !== undefined))).toContain("Looking for the PC…");
      await draw({ ...front, state: { kind: "code-entry", failure: "not-a-code" } });
      expect(view()).toBe("add-pc");
      expect(same()).toBe(true);
      expect(renderer!.root.findAll((node) => node.props.role === "alert").map(textOf)).toContain("A code has ten letters and digits, like 7K3QD-M2XHA.");
      // its Cancel ends the code, which brings the tabs back with the field closed
      await act(async () => { renderer!.root.find((node) => node.props["data-code-form"] !== undefined).find((node) => node.type === "button" && textOf(node) === "Cancel").props.onClick(); });
      expect(calls.at(-1)).toBe("cancel");
      expect(title()).toBe("Connect a PC");
      expect(renderer!.root.findAll((node) => node.props["data-code-form"] !== undefined)).toHaveLength(0);
      // a code found goes on to its own screen; back on the front page, the field is closed
      await typeCode("ABCDE-12345");
      await draw({ ...front, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } });
      expect(renderer!.root.findAllByType("h1").map(textOf)).toEqual(["Does Mac mini's screen show this ID?"]);
      await draw(front);
      expect(renderer!.root.findAll((node) => node.props["data-code-form"] !== undefined)).toHaveLength(0);
    });

    it("reads the account's PCs again when a notice changed them (a PC confirmed or removed), so Your PCs shows it at once", async () => {
      let refreshed = 0;
      await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onRefreshAccount: () => { refreshed += 1; } });
      expect(refreshed).toBe(0);
      await act(async () => { window.dispatchEvent(new Event("ovis:account-pcs-changed")); });
      expect(refreshed).toBe(1);
    });

    it("pairs with a code from Add PC's relay tab, signed in with no PC: the lookup in the field, the PC it found in the pairing dialog, over the tabs it closes back to", async () => {
      const calls: string[] = [];
      const draw = (shown: RelayShellProps) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, shown) })); });
      const shown: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none,
        onCodeStart: () => { calls.push("start"); }, onCodeSubmit: (code: string) => { calls.push(`submit ${code}`); }, onCancel: () => { calls.push("cancel"); void draw(shown); } };
      await mount(shown);
      await openAdd();
      expect(panel()).toBe("relay");
      // what to do on the PC comes first, the code under it
      const relayText = textOf(renderer!.root.find((node) => node.props["data-tab-panel"] === "relay"));
      expect(relayText.indexOf("Turn on Ovis on the PC and sign in with the same account.")).toBe(0);
      expect(relayText).toContain("Pair with a code");
      await typeCode("ABCDE-12345");
      expect(calls).toEqual(["start", "submit ABCDE-12345"]);
      await draw({ ...shown, state: { kind: "code-looking" } });
      expect(dialogs()).toHaveLength(0);
      await draw({ ...shown, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } });
      expect(dialog().props["data-pair-dialog"]).toBe("compare");
      await act(async () => { button("Cancel").props.onClick(); });
      expect(calls.at(-1)).toBe("cancel");
      expect(dialogs()).toHaveLength(0);
      expect(view()).toBe("add-pc");
      expect(renderer!.root.findAll((node) => node.props["data-code-form"] !== undefined)).toHaveLength(0);
    });

    it("opens an account with no PC yet on My PCs' empty state, whose Add PC opens the tabs and comes back to it", async () => {
      await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none });
      expect(renderer!.root.findAll((node) => node.props["data-approval-wait"] !== undefined)).toHaveLength(0);
      expect(textOf(renderer!.root.find((node) => node.props["data-view"] === "my-pcs"))).toContain("Sign in with the same account on the PC where Ovis runs");
      await openAdd();
      await act(async () => { back()[0]!.props.onClick(); });
      expect(view()).toBe("my-pcs");
    });

    it("tells of the account's news on My PCs (a new PC with its one-tap removal, a join request, a PC to confirm), and not on Add PC's tabs", async () => {
      await mount(signedIn(four()));
      const notices = () => [NewPcNotices, AccountJoinRequests, UnconfirmedPcNotices].map((type) => renderer!.root.findAllByType(type as never).filter(shown).length);
      expect(notices()).toEqual([1, 1, 1]);
      await openAdd();
      expect(notices()).toEqual([0, 0, 0]);
    });

    it("keeps My PCs and Add a PC side by side on a wide screen: the list on the left, the tabs always open on the right, no Add PC button", async () => {
      wide();
      await mount(signedIn(four()));
      expect(renderer!.root.findAll((node) => node.type === "div" && typeof node.props["data-view"] === "string").map((node) => node.props["data-view"])).toEqual(["my-pcs", "add-pc"]);
      expect(renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "add-pc")).toHaveLength(0);
      expect(renderer!.root.findAllByType("h1").map(textOf)).toEqual(["Your PCs"]);
      expect(renderer!.root.findAllByType("h2").map(textOf)).toContain("Add PC");
      expect(back()).toHaveLength(0);
      expect(panel()).toBe("relay");
      await act(async () => { tab("ssh").props.onClick(); });
      expect(panel()).toBe("ssh");
      expect(rowTexts()).toHaveLength(4);
    });

    it("keeps Connect a PC one centred card on a wide screen, signed out with nothing saved here", async () => {
      wide();
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      expect(renderer!.root.findAll((node) => node.type === "div" && typeof node.props["data-view"] === "string").map((node) => [node.props["data-view"], node.props.className])).toEqual([["add-pc", "connect-add connect-add-front"]]);
      expect(title()).toBe("Connect a PC");
    });

    it("finds a PC by name past eight, says so when none matches, and on a wide screen keeps to the PCs on or off", async () => {
      const search = () => renderer!.root.findAll((node) => node.type === "input" && node.props.type === "search");
      const listed = (count: number, extra: Partial<RelayShellProps> = {}) => ({ ...props({ kind: "list", devices: many(count), account: { kind: "signed-in", provider: "github", error: null, pcs: [] } }), scoped: false, onSignIn: none, ...extra }) satisfies RelayShellProps;
      await mount(listed(8));
      expect(search()).toHaveLength(0);
      await act(async () => { renderer!.unmount(); });
      const off = new Map(many(9).filter((_, index) => index % 2 === 1).map((pc) => [pc.server_id, { kind: "offline", reason: "pc" } as const]));
      await mount(listed(9, { pcStatus: off }));
      expect(search().map((node) => node.props["aria-label"])).toEqual(["Search PC names"]);
      // no chips on a phone
      expect(renderer!.root.findAll((node) => node.type === "button" && node.props["data-show"] !== undefined)).toHaveLength(0);
      await act(async () => { search()[0]!.props.onChange({ currentTarget: { value: "PC-1" }, target: { value: "PC-1" } }); });
      expect(rowTexts().map(([, text]) => text.split("Relay")[0])).toEqual(["pc-1"]);
      await act(async () => { search()[0]!.props.onChange({ currentTarget: { value: "zzz" }, target: { value: "zzz" } }); });
      expect(rowTexts()).toHaveLength(0);
      expect(textOf(renderer!.root.find((node) => node.props["data-view"] === "my-pcs"))).toContain("No PC matches.");
      await act(async () => { renderer!.unmount(); });
      wide();
      await mount(listed(9, { pcStatus: off }));
      const chips = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-show"] !== undefined);
      expect(chips().map((node) => [textOf(node), node.props["aria-pressed"]])).toEqual([["All", true], ["On", false], ["Off", false]]);
      await act(async () => { chips()[2]!.props.onClick(); });
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
          await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc" && shown(node)).props.onClick(); });
          const status = () => renderer!.root.findAll((node) => node.props["data-opening"] !== undefined && shown(node));
          if (canCancel) {
            expect(status().map(textOf)).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
            await act(async () => { status()[0]!.find((node) => node.type === "button").props.onClick(); });
            expect(status()).toHaveLength(0);
            expect(called).toContain("HerdrShell.cancelOpen");
          } else {
            // iOS has no way to stop an open: the status says what it opens, with nothing to press
            expect(status().map(textOf)).toEqual(["Opening desk.tail1e211e.ts.net…"]);
            await act(async () => { opened.resolve({}); await opened.promise; });
            expect(status()).toHaveLength(0);
            expect(called).not.toContain("HerdrShell.cancelOpen");
          }
          await act(async () => { renderer!.unmount(); });
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
      const row = (way: string) => renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === way && shown(node)).find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc");
      const status = () => renderer!.root.findAll((node) => node.props["data-opening"] !== undefined && shown(node)).map(textOf);
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { row("tailscale").props.onClick(); });
        // the tap says so at once, while the app is asked whether Tailscale is on
        expect(status()).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
        expect(opens()).toEqual([]);
        await act(async () => { row("address").props.onClick(); });
        expect(opens()).toEqual(["HerdrShell.open http://192.168.0.5:7317/"]);
        expect(status()).toEqual(["Opening 192.168.0.5:7317…Cancel"]);
        await act(async () => { tailscale.resolve({ on: true }); await tailscale.promise; });
        expect(opens()).toEqual(["HerdrShell.open http://192.168.0.5:7317/"]);
        // while one opens, another tap opens nothing
        await act(async () => { row("tailscale").props.onClick(); });
        expect(opens()).toHaveLength(1);
        expect(called.filter((call) => call === "HerdrShell.tailscale")).toHaveLength(1);
        await act(async () => { renderer!.unmount(); });
        expect(called).toContain("HerdrShell.cancelOpen");
        // leaving while the app is asked: its late answer opens nothing
        tailscale = Promise.withResolvers<{ on?: boolean }>();
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { row("tailscale").props.onClick(); });
        await act(async () => { renderer!.unmount(); });
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
          await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc" && shown(node)).props.onClick(); });
          const settled = () => called.some((call) => call.startsWith("HerdrShell.open ")) || renderer!.root.findAll((node) => node.props.role === "alert" && shown(node)).length > 0;
          // bounded: an app that never answers is taken as on once the short wait is over
          const deadline = Date.now() + 4_000;
          while (!settled()) {
            if (Date.now() > deadline) throw new Error(`${mode}: the open neither went ahead nor said why`);
            await act(async () => { await Promise.race([new Promise(() => {}), Bun.sleep(25)]); });
          }
          expect(renderer!.root.findAll((node) => node.props["data-tailscale-off"] !== undefined)).toHaveLength(0);
          if (mode === "no-open") {
            expect(renderer!.root.findAll((node) => node.props.role === "alert" && shown(node)).map(textOf)).toContain("This app cannot open a PC by its address. Update the Ovis app.");
            expect(called.some((call) => call.startsWith("HerdrShell.open "))).toBe(false);
          } else expect(called).toContain("HerdrShell.open https://desk.tail1e211e.ts.net/");
          await act(async () => { renderer!.unmount(); });
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
        await act(async () => { renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "address").find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
        await act(async () => { tab("tailscale").props.onClick(); });
        const form = renderer!.root.find((node) => node.props["data-tab-panel"] === "tailscale").findByType("form");
        await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "other.tail1e211e.ts.net" }) } } }); });
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual(["HerdrShell.open http://192.168.0.5:7317/"]);
        const status = () => renderer!.root.findAll((node) => node.props["data-opening"] !== undefined).map(textOf);
        expect(status()).toEqual(["Opening 192.168.0.5:7317…Cancel", "Opening 192.168.0.5:7317…Cancel"]);
        // either Cancel stops the one open
        await act(async () => { renderer!.root.find((node) => node.props["data-tab-panel"] === "tailscale").find((node) => node.props["data-opening"] !== undefined).findByType("button").props.onClick(); });
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
          await act(async () => { action("approval-wait-qr").props.onClick(); });
          await act(async () => { await Promise.resolve(); });
          expect(renderer!.root.findAll((node) => node.props["data-opening"] !== undefined).map(textOf)).toEqual(["Opening desk.tail1e211e.ts.net…Cancel"]);
          await act(async () => { renderer!.unmount(); });
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
        const alerts = () => renderer!.root.findAll((node) => node.props.role === "alert").map(textOf);
        expect(alerts().join(" ")).toContain("Another app on this phone took the address the SSH PC opens on (127.0.0.1:41234)");
        await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
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
        window.dispatchEvent(new Event(off ? "offline" : "online"));
      };
      const alerts = () => renderer!.root.findAll((node) => node.props.role === "alert" && shown(node)).map(textOf);
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
          expect(textOf(renderer!.root)).not.toContain("account service");
          // the account's PC it listed last stays, by its page, and the PC the app saved by its Tailscale address
          const relay = renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "relay").find((node) => node.type === "a");
          expect(relay.props.href).toBe(`/s/${ids.mac}/`);
          expect(textOf(relay)).toBe("hasang-uui-MacBookPro" + "Relay");
          // a tap says the phone is offline: no name that was not found, no Tailscale that may be off
          let held = 0;
          await act(async () => { relay.props.onClick({ preventDefault: () => { held++; } }); });
          expect(held).toBe(1);
          expect(alerts()).toContain("Connect this phone to the internet to open the PC.");
          const tailscale = () => renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "tailscale").find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc");
          await act(async () => { tailscale().props.onClick(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open ") || call === "HerdrShell.tailscale")).toEqual([]);
          expect(alerts().filter((text) => text.includes("not found") || text.includes("Tailscale may be off"))).toEqual([]);
          // Try again reads it all again
          await act(async () => { renderer!.root.find((node) => node.type === "button" && textOf(node) === "Try again" && shown(node)).props.onClick(); });
          expect([refreshed, checked, called.filter((call) => call === "HerdrShell.getState").length]).toEqual([1, 1, 2]);

          // the network back: the line goes, and the screen reads the account, the app's PCs and the relay's again by itself
          await act(async () => { offline(false); });
          expect(alerts().filter((text) => text.includes("internet"))).toEqual([]);
          expect([refreshed, checked, called.filter((call) => call === "HerdrShell.getState").length]).toEqual([2, 2, 3]);
          // online, the account's own failure says so again, as before
          expect(alerts()).toContain(`${unreached} Try again`);

          // an open the network dropped under says the phone went offline, not why the PC did not answer
          await act(async () => { tailscale().props.onClick(); });
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
          await act(async () => { renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "tailscale").find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
          expect(renderer!.root.findAll((node) => node.props["data-opening"] !== undefined && shown(node))).toHaveLength(1);
          (navigator as { onLine?: boolean }).onLine = false;
          await act(async () => { tailscale.resolve({ on: true }); await tailscale.promise; });
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
          expect(renderer!.root.findAll((node) => node.props["data-opening"] !== undefined && shown(node))).toHaveLength(0);
          expect(alerts()).toContain("Connect this phone to the internet to open the PC.");
        } finally {
          (navigator as { onLine?: boolean }).onLine = true;
          if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
          else Reflect.deleteProperty(globalThis, "Capacitor");
        }
      });

      it("believes the account service over a WebView that says offline: its answer takes the line away and a row opens, asked again on each open", async () => {
        // a Galaxy Z Flip6's WebView said navigator.onLine === false all along on working Wi-Fi (app 1.0.7)
        const meta = { getAttribute: (name: string) => name === "content" ? "https://account.example" : null };
        Object.assign(document, { querySelector: (selector: string) => selector === 'meta[name="ovis-account-service"]' ? meta : null });
        const asks: { readonly url: string; readonly answer: ReturnType<typeof Promise.withResolvers<Response>> }[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(async (input: Request | string | URL): Promise<Response> => {
          const answer = Promise.withResolvers<Response>();
          asks.push({ url: String(input), answer });
          return await answer.promise;
        }, { preconnect: realFetch.preconnect });
        const settle = async (ask: { readonly answer: ReturnType<typeof Promise.withResolvers<Response>> }, answered: boolean): Promise<void> => {
          await act(async () => {
            if (answered) ask.answer.resolve(new Response(null, { status: 200 }));
            else ask.answer.reject(new TypeError("Failed to fetch"));
            await ask.answer.promise.catch(() => undefined);
            for (let turn = 0; turn < 3; turn++) await Promise.resolve();
          });
        };
        const relayRow = () => renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "relay").find((node) => node.type === "a");
        const assigned: string[] = [];
        Object.assign(window.location, { assign: (href: string) => { assigned.push(href); } });
        try {
          offline(true);
          await mount(offlinePage());
          // the screen asks on its own as it starts watching; no answer: the device is offline, as before
          expect(asks.map((ask) => ask.url)).toEqual(["https://account.example/v1/providers"]);
          await settle(asks[0]!, false);
          expect(alerts()).toEqual(["This device is not connected to the internet. Try again"]);
          // Try again asks again, and its answer takes the line away
          await act(async () => { renderer!.root.find((node) => node.type === "button" && textOf(node) === "Try again" && shown(node)).props.onClick(); });
          expect(asks).toHaveLength(2);
          await settle(asks[1]!, true);
          expect(alerts().filter((text) => text.includes("internet"))).toEqual([]);
          // a tap asks once more rather than trusting that answer, and goes to the PC's page once it answers
          let held = 0;
          await act(async () => { relayRow().props.onClick({ preventDefault: () => { held++; } }); });
          expect([held, asks.length, assigned]).toEqual([1, 3, []]);
          await settle(asks[2]!, true);
          expect(assigned).toEqual([`/s/${ids.mac}/`]);
          // the network gone since, with the flag still false: the next tap's ask goes unanswered, and the row says so
          await act(async () => { relayRow().props.onClick({ preventDefault: () => { held++; } }); });
          await settle(asks[3]!, false);
          expect(assigned).toHaveLength(1);
          expect(alerts()).toContain("Connect this device to the internet to open the PC.");
        } finally {
          globalThis.fetch = realFetch;
          offline(false);
        }
      });

      it("says this device, in a browser, and opens nothing while it is offline", async () => {
        offline(true);
        try {
          await mount(offlinePage());
          expect(alerts()).toEqual(["This device is not connected to the internet. Try again"]);
          let held = 0;
          await act(async () => { renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "relay").find((node) => node.type === "a").props.onClick({ preventDefault: () => { held++; } }); });
          expect(held).toBe(1);
          expect(alerts()).toContain("Connect this device to the internet to open the PC.");
          // online, a row opens its page as before
          await act(async () => { offline(false); });
          await act(async () => { renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "relay").find((node) => node.type === "a").props.onClick({ preventDefault: () => { held++; } }); });
          expect(held).toBe(1);
        } finally {
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
          const backs = renderer!.root.findAll((node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("Back to "));
          expect(backs.length).toBe(canGoBack ? 1 : 0);
          if (canGoBack) {
            await act(async () => { backs[0]!.props.onClick(); });
            expect(called).toContain("HerdrShell.backToCurrent");
          }
          await act(async () => { renderer!.unmount(); });
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
        await act(async () => { renderer!.unmount(); });
        // one whose getState never settles: the controls once the short wait is over, and a late answer lists its PCs
        Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: app(["getState", "open"]) });
        await mount(signedOut);
        expect(asked).toBe(1);
        expect(renderer!.root.findAll((node) => typeof node.props["data-view"] === "string")).toHaveLength(0);
        // the wait is bounded: the controls come by themselves well within it
        const deadline = Date.now() + 5_000;
        while (renderer!.root.findAll((node) => typeof node.props["data-view"] === "string").length === 0) {
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
        await act(async () => { renderer!.unmount(); });
        let backed = 0;
        await mount({ ...props({ kind: "empty" }), onBack: () => { backed += 1; } });
        expect(view()).toBe("add-pc");
        await act(async () => { back()[0]!.props.onClick(); });
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
      const tracking = (element: { type: unknown; props: Record<string, unknown> }) => ({ ...node(), focus: () => { focused.push(element.type === "button" ? String(element.props["data-action"] ?? element.props["aria-label"]) : String(element.type)); } });
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) }), { createNodeMock: tracking as never }); });
      expect(pushed).toHaveLength(0);
      await act(async () => { action("add-pc").props.onClick(); });
      expect(view()).toBe("add-pc");
      expect(pushed).toHaveLength(1);
      expect(focused.at(-1)).toBe("h1");
      await act(async () => { back()[0]!.props.onClick(); });
      expect(view()).toBe("my-pcs");
      expect(focused.at(-1)).toBe("add-pc");
      // a tab is no step of the history
      await act(async () => { action("add-pc").props.onClick(); });
      await act(async () => { tab("ssh").props.onClick(); });
      expect(pushed).toHaveLength(2);
    });

    it("keeps the code line beside the QR way in the phone app, signed out and signed in, both held while a sign-in is under way", async () => {
      const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => "android",
        PluginHeaders: [{ name: "CapacitorBarcodeScanner", methods: [{ name: "scanBarcode" }] }],
        nativePromise: async () => ({}),
      } });
      const ways = () => [action("scan-qr"), action("add-code")].map((node) => [node.props["data-action"], node.props.disabled === true]);
      try {
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(ways()).toEqual([["scan-qr", false], ["add-code", false]]);
        await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...props({ kind: "empty", account: { kind: "signing-in", provider: "google" } }), scoped: false, onSignIn: none }) })); });
        expect(ways()).toEqual([["scan-qr", true], ["add-code", true]]);
        await act(async () => { renderer!.unmount(); });
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
          await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
          const card = () => renderer!.root.findAll((node) => node.props["data-tailscale-off"] !== undefined);
          if (on) {
            expect(card()).toHaveLength(0);
            expect(called).toContain("HerdrShell.open https://desk.tail1e211e.ts.net/");
          } else {
            expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
            expect(called.some((call) => call.startsWith("HerdrShell.open "))).toBe(false);
            await act(async () => { card()[0]!.find((node) => node.type === "button").props.onClick(); });
            expect(called).toContain("HerdrShell.openTailscale");
          }
          await act(async () => { renderer!.unmount(); });
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
        const search = () => one("searches", renderer!.root.findAll((node) => node.type === "input" && node.props.type === "search"));
        await act(async () => { search().props.onChange({ currentTarget: { value: "192" }, target: { value: "192" } }); });
        await act(async () => { renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === "address").find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
        await openAdd();
        await act(async () => { tab("ssh").props.onClick(); });
        await act(async () => { screen.set(true); });
        expect(views()).toEqual(["my-pcs", "add-pc"]);
        expect(panel()).toBe("ssh");
        expect(search().props.value).toBe("192");
        await act(async () => { screen.set(false); });
        expect(view()).toBe("add-pc");
        expect(panel()).toBe("ssh");
        // nothing was mounted again: the open goes on, never cancelled by the move
        expect(renderer!.root.findAll((node) => node.props["data-opening"] !== undefined && shown(node)).map(textOf)).toEqual(["Opening 192.168.0.5:7317…Cancel"]);
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
      const draw = (shown_: RelayShellProps) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, shown_) })); });
      const front: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onCancel: () => { void draw(front); } };
      await mount(front);
      await openAdd();
      expect(pushed).toHaveLength(1);
      await act(async () => { screen.set(true); });
      await typeCode("ABCDE-12345");
      await draw({ ...front, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } });
      expect(dialog().props["data-pair-dialog"]).toBe("compare");
      await act(async () => { screen.set(false); });
      expect(pushed).toHaveLength(1);
      await act(async () => { button("Cancel").props.onClick(); });
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
        const backs = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Back to this PC" && shown(node));
        expect(backs).toHaveLength(1);
        await act(async () => { backs[0]!.props.onClick(); });
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
        expect(renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Back to Laptop" && shown(node))).toHaveLength(1);
      } finally {
        if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });

    it("says a failed sign-in once on a wide screen, beside the sign-in it can try again", async () => {
      wide();
      await mount({ ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: "The sign-in did not finish." } }), scoped: false, onSignIn: none });
      const alerts = renderer!.root.findAll((node) => node.props.role === "alert" && shown(node) && textOf(node).includes("The sign-in did not finish."));
      expect(alerts).toHaveLength(1);
      expect(renderer!.root.find((node) => node.props["data-view"] === "add-pc").findAll((node) => node === alerts[0])).toHaveLength(1);
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
    const statusShown = () => renderer!.root.findAll((node) => node.props["data-opening"] !== undefined && shown(node)).map(textOf);
    const savedRow = (way: string) => renderer!.root.find((node) => node.type === "li" && node.props["data-pc-way"] === way).find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc");

    it("keeps an open the person started in view when they go on to Add PC: its status follows, and only then does the app open it", async () => {
      await withApp(async () => {
        const tailscale = Promise.withResolvers<{ on?: boolean }>();
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "cancelOpen"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net"], names: {} } : method === "tailscale" ? tailscale.promise : method === "open" ? new Promise(() => {}) : {});
        await mount(signedIn(four()));
        await act(async () => { savedRow("tailscale").props.onClick(); });
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
        await act(async () => { action("scan-qr").props.onClick(); });
        await act(async () => { tab("ssh").props.onClick(); });
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
        await act(async () => { tab("tailscale").props.onClick(); });
        const form = renderer!.root.find((node) => node.props["data-tab-panel"] === "tailscale").findByType("form");
        await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: "other.tail1e211e.ts.net" }) } } }); });
        await act(async () => { tab("ssh").props.onClick(); });
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
          const rows = () => renderer!.root.findAll((node) => node.type === "li" && node.props["data-pc-way"] === "address").map((node) => node.find((each) => each.type === "button" && each.props.className === "relay-add-saved-pc"));
          await act(async () => { rows()[0]!.props.onClick(); });
          expect(statusShown()).toEqual(["Opening 192.168.0.5:7317…"]);
          await act(async () => { rows()[1]!.props.onClick(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open"))).toHaveLength(1);
          await act(async () => { jest.advanceTimersByTime(30_000); });
          expect(statusShown()).toEqual([]);
          expect(renderer!.root.findAll((node) => node.props.role === "alert" && shown(node)).map(textOf).join(" ")).toContain("192.168.0.5:7317 did not answer within 20 seconds.");
          await act(async () => { rows()[1]!.props.onClick(); });
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
        await act(async () => { tab("tailscale").props.onClick(); });
        const asked = () => called.filter((call) => call === "HerdrShell.tailscale").length;
        expect(asked()).toBe(1);
        await act(async () => { back()[0]!.props.onClick(); });
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(asked()).toBe(1);
        await openAdd();
        // on screen again: asked once, and again when the app comes back
        expect(asked()).toBe(2);
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(asked()).toBe(3);
      });
    });

    it("ends a code's lookup when the person leaves it: folding its field, Add PC's Back, another tab, the comparison's Cancel or a sign-in, after which its result changes nothing", async () => {
      const compare = { kind: "code-compare" as const, offer: { v: 1 as const, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } };
      // folding its field, Add PC's Back, another tab
      const leave: (() => Promise<void>)[] = [
        async () => { await act(async () => { action("add-code").props.onClick(); }); },
        async () => { await act(async () => { back()[0]!.props.onClick(); }); },
        async () => { await act(async () => { tab("tailscale").props.onClick(); }); },
      ];
      for (const go of leave) {
        const calls: string[] = [];
        const draw = (shown_: RelayShellProps) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, shown_) })); });
        const page: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onCancel: () => { calls.push("cancel"); } };
        await mount(page);
        await openAdd();
        await typeCode("ABCDE-12345");
        await draw({ ...page, state: { kind: "code-looking" } });
        // the field is read-only while it looks
        expect(renderer!.root.find((node) => node.type === "input" && node.props.name === "code").props.readOnly).toBe(true);
        await go();
        expect(calls).toEqual(["cancel"]);
        // the shell, cancelled, reads the front page again
        await draw(page);
        // a result that arrives after: nothing opens over the page
        await draw({ ...page, state: compare });
        expect(dialogs()).toHaveLength(0);
        await draw(page);
        await act(async () => { renderer!.unmount(); });
      }
      // the comparison's Cancel, while the front page the shell reads again is still on its way: the dialog stays closed
      const calls: string[] = [];
      const page: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-in", provider: "google", error: null, pcs: [] } }), scoped: false, onSignIn: none, onCancel: () => { calls.push("cancel"); } };
      await mount(page);
      await openAdd();
      await typeCode("ABCDE-12345");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...page, state: compare }) })); });
      expect(dialog().props["data-pair-dialog"]).toBe("compare");
      await act(async () => { button("Cancel").props.onClick(); });
      expect(calls).toEqual(["cancel"]);
      expect(dialogs()).toHaveLength(0);
      await act(async () => { renderer!.unmount(); });
      // a sign-in started over a failed code ends the code first
      const signed: string[] = [];
      const out: RelayShellProps = { ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: () => { signed.push("sign-in"); }, onCancel: () => { signed.push("cancel"); } };
      await mount(out);
      await typeCode("x");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...out, state: { kind: "code-entry", failure: "not-a-code" } }) })); });
      expect(renderer!.root.find((node) => node.type === "input" && node.props.name === "code").props.readOnly).toBe(false);
      await act(async () => { button("Continue with GitHub").props.onClick(); });
      expect(signed).toEqual(["cancel", "sign-in"]);
    });

    it("moves the focus to Add PC's title when Add PC opens it, never when the window narrows under it", async () => {
      screen.install();
      screen.set(false);
      const focused: string[] = [];
      const tracking = (element: { type: unknown; props: Record<string, unknown> }) => ({ ...node(), focus: () => { focused.push(element.type === "button" ? String(element.props["data-action"] ?? element.props["aria-label"]) : String(element.type)); } });
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) }), { createNodeMock: tracking as never }); });
      await act(async () => { action("add-pc").props.onClick(); });
      expect(focused.filter((each) => each === "h1")).toHaveLength(1);
      await act(async () => { screen.set(true); });
      await act(async () => { screen.set(false); });
      expect(focused.filter((each) => each === "h1")).toHaveLength(1);
    });

    it("keeps a failed sign-in in view on another tab, on a wide screen and on a phone, said once", async () => {
      const failing = { ...props({ kind: "list", devices: [device(ids.desk, "p620", AP)], account: { kind: "signed-out", error: "The sign-in did not finish." } }), scoped: false, onSignIn: none } satisfies RelayShellProps;
      const said = () => renderer!.root.findAll((node) => node.props.role === "alert" && shown(node) && textOf(node).includes("The sign-in did not finish.")).length;
      wide();
      await mount(failing);
      expect(said()).toBe(1);
      await act(async () => { tab("tailscale").props.onClick(); });
      expect(said()).toBe(1);
      await act(async () => { renderer!.unmount(); });
      screen.set(false);
      await mount(failing);
      expect(said()).toBe(1);
      await openAdd();
      expect(said()).toBe(1);
      await act(async () => { tab("ssh").props.onClick(); });
      expect(said()).toBe(1);
    });

    it("never says Needs approval: an account PC this device is not let into yet is On or Off like any other", async () => {
      await mount(signedIn(four()));
      expect(rowTexts()).toEqual([["relay", "Desk PCRelayOn"], ["relay", "MacBookRelay"], ["relay", "Home serverRelayOff"], ["relay", "Mac miniRelayOn"]]);
      expect(textOf(renderer!.root)).not.toContain("Needs approval");
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
        expect(renderer!.root.find((node) => node.type === "a" && node.props.className === "relay-add-saved-pc").props.href).toBe(`/s/${ids.mac}/`);
        const rows = () => renderer!.root.findAll((node) => node.type === "li" && node.props["data-pc-way"] !== "relay" && typeof node.props["data-pc-way"] === "string");
        for (const [index, opens] of ["https://desk.tail1e211e.ts.net/", "http://192.168.0.5:7317/", "http://127.0.0.1:41234/"].entries()) {
          await act(async () => { rows()[index]!.find((node) => node.type === "button" && node.props.className === "relay-add-saved-pc").props.onClick(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open")).at(-1)).toBe(`HerdrShell.open ${opens}`);
        }
        await act(async () => { action("account-menu").props.onClick(); });
        await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-item"] === "forget-pcs").props.onClick(); });
        const deskRow = renderer!.root.find((node) => node.type === "li" && node.props["data-tailnet-pc"] === "https://desk.tail1e211e.ts.net");
        await act(async () => { deskRow.find((node) => node.type === "button" && node.props["data-action"] === "forget-pc").props.onClick(); });
        expect(called).toContain("HerdrShell.forget https://desk.tail1e211e.ts.net");
        expect(called.filter((call) => call === "HerdrShell.getState")).toHaveLength(2);
        await act(async () => { action("forget-done").props.onClick(); });
        await openAdd();
        for (const way of ["tailscale", "ssh"]) {
          await act(async () => { tab(way).props.onClick(); });
          expect(renderer!.root.findAll((node) => node.props["data-pc-way"] !== undefined && shown(node))).toHaveLength(0);
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
        expect(renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "add-code")).toHaveLength(1);
        await act(async () => { action("scan-qr").props.onClick(); });
        expect(assigned).toEqual([`https://app.ovis.sh/s/${ids.mini}/#offer=abc`]);
        await act(async () => { tab("tailscale").props.onClick(); });
        expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(1);
        expect(renderer!.root.findAll((node) => node.props["data-tailnet-pc"] !== undefined && shown(node))).toHaveLength(0);
        await act(async () => { renderer!.unmount(); });
        tailscaleOn = false;
        await mount(page);
        await openAdd();
        await act(async () => { tab("tailscale").props.onClick(); });
        // a home Wi-Fi address opens without Tailscale: its field stays, under the card
        const tailscalePanel = renderer!.root.find((node) => node.props["data-tab-panel"] === "tailscale");
        const [card, field] = [tailscalePanel.find((node) => node.props["data-tailscale-off"] !== undefined), tailscalePanel.find((node) => node.type === "input")];
        const order = tailscalePanel.findAll((node) => node === card || node === field);
        expect(order).toEqual([card, field]);
        await act(async () => { button("Open Tailscale").props.onClick(); });
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
          await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-action"] === "scan-qr").props.onClick(); });
          return renderer!.root.findAll((node) => node.props.role === "alert").map(textOf).join("");
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
      const sshField = () => renderer!.root.find((node) => node.type === "input" && node.props.name === "address");
      const submitSsh = async (typed: string) => {
        const form = renderer!.root.find((node) => node.type === "form");
        await act(async () => { form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: { namedItem: () => ({ value: typed }) } } }); });
      };
      await mount(shown);
      await openAdd();
      await act(async () => { tab("ssh").props.onClick(); });
      expect(renderer!.root.findAll((node) => node.type === "input")).toHaveLength(0);
      expect(button("Add by address").props.className).toBe("connect-address-link");
      await act(async () => { renderer!.unmount(); });
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
        await act(async () => { tab("ssh").props.onClick(); });
        expect(textOf(renderer!.root.find((node) => node.type === "label"))).toBe("SSH");
        expect(sshField().props.placeholder).toBe("user@host");
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
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-entry", failure: "no-pc" } }) })); });
      expect(view()).toBe("add-pc");
      expect(renderer!.root.findAll((node) => node.type === "input" && node.props.name === "code")).toHaveLength(1);
      // Cancel: back on Add PC, whose Back is the list that still goes back to the PC
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, shown) })); });
      expect(view()).toBe("add-pc");
      await act(async () => { back()[0]!.props.onClick(); });
      expect(view()).toBe("my-pcs");
      expect(back()).toHaveLength(1);
    });

    it("takes a code typed in /#add's Add PC on to the pairing dialog once it found its PC, signed in too", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const shown = { ...signedIn(four()), addEntry: true };
      await mount(shown);
      await openAdd();
      await typeCode("ABCDE-12345");
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...shown, state: { kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, code: "ABCDE-12345", name: "Mac mini" } } }) })); });
      expect(dialog().props["data-pair-dialog"]).toBe("compare");
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
      await act(async () => { back()[0]!.props.onClick(); });
      expect(went).toEqual(["back"]);
      // the front page it leaves for is My PCs, with no Back and no mark, and never the dashboard
      expect(back()).toHaveLength(0);
      expect(title()).toBe("Your PCs");
      expect(rowTexts().map(([, text]) => text)).toContain("Home serverRelayOff");
    });

    const forgets = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "forget-pc" && shown(node));
    const openers = () => renderer!.root.findAll((node) => (node.type === "a" || node.type === "button") && node.props.className === "relay-add-saved-pc" && shown(node));
    const forgetPcs = async () => {
      await act(async () => { action("account-menu").props.onClick(); });
      await act(async () => { renderer!.root.find((node) => node.type === "button" && node.props["data-item"] === "forget-pcs").props.onClick(); });
    };

    it("carries no Forget on a row; the menu's Forget PCs, signed out too, puts Forget in place of each forgettable row's chevron, opens no row, and Done ends it", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317", "http://127.0.0.1:41234"], names: { "https://desk.tail1e211e.ts.net": "Desk", "http://127.0.0.1:41234": "lab-linux" } } : {});
        const forgot: string[] = [];
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "MacBook", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: (serverId) => { forgot.push(serverId); } });
        // nothing to forget by mistake on a row, whose name has the row to itself
        expect(renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Forget" && shown(node))).toHaveLength(0);
        expect(openers()).toHaveLength(4);
        await forgetPcs();
        // the SSH PC goes from the app's own screen, with its keys: no Forget here, as before
        expect(forgets().map((node) => node.props["aria-label"])).toEqual(["Forget MacBook", "Forget Desk", "Forget 192.168.0.5:7317"]);
        expect(openers()).toHaveLength(0);
        expect(renderer!.root.findAll((node) => node.props.className === "relay-shell-pc-glyph" && shown(node))).toHaveLength(0);
        // what Forget does stays as it was, row by row
        await act(async () => { forgets()[0]!.props.onClick(); });
        await act(async () => { forgets()[1]!.props.onClick(); });
        expect(forgot).toEqual([ids.mac]);
        expect(called).toContain("HerdrShell.forget https://desk.tail1e211e.ts.net");
        await act(async () => { action("forget-done").props.onClick(); });
        expect(forgets()).toHaveLength(0);
        expect(openers()).toHaveLength(4);
        expect(renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "add-pc" && shown(node))).toHaveLength(1);
      });
    });

    it("asks once more, in the row, before it forgets the PC in use, and offers no Forget PCs with nothing to forget", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net", "http://192.168.0.5:7317"], names: { "https://desk.tail1e211e.ts.net": "Desk" }, choosing: true, current: "http://192.168.0.5:7317" } : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await forgetPcs();
        const inUse = () => forgets().find((node) => node.props["aria-label"] === "Forget 192.168.0.5:7317")!;
        const ask = () => renderer!.root.findAll((node) => node.props["data-forget-ask"] !== undefined && shown(node));
        await act(async () => { inUse().props.onClick(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([]);
        expect(ask().map(textOf)).toEqual(["This is the PC in use now. Forget it?ForgetCancel"]);
        await act(async () => { ask()[0]!.findAll((node) => node.type === "button").find((node) => textOf(node) === "Cancel")!.props.onClick(); });
        expect(ask()).toHaveLength(0);
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([]);
        await act(async () => { inUse().props.onClick(); });
        await act(async () => { ask()[0]!.findAll((node) => node.type === "button").find((node) => textOf(node) === "Forget")!.props.onClick(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual(["HerdrShell.forget http://192.168.0.5:7317"]);
        await act(async () => { renderer!.unmount(); });
        // only an SSH PC saved: nothing this screen forgets, so no menu signed out
        app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) => method === "getState" ? { saved: ["http://127.0.0.1:41234"], names: {} } : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        expect(view()).toBe("my-pcs");
        expect(renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "account-menu" && shown(node))).toHaveLength(0);
      });
    });

    it("says, in Forget PCs, in Forget's place, why a row has none: an account PC, an SSH PC", async () => {
      await withApp(async () => {
        app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net", "http://127.0.0.1:41234"], names: { "http://127.0.0.1:41234": "lab-linux" } } : {});
        const mac = pc(ids.mac, "hasang-uui-MacBookPro", "paired", { paired: false, linked: false, last_seen_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } });
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs: [mac] } }), scoped: false, onSignIn: none });
        const reasons = () => renderer!.root.findAll((node) => node.props["data-kept"] !== undefined && shown(node)).map((node) => [node.props["data-kept"], textOf(node)]);
        expect(reasons()).toEqual([]);
        await forgetPcs();
        expect(forgets().map((node) => node.props["aria-label"])).toEqual(["Forget desk"]);
        // in Forget's place, in a few words: the row keeps its height
        expect(reasons()).toEqual([["account", "Account PC"], ["ssh", "SSH PC"]]);
        expect(renderer!.root.findAll((node) => node.props["data-kept"] !== undefined && shown(node)).map((node) => node.parent?.props.className)).toEqual(["my-pc", "my-pc"]);
      });
    });

    it("claims no account PC is on while the account cannot be read", async () => {
      const mac = pc(ids.mac, "hasang-uui-MacBookPro", "paired", { paired: false, linked: false, last_seen_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } });
      const page = (error: string | null) => ({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error, pcs: [mac] } }), scoped: false, onSignIn: none });
      await mount(page(null));
      expect(rowTexts()).toEqual([["relay", "hasang-uui-MacBookProRelayOn"]]);
      await act(async () => { renderer!.unmount(); });
      await mount(page("The account service could not be reached. The PCs this device is paired with still work."));
      expect(rowTexts()).toEqual([["relay", "hasang-uui-MacBookProRelay"]]);
    });

    const lines = () => renderer!.root.findAll((node) => node.props["data-way-line"] !== undefined && shown(node)).map((line) => {
      const after = line.parent!.children.slice(line.parent!.children.indexOf(line) + 1).find((next) => typeof next !== "string" && (next.type === "button" || next.props["data-kept"] !== undefined || next.type === "span"));
      const end = after === undefined || typeof after === "string" ? "" : after.type === "button" ? textOf(after) : textOf(after);
      return [line.props["data-way-line"], textOf(line), end];
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
        expect(openers()[0]!.type).toBe("a");
        expect(openers()[0]!.props.href).toBe(`/s/${ids.mac}/`);
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
        expect(openers()[0]!.props.href).toBe(`/s/${ids.mac}/`);
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
        expect(forgets().map((node) => node.props["aria-label"])).toEqual(["Forget hasang-uui-MacBookPro · Relay", "Forget hasang-uui-MacBookPro · Tailscale"]);
        await act(async () => { forgets()[1]!.props.onClick(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.forget"))).toEqual([`HerdrShell.forget ${tail}`]);
        expect(forgot).toEqual([]);
        await act(async () => { forgets()[0]!.props.onClick(); });
        expect(forgot).toEqual([ids.mac]);
        await act(async () => { renderer!.unmount(); });

        // relay pairing + SSH: the SSH way goes from the app's own screen, with its keys
        called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: [sshMac], names: {}, ids: { [sshMac]: ids.mac } } : {});
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        await forgetPcs();
        expect(lines()).toEqual([["relay", "Relay", "Forget"], ["ssh", "SSH127.0.0.1:47317", "SSH PC"]]);
        await act(async () => { renderer!.unmount(); });

        // an account PC + Tailscale address: the account's way says so, the address is forgotten on its own
        called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : {});
        const mac = pc(ids.mac, "hasang-uui-MacBookPro", "paired", { paired: false, linked: false, last_seen_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } });
        await mount({ ...props({ kind: "empty", account: { kind: "signed-in", provider: "github", error: null, pcs: [mac] } }), scoped: false, onSignIn: none });
        await forgetPcs();
        expect(lines()).toEqual([["relay", "Relay", "Account PC"], ["tailscale", "Tailscalemacbookpro.tail1e211e.ts.net:17317", "Forget"]]);
        await act(async () => { forgets()[0]!.props.onClick(); });
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
        await act(async () => { forgets()[1]!.props.onClick(); });
        // no question for one way of a PC not in use, and only that way goes
        expect(renderer!.root.findAll((node) => node.props["data-forget-ask"] !== undefined && shown(node))).toHaveLength(0);
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
        const ask = () => renderer!.root.findAll((node) => node.props["data-forget-ask"] !== undefined && shown(node));
        await act(async () => { forgets()[0]!.props.onClick(); });
        expect(ask().map(textOf)).toEqual(["This is the PC in use now. Forget it?ForgetCancel"]);
        expect(forgot).toEqual([]);
        await act(async () => { ask()[0]!.findAll((node) => node.type === "button").find((node) => textOf(node) === "Forget")!.props.onClick(); });
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
        await act(async () => { openers()[0]!.props.onClick(); });
        await act(async () => { await Promise.resolve(); });
        const offer = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "open-other-way" && shown(node));
        // it names the host it opens, whole: the person sees what answers, not only that it is "the PC at its address"
        expect(offer().map((node) => [node.props["aria-label"], textOf(node)])).toEqual([["Open 192.168.0.5:7317 (Address)", "AddressOpen 192.168.0.5:7317"]]);
        await act(async () => { offer()[0]!.props.onClick(); });
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${tail}/`, `HerdrShell.open ${lan}/`]);
        await act(async () => { renderer!.unmount(); });

        // the relay PC's own page, whose open over the relay failed: the Tailscale address the app saved it by
        const again = app([{ name: "HerdrShell", methods: ["getState", "open"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "failed", failure: "pc-offline", name: "hasang-uui-MacBookPro", detail: null, server_id: ids.mac }) });
        await act(async () => { await Promise.resolve(); });
        expect(offer().map((node) => [node.props["aria-label"], textOf(node)])).toEqual([["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"]]);
        await act(async () => { offer()[0]!.props.onClick(); });
        expect(again.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${tail}/`]);
        await act(async () => { renderer!.unmount(); });
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
        const offer = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "open-other-way" && shown(node));
        const card = () => renderer!.root.findAll((node) => node.props["data-tailscale-off"] !== undefined && shown(node));
        const settle = async () => { for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); }); };
        // the relay PC's own page, whose open over the relay failed, offers the Tailscale address the app saved it by
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "openTailscale"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : method === "tailscale" ? { on: false } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "failed", failure: "pc-offline", name: "hasang-uui-MacBookPro", detail: null, server_id: ids.mac }) });
        await settle();
        expect(card()).toHaveLength(0);
        await act(async () => { offer()[0]!.props.onClick(); });
        await settle();
        // as a Tailscale row of My PCs does with Tailscale off: the line and Open Tailscale, nothing opened
        expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
        await act(async () => { card()[0]!.find((node) => node.type === "button").props.onClick(); });
        expect(called).toContain("HerdrShell.openTailscale");
        await act(async () => { renderer!.unmount(); });

        // My PCs: a row of two saved ways opens by the one that loaded last; that open fails, and the Tailscale way it offers meets Tailscale off
        const again = app([{ name: "HerdrShell", methods: ["getState", "open", "tailscale", "openTailscale"] }], (method, options) =>
          method === "getState" ? { saved: [lan, tail], names: {}, ids: { [tail]: ids.mac, [lan]: ids.mac } } : method === "tailscale" ? { on: false }
            : method === "open" && options.url === `${lan}/` ? Promise.reject(Object.assign(new Error("unknown-host"), { code: "unknown-host" })) : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
        await act(async () => { openers()[0]!.props.onClick(); });
        await settle();
        expect(offer().map((node) => node.props["aria-label"])).toEqual(["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)"]);
        await act(async () => { offer()[0]!.props.onClick(); });
        await settle();
        expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
        expect(again.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${lan}/`]);
      });
    });

    const moreWays = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "more-ways" && shown(node));
    const wayButtons = () => renderer!.root.findAll((node) => node.type === "button" && node.props["data-action"] === "open-other-way" && shown(node));
    const wayLines = () => wayButtons().map((node) => [node.props["aria-label"], textOf(node)]);

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
          expect(moreWays().map((node) => [node.props["aria-label"], node.props["aria-expanded"]])).toEqual([["More ways to open hasang-uui-MacBookPro", false]]);
          expect(wayLines()).toEqual([]);
          // what it controls is there while closed too, hidden
          const controlled = () => renderer!.root.findAll((node) => typeof node.type === "string" && node.props.id === moreWays()[0]!.props["aria-controls"]).map((node) => node.props.hidden);
          expect(controlled()).toEqual([true]);
          // the row's own tap is still the relay's page
          expect(openers()[0]!.type).toBe("a");
          expect(openers()[0]!.props.href).toBe(`/s/${ids.mac}/`);
          await act(async () => { moreWays()[0]!.props.onClick(); });
          expect(moreWays()[0]!.props["aria-expanded"]).toBe(true);
          expect(controlled()).toEqual([false]);
          // each other way, one to a line: its tag and the host it opens, whole, in its accessible name too
          expect(wayLines()).toEqual([
            ["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"],
            ["Open 192.168.0.5:7317 (Address)", "AddressOpen 192.168.0.5:7317"],
          ]);
          // opening the list opens nothing; the relay row keeps its name, its way tags and where it leads
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
          expect(openers()[0]!.props.href).toBe(`/s/${ids.mac}/`);
          await act(async () => { wayButtons()[1]!.props.onClick(); });
          expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([`HerdrShell.open ${lan}/`]);
          // closed again, the rows read as they did
          await act(async () => { moreWays()[0]!.props.onClick(); });
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
        await act(async () => { moreWays()[0]!.props.onClick(); });
        expect(wayLines()).toEqual([["Open macbookpro.tail1e211e.ts.net:17317 (Tailscale)", "TailscaleOpen macbookpro.tail1e211e.ts.net:17317"]]);
        await act(async () => { wayButtons()[0]!.props.onClick(); });
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
        await act(async () => { moreWays()[0]!.props.onClick(); });
        expect(wayLines()).toEqual([["Open 192.168.0.5:7317 (Address)", "AddressOpen 192.168.0.5:7317"]]);
        await act(async () => { openers()[0]!.props.onClick(); });
        expect(called).toContain("HerdrShell.backToCurrent");
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
      });
    });

    it("ends a More ways line's open of a Tailscale address in the Tailscale-off card while the phone's Tailscale is off, as a Tailscale row does", async () => {
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "forget", "tailscale", "openTailscale"] }], (method) =>
          method === "getState" ? { saved: [tail], names: {}, ids: { [tail]: ids.mac } } : method === "tailscale" ? { on: false } : method === "open" ? new Promise(() => {}) : {});
        await mount({ ...props({ kind: "list", devices: [device(ids.mac, "hasang-uui-MacBookPro", AP)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onForgetSaved: none });
        const card = () => renderer!.root.findAll((node) => node.props["data-tailscale-off"] !== undefined && shown(node));
        await act(async () => { moreWays()[0]!.props.onClick(); });
        await act(async () => { wayButtons()[0]!.props.onClick(); });
        for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); });
        expect(card().map(textOf)).toEqual(["Turn on Tailscale to connectOpen Tailscale"]);
        expect(called.filter((call) => call.startsWith("HerdrShell.open "))).toEqual([]);
      });
    });

    it("offers Forget PCs in the signed-in menu too", async () => {
      await mount({ ...signedIn(four()), onForgetSaved: none });
      await forgetPcs();
      expect(forgets().map((node) => node.props["aria-label"])).toEqual(["Forget Desk PC", "Forget MacBook", "Forget Home server"]);
    });

    it("goes back to the PC in use when its row is tapped, as Back does, rather than opening that PC again", async () => {
      (window.location as { hash?: string }).hash = "#add";
      const went: string[] = [];
      (window.history as { back: () => void }).back = () => { went.push("back"); };
      sessionStorage.setItem(ADD_PC_FROM_KEY, `/s/${ids.home}/`);
      await mount({ ...signedIn(four()), addEntry: true });
      const inUse = () => renderer!.root.find((node) => node.type === "li" && textOf(node).includes("In use now")).find((node) => node.props.className === "relay-add-saved-pc");
      expect(inUse().type).toBe("button");
      await act(async () => { inUse().props.onClick(); });
      expect(went).toEqual(["back"]);
      await act(async () => { renderer!.unmount(); });
      // the PC the phone app keeps open while the person chooses another: back to it
      (window.location as { hash?: string }).hash = "";
      await withApp(async () => {
        const called = app([{ name: "HerdrShell", methods: ["getState", "open", "backToCurrent"] }], (method) =>
          method === "getState" ? { saved: ["https://desk.tail1e211e.ts.net"], names: { "https://desk.tail1e211e.ts.net": "Desk" }, choosing: true, current: "https://desk.tail1e211e.ts.net" } : {});
        await mount(signedIn(four()));
        await act(async () => { inUse().props.onClick(); });
        expect(called).toContain("HerdrShell.backToCurrent");
        expect(called.filter((call) => call.startsWith("HerdrShell.open"))).toEqual([]);
      });
    });

    it("says over the signed-out relay tab's sign-in what an account gives, and under its ways in that Tailscale and SSH need none", async () => {
      await mount({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      const relay = textOf(renderer!.root.find((node) => node.props["data-tab-panel"] === "relay"));
      const at = (words: string) => relay.indexOf(words);
      expect(at("Reach your PCs from anywhere with your Ovis account")).toBeGreaterThanOrEqual(0);
      expect(at("Reach your PCs from anywhere with your Ovis account")).toBeLessThan(at("Continue with GitHub"));
      expect(at("Tailscale and SSH need no sign-in.")).toBeGreaterThan(at("Pair with a code"));
      await act(async () => { renderer!.unmount(); });
      // signed in, neither: there is no sign-in to explain
      await mount(signedIn(four()));
      await openAdd();
      const signedInRelay = textOf(renderer!.root.find((node) => node.props["data-tab-panel"] === "relay"));
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
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
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
  let windowBefore: PropertyDescriptor | undefined;
  beforeEach(() => { windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window"); Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "" } } }); });
  afterEach(() => { if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window"); });
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
