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

  // the relay says only that the PC is not there: its relay turned off looks the same as the PC turned off, so both are named
  it("explains each cause by its own sentence: only a relay this device could not reach sends the person to its network", () => {
    const copy = (failure: "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "relay-refused") => relayFailureText(t, failure, "pc-a");
    expect((["pc-offline", "pc-unresponsive", "relay-unreachable", "relay-refused"] as const).map((failure) => [copy(failure).title, copy(failure).copy])).toEqual([
      [t("Machine offline"), t("{name}'s Ovis relay or power is off, it has no network, or Ovis is not running on it. Turn it on, or wait for it to come back, then try again.", { name: "pc-a" })],
      [t("Could not reach this machine"), t("{name} answered but did not finish connecting in time. It may be busy or restarting. Try again; if it keeps happening, restart Ovis on {name}.", { name: "pc-a" })],
      [t("Could not reach this machine"), t("This device could not reach the relay. Check this device's network, then try again.")],
      [t("Could not reach this machine"), t("The relay turned this device away. Wait a minute, then try again.")],
    ]);
  });

  it("names the PC in what to do next where the PC is the cause", () => {
    expect((["pc-offline", "pc-unresponsive"] as const).map((failure) => relayFailureText(t, failure, "pc-a").copy.includes("pc-a"))).toEqual([true, true]);
  });

  it("on the join sheet, a PC that could not reach the account says the PC is on and cannot take the device now, never that it is off", () => {
    const text = relayFailureText(t, "account-unreachable", "pc-a", null, "join");
    expect([text.title, text.copy, text.retry]).toEqual([
      t("{name} could not reach your Ovis account", { name: "pc-a" }),
      t("{name} is on, but it could not reach your Ovis account, so it cannot take this device right now. Try again in a moment.", { name: "pc-a" }),
      true,
    ]);
    expect(text.copy).not.toBe(t("Machine offline"));
  });
});

describe("a join into the list that a PC which joined by an invite was asked to sign", () => {
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
  it("says that PC lets nobody in itself, and points to another device of the account", () => {
    const text = relayFailureText(t, "list-pc-invited", "pc-a");
    expect([text.title, text.copy, text.retry]).toEqual([
      "pc-a cannot add this device itself",
      "pc-a joined your account by an invite, so it lets nobody into your account's list itself. Ask to join again, and approve it on another device of your account.",
      true,
    ]);
    expect(text.copy).not.toContain("Settings");
  });
});

describe("a join into the list that a PC did not take for a cause of its own, not an invite", () => {
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
  it("says a PC that came in as its account moved has no key of its own in the list yet, and how it gets one", () => {
    const text = relayFailureText(t, "list-pc-needs-keys", "pc-a");
    expect([text.title, text.copy, text.retry]).toEqual([
      "pc-a cannot add this device itself",
      "pc-a came into your account's list as your account moved, and holds no key of its own in it yet, so it lets nobody in itself. Ask to join again and approve it on another device of your account, or run ovis add on pc-a to give it its keys.",
      true,
    ]);
    expect(text.copy).not.toContain("invite");
  });

  it("says a PC keeps this device out by a block there, whatever the list holds, and where that is lifted: never that it was not added", () => {
    const text = relayFailureText(t, "list-pc-held", "pc-a");
    expect([text.title, text.copy, text.retry]).toEqual([
      "pc-a keeps this device out for now",
      "A device was blocked on pc-a, and until that block is lifted pc-a keeps out every device that came after it, even one your account's list holds. Lift the block on an older device of your account, or run ovis recover on pc-a. This device opens pc-a after that.",
      true,
    ]);
    expect(`${text.title} ${text.copy}`).not.toContain("not added");
  });

  it("says both in every language the app keeps", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const local = (key: string, vars?: Record<string, string | number>) => translate(language, key, vars);
      for (const failure of ["list-pc-needs-keys", "list-pc-held"] as const) {
        const text = relayFailureText(local, failure, "pc-a");
        expect([language, failure, text.copy === relayFailureText(t, failure, "pc-a").copy, text.copy.includes("pc-a")]).toEqual([language, failure, false, true]);
      }
    }
  });
});
