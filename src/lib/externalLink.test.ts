import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWebLinkOpener, ExternalLink, installSafariLinks, isWebLink, openExternal, reserveTab, safariUrl } from "./externalLink.ts";

/** Runs `run` with `window.open` answering `answer`, and gives back each call's arguments. */
function withWindowOpen(answer: (url: string) => unknown, run: () => void): unknown[][] {
  const calls: unknown[][] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { open: (...args: unknown[]) => { calls.push(args); return answer(args[0] as string); } } });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
  return calls;
}

describe("ExternalLink", () => {
  it("opens a tab of its own with no opener or referrer, and passes on everything else", () => {
    expect(renderToStaticMarkup(createElement(ExternalLink, { kind: "link", href: "https://ovis.sh/", className: "settings-link", title: "Site" }, "ovis.sh")))
      .toBe('<a href="https://ovis.sh/" target="_blank" rel="noopener noreferrer" class="settings-link" title="Site">ovis.sh</a>');
    expect(renderToStaticMarkup(createElement(ExternalLink, { kind: "sign-in", href: "https://github.com/login/device" }, "Sign in")))
      .toBe('<a href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">Sign in</a>');
  });

  it("sends the referrer only when asked, to the app's own page", () => {
    expect(renderToStaticMarkup(createElement(ExternalLink, { kind: "ovis", referrer: true, href: "/api/file/view?path=a.html" }, "Open")))
      .toBe('<a href="/api/file/view?path=a.html" target="_blank" rel="noopener">Open</a>');
  });
});

describe("openExternal", () => {
  it("gives an address that is not http(s) a tab of its own, with no opener or referrer", () => {
    const calls = withWindowOpen(() => null, () => openExternal("mailto:team@ovis.sh", "link", true));
    expect(calls).toEqual([["mailto:team@ovis.sh", "_blank", "noopener,noreferrer"]]);
  });
});

describe("the desktop app's browser for links", () => {
  /** Runs `run` in a page the desktop app gave its ovisBrowsers bridge, and gives back what reached it, a new tab's link and window.open. */
  function inDesktopApp(run: () => void): { bridged: string[]; tabs: unknown[][] } {
    const bridged: string[] = [];
    const tabs: unknown[][] = [];
    const originals = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), document: Object.getOwnPropertyDescriptor(globalThis, "document"), location: Object.getOwnPropertyDescriptor(globalThis, "location") };
    const ovisBrowsers = { list: async () => null, choose: async () => {}, open: (url: string) => { bridged.push(url); } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ovisBrowsers, open: (...args: unknown[]) => { tabs.push(args); return null; } } });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://127.0.0.1:7317" } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => {
      const link = { href: "", target: "", rel: "", click: () => tabs.push([link.href, link.target, link.rel]) };
      return link;
    } } });
    try {
      run();
    } finally {
      for (const name of ["window", "document", "location"] as const) {
        if (originals[name]) Object.defineProperty(globalThis, name, originals[name]);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
    return { bridged, tabs };
  }

  it("hands a web link to the app, and keeps sign-ins, this app's own pages and other schemes on their old path", () => {
    const { bridged, tabs } = inDesktopApp(() => {
      openExternal("https://example.com/", "link");
      openExternal("https://github.com/login/device", "sign-in");
      openExternal("http://127.0.0.1:7317/?pane=t3", "link");
      openExternal("mailto:team@ovis.sh", "link");
    });
    expect(bridged).toEqual(["https://example.com/"]);
    expect(tabs).toEqual([["https://github.com/login/device", "_blank", "noopener noreferrer"], ["http://127.0.0.1:7317/?pane=t3", "_blank", "noopener noreferrer"], ["mailto:team@ovis.sh", "_blank", "noopener,noreferrer"]]);
  });

  it("takes over a plain click on a web ExternalLink to another site only", () => {
    const click = (props: Parameters<typeof ExternalLink>[0], event: { button: number; defaultPrevented?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) => {
      const fired = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...event, defaultPrevented: event.defaultPrevented ?? false, preventDefault() { fired.defaultPrevented = true; } };
      (ExternalLink(props).props as { onClick: (event: unknown) => void }).onClick(fired);
      return fired.defaultPrevented;
    };
    let seen = 0;
    const { bridged } = inDesktopApp(() => {
      expect(click({ kind: "link", href: "https://ovis.sh/", onClick: () => { seen++; } }, { button: 0 })).toBe(true);
      expect(click({ kind: "link", href: "https://ovis.sh/middle" }, { button: 1 })).toBe(false);
      for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) expect(click({ kind: "link", href: "https://ovis.sh/modified" }, { button: 0, [modifier]: true })).toBe(false);
      expect(click({ kind: "link", href: "http://127.0.0.1:7317/?pane=t3" }, { button: 0 })).toBe(false);
      expect(click({ kind: "sign-in", href: "https://github.com/login/device" }, { button: 0 })).toBe(false);
      expect(click({ kind: "ovis", href: "https://pc.example/" }, { button: 0 })).toBe(false);
      expect(click({ kind: "link", href: "mailto:team@ovis.sh" }, { button: 0 })).toBe(false);
      expect(click({ kind: "link", href: "https://ovis.sh/handled" }, { button: 0, defaultPrevented: true })).toBe(true);
    });
    expect(bridged).toEqual(["https://ovis.sh/"]);
    expect(seen).toBe(1);
  });
});

