import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MyPc } from "../lib/account/myPcs.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { keyIdGroups } from "./KeyId.tsx";
import { RelayShell, type RelayShellProps } from "./RelayShell.tsx";

const EXPECTED = "0123456789abcdef0123456789abcdef";
/** the same id but for its third and last groups */
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
/** The dashboard's table row for the PC named `name`, as rendered. */
const rowOf = (html: string, name: string): string => {
  const row = [...html.matchAll(/<tr[^>]*data-pc-state="[^"]+"[^>]*>[\s\S]*?<\/tr>/g)].map((m) => m[0]).find((r) => r.includes(`>${name}</span>`) || r.includes(`>${name}</b>`));
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};
/** The labels of the buttons and button-styled links in a piece of markup. */
const actionsOf = (html: string): string[] => [...html.matchAll(/<(?:a|button)[^>]*class="btn[^"]*"[^>]*>([\s\S]*?)<\/(?:a|button)>/g)].map(([, inner]) => inner!.replace(/<[^>]+>/g, ""));
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
  const pc = (server_id: string, name: string, state: "paired" | "needs-approval" | "offline" | "needs-update", paired = state === "paired") => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired });

  it("offers GitHub alone until the service is set up for Apple", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Apple");
  });

  const saved = (server_id: string, name: string) => ({ server_id, server_public_key: "k", relay: "wss://relay.example", name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const signInAlternatives = (html: string) => [...html.matchAll(/<button type="button" class="(?:btn account-continue-saved|btn btn-ghost account-link)"[^>]*>([^<]+)</g)].map(([, label]) => label);

  it("opens on the sign-in alone: GitHub and Apple alike, under one title, with only the pairing link below", () => {
    const html = render({ ...props({ kind: "empty", account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-account-state="signed-out"');
    const buttons = [...html.matchAll(/<button type="button" class="([^"]+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?(Continue with [^<]+)</g)].map(([, kind, label]) => [kind, label]);
    expect(buttons).toEqual([["btn account-provider", "Continue with GitHub"], ["btn account-provider", "Continue with Apple"]]);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(signInAlternatives(html)).toEqual(["Pair with a QR or code"]);
    expect(html.indexOf("Continue with Apple")).toBeLessThan(html.indexOf("Pair with a QR or code"));
    expect(html.indexOf("Pair with a QR or code")).toBeLessThan(html.indexOf("The account only lists your PCs."));
    expect(html).not.toContain("relay-shell-pc");
    expect(html).not.toContain("Scan the QR code on your PC");
  });

  it("keeps saved PCs off the sign-in, directly under the providers before the divider, counted", () => {
    const two = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(two).toContain("Continue with GitHub");
    expect(two).toContain('data-action="continue-local"');
    expect(signInAlternatives(two)).toEqual(["Continue without an account (2 PCs)", "Pair with a QR or code"]);
    expect(two.indexOf("Continue without an account (2 PCs)")).toBeLessThan(two.indexOf("account-divider"));
    expect(two.indexOf("account-divider")).toBeLessThan(two.indexOf("Pair with a QR or code"));
    expect(two).not.toContain("relay-shell-pc");
    expect(two).not.toContain("p620");
    expect(two).not.toContain("<details");
    const one = render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
    expect(signInAlternatives(one)).toEqual(["Continue without an account (1 PC)", "Pair with a QR or code"]);
    // without an account service there is no sign-in: the saved PCs are the page itself
    expect(render({ ...props({ kind: "list", devices: [saved("a".repeat(32), "p620")] }), scoped: false })).toContain(`href="/s/${"a".repeat(32)}/"`);
  });

  it("returns to the sign-in after sign-out, the pairings kept behind its button", () => {
    const devices = [saved("a".repeat(32), "p620"), saved("b".repeat(32), "nuc")];
    const signedIn = render({ ...props({ kind: "list", devices, account: { kind: "signed-in", provider: "github", error: null, pcs: [pc("a".repeat(32), "p620", "paired")] } }), scoped: false, onSignIn: none, onSignOut: none });
    expect(signedIn).toContain("Sign out");
    // what shell.tsx's signOut shows: the same saved PCs, the account signed out
    const after = render({ ...props({ kind: "list", devices, account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none, onSignOut: none });
    expect(after).toContain("Sign in to Ovis");
    expect(after).not.toContain("Sign out");
    expect(after).not.toContain("relay-shell-pc");
    expect(signInAlternatives(after)).toEqual(["Continue without an account (2 PCs)", "Pair with a QR or code"]);
  });

  it("opens a pairing link straight into pairing, without the sign-in", () => {
    const html = render({ ...props({ kind: "confirm", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", name: "Desk" } }), scoped: false, onSignIn: none, accountProviders: ["github", "apple"] });
    expect(html).toContain('data-relay-state="confirm"');
    expect(html).toContain("Pair with Desk?");
    expect(html).not.toContain("Continue with GitHub");
    expect(html).not.toContain("Sign in to Ovis");
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
    expect(text).toContain("laptopOfflineThe PC is off, or Ovis is not running on it.");
    expect(html.indexOf("Check now")).toBeLessThan(html.indexOf("home"));
    // a check stops before signing in: the PC answering is all it knows, never that this device is connected
    expect(text).not.toContain("Connected");
    // signed in, the dashboard's row for a ready PC keeps Ready as the directory state until Check now is pressed (V-023)
    const signedIn = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [pc("a".repeat(32), "home", "paired")] } }), scoped: false, onSignIn: none, pcStatus, onCheckPcs: none });
    const row = rowOf(signedIn, "home").replace(/<[^>]+>/g, "");
    expect(row).toContain("Ready");
    expect(row).not.toContain("This device: answered");
    expect(signedIn).toContain("Check now");
  });

  it("never says a PC paired by QR before the sign-in is in the account: leaving the account does not reach that pairing", () => {
    const unlinked = { ...pc("f".repeat(32), "qrbox", "paired"), linked: false };
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [unlinked] } }), scoped: false, onSignIn: none });
    const row = rowOf(html, "qrbox").replace(/<[^>]+>/g, "");
    expect(row).toContain("not in the account yet");
    expect(row).not.toContain("in your account");
  });

  it("offers Add for a PC new in the account, Join for an older one that has not approved this device, and Details for one with no way to join", () => {
    const fresh = { ...pc("b".repeat(32), "desk2", "needs-approval"), added_at: new Date().toISOString(), join: { server_public_key: "k", relay: "wss://relay.example" } };
    const old = { ...fresh, server_id: "c".repeat(32), name: "nuc", added_at: new Date(Date.now() - 3_600_000).toISOString() };
    const { join: _join, ...waiting } = { ...old, server_id: "d".repeat(32), name: "attic" };
    // the directory's last-seen time is stale until the PC's next mailbox pull, so an offline row it may still be joined through keeps Join
    const stale = { ...old, server_id: "e".repeat(32), name: "cabin", state: "offline" as const };
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null, pcs: [fresh, old, waiting, stale] } }), scoped: false, onSignIn: none, onJoin: none });
    expect(actionsOf(rowOf(html, "cabin"))).toEqual(["Join"]);
    expect(actionsOf(rowOf(html, "desk2"))).toEqual(["Add"]);
    expect(rowOf(html, "desk2")).toContain("new · 10 min left");
    expect(actionsOf(rowOf(html, "nuc"))).toEqual(["Join"]);
    expect(actionsOf(rowOf(html, "attic"))).toEqual(["Details"]);
    // the attention list names the waiting PCs without a redundant top notice banner (V-040)
    expect(html).not.toContain("relay-dash-notice");
    expect(html).toContain('class="relay-overview-attention"');
    expect(html).not.toContain("Add desk2 to your account?");
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

  it("opens a paired PC and routes an offline or unpaired PC to Details instead of a doomed connection", () => {
    const html = render({ ...props({ kind: "list", devices: [], account: { kind: "signed-in", provider: "github", error: null,
      pcs: [pc("a".repeat(32), "p620", "paired"), pc("b".repeat(32), "nuc", "needs-approval"), pc("c".repeat(32), "old-desktop", "offline", false), pc("d".repeat(32), "laptop", "offline", true)] } }), scoped: false, onSignIn: none });
    expect(html).toContain(`href="/s/${"a".repeat(32)}/"`);
    expect(html).not.toContain(`href="/s/${"b".repeat(32)}/"`);
    // offline rows open in-page Details (button), never an anchor to /s/<id>/ (V-015)
    expect(html).not.toContain(`href="/s/${"c".repeat(32)}/"`);
    expect(html).not.toContain(`href="/s/${"d".repeat(32)}/"`);
    expect(actionsOf(rowOf(html, "laptop"))).toEqual(["Details"]);
    expect(html).toContain("Needs you");
    expect(html).not.toContain("Continue with GitHub");
  });

});

