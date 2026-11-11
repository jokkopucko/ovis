import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import { dashboardPcs, type DashboardPc } from "../lib/relay/dashboard.ts";
import { loadSettings, SettingsProvider } from "../lib/settings.ts";
import { RelayDashboard, type RelayDashboardProps } from "./RelayDashboard.tsx";

const AP = "wss://relay-ap.ovis.sh";
const GLOBAL = "wss://relay.ovis.sh";
const IDS = {
  desk: "a".repeat(32),
  mac: "b".repeat(32),
  mini: "c".repeat(32),
  home: "d".repeat(32),
};

const pc = (server_id: string, name: string, state: MyPc["state"], over: Partial<MyPc> = {}): MyPc => ({
  server_id,
  name,
  state,
  last_seen_at: null,
  added_at: null,
  listed: true,
  paired: state === "paired",
  linked: true,
  ...over,
});

const fourPcs = (): DashboardPc[] =>
  dashboardPcs(
    [
      pc(IDS.desk, "Desk PC", "paired", { last_seen_at: new Date().toISOString() }),
      pc(IDS.mac, "MacBook", "paired", { listed: false, linked: false }),
      pc(IDS.mini, "Mac mini", "needs-approval", {
        last_seen_at: new Date().toISOString(),
        added_at: new Date().toISOString(),
        join: { server_public_key: "k", relay: AP },
      }),
      pc(IDS.home, "Home server", "offline", {
        paired: true,
        last_seen_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
      }),
    ],
    [
      { server_id: IDS.desk, relay: AP },
      { server_id: IDS.mac, relay: AP },
      { server_id: IDS.home, relay: GLOBAL },
    ],
  );

const baseProps = (over: Partial<RelayDashboardProps> = {}): RelayDashboardProps => ({
  pcs: fourPcs(),
  account: { provider: "github" },
  defaultRelay: GLOBAL,
  meLabel: "Linux · Chrome",
  error: null,
  onAddPc: () => {},
  onOpenSheet: () => {},
  onSignOut: () => {},
  onLeave: () => {},
  ...over,
});

