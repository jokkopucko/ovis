import { describe, expect, it } from "bun:test";
import { translate } from "../lib/i18n.ts";
import { relayFailureText } from "./relayFailureText.ts";

describe.each(["en", "ko", "ja", "zh"] as const)("a PC that could not be opened (%s)", (language) => {
  const t = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
  it("calls a PC the relay had nobody for Machine offline, and a relay or a PC that did not answer this device Could not reach this machine", () => {
    const said = (["pc-offline", "pc-unresponsive", "relay-unreachable"] as const).map((failure) => {
      const text = relayFailureText(t, failure, "pc-a");
      return [text.title, text.retry];
    });
    expect(said).toEqual([[t("Machine offline"), true], [t("Could not reach this machine"), true], [t("Could not reach this machine"), true]]);
  });

  it("explains each cause by its own sentence: only a relay this device could not reach sends the person to its network", () => {
    const copy = (failure: "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "relay-refused") => relayFailureText(t, failure, "pc-a");
    expect((["pc-offline", "pc-unresponsive", "relay-unreachable", "relay-refused"] as const).map((failure) => [copy(failure).title, copy(failure).copy])).toEqual([
      [t("Machine offline"), t("{name} is off, has no network, or Ovis is not running on it. Start it, or wait for it to come back, then try again.", { name: "pc-a" })],
      [t("Could not reach this machine"), t("{name} answered but did not finish connecting in time. It may be busy or restarting. Try again; if it keeps happening, restart Ovis on {name}.", { name: "pc-a" })],
      [t("Could not reach this machine"), t("This device could not reach the relay. Check this device's network, then try again.")],
      [t("Could not reach this machine"), t("The relay turned this device away. Wait a minute, then try again.")],
    ]);
  });

  it("names the PC in what to do next where the PC is the cause", () => {
    expect((["pc-offline", "pc-unresponsive"] as const).map((failure) => relayFailureText(t, failure, "pc-a").copy.includes("pc-a"))).toEqual([true, true]);
  });
});
