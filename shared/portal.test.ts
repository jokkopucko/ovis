import { describe, expect, it } from "bun:test";
import { checkClientId, checkEntry, checkIssuer, checkPortalAuth, NO_PORTAL_AUTH } from "./portal.ts";

const WALLET = "0x52908400098527886E0F7030069857D2E4169EE7";
const problem = (checked: object) => "problem" in checked ? checked.problem : null;

describe("an allow-list entry", () => {
  it("takes a link name of 1 to 256 printable ASCII characters, spaces included", () => {
    expect(checkEntry("credential", "  Alice Smith  ")).toEqual({ entry: "Alice Smith" });
    expect(checkEntry("credential", "-bob")).toEqual({ entry: "-bob" });
    expect(checkEntry("credential", "x".repeat(256))).toEqual({ entry: "x".repeat(256) });
    // outside Portal's own rules, on purpose: a name reaches this server in an HTTP header, which carries ASCII only
    for (const refused of ["", "   ", "x".repeat(257), "tab\tinside", "line\nbreak", "\u0085", "김철수", "café"]) {
      expect(problem(checkEntry("credential", refused))).toBe("name");
    }
  });

  it("takes an Ethereum address in any case and refuses anything else", () => {
    expect(checkEntry("siwe", ` ${WALLET} `)).toEqual({ entry: WALLET });
    expect(checkEntry("siwe", WALLET.toLowerCase())).toEqual({ entry: WALLET.toLowerCase() });
    for (const refused of ["", "0x1234", WALLET.slice(2), `${WALLET}0`, `0x${"g".repeat(40)}`, `${WALLET} ${WALLET}`]) {
      expect(problem(checkEntry("siwe", refused))).toBe("wallet");
    }
  });

  it("takes a verified email, an @domain or a sub:<id> for OIDC, lower-casing only the first two", () => {
    expect(checkEntry("oidc", " Me@Example.COM ")).toEqual({ entry: "me@example.com" });
    expect(checkEntry("oidc", "@Example.com")).toEqual({ entry: "@example.com" });
    expect(checkEntry("oidc", "sub:AbC123")).toEqual({ entry: "sub:AbC123" });
    expect(checkEntry("oidc", "SUB: AbC123 ")).toEqual({ entry: "sub:AbC123" });
    // an email-shaped id is still an id: the prefix keeps it from standing for an email entry
    expect(checkEntry("oidc", "sub:Me@Example.com")).toEqual({ entry: "sub:Me@Example.com" });
    for (const refused of ["", "me", "example.com", "@", "me@", "a@b@c.example", "me @example.com", "me@exa mple.com", "sub:", "sub:   ", "me@exämple.com", "안녕@example.com", "sub:\u0001"]) {
      expect(problem(checkEntry("oidc", refused))).toBe("principal");
    }
  });
});

describe("the identity provider", () => {
  it("is an https address without credentials, query or fragment, kept as typed but for a trailing slash", () => {
    expect(checkIssuer(" https://accounts.google.com/ ")).toEqual({ issuer: "https://accounts.google.com" });
    expect(checkIssuer("https://login.example.com/tenant-1/v2.0")).toEqual({ issuer: "https://login.example.com/tenant-1/v2.0" });
    expect(checkIssuer("https://sso.example.com:8443")).toEqual({ issuer: "https://sso.example.com:8443" });
    for (const refused of ["", "accounts.google.com", "http://accounts.google.com", "ftp://x.example", "https://", "https://user:pass@x.example", "https://x.example?a=1", "https://x.example/?", "https://x.example#frag", "https://x.example/#", "https://x .example", "https://exämple.com", `https://x.example/${"a".repeat(2048)}`]) {
      expect(problem(checkIssuer(refused))).toBe("issuer");
    }
  });

  it("has a client ID of up to 256 characters with no spaces", () => {
    expect(checkClientId(" 123-abc.apps.googleusercontent.com ")).toEqual({ clientId: "123-abc.apps.googleusercontent.com" });
    for (const refused of ["", "  ", "two words", "x".repeat(257), "id\u0001"]) expect(problem(checkClientId(refused))).toBe("client_id");
  });
});

describe("a sign-in, as a request or the saved state says it", () => {
  const oidc = { method: "oidc", allow: ["Me@Example.com", "me@example.com", "@example.com", "sub:A", "sub:a"], issuer: "https://accounts.google.com/", client_id: "client-1" };

  it("is no sign-in when nothing is named, and drops what only a sign-in carries", () => {
    for (const unset of [undefined, null, { method: "none" }, { method: "none", allow: ["alice"], issuer: "https://x.example", client_id: "c" }]) {
      expect(checkPortalAuth(unset)).toEqual({ auth: NO_PORTAL_AUTH });
    }
  });

  it("lets a private link list be empty (any link works) or hold names, without duplicates", () => {
    expect(checkPortalAuth({ method: "credential" })).toEqual({ auth: { method: "credential", allow: [], issuer: null, client_id: null } });
    expect(checkPortalAuth({ method: "credential", allow: [" alice ", "Alice", "alice", "bob smith"], issuer: "https://x.example", client_id: "c" }))
      .toEqual({ auth: { method: "credential", allow: ["alice", "Alice", "bob smith"], issuer: null, client_id: null } });
  });

  it("refuses Ethereum with no wallet: with none, any wallet would reach every terminal", () => {
    expect(problem(checkPortalAuth({ method: "siwe" }))).toBe("no_wallet");
    expect(problem(checkPortalAuth({ method: "siwe", allow: [] }))).toBe("no_wallet");
    expect(checkPortalAuth({ method: "siwe", allow: [WALLET, WALLET.toLowerCase()] })).toEqual({ auth: { method: "siwe", allow: [WALLET], issuer: null, client_id: null } });
  });

  it("settles OIDC: an issuer, a client ID and at least one entry, which Portal also requires", () => {
    expect(checkPortalAuth(oidc)).toEqual({ auth: { method: "oidc", allow: ["me@example.com", "@example.com", "sub:A", "sub:a"], issuer: "https://accounts.google.com", client_id: "client-1" } });
    expect(problem(checkPortalAuth({ ...oidc, allow: [] }))).toBe("no_principal");
    expect(problem(checkPortalAuth({ ...oidc, issuer: "http://accounts.google.com" }))).toBe("issuer");
    expect(problem(checkPortalAuth({ ...oidc, issuer: undefined }))).toBe("issuer");
    expect(problem(checkPortalAuth({ ...oidc, client_id: null }))).toBe("client_id");
    expect(problem(checkPortalAuth({ ...oidc, allow: ["not-an-email"] }))).toBe("principal");
  });

  it("refuses what is not a sign-in", () => {
    for (const input of ["credential", 7, [], { method: "saml" }, { method: "credential", allow: "alice" }, { method: "credential", allow: [1] }, { allow: ["alice"] }]) {
      expect(problem(checkPortalAuth(input))).toBe("invalid");
    }
  });
});
