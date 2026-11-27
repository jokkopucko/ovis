import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act } from "react";

import type { AccountIdentity, AccountIdentityChange, AccountIdentityList } from "../lib/account/service.ts";
import type { AccountProvider, AccountSession } from "../lib/account/store.ts";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HostedAccountMethods } from "./AccountMethods.tsx";

type Shell = Parameters<typeof HostedAccountMethods>[0]["signIn"];
type Outcome = ReturnType<NonNullable<Shell["methodsChange"]>>;

// Use local dates: the chip shows the local calendar day of the service's ISO instant.
const at = (day: number): string => new Date(2026, 10, day, 12).toISOString();
const session: AccountSession = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "s", access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000 };
const way = (provider: AccountProvider): AccountIdentity => ({ provider, added_at: at(1) });
const changed = (kind: AccountIdentityChange["kind"], provider: AccountProvider, day: number, device_no: number | null): AccountIdentityChange => ({ kind, provider, at: at(day), device_no });
const ways = (providers: readonly AccountProvider[], history: AccountIdentityChange[] = []): AccountIdentityList => ({ identities: providers.map(way), history });

const shell = (extra: Partial<Shell> = {}): Shell => ({
  provider: "github", account: "acct", session,
  methods: async () => ways(["github", "google"]),
  offered: async () => ["github", "google", "apple"],
  addMethod: async () => {}, removeMethod: async () => {},
  ...extra,
});

