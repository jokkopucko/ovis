import { afterEach, describe, expect, it } from "bun:test";
import { ExternalLink } from "./externalLink.ts";
import { safariAddress, type LinkEnvironment } from "./safariLinks.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const homeScreen: LinkEnvironment = { userAgent: IPHONE, maxTouchPoints: 5, standalone: true, origin: "https://ovis.example.com" };

describe("safariAddress", () => {
  it("hands another site's address to Safari in the iPhone and iPad Home Screen app", () => {
    expect(safariAddress("https://gitlab.com/group/project/-/issues/7", homeScreen)).toBe("x-safari-https://gitlab.com/group/project/-/issues/7");
    expect(safariAddress("HTTPS://example.org/a?b=1#c", homeScreen)).toBe("x-safari-https://example.org/a?b=1#c");
    expect(safariAddress("https://gitlab.com/", { ...homeScreen, userAgent: IPAD })).toBe("x-safari-https://gitlab.com/");
  });

  it("keeps the app's own pages in the app, and every address but https as it is", () => {
    expect(safariAddress("https://ovis.example.com/settings", homeScreen)).toBe("https://ovis.example.com/settings");
    for (const uri of ["http://100.64.0.1:5173/", "mailto:user@example.com", "file:///tmp/a.txt", "https://example.org:99999/"]) expect(safariAddress(uri, homeScreen)).toBe(uri);
  });

  it("changes nothing in a Safari tab, on a Mac or on Android", () => {
    const uri = "https://gitlab.com/";
    expect(safariAddress(uri, { ...homeScreen, standalone: false })).toBe(uri);
    expect(safariAddress(uri, { ...homeScreen, userAgent: IPAD, maxTouchPoints: 0 })).toBe(uri);
    expect(safariAddress(uri, { ...homeScreen, userAgent: "Mozilla/5.0 (Linux; Android 16) Mobile", standalone: undefined })).toBe(uri);
  });
});

describe("a tap on a link in the Home Screen app", () => {
  const saved = ["document", "window", "navigator", "location"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    Reflect.deleteProperty(globalThis, "Capacitor");
  });
  const tap = (href: string, init: Partial<MouseEvent> = {}, page: object = { userAgent: IPHONE, maxTouchPoints: 5, standalone: true }): { prevented: boolean; clicked: string[] } => {
    const clicked: string[] = [];
    const values: Record<string, unknown> = {
      document: { createElement: () => { const link = { href: "", target: "", rel: "", click: () => clicked.push(link.href) }; return link; } },
      window: { open: () => null },
      navigator: page,
      location: { origin: homeScreen.origin },
    };
    for (const [key] of saved) Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
    let prevented = false;
    const event = { button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init, preventDefault: () => { prevented = true; } };
    (ExternalLink({ kind: "link", href, children: "link" }).props as { onClick: (event: unknown) => void }).onClick(event);
    return { prevented, clicked };
  };

  it("opens another site in Safari instead of the app's own view", () => {
    expect(tap("https://gitlab.com/")).toEqual({ prevented: true, clicked: ["x-safari-https://gitlab.com/"] });
    expect(tap("//gitlab.com/issues/7")).toEqual({ prevented: true, clicked: ["x-safari-https://gitlab.com/issues/7"] });
  });

  it.each([
    ["iOS 16", IPHONE.replace("17_0", "16_7")],
    ["iPadOS 16", IPAD.replace("Version/17.0", "Version/16.7")],
    ["iPadOS with no version", IPAD.replace(" Version/17.0", "")],
  ])("leaves normal HTTPS navigation alone on %s", (_, userAgent) => {
    expect(tap("https://gitlab.com/", {}, { ...homeScreen, userAgent })).toEqual({ prevented: false, clicked: [] });
  });

  it("leaves the app's own links, a click a handler took and a modified click alone", () => {
    for (const result of [
      tap("https://ovis.example.com/x"), tap("https://gitlab.com/", { defaultPrevented: true }), tap("https://gitlab.com/", { button: 1 }),
      tap("https://gitlab.com/", { metaKey: true }), tap("https://gitlab.com/", { ctrlKey: true }), tap("https://gitlab.com/", { altKey: true }), tap("https://gitlab.com/", { shiftKey: true }),
    ]) expect(result).toEqual({ prevented: false, clicked: [] });
  });

  it("reads the device from the page: a Safari tab on an iPhone keeps the link, an iPad Home Screen app hands it to Safari", () => {
    expect(tap("https://gitlab.com/", {}, { userAgent: IPHONE, maxTouchPoints: 5, standalone: false })).toEqual({ prevented: false, clicked: [] });
    expect(tap("https://gitlab.com/", {}, { userAgent: IPAD, maxTouchPoints: 5, standalone: true })).toEqual({ prevented: true, clicked: ["x-safari-https://gitlab.com/"] });
  });

  it("changes nothing in the native apps", () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    expect(safariAddress("https://gitlab.com/", homeScreen)).toBe("https://gitlab.com/");
  });
});