describe("the dashboard", () => {
  const pc = (server_id: string, name: string, state: MyPc["state"], over: Partial<MyPc> = {}): MyPc => ({ server_id, name, state, last_seen_at: null, added_at: null, listed: true, paired: state === "paired", linked: true, ...over });
  const device = (server_id: string, name: string, relay: string) => ({ server_id, server_public_key: "k", relay, name, device_id: "0".repeat(16), label: "Phone" }) as unknown as Extract<RelayShellProps["state"], { kind: "list" }>["devices"][number];
  const AP = "wss://relay-ap.ovis.sh";
  const GLOBAL = "wss://relay.ovis.sh";
  const ids = { desk: "a".repeat(32), mac: "b".repeat(32), mini: "c".repeat(32), home: "d".repeat(32) };
  /** Four PCs: one ready, one unchecked QR pairing, one waiting, and one offline. */
  const four = (): MyPc[] => [
    pc(ids.desk, "Desk PC", "paired", { last_seen_at: new Date().toISOString() }),
    pc(ids.mac, "MacBook", "paired", { listed: false, linked: false }),
    pc(ids.mini, "Mac mini", "needs-approval", { last_seen_at: new Date().toISOString(), added_at: new Date().toISOString(), join: { server_public_key: "k", relay: AP } }),
    pc(ids.home, "Home server", "offline", { paired: true, last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString() }),
  ];
  const devices = () => [device(ids.desk, "Desk PC", AP), device(ids.mac, "MacBook", AP), device(ids.home, "Home server", GLOBAL)];
  const signedIn = (pcs: MyPc[] | null, extra: Partial<RelayShellProps> = {}): RelayShellProps => ({ ...props({ kind: "list", devices: devices(), account: { kind: "signed-in", provider: "github", error: null, pcs } }), scoped: false, onSignIn: none, onJoin: none, onSignOut: none, onLeave: none, ...extra });
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  it("sums the model into the strip: counts, relays in the map's order with their kind, and what needs attention", () => {
    const html = render(signedIn(four()));
    expect(html).toContain('data-dashboard-mode="account"');
    // IS-FRAME-06: no subtitle in the page header (the count lives in the strip and sidebar)
    expect(html).not.toContain("relay-dash-sub");
    const counts = [...html.matchAll(/data-strip-cell="(\w+)"[^>]*data-strip-count="(\d+)"[\s\S]*?<span class="relay-overview-strip-label"><svg[\s\S]*?<\/svg><span>([^<]+)<\/span><\/span>/g)].map(([, cell, n, label]) => [cell, label, Number(n)]);
    expect(counts).toEqual([["ready", "Ready", 1], ["needs", "Needs you", 2], ["relays", "Relays in use", 2]]);
    const relays = [...html.matchAll(/<button type="button" class="pill relay-overview-relay-chip">([^<]+)<\/button><span class="relay-overview-relay-count">([^<]+)<\/span><span class="relay-overview-relay-scope">([^<]+)<\/span>/g)].map(([, host, n, kind]) => [host, n, kind]);
    expect(relays).toEqual([["relay-ap.ovis.sh", "3 PCs", "regional"], ["relay.ovis.sh", "1 PC", "global"]]);
    const attention = [...html.matchAll(/<span class="relay-overview-attention-name"[^>]*>([^<]+)<\/span><span class="relay-overview-attention-why">([^<]+)<\/span>/g)].map(([, name, why]) => [name, why]);
    expect(attention).toEqual([["Mac mini", "new · 10 min left"], ["Home server", "offline since 20 h"]]);
    // Overview ends with the Connection map disclosure to #relay; the nav counts the PCs
    expect(html).not.toContain('data-slot="relay-map"');
    expect(html).toContain('class="relay-overview-map-disclosure"');
    expect(html).toContain('<span class="relay-dash-nav-count">4</span>');
  });

  it("places a Connection map disclosure after the table on Overview, draws the full map on #relay, and omits both for an empty account", () => {
    const overview = render(signedIn(four()));
    expect(overview).not.toContain('data-slot="relay-map"');
    expect(overview.indexOf('class="relay-overview-strip"')).toBeLessThan(overview.indexOf('id="relay-dash-pcs"'));
    expect(overview.indexOf('id="relay-dash-pcs"')).toBeLessThan(overview.indexOf('class="relay-overview-map-disclosure"'));
    const prevWin = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hash: "#relay" } } });
    try {
      const relayHtml = render(signedIn(four()));
      const map = /<section class="relay-dash-map" data-slot="relay-map"[\s\S]*?<\/section>/.exec(relayHtml)?.[0] ?? "";
      expect(text(map)).toContain("Connection map");
      expect(map).toMatch(/<svg class="relay-map-svg" viewBox="[^"]+" role="img" aria-label="Connection map: This device\. Relays: relay-ap\.ovis\.sh, relay\.ovis\.sh\. PCs: 4\. Seen lately: 1\. Ready: 1\. Needs you: 2\. Offline: 1\."/);
      expect(map).toContain('class="relay-map-routes"');
    } finally {
      if (prevWin) Object.defineProperty(globalThis, "window", prevWin);
      else Reflect.deleteProperty(globalThis, "window");
    }
    const empty = render(signedIn([]));
    expect(empty).not.toContain('role="img"');
    expect(empty).not.toContain("relay-map");
  });

  it("gives each row its state, relay, last seen and the one action its state allows", () => {
    const html = render(signedIn(four()));
    expect(text(rowOf(html, "Desk PC"))).toContain("Ready");
    expect(text(rowOf(html, "Desk PC"))).toContain("just now");
    expect(actionsOf(rowOf(html, "Desk PC"))).toEqual(["Open"]);
    expect(rowOf(html, "Desk PC")).toContain(`href="/s/${ids.desk}/"`);
    expect(text(rowOf(html, "MacBook"))).toContain("Paired · not checked");
    expect(text(rowOf(html, "MacBook"))).toContain("—");
    expect(actionsOf(rowOf(html, "Mac mini"))).toEqual(["Add"]);
    expect(rowOf(html, "Home server")).toContain('data-pc-state="offline"');
    expect(actionsOf(rowOf(html, "Home server"))).toEqual(["Details"]);
    expect(rowOf(html, "Home server")).not.toContain(`href="/s/${ids.home}/"`);
    expect(text(rowOf(html, "Home server"))).toContain("20 h ago");
    // the Relay cell: the directory's relay for the PC this device cannot check, Not checked for the paired ones until a check ran
    const routes = [...html.matchAll(/<td class="relay-dash-relay relay-pc-cell-relay">([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell ?? ""));
    expect(routes).toEqual(["relay-ap.ovis.sh", "Not checked", "Not checked", "Not checked"]);
    // an offline PC this device is not paired with offers Details when it has no join route, and the directory's relay wins over the pairing's
    const unpaired = render(signedIn([pc(ids.home, "Home server", "offline")], { directoryRelays: [{ server_id: ids.home, relay: AP }] }));
    expect(actionsOf(rowOf(unpaired, "Home server"))).toEqual(["Details"]);
    expect(rowOf(unpaired, "Home server")).toContain("relay-ap.ovis.sh");
  });

  it("keeps Offline in the row of a PC the directory has not seen lately until this device's own check answers, which reads Ready with its route, and shows the probe line only after explicit Check now", () => {
    const answered = { kind: "answered", route: "relay", rttMs: 13 } as const;
    const html = render(signedIn(four(), { pcStatus: new Map([[ids.home, answered], [ids.desk, answered]]), onCheckPcs: none }));
    const cell = (name: string) => /<td class="relay-dash-state-cell[^"]*">([\s\S]*?)<\/td>/.exec(rowOf(html, name))?.[1] ?? "";
    // a live answer beats the directory's stale Offline: the PC is reachable now
    expect(rowOf(html, "Home server")).toContain('<svg class="status-dot" data-state="ready"');
    expect(text(cell("Home server"))).toBe("Ready");
    expect(text(/<td class="relay-dash-relay relay-pc-cell-relay">([\s\S]*?)<\/td>/.exec(rowOf(html, "Home server"))?.[1] ?? "")).toBe("Relay · 13 ms");
    expect(cell("Home server")).not.toContain("connection-line");
    // automatic probes add no second line until Check now
    expect(text(cell("Desk PC"))).toBe("Ready");
    const down = render(signedIn(four(), { pcStatus: new Map([[ids.home, { kind: "offline", reason: "pc" }]] as const), onCheckPcs: none }));
    expect(rowOf(down, "Home server")).toContain('<svg class="status-dot" data-state="offline"');
    const downCell = /<td class="relay-dash-state-cell[^"]*">([\s\S]*?)<\/td>/.exec(rowOf(down, "Home server"))?.[1] ?? "";
    expect(text(downCell)).toBe("Offline · 20 h ago");
  });

  it("gives both the sidebar and a phone's tab bar the five real routes: Overview, PCs, Devices, Relay and Settings", () => {
    const html = render(signedIn(four()));
    const tabs = /<nav class="relay-dash-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    const items = [...tabs.matchAll(/<(a|span) class="relay-dash-tab"([^>]*)><svg[\s\S]*?<\/svg><span>([^<]+)<\/span><\/(?:a|span)>/g)].map(([, tag, attrs, label]) => [tag, label, attrs!.trim()]);
    expect(items).toEqual([
      ["a", "Overview", 'href="#overview" aria-current="page"'],
      ["a", "PCs", 'href="#pcs"'],
      ["a", "Devices", 'href="#devices"'],
      ["a", "Relay", 'href="#relay"'],
      ["a", "Settings", 'href="#settings"'],
    ]);
    expect(tabs).not.toContain("relay-dash-nav-count");
    const side = /<nav class="relay-dash-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect([...side.matchAll(/<(a|span) class="relay-dash-nav-item"([^>]*)>/g)].map(([, tag, attrs]) => [tag, attrs!.trim()])).toEqual([
      ["a", 'href="#overview" aria-current="page"'], ["a", 'href="#pcs"'], ["a", 'href="#devices"'], ["a", 'href="#relay"'], ["a", 'href="#settings"'],
    ]);
    expect(rowOf(html, "Desk PC")).toContain('<td class="relay-dash-state-cell relay-pc-cell-state">');
  });

  it("counts an unchecked QR pairing in the sidebar but not the Ready strip", () => {
    const countsOf = (html: string) => [...html.matchAll(/data-strip-cell="(\w+)"[^>]*data-strip-count="(\d+)"/g)].map(([, cell, n]) => [cell, Number(n)]);
    // the directory empty, this device paired with one PC by QR: a row, marked not checked / not in the account yet
    const alone = render(signedIn([pc(ids.mac, "MacBook", "paired", { listed: false, linked: false })]));
    expect(alone).not.toContain("relay-dash-sub");
    expect(text(rowOf(alone, "MacBook"))).toContain("Paired · not checked");
    expect(text(rowOf(alone, "MacBook"))).not.toContain("in your account");
    expect(alone).toContain('<span class="relay-dash-nav-count">1</span>');
    expect(countsOf(alone)).toEqual([["ready", 0], ["needs", 0], ["relays", 1]]);
    // one listed in the account + one listed but paired by QR alone: only the unlinked row says "Ready · not in the account yet"
    const both = render(signedIn([pc(ids.desk, "Desk PC", "paired"), pc(ids.mac, "MacBook", "paired", { listed: true, linked: false })]));
    expect(text(rowOf(both, "Desk PC"))).toContain("Ready");
    expect(text(rowOf(both, "MacBook"))).toContain("Ready · not in the account yet");
    expect(both).toContain('<span class="relay-dash-nav-count">2</span>');
    expect(countsOf(both)).toEqual([["ready", 2], ["needs", 0], ["relays", 1]]);
  });

  it("says who is signed in at the sidebar's foot with Sign out, while keeping device removal in Devices", () => {
    const html = render(signedIn(four()));
    const foot = /<div class="relay-dash-foot"[\s\S]*?<\/aside>/.exec(html)![0];
    expect(text(foot)).toContain("Signed in with GitHub");
    expect([...foot.matchAll(/<button type="button" class="account-link[^"]*">([^<]+)</g)].map(([, label]) => label)).toEqual(["Sign out"]);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Overview");
  });

  it("shows the steps to add a PC, Check again, Add a PC and Pair with a QR or code for an empty account, and skeleton rows while the directory loads", () => {
    const empty = render(signedIn([], { onRefreshAccount: none }));
    expect(empty).toContain('<h2 class="relay-overview-empty-title">No PCs yet</h2><ol class="relay-overview-empty-steps"');
    expect(text(empty)).toContain("sign in with the same GitHub account as on this device.");
    expect(actionsOf(empty)).toEqual(["Add a PC", "Copy", "Copy", "Check again", "Add a PC", "Pair with a QR or code"]);
    // Check again needs the account's refresh: without one the dashboard offers none
    expect(actionsOf(render(signedIn([])))).toEqual(["Add a PC", "Copy", "Copy", "Add a PC", "Pair with a QR or code"]);
    expect(empty).not.toContain("<table");
    expect(empty).not.toContain('data-slot="relay-map"');
    expect(empty).not.toContain("relay-dash-nav-count");
    const loading = render(signedIn(null));
    expect(loading).toContain('data-dashboard-loading=""');
    expect(loading).not.toContain("<table");
  });

  describe("in a browser", () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    let renderer: ReactTestRenderer | undefined;
    // the test renderer draws no DOM: a node stands in for every element (the map's svg pauses and resumes its animations on it), and the sheet portals into a body that holds them
    const node = () => ({ isConnected: true, focus() {}, contains: () => false, querySelectorAll: () => [], getClientRects: () => [], closest: () => null, addEventListener() {}, removeEventListener() {}, pauseAnimations() {}, unpauseAnimations() {} });

    beforeEach(() => {
      for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IntersectionObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      const events = new EventTarget();
      const store = new Map<string, string>();
      const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
      const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      class HTMLElement { isConnected = true; focus(): void {} }
      // the map watches whether its svg is on screen; nothing here scrolls, so the watch never reports
      class IntersectionObserver { observe(): void {} disconnect(): void {} }
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
      Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: IntersectionObserver });
      Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { href: "https://app.ovis.sh/", search: "", origin: "https://app.ovis.sh", pathname: "/" },
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
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      } });
    });

    afterEach(async () => {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
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
    const buttons = (label: string) => renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label);
    const button = (label: string) => { const found = buttons(label); if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`); return found[0]!; };
    const rows = () => renderer!.root.findAll((node) => node.type === "tr" && node.props["data-pc-state"] !== undefined).map((row) => textOf(row.find((node) => node.props.className === "relay-pc-name-label")));

    it("keeps the account foot in the desktop sidebar and moves account controls to the Devices view on a phone", async () => {
      const stops = () => renderer!.root.findAll((node) => node.type === "button" || (node.type === "a" && node.props.href !== undefined)).map((node) => textOf(node).trim());
      await mount(signedIn(four()));
      const desktop = stops();
      expect(desktop.indexOf("Sign out")).toBeLessThan(desktop.indexOf("Add a PC"));
      expect(desktop).not.toContain("Remove this device from your account");
      await act(async () => { renderer!.unmount(); });
      const narrow = (query: string) => ({ matches: query === "(max-width: 768px)", addEventListener() {}, removeEventListener() {} });
      (window as unknown as { matchMedia: typeof narrow }).matchMedia = narrow;
      await mount(signedIn(four()));
      expect(renderer!.root.findAll((node) => node.props.className === "relay-dash-foot")).toHaveLength(0);
    });

    it("reorders PairQrDialog footer actions in markup per breakpoint so DOM order matches visual order at desktop and phone widths", async () => {
      const footerLabels = () => dialog().findByType("footer").findAll((n) => n.type === "button").map(textOf);
      const shownAs = (state: RelayShellProps["state"]) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...signedIn(four()), state }) })); });
      await mount(signedIn(four()));
      await act(async () => { button("Add a PC").props.onClick(); });
      expect(footerLabels()).toEqual(["Close", "Pair with a QR or code"]);
      await act(async () => { button("Pair with a QR or code").props.onClick(); });
      expect(footerLabels()).toEqual(["Back", "Pair with a code"]);
      await shownAs({ kind: "code-entry", failure: null });
      expect(footerLabels()).toEqual(["Cancel", "Pair"]);
      await shownAs({ kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" } });
      expect(footerLabels()).toEqual(["Cancel", "It matches"]);
      await act(async () => { renderer!.unmount(); });

      const phoneMedia = (query: string) => ({ matches: query === "(max-width: 640px)" || query === "(max-width: 768px)", addEventListener() {}, removeEventListener() {} });
      Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: phoneMedia });
      (window as unknown as { matchMedia: typeof phoneMedia }).matchMedia = phoneMedia;
      const addPcTrigger = () => renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "add-pc");
      jest.useFakeTimers();
      try {
        await mount(signedIn(four()));
        await act(async () => { addPcTrigger().props.onClick(); });
        expect(footerLabels()).toEqual(["Pair with a QR or code", "Close"]);
        await act(async () => { button("Pair with a QR or code").props.onClick(); });
        expect(footerLabels()).toEqual(["Pair with a code", "Back"]);
        await shownAs({ kind: "code-entry", failure: null });
        expect(footerLabels()).toEqual(["Pair", "Cancel"]);
        await shownAs({ kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" } });
        expect(footerLabels()).toEqual(["It matches", "Cancel"]);
        await act(async () => { renderer!.unmount(); jest.runAllTimers(); });
      } finally {
        jest.useRealTimers();
      }
    });

    it("narrows the table: Needs you hides the ready rows while keeping offline, Ready hides the others, All brings them back", async () => {
      await mount(signedIn(four()));
      expect(rows()).toEqual(["Mac mini", "Home server", "Desk PC", "MacBook"]);
      const seg = () => renderer!.root.findByProps({ className: "segmented" });
      const segBtn = (label: string) => seg().find((n) => n.type === "button" && textOf(n).trim() === label);
      await act(async () => { segBtn("Needs you").props.onClick(); });
      expect(rows()).toEqual(["Mac mini", "Home server"]);
      expect(segBtn("Needs you").props["aria-pressed"]).toBe(true);
      await act(async () => { segBtn("Ready").props.onClick(); });
      expect(rows()).toEqual(["Desk PC"]);
      await act(async () => { segBtn("All").props.onClick(); });
      expect(rows()).toEqual(["Mac mini", "Home server", "Desk PC", "MacBook"]);
    });

    it("opens the Add-a-PC sheet from Add and Join in the matching mode over an inert dashboard, whose own button starts the join and names the sheet", async () => {
      const old = pc("e".repeat(32), "nuc", "needs-approval", { added_at: new Date(Date.now() - 3_600_000).toISOString(), join: { server_public_key: "k", relay: AP } });
      const joined: [string, unknown][] = [];
      await mount(signedIn([...four(), old], { onJoin: (target, options) => { joined.push([target.name, options]); } }));
      expect(dialogs()).toHaveLength(0);
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(0);
      // the attention list offers Add for the waiting PC, and its table row again: both open the one sheet over an inert dashboard
      expect(buttons("Add")).toHaveLength(2);
      await act(async () => { buttons("Add")[1]!.props.onClick({ stopPropagation() {} }); });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      expect(dialog().props["data-add-pc-phase"]).toBe("start");
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(1);
      expect(textOf(dialog())).toContain("Add Mac mini to your account");
      await act(async () => { button("Add this PC").props.onClick(); });
      expect(joined).toEqual([["Mac mini", { typed: true, sheet: "new" }]]);
      await act(async () => { button("Cancel").props.onClick(); });
      expect(dialogs()).toHaveLength(0);
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(0);
      await act(async () => { buttons("Add")[0]!.props.onClick({ stopPropagation() {} }); });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      await act(async () => { button("Cancel").props.onClick(); });
      await act(async () => { buttons("Join")[0]!.props.onClick({ stopPropagation() {} }); });
      expect(dialog().props["data-add-pc-mode"]).toBe("join");
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(1);
      expect(textOf(dialog())).toContain("Add this device to nuc");
      await act(async () => { button("Ask to join").props.onClick(); });
      expect(joined[1]).toEqual(["nuc", { sheet: "join" }]);
    });

    it("takes Add a PC to the sheet's add mode, opens Pair with a QR or code as a dialog over the inert dashboard, and returns focus to its trigger on close", async () => {
      const H = globalThis.HTMLElement as unknown as new () => { isConnected: boolean; focus: () => void };
      const opener = new H();
      let openerFocused = 0;
      opener.focus = () => { openerFocused += 1; };
      Object.defineProperty(document, "activeElement", { configurable: true, value: opener });
      await mount(signedIn(four()));
      await act(async () => { button("Add a PC").props.onClick(); });
      expect(dialog().props["data-add-pc-mode"]).toBe("add");
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(1);
      await act(async () => { button("Pair with a QR or code").props.onClick(); });
      expect(dialogs()).toHaveLength(1);
      expect(dialog().props["data-pair-dialog"]).toBe("qr");
      expect(dialog().parent?.props.className).toBe("modal-scrim");
      expect(String(dialog().props.className)).not.toContain("relay-shell");
      expect(dialog().findByType("footer").findAll((n) => n.type === "button").map(textOf)).toEqual(["Back", "Pair with a code"]);
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(1);
      expect(textOf(dialog())).toContain("Scan the QR code on your PC");
      expect(textOf(dialog())).toContain("Settings → Devices and PCs → Add a connection → Ovis relay");
      expect(textOf(dialog())).not.toContain("older Ovis");
      expect(renderer!.root.findAll((instance) => instance.type === "table")).toHaveLength(1);
      openerFocused = 0;
      await act(async () => { button("Back").props.onClick(); });
      expect(dialogs()).toHaveLength(0);
      expect(renderer!.root.findAll((n) => n.props.inert === true)).toHaveLength(0);
      expect(openerFocused).toBeGreaterThanOrEqual(1);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Overview");
      expect(rows()).toHaveLength(4);
    });

    it("names the QR and code dialog by the heading of its current screen", async () => {
      await mount(signedIn(four()));
      await act(async () => { button("Add a PC").props.onClick(); });
      await act(async () => { button("Pair with a QR or code").props.onClick(); });
      /** the dialog's accessible name: the text of the element its aria-labelledby names */
      const nameOf = (): string => {
        const shown = dialog();
        const labelledBy: unknown = shown.props["aria-labelledby"];
        if (typeof labelledBy !== "string") throw new Error(`the ${shown.props["data-pair-dialog"]} dialog has no aria-labelledby`);
        return textOf(shown.find((node) => node.props.id === labelledBy)).trim();
      };
      const shownAs = (state: RelayShellProps["state"]) => act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, { ...signedIn(four()), state }) })); });
      expect(dialog().props["data-pair-dialog"]).toBe("qr");
      expect(nameOf()).toBe("Scan the QR code on your PC");
      await shownAs({ kind: "code-entry", failure: null });
      expect(dialog().props["data-pair-dialog"]).toBe("code");
      expect(nameOf()).toBe("Pair with a code");
      await shownAs({ kind: "code-looking" });
      expect(nameOf()).toBe("Pair with a code");
      await shownAs({ kind: "code-compare", offer: { v: 1, server_id: ids.mini, server_public_key: "k", relay: AP, name: "Mac mini" } });
      expect(dialog().props["data-pair-dialog"]).toBe("compare");
      expect(nameOf()).toBe("Does Mac mini's screen show this ID?");
    });

    it("drops the QR dialog when a directory refresh finds the account signed out, leaving the sign-in its only screen", async () => {
      await mount(signedIn(four()));
      await act(async () => { button("Add a PC").props.onClick(); });
      await act(async () => { button("Pair with a QR or code").props.onClick(); });
      expect(dialog().props["data-pair-dialog"]).toBe("qr");
      const signedOut: RelayShellProps = { ...signedIn(four()), state: { kind: "list", devices: devices(), account: { kind: "signed-out", error: null } } };
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedOut) })); });
      expect(renderer!.root.findAllByType("h1").map(textOf)).toEqual(["Sign in to Ovis"]);
      // signing in again opens the dashboard without the dialog the sign-out closed
      await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayShell, signedIn(four())) })); });
      expect(dialogs()).toHaveLength(0);
    });

    it("keeps the dashboard mounted under the sheet, so its filter and the control that opened the sheet are still there to take the focus back", async () => {
      await mount(signedIn(four()));
      const segBtn = (label: string) => renderer!.root.findByProps({ className: "segmented" }).find((n) => n.type === "button" && textOf(n).trim() === label);
      await act(async () => { segBtn("Ready").props.onClick(); });
      await act(async () => { button("Add a PC").props.onClick(); });
      expect(dialog().props["data-add-pc-mode"]).toBe("add");
      await act(async () => { button("Close").props.onClick(); });
      expect(dialogs()).toHaveLength(0);
      expect(segBtn("Ready").props["aria-pressed"]).toBe(true);
      expect(rows()).toEqual(["Desk PC"]);
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
      // Ready state in continued mode renders AddPcSheet phase="ready" with Step 4 of 4 and all four steps done, not ReadyCheckpoint
      let openedPc = 0;
      await mount({ ...props({ kind: "ready", name: "Mac mini", server_id: ids.mini }), onOpenPc: () => { openedPc += 1; }, sheetJoin: { mode: "new", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-mode"]).toBe("new");
      expect(dialog().props["data-add-pc-phase"]).toBe("ready");
      expect(textOf(dialog())).toContain("Step 4 of 4");
      expect(dialog().findAll((n) => n.type === "li").map((n) => n.props["data-step"])).toEqual(["done", "done", "done", "done"]);
      await act(async () => { button("Open PC").props.onClick(); });
      expect(openedPc).toBe(1);
      await act(async () => { renderer!.unmount(); });
      // the same screen without the sheet's join, or with another PC's: the shell's own screen, as before
      await mount({ ...props({ kind: "confirm", offer }), sheetJoin: { mode: "join", server_id: ids.desk } });
      expect(dialogs()).toHaveLength(0);
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Pair with Mac mini?");
    });

    it("shows how the sheet's join failed in the sheet, with Try again, only for that PC, and suppresses raw close-code details in the RelayShell failure path", async () => {
      let retried = 0;
      const offline = { kind: "failed", failure: "pc-offline", name: "Mac mini", detail: "The relay closed the connection (0)" } as const;
      await mount({ ...props({ ...offline, server_id: ids.mini }), onRetry: () => { retried += 1; }, sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialog().props["data-add-pc-phase"]).toBe("failed");
      expect(textOf(dialog())).toContain("Mac mini is offline");
      expect(textOf(dialog())).not.toContain("The relay closed the connection (0)");
      await act(async () => { button("Try again").props.onClick(); });
      expect(retried).toBe(1);
      await act(async () => { renderer!.unmount(); });
      // another PC's failure, or one with no PC named: the shell's own screen, also filtering raw close-code details
      for (const state of [{ ...offline, server_id: ids.desk }, offline]) {
        await mount({ ...props(state), sheetJoin: { mode: "join", server_id: ids.mini } });
        expect(dialogs()).toHaveLength(0);
        expect(textOf(renderer!.root.findByType("h1"))).toBe("Mac mini is offline");
        expect(textOf(renderer!.root)).not.toContain("The relay closed the connection (0)");
        await act(async () => { renderer!.unmount(); });
      }
      await mount({ ...props({ kind: "failed", failure: "identity-changed", name: "Mac mini", detail: null, server_id: ids.mini }), sheetJoin: { mode: "join", server_id: ids.mini } });
      expect(dialogs()).toHaveLength(0);
      expect(button("Forget this PC")).toBeDefined();
    });

    it("lists this device's own pairings behind Continue without an account without account-availability words, and offers the sign-in at the foot", async () => {
      await mount({ ...props({ kind: "list", devices: [device(ids.desk, "p620", AP), device(ids.mac, "nuc", GLOBAL)], account: { kind: "signed-out", error: null } }), scoped: false, onSignIn: none });
      await act(async () => { button("Continue without an account (2 PCs)").props.onClick(); });
      const main = renderer!.root.findByType("main");
      expect(main.props["data-account-state"]).toBe("signed-out");
      expect(renderer!.root.findByProps({ className: "relay-dash" }).props["data-dashboard-mode"]).toBe("local");
      expect(rows()).toEqual(["nuc", "p620"]);
      expect(renderer!.root.findAll((node) => node.type === "a" && node.props["data-pc-action"] === "open").map((link) => link.props.href)).toEqual([`/s/${ids.mac}/`, `/s/${ids.desk}/`]);
      const foot = renderer!.root.findByProps({ className: "relay-dash-foot" });
      expect(textOf(foot)).toContain("Without an account");
      expect(textOf(foot)).not.toContain("Sign out");
      expect(renderer!.root.findAll((node) => node.type === "p" && node.props.className === "relay-dash-sub")).toHaveLength(0);
      const allText = textOf(renderer!.root);
      expect(allText).toContain("Paired with this device");
      expect(allText).toContain("Paired · not checked");
      expect(allText).not.toContain("Needs you");
      expect(allText).not.toContain("Ready");
      // the overview lists both relays
      expect(renderer!.root.findAll((node) => node.type === "button" && String(node.props.className ?? "").includes("relay-overview-relay-chip")).map(textOf)).toEqual(["relay-ap.ovis.sh", "relay.ovis.sh"]);
      await act(async () => { foot.find((node) => node.type === "button").props.onClick(); });
      expect(textOf(renderer!.root.findByType("h1"))).toBe("Sign in to Ovis");
    });
  });
});

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
      // a differing group is named for a screen reader, not told by colour alone
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
