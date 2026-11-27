import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import { setup } from "../relay/accountController.methods.test-helpers.ts";
import { openPage, type Page } from "../page.fixture.ts";
import { signInReturn } from "./signin.ts";

async function signedOut() {
  const fixture = await setup();
  await fixture.store.set("session", undefined);
  const opened: string[] = [];
  let next = Promise.withResolvers<string>();
  const page = () => fixture.controller((url) => { opened.push(url); next.resolve(url); });
  const callback = async (url: string) => signInReturn(await fixture.callback(url));
  const start = async () => {
    const first = page();
    first.signIn("google");
    const url = await next.promise;
    next = Promise.withResolvers<string>();
    first.dispose();
    return url;
  };
  const hint = async (existingProvider = "github") => {
    const url = new URL(await start());
    const second = page();
    await second.load(signInReturn(new URLSearchParams({
      state: url.searchParams.get("state") ?? "", error: "existing_account", existing_provider: existingProvider,
    }).toString()));
    return second;
  };
  const choose = async (second: Awaited<ReturnType<typeof hint>>, choice: "create" | "connect") => {
    expect(typeof second.chooseAccountHint).toBe("function");
    second.chooseAccountHint(choice);
    return next.promise;
  };
  return { ...fixture, page, callback, start, hint, choose, opened };
}

describe("first sign-in account hint", () => {
  let browser: Page;
  beforeEach(() => { browser = openPage(WEB_REDIRECT); });
  afterEach(async () => { await browser.close(); });

  it.each(["github", "google", "apple", "again", "link"] as const)("sets create only for the first GitHub and Google sign-in (%s)", async (kind) => {
    const fixture = await signedOut();
    const sent = Promise.withResolvers<string>();
    const page = fixture.controller(sent.resolve);
    try {
      if (kind === "again" || kind === "link") {
        const session = await fixture.signIn("github");
        await page.load(null);
        if (kind === "again") await page.signInAgainForMethod(session, undefined);
        else await page.addMethod("google", session);
      } else page.signIn(kind);
      const url = new URL(await sent.promise);
      expect(url.searchParams.get("create")).toBe(kind === "github" || kind === "google" ? "ask" : null);
    } finally { page.dispose(); }
  });

  it("shows the matched provider without redeeming or storing a session", async () => {
    const fixture = await signedOut();
    const page = await fixture.hint();
    try {
      expect(await fixture.store.get("session")).toBeUndefined();
      expect(page.state).toMatchObject({ kind: "signed-out", hint: { provider: "google", existingProvider: "github" } });
    } finally { page.dispose(); }
  });

  it("preserves an Apple match as a create-only hint rather than a cancellation", async () => {
    const fixture = await signedOut();
    const page = await fixture.hint("apple");
    try {
      expect(page.state).toMatchObject({ kind: "signed-out", error: null, hint: { provider: "google", existingProvider: "apple" } });
      const url = new URL(await fixture.choose(page, "create"));
      expect(url.pathname).toBe("/v1/signin/google");
      expect(url.searchParams.has("create")).toBe(false);
    } finally { page.dispose(); }
  });

  it.each(["kept", "cleared"] as const)("does not install or link a stale Connect when another tab's sign-in was %s", async (later) => {
    const fixture = await signedOut();
    const page = await fixture.hint();
    const back = fixture.page();
    try {
      const url = await fixture.choose(page, "connect");
      const returned = await fixture.callback(url);
      const replacement = await fixture.signIn("apple");
      if (later === "cleared") await fixture.store.set("session", undefined);
      const from = fixture.fake.requests.length;
      await back.load(returned);
      expect(await fixture.store.get("session")).toEqual(later === "kept" ? replacement : undefined);
      expect(fixture.fake.requests.slice(from)).toContain("POST /v1/signout");
      expect(fixture.fake.requests.slice(from)).not.toContain("POST /v1/identities/link");
      expect(back.methodsChange).toBeUndefined();
    } finally { page.dispose(); back.dispose(); }
  });

  it("restarts the new provider without create and signs into its new account", async () => {
    const fixture = await signedOut();
    const page = await fixture.hint();
    try {
      const url = await fixture.choose(page, "create");
      expect(new URL(url).searchParams.has("create")).toBe(false);
      await page.load(await fixture.callback(url));
      expect(await fixture.store.get("session")).toMatchObject({ account: "acct_google", provider: "google" });
    } finally { page.dispose(); }
  });

  it.each([null, "two_step_required", "two_step_unknown", "identity_in_use", "merge_open", "reauth_required"] as const)(
    "signs into the existing account and reports the link outcome (%s)", async (refusal) => {
      const fixture = await signedOut();
      const page = await fixture.hint();
      let result = page;
      try {
        const url = await fixture.choose(page, "connect");
        expect(new URL(url).searchParams.get("create")).toBe("never");
        if (refusal !== null) fixture.fake.methodLinkRefusal = refusal;
        result = fixture.page();
        const leaving = await result.load(await fixture.callback(url));
        if (refusal === null) {
          expect(leaving).toBe(true);
          const link = fixture.opened.at(-1) ?? WEB_REDIRECT;
          expect(new URL(link).searchParams.has("create")).toBe(false);
          result.dispose();
          result = fixture.page();
          await result.load(await fixture.callback(link));
        }
        expect(await fixture.store.get("session")).toMatchObject({ account: fixture.before.account, provider: refusal === null ? "google" : "github" });
        expect(result.methodsChange).toMatchObject({ account: fixture.before.account, provider: "google", error: refusal });
        expect((await fixture.service.identities()).identities.map(({ provider }) => provider).sort())
          .toEqual(refusal === null ? ["github", "google"] : ["github"]);
      } finally { page.dispose(); if (result !== page) result.dispose(); }
    },
  );

  it("keeps the hint after the chosen GitHub identity has no Ovis account", async () => {
    const fixture = await signedOut();
    fixture.fake.signInAs("github", "acct_other");
    const page = await fixture.hint();
    try {
      const url = await fixture.choose(page, "connect");
      await page.load(await fixture.callback(url));
      expect(await fixture.store.get("session")).toBeUndefined();
      expect(page.state).toMatchObject({ kind: "signed-out", hint: { provider: "google", existingProvider: "github", noAccount: true } });
    } finally { page.dispose(); }
  });

  it("the fake defers a new identity with a configured email match", async () => {
    const fixture = await signedOut();
    fixture.fake.emailMatches = { google: "github" };
    const url = new URL(await fixture.start());
    url.searchParams.set("create", "ask");
    expect(await fixture.callback(url.href)).toMatchObject({ error: "existing_account", existingProvider: "github" });
  });

  it("still signs in when an older service ignores create", async () => {
    const fixture = await signedOut();
    fixture.fake.emailMatches = { google: "github" };
    fixture.fake.honorsCreate = false;
    const url = new URL(await fixture.start());
    expect(url.searchParams.get("create")).toBe("ask");
    const page = fixture.page();
    try {
      await page.load(await fixture.callback(url.href));
      expect(await fixture.store.get("session")).toMatchObject({ account: "acct_google", provider: "google" });
    } finally { page.dispose(); }
  });
});