describe("the hosted Manage account's ways to sign in", () => {
  let page: Page;

  beforeEach(() => { page = openPage("https://app.ovis.sh/pc/abc"); });
  afterEach(async () => {
    await page.close();
    jest.restoreAllMocks();
  });

  const show = async (signIn: Shell, key = "sheet"): Promise<void> => {
    await page.render(<SettingsProvider><HostedAccountMethods key={key} signIn={signIn} /></SettingsProvider>);
  };
  const press = async (button: HTMLElement): Promise<void> => { await act(async () => { button.click(); }); };
  const providerOf = (node: Element): string | null => node.getAttribute("data-provider");
  const chips = (): Element[] => [...page.container.querySelectorAll("li.account-method")];
  const linked = (): (string | null)[] => chips().map(providerOf);
  const removable = (): (string | null)[] => chips().filter((chip) => chip.querySelector(".account-chip-remove") !== null).map(providerOf);
  const addable = (): (string | null)[] => [...page.container.querySelectorAll("button.account-chip-add")].map(providerOf);
  const add = (provider: AccountProvider): HTMLElement => page.one(`button.account-chip-add[data-provider="${provider}"]`);
  const remove = (provider: AccountProvider): HTMLElement => page.one(`li.account-method[data-provider="${provider}"] .account-chip-remove`);
  const recent = (): string[] => [...page.container.querySelectorAll('[data-testid="account-method-history"] li')].map((line) => line.textContent ?? "");
  const alerts = (): Element[] => [...page.container.querySelectorAll('[role="alert"]')];

  it.each([
    { offered: ["github", "google", "apple"] as const, adds: ["apple"] },
    { offered: ["github", "google"] as const, adds: [] },
    { offered: [] as const, adds: [] },
  ])("shows the account's ways in as chips, and Add only for what the service offers ($offered) and the account lacks", async ({ offered, adds }) => {
    await show(shell({ offered: async () => offered }));
    expect(linked()).toEqual(["github", "google"]);
    expect(addable()).toEqual([...adds]);
  });

  it("asks the shell to add the provider whose Add was pressed", async () => {
    const addMethod = jest.fn(async (_provider: AccountProvider, _shown: AccountSession): Promise<void> => {});
    await show(shell({ addMethod }));
    await press(add("apple"));
    expect(addMethod.mock.calls).toEqual([["apple", session]]);
  });

  it.each([
    { signedInWith: "github", has: ["github", "google", "apple"], removes: ["google", "apple"] },
    { signedInWith: "google", has: ["github", "google"], removes: ["github"] },
    { signedInWith: "google", has: ["github"], removes: [] },
  ] as const)("offers Remove on $removes of $has for a device signed in with $signedInWith: never on its own way in or the only one", async ({ signedInWith, has, removes }) => {
    await show(shell({ provider: signedInWith, methods: async () => ways(has) }));
    expect(linked()).toEqual([...has]);
    expect(removable()).toEqual([...removes]);
  });

  it("removes the way in whose Remove was pressed, then reads the ways in again", async () => {
    let now = ways(["github", "google"]);
    const removeMethod = jest.fn(async (_provider: AccountProvider, _shown: AccountSession): Promise<void> => { now = ways(["github"], [changed("remove", "google", 27, 2)]); });
    await show(shell({ methods: async () => now, removeMethod }));
    await press(remove("google"));
    expect(removeMethod.mock.calls).toEqual([["google", session]]);
    expect(linked()).toEqual(["github"]);
    expect(recent()).toEqual(["Nov 27 · Google removed · Device 2"]);
  });

  it("shows the three latest changes under the chips, with the device only where the service numbers one", async () => {
    await show(shell({ methods: async () => ways(["github", "google"], [
      changed("add", "google", 27, 3), changed("remove", "apple", 20, null), changed("merge_in", "github", 12, 1), changed("add", "apple", 3, 2),
    ]) }));
    expect(recent()).toEqual(["Nov 27 · Google added · Device 3", "Nov 20 · Apple removed", "Nov 12 · GitHub merged in · Device 1"]);
  });

  it("draws no Recent changes block for an account whose ways in never changed", async () => {
    await show(shell());
    expect(linked()).toEqual(["github", "google"]);
    expect(page.container.querySelector('[data-testid="account-method-history"]')).toBeNull();
  });

  it.each([
    { does: "add", provider: "apple", error: "in_use", says: "This Apple account is linked to another Ovis account. Take Apple off that account first, then you can add it here.", steps: true },
    { does: "add", provider: "apple", error: "identity_exists", says: "Your account already signs in with Apple.", steps: false },
    { does: "add", provider: "apple", error: "failed", says: "The sign-in did not finish. Try again.", steps: false },
    { does: "remove", provider: "google", error: "last_identity", says: "Add another way to sign in before removing this one.", steps: false },
    { does: "remove", provider: "google", error: "failed", says: "The sign-in method could not be removed. Try again.", steps: false },
  ] as const)("says under the row why the shell refused to $does a way in ($error), with the steps link only for a provider account another Ovis account holds", async ({ does, provider, error, says, steps }) => {
    let outcome: Outcome;
    const refuse = async (asked: AccountProvider): Promise<void> => { outcome = { account: session.account, provider: asked, error }; };
    await show(shell({ addMethod: refuse, removeMethod: refuse, methodsChange: () => outcome }));
    expect(alerts()).toHaveLength(0);
    await press(does === "add" ? add(provider) : remove(provider));
    expect(alerts().map((alert) => alert.closest(".account-methods") !== null)).toEqual([true]);
    expect(alerts()[0]?.firstChild?.textContent).toBe(says);
    expect(alerts()[0]?.querySelector("a") != null).toBe(steps);
  });

  it("says a link's refusal that came back with the page when the sheet opens, and not again in a sheet opened later", async () => {
    const outcome = { account: session.account, provider: "apple", error: "in_use" } as const;
    const signIn = shell({ methodsChange: () => outcome });
    await show(signIn);
    expect(alerts()).toHaveLength(1);
    await show(signIn, "opened again");
    expect(linked()).toEqual(["github", "google"]);
    expect(alerts()).toHaveLength(0);
  });

  it("shows a returned link's refusal only on the account that asked for it", async () => {
    const outcome = { account: "acct", provider: "apple", error: "expired" } as const;
    const signIn = shell({ account: "acct_other", methodsChange: () => outcome });
    await show(signIn);
    expect(alerts()).toHaveLength(0);
    await show({ ...signIn, account: outcome.account }, "asking account");
    expect(alerts()).toHaveLength(1);
  });

  describe("when the service wants a fresh sign-in first", () => {
    const stale = (): Pick<Shell, "addMethod" | "methodsChange"> & { readonly asked: AccountProvider[]; freshNow(): void } => {
      let outcome: Outcome;
      let fresh = false;
      const asked: AccountProvider[] = [];
      return {
        asked, freshNow: () => { fresh = true; },
        addMethod: async (provider, from) => { asked.push(provider); outcome = { account: from.account, provider, error: fresh ? null : "reauth_required" }; },
        methodsChange: () => outcome,
      };
    };
    const signInAgain = (): HTMLElement | null => page.container.querySelector<HTMLElement>(".account-reauth button");

    it("says to sign in again with the provider this device uses, and its button starts the shell's sign-in with it", async () => {
      const leaves = jest.fn(async (_from: AccountSession, _add: AccountProvider | undefined): Promise<void> => {});
      await show(shell({ ...stale(), signInAgainForMethod: leaves }));
      await press(add("apple"));
      expect(page.one(".account-reauth p").textContent).toBe("To change how you sign in, sign in again with GitHub first.");
      await press(signInAgain()!);
      expect(leaves.mock.calls).toEqual([[session, "apple"]]);
    });

    it("signs in again in place where the shell can, then makes the change that was asked", async () => {
      const link = stale();
      const freshSignIn = jest.fn(async (from: AccountSession): Promise<AccountSession | null> => { link.freshNow(); return from; });
      await show(shell({ ...link, freshSignIn }));
      await press(add("apple"));
      await press(signInAgain()!);
      expect(freshSignIn.mock.calls.map(([from]) => from)).toEqual([session]);
      expect(link.asked).toEqual(["apple", "apple"]);
      expect(alerts()).toHaveLength(0);
    });

    it("only says so where the shell has no sign-in again to offer", async () => {
      await show(shell(stale()));
      await press(add("apple"));
      expect(alerts()).toHaveLength(1);
      expect(signInAgain()).toBeNull();
    });
  });
});
