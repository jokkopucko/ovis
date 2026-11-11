import { expect, it } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { FoundHerdrChoices, type HerdrChoice } from "./FoundHerdrChoices.tsx";

it("offers each running session and a separate explicit new-start choice", async () => {
  const choices: HerdrChoice[] = [];
  let view: ReactTestRenderer | undefined;
  const prior = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
  const listen = { addEventListener() {}, removeEventListener() {} };
  for (const [key, value] of Object.entries({ window: listen, navigator: { languages: ["en"] }, document: { documentElement: { dataset: {}, style }, querySelector: () => null }, getComputedStyle: () => style })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  try {
    await act(async () => { view = create(<SettingsProvider><FoundHerdrChoices sessions={[
      { session: "work", label: "work", socket_path: "/desktop/herdr/sessions/work/herdr.sock" },
      { label: "Default session", socket_path: "/desktop/herdr/herdr.sock" },
    ]} ownOvis={[{ socket_path: "/desktop/ovis/hc.sock", runtime: "herdr-core" }]} error="Choose this PC's Ovis server or a running herdr session." busy={false} onChoose={(choice) => choices.push(choice)} /></SettingsProvider>); });
    if (!view) throw new Error("card did not mount");
    const buttons = view.root.findAllByType("button");
    // the PC's own Ovis, where its sessions are, comes first as the main button; the herdr sessions beside it after
    expect(buttons.map((button) => button.children.join(""))).toEqual(["Use Ovis on this PC (herdr-core)", "Use work", "Use Default session", "Start a new herdr here"]);
    expect(buttons.map((button) => button.props.className.split(" ").includes("btn-primary"))).toEqual([true, false, false, false]);
    // a fresh choice is drawn as a question
    expect(view.root.findByProps({ role: "status" }).props.className.split(" ")).toContain("is-setup");
    await act(async () => { for (const button of buttons) button.props.onClick(); });
    expect(choices).toEqual([
      { own_ovis: "/desktop/ovis/hc.sock", herdr_socket: undefined, start_new_herdr: undefined },
      { session: "work", herdr_socket: "/desktop/herdr/sessions/work/herdr.sock", start_new_herdr: undefined },
      { session: undefined, herdr_socket: "/desktop/herdr/herdr.sock", start_new_herdr: undefined },
      { herdr_socket: undefined, start_new_herdr: true },
    ]);
    // the chosen Ovis could not be used: the heading is why (gone, or its socket refused), as the server said it
    for (const reason of ["Start Ovis on that PC, or start a new herdr here", "The Ovis chosen on this PC serves herdr-core from a socket that is not this SSH account's own, so it was not used. Choose again, or start a new herdr here."]) {
      await act(async () => { view?.update(<SettingsProvider><FoundHerdrChoices sessions={[]} error={reason} busy onChoose={(choice) => choices.push(choice)} /></SettingsProvider>); });
      expect(view.root.findByType("strong").children.join("")).toBe(reason);
      expect(view.root.findByType("button").props.disabled).toBe(true);
    }
    // a choice offered after a failure (this PC's Ovis found but not answering; the chosen session gone while another
    // runs) is told as that failure, with why, and offers no main button: it is not a fresh question
    const unanswered = "Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.";
    const gone = "The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again.";
    for (const [reason, ownOvis] of [[unanswered, [{ socket_path: "/desktop/ovis/hc.sock", runtime: "herdr-core" as const }]], [gone, []]] as const) {
      await act(async () => { view?.update(<SettingsProvider><FoundHerdrChoices sessions={[{ session: "work", label: "work", socket_path: "/desktop/herdr/sessions/work/herdr.sock" }]} ownOvis={[...ownOvis]} error={reason} busy={false} onChoose={(choice) => choices.push(choice)} /></SettingsProvider>); });
      expect(view.root.findAllByType("strong")[0]?.children.join("")).toBe(reason);
      expect(view.root.findByProps({ role: "status" }).props.className.split(" ")).not.toContain("is-setup");
      expect(view.root.findAllByType("button").some((button) => button.props.className.split(" ").includes("btn-primary"))).toBe(false);
    }
  } finally {
    await act(async () => { view?.unmount(); });
    if (prior) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", prior); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
