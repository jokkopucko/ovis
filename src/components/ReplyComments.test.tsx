import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { ReplyCommentAction } from "./ReplyComments.tsx";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const heard = new Set<string>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "https://ovis.example/" },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  heard.clear();
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null,
    addEventListener: (type: string) => { heard.add(type); },
    removeEventListener: (type: string) => { heard.delete(type); },
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

// #511: the chat's timeline chunk can arrive after the action mounted, with no scroller yet
it("hears the reader's selection even when the chat's scroller arrives after it mounted", async () => {
  const scroller = { current: null as HTMLDivElement | null };
  await act(async () => { renderer = create(<SettingsProvider><ReplyCommentAction scroller={scroller} storageKey="ovis:reply-comments:p1" /></SettingsProvider>); });
  expect([...heard].sort()).toEqual(["pointerdown", "pointerup", "scroll", "selectionchange"]);
});
