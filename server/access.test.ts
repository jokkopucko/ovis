import { describe, expect, it } from "bun:test";
import { bindScope, cameThroughProxy, decideAccess, forwardingHeaders, isLoopbackAddress, isLoopbackBind, isLoopbackHost, lanExposed, observedIngress, type AccessInput } from "./access.ts";

const device = { id: "d1", label: "Phone", role: "drive" as const };
const base: AccessInput = { loopback: true, forwarded: false, funnel: false, tailscaleLogin: null, forwardedFor: "100.64.0.9", host: null, tokenMatched: false, device: null, owner: null, tagged: false, soleLogin: null, dnsName: null, tailnetIp: null, serveOnly: false, tokenConfigured: false, gated: false };
const NODE = "pc.tail5cc90b.ts.net";
const IP = "100.64.0.7";
const node = { host: NODE, dnsName: NODE, tailnetIp: IP } as const;
const via = (input: Partial<AccessInput>) => { const a = decideAccess({ ...base, ...input }); return a.level === "full" ? a.via : `refused:${a.reason}`; };

describe("decideAccess", () => {
  it("uses the authenticated relay principal before every socket credential", () => {
    const relayPeer = { id: "relay-device", label: "Relay phone", role: "watch" as const };
    expect(decideAccess({
      ...base, relayPeer, device, tokenMatched: true, tokenConfigured: true,
      tailscaleLogin: "another@example.com", owner: "owner@example.com", gated: true,
      portal: { proven: true, user: "owner", auth: "credential", role: "drive" },
    })).toEqual({ level: "full", via: "relay", role: "watch", device: relayPeer });
  });
  for (const forwardedFor of [null, "127.0.0.1", "203.0.113.50", "100.101.102.103, 100.64.0.9", "100.63.255.255", "100.128.0.0", "fd7a:115c:a1e1::1", "100.64.0.999", "::ffff:100.64.0.9"]) {
    it(`regression: refuses a login forwarded for ${forwardedFor}`, () => {
      const input = { ...base, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com", forwardedFor };
      expect(decideAccess(input)).toEqual({ level: "none", reason: "pairing_required" });
    });
  }

  for (const forwardedFor of ["100.101.102.103", "100.64.0.0", "100.127.255.255", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:0:0:0:0:1"]) {
    it(`control: accepts a login forwarded for ${forwardedFor}`, () => {
      const input = { ...base, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com", forwardedFor };
      expect(decideAccess(input)).toMatchObject({ level: "full", via: "tailscale" });
    });
  }

  it("regression: a rejected login never falls through to the serve-only owner grant", () => {
    const input = { ...base, ...node, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com", soleLogin: "me@example.com", serveOnly: true, forwardedFor: "127.0.0.1" };
    expect(decideAccess(input)).toEqual({ level: "none", reason: "pairing_required" });
  });

  it("lets this PC in without a token, but not through a proxy", () => {
    expect(via({})).toBe("local");
    expect(via({ forwarded: true, gated: true })).toBe("refused:pairing_required");
  });

  it("keeps everything open, as before, while no token and no device exist", () => {
    expect(via({ loopback: false })).toBe("open");
    expect(via({ loopback: true, forwarded: true })).toBe("open");
    expect(via({ loopback: false, gated: true })).toBe("refused:pairing_required");
  });

  it("never treats a Funnel request as open", () => {
    expect(via({ loopback: true, forwarded: true, funnel: true })).toBe("refused:pairing_required");
    expect(via({ loopback: true, forwarded: true, funnel: true, device })).toBe("device");
  });

  it("trusts the PC's own Tailscale login only from the local tailscaled", () => {
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ forwarded: true, tailscaleLogin: "Me@Example.com", owner: "me@example.com" })).toBe("tailscale");
    expect(via({ forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com", gated: true })).toBe("refused:other_user");
    expect(via({ forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com" })).toBe("refused:other_user");
    // a LAN client can type any header: from off this machine it means nothing
    expect(via({ loopback: false, tailscaleLogin: "me@example.com", owner: "me@example.com", gated: true })).toBe("refused:pairing_required");
    // no login from tailscale serve is a tagged node, not a person: it pairs like any other device
    expect(via({ forwarded: true, owner: "me@example.com" })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, owner: "me@example.com", device })).toBe("device");
    // no owner known yet: the header decides nothing either way
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: null })).toBe("open");
  });

  it("lets the owner's own device in through serve with no login, when serve is declared the only ingress and one login owns the tailnet", () => {
    // the phone's shape: tailscale serve proxies from loopback, states no person, and the Host is this PC's name
    const phone = { forwarded: true, owner: "me@example.com", soleLogin: "me@example.com", serveOnly: true, ...node } as const;
    expect(via(phone)).toBe("tailscale");
    expect(via({ ...phone, gated: true })).toBe("tailscale");
    expect(decideAccess({ ...base, ...phone })).toEqual({ level: "full", via: "tailscale", role: "drive", login: "me@example.com" });
    // the same request where the operator did not declare serve the only ingress pairs, as it always did
    expect(via({ ...phone, serveOnly: false })).toBe("refused:pairing_required");
    // and where Tailscale proves nothing, it is the stranger it always was
    expect(via({ ...phone, soleLogin: null })).toBe("refused:pairing_required");
    // with the name unknown, a Host that could be this PC's cannot be taken for it
    expect(via({ ...phone, dnsName: null, tailnetIp: null })).toBe("refused:pairing_required");
  });

  it("grants only on this PC's tailnet name or address, in any case, with a trailing dot or a port", () => {
    const phone = { forwarded: true, owner: "me@example.com", soleLogin: "me@example.com", serveOnly: true, dnsName: NODE, tailnetIp: IP } as const;
    for (const host of [`${NODE}:7317`, NODE.toUpperCase(), `${NODE}.`, `${NODE}.:443`, IP, `${IP}:7317`]) expect(via({ ...phone, host })).toBe("tailscale");
    // a rebinding page or a public domain forwarded here presents its own name, never this PC's
    for (const host of [null, "evil.example", "evil.example:7317", `${NODE}.evil.example`, "herdr.example.com:7317", "100.64.0.8", `[${IP}]`, "[fd7a::1]:7317"]) {
      expect(via({ ...phone, host })).toBe("refused:pairing_required");
    }
  });

  it("holds the floor the sole-login rule sits on: another user, Funnel, a token, a tag, a LAN client, a named owner that is not the sole login", () => {
    const sole = { forwarded: true, owner: "me@example.com", soleLogin: "me@example.com", serveOnly: true, ...node } as const;
    // a login Tailscale did stage is still read, and still refused when it is not the owner's
    expect(via({ ...sole, tailscaleLogin: "them@example.com" })).toBe("refused:other_user");
    expect(via({ ...sole, tailscaleLogin: "me@example.com" })).toBe("tailscale");
    // the public internet proves nothing about who is asking, whoever owns the tailnet
    expect(via({ ...sole, funnel: true })).toBe("refused:pairing_required");
    expect(via({ ...sole, funnel: true, gated: true })).toBe("refused:pairing_required");
    // a token still gates everything but a paired device
    expect(via({ ...sole, tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ ...sole, tokenConfigured: true, tokenMatched: true })).toBe("token");
    // a tagged PC names no owner to be: its visitors pair, as before
    expect(via({ forwarded: true, tagged: true, soleLogin: "me@example.com", serveOnly: true })).toBe("refused:pairing_required");
    // off this machine the rule buys nothing: any LAN client could claim the same proxy
    expect(via({ ...sole, loopback: false, gated: true })).toBe("refused:pairing_required");
    expect(via({ ...sole, loopback: false, tailscaleLogin: "me@example.com", gated: true })).toBe("refused:pairing_required");
    // a named owner the tailnet's sole login does not match keeps the refusal it had
    expect(via({ ...sole, owner: "named@example.com" })).toBe("refused:pairing_required");
  });

  it("asks a tagged PC's visitors to pair, its owner included, and never calls them another user", () => {
    // the node names no person: there is no login to match, and none to be a stranger to
    expect(via({ forwarded: true, tagged: true, tailscaleLogin: "me@example.com" })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, tagged: true })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, tagged: true, tailscaleLogin: "me@example.com", tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ forwarded: true, tagged: true, tailscaleLogin: "me@example.com", device })).toBe("device");
    expect(via({ tagged: true })).toBe("local");
    // a login header alone marks a proxy: with no owner to refuse it against, it must not pass for this PC
    expect(cameThroughProxy(new Headers({ host: "localhost:7317", "tailscale-user-login": "them@example.com" }))).toBe(true);
    // a login named for the PC lets that person in as on any other node
    expect(via({ forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("tailscale");
  });

  it("a configured token gates everything but a paired device, this PC and its Tailscale login included", () => {
    expect(via({ tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, tokenMatched: true })).toBe("token");
    expect(via({ tokenConfigured: true, device })).toBe("device");
    // any proxy on this PC can pass a visitor's copy of the login header on: a token holds against it
    expect(via({ tokenConfigured: true, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com" })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, tokenMatched: true, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("token");
    expect(via({ tokenConfigured: true, device, forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" })).toBe("device");
  });

  it("a paired device gets in from anywhere, with its role", () => {
    const access = decideAccess({ ...base, loopback: false, gated: true, device: { ...device, role: "watch" } });
    expect(access).toEqual({ level: "full", via: "device", role: "watch", device: { ...device, role: "watch" } });
  });

  it("knows a name for this machine from a proxied Host", () => {
    for (const host of ["localhost", "localhost:7317", "LOCALHOST:5173", "herdr.localhost:7317", "127.0.0.1:7317", "127.9.9.9", "[::1]:7317", "localhost.:7317", "[::ffff:127.0.0.1]:7317"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["app.example.test", "app.example.test:8443", "192.168.0.10:7317", "localhost.example.test", "127.0.0.1.example.test", "[fd7a::1]:7317", "", "0.0.0.0:7317", "[::ffff:192.168.0.10]"]) expect(isLoopbackHost(host)).toBe(false);
    // not an authority: a URL parser would have read these as localhost
    for (const host of ["public.example@localhost:7317", "localhost/x@public.example", "localhost:7317/x", "localhost?x", "local host", "localhost:port", "localhost..", "127.0.0.1@public.example"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("sees a proxy in a forwarding header or in a Host that is not this machine", () => {
    const proxy = (headers: Record<string, string>) => cameThroughProxy(new Headers(headers));
    expect(proxy({ host: "localhost:7317" })).toBe(false);
    expect(proxy({ host: "127.0.0.1:7317", origin: "http://127.0.0.1:7317" })).toBe(false);
    // no Host at all: HTTP/1.0 through a proxy, never a local browser or CLI
    expect(proxy({})).toBe(true);
    expect(proxy({ host: "public.example@localhost:7317" })).toBe(true);
    expect(proxy({ host: "app.example.test" })).toBe(true);
    for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via"]) expect(proxy({ host: "127.0.0.1:7317", [name]: "x" })).toBe(true);
  });

  it("knows loopback addresses in every spelling", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["192.168.0.10", "100.64.0.2", "::ffff:192.168.0.10", "fd7a::1"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("Portal's sign-in", () => {
  // what a request through the running Portal looks like: the identity it states, and its proof
  const HOST = "herdr-test-0123.relay.example";
  const WALLET = "0x52908400098527886E0F7030069857D2E4169EE7";
  const through = (portal: Partial<NonNullable<AccessInput["portal"]>> = {}, over: Partial<AccessInput> = {}): Partial<AccessInput> => ({
    tokenConfigured: true, forwarded: true, host: HOST, portal: { proven: true, user: "alice", auth: "credential", ...portal }, ...over,
  });
  const REFUSED = "refused:token_required";

  // a visitor can type X-Portal-User wherever Portal is not the one carrying the request; only Portal has the proof
  const cases: [string, Partial<AccessInput>, string][] = [
    ["the identity of a request that carries the Portal's proof, like a device that may watch", through(), "portal"],
    ["whatever Host, forwarding headers or Tailscale login come with it: the proof is the only condition", through({}, { host: "anything.example", forwardedFor: "100.64.0.9", tailscaleLogin: "me@example.com", owner: "me@example.com", funnel: true }), "portal"],
    ["a request with no proof, from loopback, naming Portal's public host", through({ proven: false }), REFUSED],
    ["a request with no proof, from off this machine", through({ proven: false }, { loopback: false }), REFUSED],
    ["a request with no proof, through a proxy that sends the Host and the forwarding headers", through({ proven: false }, { forwardedFor: "203.0.113.9", host: HOST }), REFUSED],
    ["a request with no proof, through a tagged tailscale serve", through({ proven: false }, { forwardedFor: "100.64.0.9", host: HOST, tagged: true }), REFUSED],
    ["no Portal sign-in started: nothing has a proof to carry, so the headers mean nothing", { ...through(), portal: undefined }, REFUSED],
    ["no user", through({ user: null }), REFUSED],
    ["no method", through({ auth: null }), REFUSED],
    ["an empty user", through({ user: "" }), REFUSED],
    ["a user with a control character", through({ user: "alice\u0007" }), REFUSED],
    ["a user with other than printable ASCII", through({ user: "김철수" }), REFUSED],
    ["a user with spaces around it", through({ user: " alice " }), REFUSED],
    ["a user of 261 characters", through({ user: "a".repeat(261) }), REFUSED],
    ["a method Portal does not have", through({ auth: "saml" }), REFUSED],
    ["a method in another case", through({ auth: "Credential" }), REFUSED],
    ["a link name of 256 characters, spaces inside", through({ user: `${"a ".repeat(127)}ab` }), "portal"],
    ["a wallet that is an address", through({ user: WALLET, auth: "siwe" }), "portal"],
    ["a wallet that is not", through({ user: "alice", auth: "siwe" }), REFUSED],
    ["an email for OIDC", through({ user: "me@example.com", auth: "oidc" }), "portal"],
    ["an id for OIDC", through({ user: "sub:1234567890", auth: "oidc" }), "portal"],
    ["a bare word for OIDC", through({ user: "alice", auth: "oidc" }), REFUSED],
  ];
  for (const [name, input, expected] of cases) it(`${expected === "portal" ? "accepts" : "ignores"} ${name}`, () => {
    expect(via(input)).toBe(expected);
  });

  it("says who signed in and how, and defaults every Portal method to watch", () => {
    for (const [user, method] of [["alice", "credential"], [WALLET, "siwe"], ["me@example.com", "oidc"]] as const) {
      expect(decideAccess({ ...base, ...through({ user, auth: method }) })).toEqual({ level: "full", via: "portal", role: "watch", portal: { user, method } });
    }
  });

  it("is believed after the token and a paired device, never before them", () => {
    expect(decideAccess({ ...base, ...through(), tokenMatched: true })).toMatchObject({ via: "token", role: "drive" });
    expect(decideAccess({ ...base, ...through(), device })).toMatchObject({ via: "device", role: "drive" });
    expect(decideAccess({ ...base, ...through(), device: { ...device, role: "watch" } })).toMatchObject({ via: "device", role: "watch" });
  });

  it("uses a stored invitation role only with a proven Portal identity", () => {
    expect(decideAccess({ ...base, ...through({ role: "watch" }) })).toMatchObject({ via: "portal", role: "watch" });
    expect(decideAccess({ ...base, ...through({ role: "drive" }) })).toMatchObject({ via: "portal", role: "drive" });
    expect(via(through({ role: "drive", proven: false }))).toBe(REFUSED);
  });

  it("changes nothing for a request that has no proof", () => {
    const forged = { proven: false, user: "alice", auth: "credential" };
    const requests: Partial<AccessInput>[] = [
      {}, { forwarded: true, gated: true }, { loopback: false }, { loopback: false, gated: true }, { tokenConfigured: true }, { tokenConfigured: true, tokenMatched: true }, { tokenConfigured: true, device },
      { forwarded: true, tailscaleLogin: "me@example.com", owner: "me@example.com" }, { forwarded: true, tailscaleLogin: "them@example.com", owner: "me@example.com", tokenConfigured: true },
      { forwarded: true, funnel: true }, { forwarded: true, tagged: true, tailscaleLogin: "me@example.com" },
      { forwarded: true, owner: "me@example.com", soleLogin: "me@example.com", serveOnly: true, ...node },
    ];
    for (const request of requests) {
      expect(decideAccess({ ...base, ...request, portal: forged })).toEqual(decideAccess({ ...base, ...request }));
      expect(decideAccess({ ...base, ...request, host: HOST, portal: forged })).toEqual(decideAccess({ ...base, ...request, host: HOST }));
    }
  });
});

describe("lanExposed", () => {
  const open = { hostname: "0.0.0.0", tokenConfigured: false, gated: false };
  const warned = (over: Partial<typeof open>): boolean => lanExposed({ ...open, ...over });

  it("names the one state a warning belongs to: bound past this PC, no token, nothing paired", () => {
    expect(lanExposed(open)).toBe(true);
    // wildcard, LAN, other IPv6 and DNS binds still warn, even on a PC with Tailscale
    for (const hostname of ["::", "[::]", "192.168.0.10", "fd7a::1", "my-pc.local", "127.devbox.example", "localhost.example", "100.63.255.255", "100.128.0.0", "fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff", "fd7a:115c:a1e1::", "100.64.0.999", "100.64.0.2.example"]) {
      expect(isLoopbackBind(hostname)).toBe(false);
      expect(warned({ hostname })).toBe(true);
    }
  });

  for (const hostname of ["100.64.0.0", "100.64.0.2", "100.127.255.255", "fd7a:115c:a1e0::", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff", "FD7A:115C:A1E0:0:0:0:0:1", "[fd7a:115c:a1e0::1]", " 100.64.0.2 "]) {
    it(`does not warn for a Tailscale-only bind at ${hostname}`, () => {
      expect(isLoopbackBind(hostname)).toBe(false);
      expect(warned({ hostname })).toBe(false);
    });
  }

  it("is quiet whenever one of the three is not the case", () => {
    // a loopback bind is unreachable from the network however it is addressed or spelt
    for (const hostname of ["127.0.0.1", "localhost", "::1", "127.0.0.2", "[::1]", "LOCALHOST", "::ffff:127.0.0.1", "app.localhost", " localhost "]) {
      expect(isLoopbackBind(hostname)).toBe(true);
      expect(warned({ hostname })).toBe(false);
    }
    // a token means a stranger is asked for it, and a paired device means the gate is closed
    expect(warned({ tokenConfigured: true })).toBe(false);
    expect(warned({ gated: true })).toBe(false);
    expect(warned({ tokenConfigured: true, gated: true })).toBe(false);
  });
});

describe("bindScope", () => {
  it("reads every loopback spelling as loopback, never a name that merely resolves there", () => {
    for (const hostname of ["127.0.0.1", "localhost", "::1", "127.0.0.2", "[::1]", "LOCALHOST", "::ffff:127.0.0.1", "app.localhost", " localhost "]) expect(bindScope(hostname)).toBe("loopback");
    for (const hostname of ["127.devbox.example", "localhost.example"]) expect(bindScope(hostname)).toBe("other");
  });

  it("reads Tailscale address literals as tailnet", () => {
    for (const hostname of ["100.64.0.0", "100.127.255.255", "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0::1]", "FD7A:115C:A1E0:0:0:0:0:1", " 100.64.0.2 "]) expect(bindScope(hostname)).toBe("tailnet");
  });

  it("reads wildcards, LAN addresses and names as other, matching where lanExposed warns", () => {
    for (const hostname of ["0.0.0.0", "::", "[::]", "192.168.0.10", "fd7a::1", "my-pc.local", "100.63.255.255", "100.128.0.0", "fd7a:115c:a1e1::", "100.64.0.2.example"]) {
      expect(bindScope(hostname)).toBe("other");
      expect(lanExposed({ hostname, tokenConfigured: false, gated: false })).toBe(true);
    }
  });
});

describe("observedIngress", () => {
  // a request from this PC's own browser, with Tailscale running here and nothing forwarded
  type Request = Parameters<typeof observedIngress>[0];
  const local: Request = { peerKnown: true, loopback: true, forwarded: false, forwardingHeaders: false, funnel: false, tailscaleLogin: null, forwardedFor: null, owner: "owner@example.com", tagged: false, serveOnly: false };
  const ingress = (over: Partial<Request>) => observedIngress({ ...local, ...over });
  // what tailscale serve sends on an install that declared it the only ingress: from loopback, its own login header and a tailnet source address
  const serve = { forwarded: true, forwardingHeaders: true, tailscaleLogin: "owner@example.com", forwardedFor: "100.64.0.9", serveOnly: true };

  it("calls an unforwarded request direct, from this PC or from the network", () => {
    expect(ingress({})).toBe("direct");
    // a LAN client addresses the server by its LAN name; that Host alone is no forwarding
    expect(ingress({ loopback: false, forwarded: true })).toBe("direct");
  });

  it("labels Tailscale only on the shape Tailscale itself produces, where serve is declared the only ingress", () => {
    expect(ingress(serve)).toBe("tailscale");
    expect(ingress({ ...serve, owner: null, tagged: true })).toBe("tailscale");
    // a tagged node or the owner's grant sends no login
    expect(ingress({ ...serve, tailscaleLogin: null })).toBe("tailscale");
    expect(ingress({ ...serve, tailscaleLogin: null, serveOnly: false })).toBe("proxy");
  });

  it("keeps forwarded-but-unverified Tailscale headers unknown", () => {
    // without the declaration any client or proxy on this PC can send the very same shape
    expect(ingress({ ...serve, serveOnly: false })).toBe("unknown");
    expect(ingress({ ...serve, serveOnly: false, owner: null, tagged: true })).toBe("unknown");
    // a LAN client can send the login header itself
    expect(ingress({ ...serve, loopback: false })).toBe("unknown");
    // another proxy on this PC passing a visitor's copy on: the source is not a tailnet address
    expect(ingress({ ...serve, forwardedFor: "203.0.113.7" })).toBe("unknown");
    expect(ingress({ ...serve, forwardedFor: null })).toBe("unknown");
    // Tailscale does not run here: nothing could have written the header
    expect(ingress({ ...serve, owner: null, tagged: false })).toBe("unknown");
    // a Funnel header is trusted only where serve is declared the only ingress
    expect(ingress({ ...serve, tailscaleLogin: null, forwardedFor: "203.0.113.7", funnel: true, serveOnly: false })).toBe("unknown");
    expect(ingress({ ...serve, tailscaleLogin: null, forwardedFor: "203.0.113.7", funnel: true, loopback: false })).toBe("unknown");
    expect(ingress({ peerKnown: false })).toBe("unknown");
  });

  it("labels Funnel only with trusted public-ingress evidence", () => {
    expect(ingress({ ...serve, tailscaleLogin: null, forwardedFor: "203.0.113.7", funnel: true })).toBe("funnel");
  });

  it("calls any other forwarding a proxy, including a rewritten Host from this PC", () => {
    expect(ingress({ forwarded: true, forwardingHeaders: true, forwardedFor: "192.168.0.20" })).toBe("proxy");
    expect(ingress({ loopback: false, forwarded: true, forwardingHeaders: true })).toBe("proxy");
    expect(ingress({ forwarded: true })).toBe("proxy");
  });

  it("finds forwarding headers, but not in a Host header alone", () => {
    expect(forwardingHeaders(new Headers({ host: "192.168.0.10:7317" }))).toBe(false);
    for (const name of ["x-forwarded-for", "forwarded", "via", "x-real-ip", "tailscale-user-login", "tailscale-funnel-request"]) expect(forwardingHeaders(new Headers({ [name]: "x" }))).toBe(true);
  });
});
