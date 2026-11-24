import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AllowRefusal } from "../lib/account/listAllow.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { translate, type Language } from "../lib/i18n.ts";
import type { AccountList, WaitingRequest } from "../lib/account/accountList.ts";
import { unconfirmedReason, waitingOf } from "./AccountApprovals.tsx";
import { keepStalled, ListAllowNotice } from "./ListChangeNotice.tsx";

/** `pairedAtPc`: the PC let the device in by a pairing of its own (one that does not follow the list), as every case here but the last */
function render(why: AllowRefusal, retryAfterMs: number | null = null, pairedAtPc = true, placed = false): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(ListAllowNotice, { stalled: { key: "tablet-key", device: "Dana's tablet", pc: "Desk", pairedAtPc, placed, why, retryAfterMs, retry: async () => {} }, onClose: () => {} })));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("a device a PC let in that the account's list did not take", () => {
  it("says where the device is, why it is not in the account, and offers to try again", () => {
    const html = render("not_claimed");
    expect(html).toContain("Dana&#x27;s tablet was added to Desk only");
    expect(html).toContain("Update Ovis on that device and sign in there, then try again.");
    expect(html).toContain("Try again");
    expect(html).toContain("Close");
    expect(html).toContain('data-why="not_claimed"');
  });

  it("says each reason in its own words, and never offers to try again for a device the list put out", () => {
    expect(render("stopped")).toContain("The account service cannot change the list right now.");
    expect(render("budget")).toContain("Too many devices were added just now. Try again in a few minutes.");
    for (const why of ["busy", "refused", "unreached"] as const) expect(render(why)).toContain("It could not be added to your account. Try again.");
    const removed = render("removed");
    expect(removed).toContain("That device was removed from your account. Sign in again on it first.");
    expect(removed).not.toContain(">Try again<");
  });

  it("never says the device was added to this PC only while that is not known: after an answer that never came, it says so and offers to check", () => {
    const html = render("unknown");
    expect(html).not.toContain("was added to Desk only");
    expect(html).toContain("Not known yet: is Dana&#x27;s tablet in your account?");
    expect(html).toContain("The account service did not answer. Try again to check.");
    expect(html).toContain(">Try again<");
  });

  it("says that the clock looks wrong, that this device cannot change the list, and how long a budget lasts", () => {
    expect(render("clock")).toContain("This device&#x27;s clock looks wrong. Check its date and time, then try again.");
    expect(render("blocked")).toContain("This device cannot change your account&#x27;s list right now.");
    // the sign-in changed since the approval: nothing is written to the other account's list
    expect(render("changed")).toContain("The sign-in on this device changed since you approved it. Sign in to that account again, then try again.");
    // a device that is behind signs nobody in until it is updated
    expect(render("behind")).toContain("Update Ovis on this device, then try again.");
    expect(render("budget", 20 * 3600_000)).toContain("Too many devices were added. Try again tomorrow.");
    expect(render("budget", 5 * 60_000)).toContain("Too many devices were added just now. Try again in a few minutes.");
  });
});

describe("a device a PC that lets devices in by the list did not let in", () => {
  it("says that the device is not in the account, never that it was added to that PC: such a PC made no pairing of its own", () => {
    for (const why of ["not_claimed", "stopped", "removed", "refused"] as const) {
      const html = render(why, null, false);
      expect(html).toContain("Dana&#x27;s tablet is not in your account");
      expect(html).not.toContain("only");
    }
    expect(render("unknown", null, false)).toContain("Not known yet: is Dana&#x27;s tablet in your account?");
  });
});

describe("a device the list took, where what was to follow its entry stopped", () => {
  it("says that the device was added to the list, never that it is not in the account or was added to the PC only", () => {
    for (const pairedAtPc of [true, false]) {
      const html = render("changed", null, pairedAtPc, true);
      expect(html).toContain("Dana&#x27;s tablet was added to your account&#x27;s list");
      expect(html).not.toContain("is not in your account");
      expect(html).not.toContain("only");
      expect(html).toContain("The sign-in on this device changed since you approved it.");
    }
  });
});

