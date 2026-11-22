import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error app/web is plain JavaScript the app carries as is, without types
import { APP_ORIGIN, homeHost, listedProviders, loopbackHost, openFailure, parseAddress, relayLink, sshDetails, tailnetHost } from "../app/web/shell.js";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import { encodeOffer } from "../shared/relay-offer.ts";

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const offer = { v: 1 as const, server_id: SERVER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.sh", code: "123456", name: "Studio PC" };
const link = (text: string, appOrigin?: string) => relayLink(parseAddress(text), appOrigin);

describe("the sign-in buttons", () => {
  it("draws the sign-ins the account service names, in the app's order, and none it does not know", () => {
    expect(listedProviders({ providers: ["apple", "github"], device: ["github"] })).toEqual(["github", "apple"]);
    expect(listedProviders({ providers: ["google", "gitlab"], device: [] })).toEqual(["google"]);
    expect(listedProviders({ providers: [], device: [] })).toEqual([]);
  });

  it("reads nothing from an answer with no list, so the build's buttons stay", () => {
    for (const body of [null, "github", {}, { providers: "github" }, { providers: ["google"] }]) expect(listedProviders(body)).toBeNull();
  });
});

describe("relay pairing links", () => {
  it("opens an offer on the app's origin at its scope, the fragment kept, labelled from the offer", () => {
    const url = encodeOffer(offer, APP_ORIGIN);
    expect(APP_ORIGIN).toBe("https://app.ovis.sh");
    expect(link(url)).toEqual({ url, scope: `https://app.ovis.sh/s/${SERVER_ID}/`, name: "Studio PC" });
  });

  it("takes the configured app origin, and an offer without a name or a scope without its slash", () => {
    const origin = "https://shell.example.ts.net:18921";
    const { name: _, ...unnamed } = offer;
    const url = encodeOffer(unnamed, origin);
    const fragment = url.slice(url.indexOf("#"));
    expect(link(url, origin)).toEqual({ url, scope: `${origin}/s/${SERVER_ID}/`, name: undefined });
    expect(link(`${origin}/s/${SERVER_ID}${fragment}`, origin)).toEqual({ url, scope: `${origin}/s/${SERVER_ID}/`, name: undefined });
    expect(link(url)).toEqual({ error: "foreign-offer" });
  });

  it("reopens a saved relay PC by its scope", () => {
    const scope = `https://app.ovis.sh/s/${SERVER_ID}/`;
    expect(link(scope)).toEqual({ url: scope, scope, name: undefined });
  });

  it("refuses an offer on any other origin", () => {
    const fragment = encodeOffer(offer, APP_ORIGIN).split("#")[1];
    for (const text of [
      `https://evil.example/s/${SERVER_ID}/#${fragment}`,
      `https://evil.example/#${fragment}`,
      `http://app.ovis.sh/s/${SERVER_ID}/#${fragment}`,
      `https://app.ovis.sh.evil.example/s/${SERVER_ID}/#${fragment}`,
      `https://app.ovis.sh:8443/s/${SERVER_ID}/#${fragment}`,
      `https://evil.example/#offer=`,
    ]) expect([text, link(text)]).toEqual([text, { error: "foreign-offer" }]);
  });

  it("refuses an offer that is malformed or names another PC, and the app's other pages", () => {
    const fragment = encodeOffer(offer, APP_ORIGIN).split("#")[1];
    const other = "fedcba9876543210fedcba9876543210";
    const json = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const text of [
      `https://app.ovis.sh/s/${other}/#${fragment}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=not*base64`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json([1])}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json({ ...offer, v: 2 })}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${json({ ...offer, name: "x".repeat(65) })}`,
      `https://app.ovis.sh/s/${SERVER_ID}/#offer=${"A".repeat(2049)}`,
    ]) expect([text, link(text)]).toEqual([text, { error: "bad-offer" }]);
    for (const text of ["https://app.ovis.sh/", `https://app.ovis.sh/s/${SERVER_ID.toUpperCase()}/`, `https://app.ovis.sh/s/${SERVER_ID}/sw.js`, `https://app.ovis.sh/s/${SERVER_ID}/#pair`]) {
      expect([text, link(text)]).toEqual([text, { error: "not-a-pc" }]);
    }
  });

  it("leaves a PC's own address to open as before", () => {
    for (const text of ["https://pc.tail1234.ts.net", "100.64.0.1:7421/?pair=123456", "https://pc.example.com/#settings"]) {
      expect([text, link(text)]).toEqual([text, null]);
    }
  });
});