describe("reserveTab", () => {
  it("opens a blank tab the page it is sent to has no handle on, or answers null when the browser blocks it", () => {
    const tab = { opener: {} as unknown };
    let reserved: unknown;
    expect(withWindowOpen(() => tab, () => { reserved = reserveTab(); })).toEqual([["about:blank", "_blank"]]);
    expect(reserved).toBe(tab);
    expect(tab.opener).toBeNull();
    withWindowOpen(() => null, () => { reserved = reserveTab(); });
    expect(reserved).toBeNull();
  });
});


describe("openWebLink", () => {
  it("opens a new tab unless asked to reuse, and falls back to one whenever the reused tab is gone or refused", () => {
    const clicked: Record<string, string>[] = [];
    const opened: { closed: boolean; location: { href: string }; focus: () => void; focused: number }[] = [];
    let blocked = false;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => {
      const link = { href: "", target: "", rel: "", click: () => clicked.push({ href: link.href, target: link.target, rel: link.rel }) };
      return link;
    } } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { open: (uri: string) => {
      if (blocked) return null;
      const tab = { closed: false, location: { href: uri }, focused: 0, focus() { this.focused++; } };
      opened.push(tab);
      return tab;
    } } });
    try {
      const open = createWebLinkOpener();
      open("https://one.example", false);
      open("https://two.example", true);
      open("https://three.example", true);
      expect(clicked).toEqual([{ href: "https://one.example", target: "_blank", rel: "noopener noreferrer" }]);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ location: { href: "https://three.example" }, focused: 1 });
      opened[0]!.closed = true;
      open("https://four.example", true);
      expect(opened).toHaveLength(2);
      expect(opened[1]).toMatchObject({ location: { href: "https://four.example" }, focused: 0 });
      blocked = true;
      createWebLinkOpener()("https://blocked.example", true);
      expect(clicked.at(-1)).toEqual({ href: "https://blocked.example", target: "_blank", rel: "noopener noreferrer" });
      // a tab the browser no longer lets this page steer still opens the address, in a new tab
      blocked = false;
      const refusing = createWebLinkOpener();
      refusing("https://five.example", true);
      Object.defineProperty(opened.at(-1)!.location, "href", { set: () => { throw new Error("SecurityError"); } });
      refusing("https://six.example", true);
      expect(clicked.at(-1)).toEqual({ href: "https://six.example", target: "_blank", rel: "noopener noreferrer" });
      const windowOpen = (globalThis as unknown as { window: { open: unknown } }).window.open;
      (globalThis as unknown as { window: { open: unknown } }).window.open = () => { throw new Error("SecurityError"); };
      createWebLinkOpener()("https://seven.example", true);
      expect(clicked.at(-1)).toEqual({ href: "https://seven.example", target: "_blank", rel: "noopener noreferrer" });
      (globalThis as unknown as { window: { open: unknown } }).window.open = windowOpen;
      // an app hands the address to the system browser: it never keeps a window to reuse
      (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
      createWebLinkOpener()("https://app.example", true);
      expect(opened).toHaveLength(3);
      expect(clicked.at(-1)).toEqual({ href: "https://app.example", target: "_blank", rel: "noopener noreferrer" });
    } finally {
      Reflect.deleteProperty(globalThis, "Capacitor");
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("isWebLink", () => {
  it("opens http and https addresses, in any case", () => {
    for (const uri of ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM"]) {
      expect(isWebLink(uri)).toBe(true);
    }
  });

  it("refuses every other scheme a crafted terminal line could carry", () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:x", "file:///etc/passwd", "ws://example.com", "//example.com", "example.com", " https://example.com"]) {
      expect(isWebLink(uri)).toBe(false);
    }
  });
});