const renderStatic = (shown: RelayDashboardProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayDashboard, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("RelayDashboard frame and routes", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let focusedNodes: string[] = [];
  let store: Map<string, string>;
  let phoneMatches = false;
  let narrowMatches = false;
  let narrowSplitMatches = false;
  let events: EventTarget;
  /** the open details panel and its heading, as the dashboard finds them under the PCs split (the renderer draws no DOM) */
  let detailsHeading: { tabIndex: number; focus: () => void };
  let detailsPanel: { scrolledTo: unknown[]; scrollIntoView: (options?: unknown) => void; querySelector: (selector: string) => unknown };

  const createMockNode = (element: { type: unknown; props?: unknown }) => ({
    isConnected: true,
    tagName: typeof element.type === "string" ? element.type.toUpperCase() : "DIV",
    focus() {
      const p = typeof element.props === "object" && element.props !== null ? (element.props as Record<string, unknown>) : {};
      const label = typeof p["aria-label"] === "string"
        ? p["aria-label"]
        : typeof p["id"] === "string"
          ? p["id"]
          : String(element.type);
      focusedNodes.push(label);
    },
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: (selector: string) => {
      if (selector === "[data-pc-details]") return detailsPanel;
      const row = /^\[data-pc-id="([^"]+)"\] \.relay-pc-name-btn$/.exec(selector);
      if (row === null || renderer === undefined) return null;
      const mounted = renderer.root.findAll((n) => (n.type === "tr" || n.type === "li") && n.props["data-pc-id"] === row[1]);
      return mounted.length === 0 ? null : { focus() { focusedNodes.push(`row:${row[1]}`); } };
    },
    getClientRects: () => [],
    closest: () => null,
    addEventListener() {},
    removeEventListener() {},
    pauseAnimations() {},
    unpauseAnimations() {},
  });

  beforeEach(() => {
    focusedNodes = [];
    phoneMatches = false;
    narrowMatches = false;
    narrowSplitMatches = false;
    detailsHeading = { tabIndex: 0, focus() { focusedNodes.push("details-heading"); } };
    detailsPanel = { scrolledTo: [], scrollIntoView(options) { detailsPanel.scrolledTo.push(options); }, querySelector: (selector) => selector === "h2" ? detailsHeading : null };
    events = new EventTarget();
    store = new Map<string, string>();
    for (const key of [
      "window",
      "document",
      "navigator",
      "localStorage",
      "getComputedStyle",
      "matchMedia",
      "HTMLElement",
      "ResizeObserver",
      "IntersectionObserver",
      "IS_REACT_ACT_ENVIRONMENT",
    ]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
      key: () => null,
      length: 0,
      clear: () => store.clear(),
    };
    const matchMedia = (query: string) => ({
      matches: query === "(max-width: 768px)" ? phoneMatches : query === "(max-width: 1099px)" ? narrowMatches : query === "(max-width: 1391px)" ? narrowSplitMatches : false,
      addEventListener() {},
      removeEventListener() {},
    });
    class HTMLElement {
      isConnected = true;
      focus(): void {}
    }
    class ResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    class IntersectionObserver {
      observe(): void {}
      disconnect(): void {}
    }
    const loc = {
      href: "https://app.ovis.sh/",
      search: "",
      origin: "https://app.ovis.sh",
      pathname: "/",
      hash: "",
    };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserver });
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: IntersectionObserver });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 },
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: loc,
        history: {
          state: null,
          pushState(_data: unknown, _unused: string, url: string) {
            const parsed = new URL(url, loc.origin);
            loc.pathname = parsed.pathname;
            loc.search = parsed.search;
            loc.hash = parsed.hash;
            loc.href = parsed.href;
          },
          replaceState(_data: unknown, _unused: string, url: string) {
            const parsed = new URL(url, loc.origin);
            loc.pathname = parsed.pathname;
            loc.search = parsed.search;
            loc.hash = parsed.hash;
            loc.href = parsed.href;
          },
        },
        localStorage: storage,
        matchMedia,
        innerWidth: 1440,
        scrollTo() {},
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 1; },
        cancelAnimationFrame() {},
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        body: { nodeType: 1, children: [], createNodeMock: createMockNode },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
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

  const mount = async (shown: RelayDashboardProps = baseProps()) => {
    await act(async () => {
      renderer = create(createElement(SettingsProvider, { children: createElement(RelayDashboard, shown) }), {
        createNodeMock: createMockNode,
      });
    });
  };

  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

  const navigateHash = async (hash: string, eventType: "hashchange" | "popstate" = "hashchange") => {
    await act(async () => {
      window.location.hash = hash;
      window.location.href = `https://app.ovis.sh/${hash}`;
      window.dispatchEvent(new Event(eventType));
    });
  };

  it("renders labeled landmarks, brand link to #overview, all five real routes in sidebar and phone tab bar without disabled items, and no header subtitle", () => {
    const html = renderStatic(baseProps());
    expect(html).toContain('<aside class="relay-dash-side" aria-label="Navigation">');
    expect(html).toContain('<nav class="relay-dash-nav" aria-label="Sections">');
    expect(html).toContain('<nav class="relay-dash-tabs" aria-label="Sections">');
    expect(html).toContain('href="#overview"');
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain("relay-dash-sub");

    const sideLinks = [...(/<nav class="relay-dash-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "").matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map(([, href]) => href);
    expect(sideLinks).toEqual(["#overview", "#pcs", "#devices", "#relay", "#settings"]);

    const tabLinks = [...(/<nav class="relay-dash-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "").matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map(([, href]) => href);
    expect(tabLinks).toEqual(["#overview", "#pcs", "#devices", "#relay", "#settings"]);
  });

  it("loads directly into any of the five routes, updates aria-current on Back/Forward, and moves focus to the view heading only on route changes", async () => {
    window.location.hash = "#relay";
    await mount();
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Relay");
    const currentHrefs = () =>
      renderer!.root
        .findAll((n) => n.type === "a" && n.props["aria-current"] === "page")
        .map((n) => n.props.href);
    expect(currentHrefs()).toEqual(["#relay", "#relay"]);

    focusedNodes = [];
    await navigateHash("#devices", "popstate");
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Devices");
    expect(currentHrefs()).toEqual(["#devices", "#devices"]);
    expect(focusedNodes.length).toBeGreaterThan(0);

    // Data refresh (re-render with updated pcs) never steals focus
    focusedNodes = [];
    await act(async () => {
      renderer!.update(createElement(SettingsProvider, { children: createElement(RelayDashboard, baseProps()) }));
    });
    expect(focusedNodes).toEqual([]);

    await navigateHash("#settings", "popstate");
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Settings");
    expect(currentHrefs()).toEqual(["#settings", "#settings"]);
  });

  it("restores PCs filter, relay and details selection from the route and clears missing selection", async () => {
    window.location.hash = `#pcs?filter=offline&pc=${IDS.home}`;
    await mount();
    expect(textOf(renderer!.root.findByType("h1"))).toBe("PCs");
    const rows = () =>
      renderer!.root
        .findAll((n) => n.type === "tr" && n.props["data-pc-state"] !== undefined)
        .map((r) => textOf(r.find((n) => n.props.className === "relay-pc-name-label")));
    expect(rows()).toEqual(["Home server"]);
    expect(renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined).length).toBe(1);
    // with Details open beside it the table drops Last seen, so its cells stay on one line
    const headers = () => renderer!.root.findAll((n) => n.type === "th").map(textOf);
    expect(headers()).toEqual(["Name", "State", "Relay", "Action"]);

    // Back to Needs you filter without selection
    await navigateHash("#pcs?filter=needs", "popstate");
    expect(rows()).toEqual(["Mac mini", "Home server"]);
    expect(renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined).length).toBe(0);
    expect(headers()).toEqual(["Name", "State", "Relay", "Last seen", "Action"]);

    // Missing PC id in route renders no details panel
    await navigateHash("#pcs?pc=missing_pc_id", "popstate");
    expect(renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined).length).toBe(0);
  });

  it("below 1100px the details replace the list as a full view whose Back shows the list and focuses its row; from 1100px the side panel leaves the focus alone", async () => {
    const nameButton = (id: string) => renderer!.root.find((n) => (n.type === "tr" || n.type === "li") && n.props["data-pc-id"] === id).find((n) => n.props.className === "relay-pc-name-btn");
    const details = () => renderer!.root.findAll((n) => n.props["data-pc-details"] !== undefined);
    const lists = () => renderer!.root.findAll((n) => n.props["data-pc-list"] !== undefined);
    const select = async () => { await act(async () => { nameButton(IDS.home).props.onClick({ stopPropagation() {} }); }); };
    const back = async () => { await act(async () => { renderer!.root.find((n) => n.type === "button" && textOf(n).trim() === "Back").props.onClick(); }); };
    const scrolls: unknown[][] = [];
    (window as unknown as { scrollTo: (...args: unknown[]) => void }).scrollTo = (...args) => { scrolls.push(args); };

    // a phone (the tab-bar layout): the details are the whole view, started at the top; Back brings the list back under the focus
    phoneMatches = true;
    narrowMatches = true;
    window.location.hash = "#pcs";
    await mount();
    expect(lists()).toHaveLength(1);
    expect(focusedNodes).toEqual([]);
    await select();
    expect(details()).toHaveLength(1);
    expect(lists()).toHaveLength(0);
    expect(focusedNodes).toEqual(["details-heading"]);
    expect(detailsHeading.tabIndex).toBe(-1);
    expect(scrolls).toEqual([[0, 0]]);
    expect(detailsPanel.scrolledTo).toEqual([]);
    await back();
    expect(details()).toHaveLength(0);
    expect(lists()).toHaveLength(1);
    expect(focusedNodes).toEqual(["details-heading", `row:${IDS.home}`]);
    // browser Back (popstate) from phone Details also restores focus to the row
    focusedNodes = [];
    await select();
    expect(details()).toHaveLength(1);
    expect(focusedNodes).toEqual(["details-heading"]);
    await navigateHash("#pcs", "popstate");
    expect(details()).toHaveLength(0);
    expect(lists()).toHaveLength(1);
    expect(focusedNodes).toEqual(["details-heading", `row:${IDS.home}`]);

    // between the phone and 1100px: the details also replace the list as a full view, started at the top, and Back restores focus to the row
    await act(async () => { renderer!.unmount(); });
    phoneMatches = false;
    focusedNodes = [];
    scrolls.length = 0;
    detailsHeading.tabIndex = 0;
    window.location.hash = "#pcs";
    await mount();
    await select();
    expect(details()).toHaveLength(1);
    expect(lists()).toHaveLength(0);
    expect(focusedNodes).toEqual(["details-heading"]);
    expect(detailsHeading.tabIndex).toBe(-1);
    expect(detailsPanel.scrolledTo).toEqual([]);
    expect(scrolls).toEqual([[0, 0]]);
    await back();
    expect(details()).toHaveLength(0);
    expect(lists()).toHaveLength(1);
    expect(focusedNodes).toEqual(["details-heading", `row:${IDS.home}`]);
    // browser Back (popstate) from narrow Details also restores focus to the row
    focusedNodes = [];
    await select();
    expect(details()).toHaveLength(1);
    expect(focusedNodes).toEqual(["details-heading"]);
    await navigateHash("#pcs", "popstate");
    expect(details()).toHaveLength(0);
    expect(lists()).toHaveLength(1);
    expect(focusedNodes).toEqual(["details-heading", `row:${IDS.home}`]);

    // a deep link opens with the details and moves no focus
    await act(async () => { renderer!.unmount(); });
    focusedNodes = [];
    window.location.hash = `#pcs?pc=${IDS.home}`;
    await mount();
    expect(details()).toHaveLength(1);
    expect(focusedNodes).toEqual([]);

    // between 1100px and 1391px (remaining table < 720px): Details sits beside the two-line narrow list
    await act(async () => { renderer!.unmount(); });
    narrowMatches = false;
    narrowSplitMatches = true;
    scrolls.length = 0;
    detailsPanel.scrolledTo = [];
    detailsHeading.tabIndex = 0;
    window.location.hash = "#pcs";
    await mount();
    expect(lists().map((n) => n.props["data-pc-list"])).toEqual(["table"]);
    await select();
    expect(details()).toHaveLength(1);
    expect(lists().map((n) => n.props["data-pc-list"])).toEqual(["phone"]);
    await act(async () => { renderer!.root.find((n) => n.type === "button" && n.props["aria-label"] === "Close").props.onClick(); });
    expect(details()).toHaveLength(0);
    expect(lists().map((n) => n.props["data-pc-list"])).toEqual(["table"]);

    // the side panel from 1392px+: the click keeps its focus, nothing scrolls, Close moves nothing
    await act(async () => { renderer!.unmount(); });
    narrowSplitMatches = false;
    focusedNodes = [];
    scrolls.length = 0;
    detailsPanel.scrolledTo = [];
    detailsHeading.tabIndex = 0;
    window.location.hash = "#pcs";
    await mount();
    await select();
    expect(details()).toHaveLength(1);
    expect(lists().map((n) => n.props["data-pc-list"])).toEqual(["table"]);
    await act(async () => { renderer!.root.find((n) => n.type === "button" && n.props["aria-label"] === "Close").props.onClick(); });
    expect(details()).toHaveLength(0);
    expect(focusedNodes).toEqual([]);
    expect(detailsHeading.tabIndex).toBe(0);
    expect(detailsPanel.scrolledTo).toEqual([]);
    expect(scrolls).toEqual([]);

    // when an unlisted pairing is forgotten and its row disappears (focus dropped to <body> as the dialog unmounted),
    // focus moves to the next surviving row, else the previous surviving row, else the view heading when the last PC is gone
    const zed = pc("z".repeat(32), "Zed laptop", "paired", { listed: false, linked: false });
    const forgetSelect = async (id: string) => {
      await act(async () => { nameButton(id).props.onClick({ stopPropagation() {} }); });
    };
    const closeAfterForget = async (remaining: DashboardPc[]) => {
      Reflect.set(document, "activeElement", document.body);
      const closeBtn = renderer?.root.find((n) => n.type === "button" && (textOf(n).trim() === "Back" || n.props["aria-label"] === "Close"));
      await act(async () => {
        renderer?.update(createElement(SettingsProvider, { children: createElement(RelayDashboard, baseProps({ pcs: remaining })) }));
        closeBtn?.props.onClick();
      });
    };
    for (const isNarrow of [false, true] as const) {
      await act(async () => { renderer?.unmount(); });
      phoneMatches = isNarrow;
      narrowMatches = isNarrow;
      window.location.hash = "#pcs";
      const withZed = dashboardPcs([...fourPcs(), zed], [
        { server_id: IDS.desk, relay: AP },
        { server_id: IDS.mac, relay: AP },
        { server_id: IDS.home, relay: GLOBAL },
        { server_id: zed.server_id, relay: AP },
      ]);
      await mount(baseProps({ pcs: withZed }));
      // MacBook is before Zed laptop in the table: forgetting MacBook focuses the next row (Zed laptop)
      await forgetSelect(IDS.mac);
      focusedNodes = [];
      await closeAfterForget(withZed.filter((item) => item.server_id !== IDS.mac));
      expect(focusedNodes).toEqual([`row:${zed.server_id}`]);
      // Zed laptop is now the last row in the table: forgetting it focuses the previous row (Desk PC)
      await forgetSelect(zed.server_id);
      focusedNodes = [];
      await closeAfterForget(fourPcs().filter((item) => item.server_id !== IDS.mac));
      expect(focusedNodes).toEqual([`row:${IDS.desk}`]);
      // When the forgotten unlisted pairing was the only PC, the split unmounts and focus lands on the view heading
      await act(async () => { renderer?.unmount(); });
      window.location.hash = "#pcs";
      const sole = dashboardPcs([pc(IDS.mac, "MacBook", "paired", { listed: false, linked: false })], [{ server_id: IDS.mac, relay: AP }]);
      await mount(baseProps({ pcs: sole }));
      await forgetSelect(IDS.mac);
      focusedNodes = [];
      await closeAfterForget([]);
      expect(focusedNodes).toEqual(["h1"]);
    }
  });

  it("keeps Sign out in the desktop sidebar foot while placing Remove this device only in Devices with same-element confirmation", async () => {
    let signedOut = 0;
    let left = 0;
    await mount(baseProps({ onSignOut: () => { signedOut += 1; }, onLeave: () => { left += 1; } }));
    const sideFoot = renderer!.root.findByProps({ className: "relay-dash-foot" });
    expect(textOf(sideFoot)).toContain("Signed in with GitHub");
    expect(textOf(sideFoot)).toContain("Sign out");
    expect(textOf(sideFoot)).not.toContain("Remove this device");

    await navigateHash("#devices");
    const removeBtn = renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "remove-device");
    expect(String(removeBtn.props.className)).not.toContain("btn-danger");
    expect(String(removeBtn.props.className)).not.toContain("account-link-danger");

    // First click arms confirmation on the exact same button instance
    await act(async () => { removeBtn.props.onClick(); });
    expect(left).toBe(0);
    expect(String(removeBtn.props.className)).toContain("btn-danger");
    expect(removeBtn.props["data-confirm"]).toBe("remove-device");

    // Second click on the same button invokes onLeave
    await act(async () => { removeBtn.props.onClick(); });
    expect(left).toBe(1);

    // Sign out button works
    const signOutBtn = sideFoot.find((n) => n.type === "button");
    await act(async () => { signOutBtn.props.onClick(); });
    expect(signedOut).toBe(1);
  });

  it("offers Delete account in Devices only, says what it erases before the second press, and Cancel takes it back", async () => {
    let deleted = 0;
    await mount(baseProps({ onDeleteAccount: () => { deleted += 1; } }));
    expect(textOf(renderer!.root.findByProps({ className: "relay-dash-foot" }))).not.toContain("Delete account");

    await navigateHash("#devices");
    const button = () => renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "delete-account");
    expect(textOf(button())).toBe("Delete account");
    expect(String(button().props.className)).not.toContain("btn-danger");
    expect(textOf(renderer!.root)).not.toContain("for good");

    await act(async () => { button().props.onClick(); });
    expect(deleted).toBe(0);
    expect(String(button().props.className)).toContain("btn-danger");
    expect(button().props["data-confirm"]).toBe("delete-account");
    expect(textOf(button())).toBe("Delete account for good?");
    const said = textOf(renderer!.root.find((n) => n.props["data-testid"] === "delete-account-says"));
    expect(said).toContain("your sign-in methods, your list of PCs and your plan");
    expect(said).toContain("stay paired");

    const cancel = renderer!.root.findAll((n) => n.type === "button" && textOf(n) === "Cancel").at(-1)!;
    await act(async () => { cancel.props.onClick(); });
    expect(textOf(button())).toBe("Delete account");
    expect(deleted).toBe(0);

    await act(async () => { button().props.onClick(); });
    await act(async () => { button().props.onClick(); });
    expect(deleted).toBe(1);
  });

  it("drops an asked Delete account when another sign-in is shown, so its second press never reaches that one", async () => {
    let deleted = 0;
    const shown = (signedInAs: string) => baseProps({ signedInAs, onDeleteAccount: () => { deleted += 1; } });
    await mount(shown("sign-in-one"));
    await navigateHash("#devices");
    const button = () => renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "delete-account");
    await act(async () => { button().props.onClick(); });
    expect(textOf(button())).toBe("Delete account for good?");
    await act(async () => { renderer!.update(createElement(SettingsProvider, { children: createElement(RelayDashboard, shown("sign-in-two")) })); });
    expect(textOf(button())).toBe("Delete account");
    await act(async () => { button().props.onClick(); });
    expect(deleted).toBe(0);
  });

  it("says on Devices why a delete was refused, and there only", async () => {
    await mount(baseProps({ deleteError: "Cancel your subscription first, then delete the account.", onDeleteAccount: () => {} }));
    await navigateHash("#devices");
    const alert = renderer!.root.findAll((n) => n.props.role === "alert" && textOf(n).includes("Cancel your subscription first"));
    expect(alert.length).toBeGreaterThan(0);
    await navigateHash("#overview");
    expect(textOf(renderer!.root)).not.toContain("Cancel your subscription first");
  });

  it("draws no directory failure under Delete account", async () => {
    await mount(baseProps({ error: "The account service could not be reached.", onDeleteAccount: () => {} }));
    await navigateHash("#devices");
    expect(textOf(renderer!.root)).not.toContain("could not be reached");
  });

  it("offers no Delete account without an account", async () => {
    await mount(baseProps({ account: null, onDeleteAccount: () => {} }));
    await navigateHash("#devices");
    expect(renderer!.root.findAll((n) => n.type === "button" && n.props["data-action"] === "delete-account")).toHaveLength(0);
  });

  it("persists theme, density and language through SettingsProvider in the Settings view", async () => {
    window.location.hash = "#settings";
    await mount();
    const lightBtn = renderer!.root.find((n) => n.type === "button" && textOf(n).trim() === "Light");
    await act(async () => { lightBtn.props.onClick(); });
    expect(loadSettings().theme).toBe("light");

    const compactBtn = renderer!.root.find((n) => n.type === "button" && textOf(n).trim() === "Compact");
    await act(async () => { compactBtn.props.onClick(); });
    expect(loadSettings().density).toBe("compact");

    const langSelect = renderer!.root.find((n) => n.type === "select" && n.props.id === "relay-settings-language");
    await act(async () => { langSelect.props.onChange({ target: { value: "ko" } }); });
    expect(loadSettings().language).toBe("ko");
  });

  it("renders a 44px Add a PC button in the phone top bar and omits the account foot from Overview on phones", async () => {
    phoneMatches = true;
    await mount();
    expect(renderer!.root.findAll((n) => n.props.className === "relay-dash-foot")).toHaveLength(0);
    const addButtons = renderer!.root.findAll((n) => n.type === "button" && n.props["data-action"] === "add-pc");
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("omits the full connection map from Overview, renders a 44px Connection map disclosure after the table that navigates to #relay, and renders the map on #relay", async () => {
    const html = renderStatic(baseProps());
    expect(html).not.toContain('data-slot="relay-map"');
    expect(html).toContain('class="relay-overview-map-disclosure"');
    expect(html.indexOf('id="relay-dash-pcs"')).toBeLessThan(html.indexOf('class="relay-overview-map-disclosure"'));

    await mount();
    expect(renderer!.root.findAll((n) => n.props["data-slot"] === "relay-map")).toHaveLength(0);
    const disclosure = renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "open-connection-map");
    expect(textOf(disclosure)).toContain("Connection map");

    await act(async () => {
      disclosure.props.onClick();
    });
    expect(window.location.hash).toBe("#relay");
    expect(textOf(renderer!.root.findByType("h1"))).toBe("Relay");
    expect(renderer!.root.findAll((n) => n.props["data-slot"] === "relay-map")).toHaveLength(1);
  });

  it("mounts RelayOverview, RelayPcTable, RelayPcDetails and RelayMap with at most three attention rows, matching Needs filter counts, truthful local words, live map checks, and Details selection without a connection attempt", async () => {
    const extra1 = pc("e".repeat(32), "Build box", "needs-update", { paired: true });
    const extra2 = pc("f".repeat(32), "Test rig", "needs-approval", { join: { server_public_key: "k2", relay: GLOBAL } });
    const fleet = dashboardPcs([
      ...fourPcs(),
      extra1,
      extra2,
    ], [
      { server_id: IDS.desk, relay: AP },
      { server_id: IDS.mac, relay: AP },
      { server_id: IDS.home, relay: GLOBAL },
      { server_id: extra1.server_id, relay: GLOBAL },
    ]);
    const liveStatus = new Map([
      [IDS.desk, { kind: "checking" } as const],
      [IDS.home, { kind: "answered", route: "relay", relay: GLOBAL, rttMs: 24 } as const],
    ]);
    await mount(baseProps({ pcs: fleet, pcStatus: liveStatus, onCheckPcs: () => {} }));

    // 1. The live answer replaces stale Offline; the unchecked QR pairing counts in neither group.
    const stripBtns = renderer!.root.findAll((n) => n.type === "button" && typeof n.props["data-strip-cell"] === "string");
    expect(stripBtns.map((b) => [b.props["data-strip-cell"], b.props["data-strip-count"], textOf(b)])).toEqual([
      ["ready", 2, "Ready2"],
      ["needs", 3, "Needs you3"],
      ["relays", 2, "Relays in use2"],
    ]);
    const attentionRows = renderer!.root.findAll((n) => n.type === "li" && n.props.className === "relay-overview-attention-row");
    expect(attentionRows).toHaveLength(3);
    const viewAll = renderer!.root.findAll((n) => n.type === "button" && n.props["data-action"] === "view-all-attention");
    expect(viewAll).toHaveLength(0);

    // 2. Needs you contains exactly the three PCs still needing action, excluding the answered PC.
    await act(async () => { stripBtns[1]!.props.onClick(); });
    expect(window.location.hash).toBe("#pcs?filter=needs");
    const needsTableRows = renderer!.root.findAll((n) => n.type === "tr" && n.props["data-pc-id"] !== undefined);
    expect(needsTableRows.map((row) => row.props["data-pc-id"])).toEqual([extra1.server_id, IDS.mini, extra2.server_id]);

    // 3. The answered PC belongs to Ready; its name opens Details without opening the PC.
    const readyFilter = renderer!.root.find((n) => n.type === "button" && textOf(n) === "Ready");
    await act(async () => { readyFilter.props.onClick(); });
    const homeRow = renderer!.root.find((n) => n.type === "tr" && n.props["data-pc-id"] === IDS.home);
    const detailsBtn = homeRow.find((n) => n.type === "button" && n.props.className === "relay-pc-name-btn");
    await act(async () => { detailsBtn.props.onClick({ stopPropagation() {} }); });
    expect(window.location.hash).toContain(`pc=${IDS.home}`);
    const detailsPane = renderer!.root.find((n) => n.props["data-pc-details"] === IDS.home);
    expect(textOf(detailsPane)).toContain("Home server");
    expect(textOf(detailsPane)).toContain("This device: answered · 24 ms");

    // 4. Relay route passes live pcStatus into RelayMap (only checking wire animates, answered/no-answer reflected) and selecting a PC in the map opens Details
    await navigateHash("#relay");
    const flows = renderer!.root.findAll((n) => n.type === "path" && n.props.className === "relay-map-flow");
    expect(flows.length).toBeGreaterThan(0);
    const deskMapNode = renderer!.root.find((n) => n.type === "button" && n.props["data-pc-id"] === IDS.desk);
    await act(async () => { deskMapNode.props.onClick(); });
    expect(window.location.hash).toContain(`#pcs`);
    expect(window.location.hash).toContain(`pc=${IDS.desk}`);
    expect(renderer!.root.find((n) => n.props["data-pc-details"] === IDS.desk)).toBeDefined();

    // 5. Local mode's Overview shows no account-availability words (Ready/Needs you/Offline)
    window.location.hash = "#overview";
    const localHtml = renderStatic(baseProps({
      account: null,
      pcs: dashboardPcs([pc(IDS.desk, "Desk PC", "paired", { listed: false, linked: false })], [{ server_id: IDS.desk, relay: AP }]),
    }));
    expect(localHtml).toContain("Paired with this device");
    expect(localHtml).toContain("Paired · not checked");
    expect(localHtml).not.toContain('data-strip-cell="ready"');
    expect(localHtml).not.toContain(">Ready<");

    // 6. Empty fleet (F0) on Overview/PCs keeps only the empty state's Add a PC as .btn-primary while making the header action quiet, and restores the header .btn-primary on Devices/Relay/Settings
    await act(async () => {
      renderer!.update(createElement(SettingsProvider, { children: createElement(RelayDashboard, baseProps({ pcs: [] })) }));
    });
    await navigateHash("#overview");
    const primaries = () => renderer!.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("btn-primary"));
    const headerAdd = () => renderer!.root.findByProps({ className: "relay-dash-top" }).find((n) => n.type === "button" && n.props["data-action"] === "add-pc");
    expect(primaries()).toHaveLength(1);
    expect(String(headerAdd().props.className)).toBe("btn");
    await navigateHash("#pcs");
    expect(primaries()).toHaveLength(1);
    expect(String(headerAdd().props.className)).toBe("btn");
    await navigateHash("#relay");
    expect(primaries()).toHaveLength(1);
    expect(String(headerAdd().props.className)).toBe("btn btn-primary");
    await navigateHash("#devices");
    expect(primaries()).toHaveLength(1);
    expect(String(headerAdd().props.className)).toBe("btn btn-primary");
  });

  // the page heading's ring and the phone map's rail are what the browser draws: scripts/relay-dashboard-browser-qa.ts
  // (view-heading-focus, details-390-focus, map-rail-390) reads their computed styles and rectangles
});