describe("a change that still waits", () => {
  it("offers Cancel beside Try again where a signed request waits, and none where nothing waits", () => {
    const waits = (why: AllowRefusal, cancel: boolean): string => {
      const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
      Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
      try {
        return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(ListAllowNotice, { stalled: { key: "k", device: "Dana's tablet", pc: "Desk", pairedAtPc: true, why, retry: async () => {}, ...(cancel ? { cancel: async () => {} } : {}) }, onClose: () => {} })));
      } finally {
        if (saved) Object.defineProperty(navigator, "languages", saved);
        else Reflect.deleteProperty(navigator, "languages");
      }
    };
    expect(waits("unknown", true)).toContain(">Cancel<");
    expect(waits("not_claimed", false)).not.toContain(">Cancel<");
    // another change was refused because this one waits: the card says so, whatever page made the first
    const other = waits("waiting", true);
    expect(other).toContain("An earlier change is still waiting");
    expect(other).toContain("Try it again, or cancel it.");
    expect(other).toContain(">Try again<");
    expect(other).not.toContain("was added to Desk only");
  });
});

describe("the devices the list did not take, kept until each is closed or let in", () => {
  const stalled = (key: string, why: AllowRefusal) => ({ key, device: key, pc: "Desk", pairedAtPc: true, why, retry: async () => {} });

  it("keeps one card for each device, the first refused first, and takes a device's card away when it is let in or closed", () => {
    let kept = keepStalled([], "tablet", stalled("tablet", "budget"));
    kept = keepStalled(kept, "laptop", stalled("laptop", "unknown"));
    expect(kept.map((each) => [each.key, each.why])).toEqual([["tablet", "budget"], ["laptop", "unknown"]]);
    // a later answer for the same device takes its place, where it stood
    kept = keepStalled(kept, "tablet", stalled("tablet", "stopped"));
    expect(kept.map((each) => [each.key, each.why])).toEqual([["tablet", "stopped"], ["laptop", "unknown"]]);
    kept = keepStalled(kept, "tablet", null);
    expect(kept.map((each) => each.key)).toEqual(["laptop"]);
    expect(keepStalled(kept, "phone", null)).toBe(kept);
  });
});

describe("an approval a PC that lets devices in by the list has not seen confirmed", () => {
  const join = { id: "r1", label: "Tablet", intent: "account" as const, choices: ["111111", "222222", "333333"] as [string, string, string], expires_at: "", key: "k" };
  const said = (language: Language, request: Parameters<typeof unconfirmedReason>[1]) => unconfirmedReason((key, vars) => translate(language, key, vars), request, "Dana's tablet", "Desk");

  it("asks the new device's person to press The numbers match where the join brought its card", () => {
    expect(said("en", { ...join, list: true })).toBe("First press “The numbers match” on Dana's tablet");
  });

  it("says to approve a join that brought no card on that PC's own screen: no device is ever told it confirmed, in every language", () => {
    expect(said("en", join)).toBe("Approve Dana's tablet on Desk's own screen");
    for (const language of ["ko", "ja", "zh"] as const) {
      const words = said(language, join);
      expect(words).not.toBe("Approve Dana's tablet on Desk's own screen");
      expect(words).toContain("Dana's tablet");
      expect(words).toContain("Desk");
    }
  });
});

describe("the request a stalled approval's card acts on", () => {
  const waits = (account: string): WaitingRequest => ({ account, list: "5c".repeat(32), key: "member", on: { seq: 1, hash: "ab".repeat(32) }, place: { seq: 2, hash: "cd".repeat(32) }, for: "allow:k", at: 1 });
  const listOf = (request: WaitingRequest | null) => ({ waiting: async () => request }) as unknown as AccountList;

  it("is the request that waits for the account the approval began under, and none that waits for another account", async () => {
    expect(await waitingOf(listOf(waits("acct_a")), "acct_a")).toEqual(waits("acct_a"));
    // the sign-in moved to another account while the approval waited: its request is not this card's to send or let go
    expect(await waitingOf(listOf(waits("acct_b")), "acct_a")).toBeNull();
    expect(await waitingOf(listOf(null), "acct_a")).toBeNull();
    expect(await waitingOf(null, "acct_a")).toBeNull();
  });
});
