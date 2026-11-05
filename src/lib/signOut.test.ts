import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import type { HealthAuth } from "../../shared/protocol.ts";
import { canSignOut, endSignIn } from "./signOut.ts";

const in_ = (patch: Partial<HealthAuth>): HealthAuth => ({ required: false, authenticated: true, role: "drive", ...patch });

describe("which sign-ins this browser can end", () => {
  it("ends a token it typed, a paired device's and Portal's own sign-in", () => {
    expect(canSignOut(in_({ via: "token" }))).toBe(true);
    expect(canSignOut(in_({ via: "device" }))).toBe(true);
    expect(canSignOut(in_({ via: "portal", portal: { user: "alice", method: "credential" } }))).toBe(true);
  });

  it("does not offer it where there is nothing to forget or it would come right back", () => {
    // a proxy sends its token with every request
    expect(canSignOut(in_({ via: "token", bearer: true }))).toBe(false);
    // this PC, the Tailscale login and an open server hold no sign-in of this browser's
    for (const via of ["local", "tailscale", "open"] as const) expect(canSignOut(in_({ via }))).toBe(false);
    expect(canSignOut(in_({}))).toBe(false);
    expect(canSignOut({ required: true, authenticated: false, reason: "token_required" })).toBe(false);
    expect(canSignOut(null)).toBe(false);
  });
});

describe("ending a sign-in", () => {
  const calls: { url: string; method: string | undefined }[] = [];
  // what the app says about this browser once its own sign-in is gone
  let left: HealthAuth["via"] = undefined;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    // herdr is down: only the bridge's health answers, and signing out must not need more
    if (String(url) === "/api/health") return new Response(null, { status: 502 });
    return String(url) === "/api/health?scope=bridge" ? Response.json({ auth: in_({ via: left }) }) : new Response(null, { status: 204 });
  }, { preconnect: globalThis.fetch.preconnect }));
  afterAll(() => fetchSpy.mockRestore());
  afterEach(() => { calls.length = 0; left = undefined; });

  it("asks Portal to sign a Portal visitor out, and has the page load what Portal answers with", async () => {
    expect(await endSignIn("portal")).toEqual({ reload: true });
    expect(calls).toEqual([{ url: "/_portal/auth/logout", method: "POST" }]);
  });

  it("asks the app to sign the others out, which then shows its own gate", async () => {
    for (const via of ["token", "device"] as const) {
      calls.length = 0;
      expect(await endSignIn(via)).toEqual({ reload: false });
      expect(calls).toEqual([{ url: "/api/auth", method: "DELETE" }, { url: "/api/health?scope=bridge", method: undefined }]);
    }
  });

  for (const via of ["token", "device"] as const) {
    it(`ends Portal's sign-in too when it is what the ${via} session leaves behind`, async () => {
      left = "portal";
      expect(await endSignIn(via)).toEqual({ reload: true });
      expect(calls).toEqual([{ url: "/api/auth", method: "DELETE" }, { url: "/api/health?scope=bridge", method: undefined }, { url: "/_portal/auth/logout", method: "POST" }]);
    });
  }
});
