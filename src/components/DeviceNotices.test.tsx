import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import { keyFingerprint } from "../lib/deviceNotices.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DeviceNotices } from "./DevicePairedNotice.tsx";

const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(87);
const notice = (over: Partial<DeviceNotice>): DeviceNotice => ({
  seq: 1, id: "1".padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind: "admit", how: "list", key: KEY, no: 4, row: "r1", label: "Galaxy S30",
  by: null, account: "acct", open: true, method: "github", two_step: "set", ...over,
});

describe("device notices", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"] } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (notices: readonly DeviceNotice[], dismissed: DeviceNotice[] = [], cut = 0) => {
    await act(async () => {
      renderer = create(<SettingsProvider><DeviceNotices pc="Desk" notices={notices} cut={cut} onDismiss={(item) => dismissed.push(item)} /></SettingsProvider>);
    });
    return renderer!.root.findAll((node) => node.props["data-testid"] === "device-notice");
  };

  it("T34: an admission names the PC, the device, its key and how it signed in", async () => {
    const [card] = await mount([notice({})]);
    const shown = text(card!);
    expect(shown).toContain("joined Desk: Galaxy S30");
    expect(shown).toContain("GitHub");
    expect(shown).toContain(keyFingerprint(KEY));
  });

  it("T58: Apple's two-step sign-in is said to be set on the account, never that this sign-in used it", async () => {
    const [card] = await mount([notice({ kind: "method", method: "apple", two_step: "set", open: false })]);
    const shown = text(card!);
    expect(shown).toContain("Apple");
    expect(shown).toContain("set");
    expect(shown.toLowerCase()).not.toContain("used");
  });

  it("T57: hiding an undecided admission neither records a dismissal nor answers or acknowledges it again", async () => {
    const onDismiss = mock();
    const onShown = mock();
    const answer = mock();
    const told = notice({ kind: "method", open: false });
    const open = notice({ seq: 2, id: "2".padStart(32, "0"), row: null });
    await act(async () => {
      renderer = create(<SettingsProvider><DeviceNotices pc="Desk" notices={[told, open]} onDismiss={onDismiss} onShown={onShown}
        actions={() => <button type="button" onClick={answer}>Answer</button>} /></SettingsProvider>);
    });
    if (renderer === undefined) throw new Error("No device notices rendered");
    const cards = () => renderer?.root.findAllByProps({ "data-testid": "device-notice" }) ?? [];
    const dismiss = (card: ReactTestInstance) => card.find((node) => node.type === "button" && node.props["aria-label"] === "Dismiss");
    const [closedCard, openCard] = cards();
    if (closedCard === undefined || openCard === undefined) throw new Error("Expected two notices");
    expect(onShown.mock.calls).toEqual([[2]]);
    await act(async () => { dismiss(openCard).props.onClick(); });
    expect(cards()).toEqual([closedCard]);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(onShown.mock.calls).toEqual([[2]]);
    await act(async () => { dismiss(closedCard).props.onClick(); });
    expect(onDismiss.mock.calls).toEqual([[told]]);
  });

  it("G5: shows nothing for journal kinds this release does not tell here", async () => {
    expect(await mount([notice({ kind: "merge", open: false })])).toEqual([]);
  });

  it("P15: the PC's trimmed line shows the count even with no card left", async () => {
    await mount([], [], 12);
    expect(text(renderer!.root)).toBe("12 older notices from Desk were cleared before this device saw them.");
    await mount([], [], 0);
    expect(text(renderer!.root)).toBe("");
  });

  it("P15: one trimmed notice reads in the singular", async () => {
    await mount([], [], 1);
    const shown = text(renderer!.root);
    expect(shown).toContain("An older notice from Desk");
    expect(shown).not.toContain("1 older notices");
  });
});

describe("keyFingerprint", () => {
  it("T34: four groups of four hex digits of the key's SHA-256, the same key the same every time", () => {
    expect(keyFingerprint(KEY)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY));
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(KEY.slice(0, -1) + "B"));
  });
});
