import { describe, expect, it } from "bun:test";
import { PORTAL_AUTH_PROBLEMS } from "../../shared/portal.ts";
import { authOf, authProblem, draftOf, GOOGLE_ISSUER, redirectAddress, withEntry } from "./portalAuth.ts";

const NONE = { method: "none", allow: [], issuer: null, client_id: null } as const;
const WALLET = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("the Portal sign-in form", () => {
  it("starts from what Portal ran with, keeps each sign-in's list apart, and offers Google for a new OIDC", () => {
    expect(authOf(draftOf(NONE))).toEqual(NONE);
    expect(draftOf(NONE)).toMatchObject({ method: "none", issuer: GOOGLE_ISSUER, clientId: "", allow: { credential: [], siwe: [], oidc: [] } });
    const wallets = { method: "siwe", allow: [WALLET], issuer: null, client_id: null } as const;
    expect(draftOf(wallets).allow).toEqual({ credential: [], siwe: [WALLET], oidc: [] });
    expect(authOf(draftOf(wallets))).toEqual(wallets);
    const oidc = { method: "oidc", allow: ["me@example.com"], issuer: "https://login.example.com", client_id: "client-1" } as const;
    expect(authOf(draftOf(oidc))).toEqual(oidc);
    // switching to another sign-in asks for that one's list, not the last one typed
    expect(authOf({ ...draftOf(wallets), method: "credential" })).toEqual({ method: "credential", allow: [], issuer: null, client_id: null });
    // and an OIDC address typed earlier is not sent with a wallet
    expect(authOf({ ...draftOf(oidc), method: "siwe" })).toMatchObject({ method: "siwe", issuer: null, client_id: null });
  });

  it("says what the server would refuse, in the server's own words", () => {
    const oidc = draftOf({ method: "oidc", allow: ["me@example.com"], issuer: GOOGLE_ISSUER, client_id: "client-1" });
    expect(authProblem(oidc)).toBeNull();
    expect(authProblem({ ...oidc, clientId: "" })).toBe("client_id");
    expect(authProblem({ ...oidc, issuer: "http://login.example.com" })).toBe("issuer");
    expect(authProblem({ ...oidc, allow: { ...oidc.allow, oidc: [] } })).toBe("no_principal");
    expect(authProblem({ ...draftOf(NONE), method: "siwe" })).toBe("no_wallet");
    // a private link needs no name, and no sign-in needs nothing at all
    expect(authProblem({ ...draftOf(NONE), method: "credential" })).toBeNull();
    expect(authProblem(draftOf(NONE))).toBeNull();
    expect(PORTAL_AUTH_PROBLEMS[authProblem({ ...draftOf(NONE), method: "siwe" })!]).toContain("any wallet");
  });

  it("adds an entry in Portal's form, once, and says why it cannot", () => {
    expect(withEntry([], "oidc", " Me@Example.com ")).toEqual({ list: ["me@example.com"] });
    expect(withEntry(["me@example.com"], "oidc", "ME@example.com")).toEqual({ problem: "duplicate" });
    expect(withEntry(["Alice"], "credential", "alice")).toEqual({ list: ["Alice", "alice"] });
    expect(withEntry([WALLET], "siwe", WALLET.toLowerCase())).toEqual({ problem: "duplicate" });
    expect(withEntry([], "siwe", "0x1234")).toEqual({ problem: "wallet" });
    expect(withEntry([], "credential", "김철수")).toEqual({ problem: "name" });
    expect(withEntry([], "oidc", "me")).toEqual({ problem: "principal" });
  });

  it("names the address to register with the provider", () => {
    expect(redirectAddress("https://herdr-test-0123.relay.example")).toBe("https://herdr-test-0123.relay.example/_portal/auth/callback");
  });
});