describe("why an address did not open", () => {
  it("tells this phone's own addresses, which never reach the PC", () => {
    for (const text of ["localhost:17531", "http://127.0.0.1:17531", "http://127.1.2.3/", "http://[::1]:7317", "https://app.localhost"]) {
      expect([text, loopbackHost(parseAddress(text).hostname)]).toEqual([text, true]);
    }
    for (const text of ["192.168.0.10:7317", "https://my-pc.tail1234.ts.net", "http://128.0.0.1/"]) {
      expect([text, loopbackHost(parseAddress(text).hostname)]).toEqual([text, false]);
    }
  });

  it("tells Tailscale addresses as error.html does", () => {
    for (const text of ["100.64.0.1:7317", "100.127.255.1", "https://pc.tail1234.ts.net", "http://[fd7a:115c:a1e0::1]:7317"]) {
      expect([text, tailnetHost(parseAddress(text).hostname)]).toEqual([text, true]);
    }
    for (const text of ["100.63.0.1", "100.128.0.1", "192.168.0.10", "https://ts.net.example.com"]) {
      expect([text, tailnetHost(parseAddress(text).hostname)]).toEqual([text, false]);
    }
  });

  it("tells home network and tailnet addresses from public servers, as error.html does", () => {
    for (const text of ["192.168.0.10:7317", "10.0.2.2:7317", "172.20.1.1", "169.254.1.2", "100.64.0.1", "localhost:17531", "http://[fd00::1]:7317", "http://[fe80::1]/", "http://studio:7317", "https://pc.local", "https://pc.home.arpa", "https://pc.tail1234.ts.net"]) {
      expect([text, homeHost(parseAddress(text).hostname)]).toEqual([text, true]);
    }
    for (const text of ["https://herdr.theworld.codes", "8.8.8.8", "172.32.0.1", "100.128.0.1", "http://[2001:db8::1]/", "https://local.example.com"]) {
      expect([text, homeHost(parseAddress(text).hostname)]).toEqual([text, false]);
    }
  });

  it("has error.html's own copy of homeHost agree with shell.js", () => {
    const page = readFileSync(join(import.meta.dir, "../app/web/error.html"), "utf8");
    const source = page.match(/function homeHost\(hostname\) \{[\s\S]*?\n {4}\}\n/)?.[0];
    expect(source).toBeDefined();
    const pageHomeHost = new Function(`${source}; return homeHost;`)() as (hostname: string) => boolean;
    const hosts = ["192.168.0.10", "10.0.2.2", "172.16.0.1", "172.32.0.1", "169.254.1.2", "127.0.0.1", "100.64.0.1", "100.127.255.1", "100.128.0.1", "8.8.8.8",
      "localhost", "app.localhost", "[::1]", "[fd00::1]", "[fe80::1]", "[fd7a:115c:a1e0::1]", "[2001:db8::1]", "studio", "pc.local", "pc.lan", "pc.home.arpa", "pc.internal",
      "pc.tail1234.ts.net", "herdr.theworld.codes", "local.example.com"];
    for (const host of hosts) expect([host, pageHomeHost(host)]).toEqual([host, homeHost(host)]);
  });

  it("explains a timeout differently for a home network address and a public server", () => {
    const home = openFailure(parseAddress("192.168.77.20:7317"), "timeout", "x").replace("192.168.77.20:7317", "HOST");
    const server = openFailure(parseAddress("https://herdr.example.com"), "timeout", "x").replace("herdr.example.com", "HOST");
    expect(server).not.toBe(home);
  });

  it("keeps the loading spinner the native apps wait on in index.html's root", () => {
    // MainActivity (PAGE_SCRIPT) lifts its cover once #root no longer holds .boot: a page whose
    // root starts without it would lift the cover before the client is up
    const page = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
    expect(page).toMatch(/<div id="root">\s*<div class="boot"/);
  });

  it("says nothing for a cancelled open and something for every other refusal", () => {
    const url = parseAddress("192.168.77.20:7317");
    expect(openFailure(url, "cancelled", "Cancelled")).toBe("");
    for (const code of ["not-ovis", "refused", "timeout", "unknown-host", "no-answer", undefined]) {
      expect([code, openFailure(url, code, "x").length > 0]).toEqual([code, true]);
    }
  });
});

describe("an SSH PC under Manage", () => {
  const pc = { origin: "http://127.0.0.2:47317", host: "studio.lan", port: 22, user: "me", auth: "phone-key", keyType: "", hostKeyAlgorithm: "ssh-ed25519", fingerprint: "SHA256:abc" };

  it("names its address, the pasted key's type, and its confirmed host key", () => {
    const details = sshDetails(pc);
    expect(details.address).toBe("me@studio.lan");
    expect(details.confirmed).toBe(true);
    expect(details.hostKey).toContain("ssh-ed25519 SHA256:abc");
    const pasted = sshDetails({ ...pc, port: 2222, auth: "imported", keyType: "rsa 3072" });
    expect(pasted.address).toBe("me@studio.lan:2222");
    expect(pasted.how).toContain("rsa 3072");
    expect(pasted.how).not.toBe(details.how);
  });

  it("is not confirmed once its host key was forgotten", () => {
    const forgotten = sshDetails({ ...pc, hostKeyAlgorithm: "", fingerprint: "" });
    expect(forgotten.confirmed).toBe(false);
    expect(forgotten.hostKey).not.toContain("SHA256:");
  });
});