describe("Safari links in the iOS home-screen app", () => {
  /** runs `body` as a page of `origin`, standalone or not, with document and window stubbed */
  function asPage(standalone: boolean, body: (page: { location: { href: string; origin: string }; listeners: ((event: MouseEvent) => void)[] }) => void): void {
    const saved = ["document", "window", "Element"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const savedStandalone = Object.getOwnPropertyDescriptor(navigator, "standalone");
    const location = { href: "https://ovis.example/", origin: "https://ovis.example" };
    const listeners: ((event: MouseEvent) => void)[] = [];
    class FakeElement {
      constructor(readonly href: string, readonly attributes: string[] = []) {}
      closest(): FakeElement { return this; }
      hasAttribute(name: string): boolean { return this.attributes.includes(name); }
    }
    Object.defineProperty(globalThis, "Element", { configurable: true, value: FakeElement });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location, open: () => { throw new Error("no tab in this test"); } } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      addEventListener: (_type: string, listener: (event: MouseEvent) => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: (event: MouseEvent) => void) => listeners.splice(listeners.indexOf(listener), 1),
      createElement: () => { throw new Error("no tab in this test"); },
    } });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: standalone });
    try {
      body({ location, listeners });
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      if (savedStandalone) Object.defineProperty(navigator, "standalone", savedStandalone);
      else Reflect.deleteProperty(navigator, "standalone");
    }
  }

  it("sends another site's http(s) address to Safari, and keeps Ovis's own and other schemes", () => {
    asPage(true, () => {
      expect(safariUrl("https://tasks.example/t/T-1")).toBe("x-safari-https://tasks.example/t/T-1");
      expect(safariUrl("http://tasks.example/")).toBe("x-safari-http://tasks.example/");
      expect(safariUrl("https://ovis.example/file?path=a")).toBeNull();
      expect(safariUrl("mailto:someone@example.com")).toBeNull();
      // the iOS app (a WebView) hands links to the system browser itself
      (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
      try {
        expect(safariUrl("https://tasks.example/")).toBeNull();
      } finally {
        Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });
    asPage(false, () => expect(safariUrl("https://tasks.example/")).toBeNull());
  });

  it("opens chat and terminal links in Safari instead of a tab", () => {
    asPage(true, ({ location }) => {
      createWebLinkOpener()("https://tasks.example/t/T-2", true);
      expect(location.href).toBe("x-safari-https://tasks.example/t/T-2");
    });
  });

  it("takes a plain click on a link no other handler took", () => {
    asPage(true, ({ location, listeners }) => {
      const remove = installSafariLinks();
      const Fake = (globalThis as unknown as { Element: new (href: string, attributes?: string[]) => object }).Element;
      const click = (href: string, init: Partial<MouseEvent> = {}, attributes: string[] = []) => {
        let prevented = init.defaultPrevented ?? false;
        listeners[0]!({ button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init, defaultPrevented: prevented, target: new Fake(href, attributes), preventDefault: () => { prevented = true; } } as unknown as MouseEvent);
        return prevented;
      };
      expect(click("https://ovis.example/x")).toBe(false);
      expect(click("https://tasks.example/", { defaultPrevented: true })).toBe(true);
      expect(click("https://tasks.example/", { metaKey: true })).toBe(false);
      expect(click("https://tasks.example/", {}, ["download"])).toBe(false);
      expect(location.href).toBe("https://ovis.example/");
      expect(click("https://tasks.example/t/T-3")).toBe(true);
      expect(location.href).toBe("x-safari-https://tasks.example/t/T-3");
      remove();
      expect(listeners).toHaveLength(0);
    });
  });
});
