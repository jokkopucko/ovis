import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { X509Certificate } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetAuthAttempts } from "./auth.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { createServer } from "./index.ts";
import { PortalService } from "./portal.ts";
import { lanHttpsCertificate, lanHttpsConfig, privateLanAddresses, privateLanPeer, selfSignedCertificate } from "./lan-https.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-lan-https-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  forgetAuthAttempts();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lanHttpsConfig", () => {
  it("is off while OVIS_LAN_HTTPS_PORT is unset or blank", () => {
    expect(lanHttpsConfig({})).toBeNull();
    expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: " " })).toBeNull();
  });

  it("takes a port and an optional certificate and key pair", () => {
    expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: "7318" })).toEqual({ port: 7318 });
    expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: "7318", OVIS_LAN_HTTPS_CERT: "/c.pem", OVIS_LAN_HTTPS_KEY: "/k.pem" })).toEqual({ port: 7318, certFile: "/c.pem", keyFile: "/k.pem" });
    expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: "7318", OVIS_LAN_HTTPS_HOST: "0.0.0.0" })).toEqual({ port: 7318, host: "0.0.0.0" });
  });

  it("refuses a value that is not a port, or a certificate without its key", () => {
    for (const port of ["0", "65536", "73a", "-1", "7318.5"]) expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: port })).toMatchObject({ error: expect.stringContaining("OVIS_LAN_HTTPS_PORT") });
    expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: "7318", OVIS_LAN_HTTPS_CERT: "/c.pem" })).toMatchObject({ error: expect.stringContaining("OVIS_LAN_HTTPS_KEY") });
    expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: "7318", OVIS_LAN_HTTPS_KEY: "/k.pem" })).toMatchObject({ error: expect.stringContaining("OVIS_LAN_HTTPS_CERT") });
    for (const host of ["lan.example", "::", "192.168.1"]) expect(lanHttpsConfig({ OVIS_LAN_HTTPS_PORT: "7318", OVIS_LAN_HTTPS_HOST: host })).toMatchObject({ error: expect.stringContaining("OVIS_LAN_HTTPS_HOST") });
  });
});

it("lets in private IPv4 peers only", () => {
  for (const address of ["10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.50", "169.254.3.4", "::ffff:192.168.1.50"]) expect(privateLanPeer(address)).toBe(true);
  for (const address of ["127.0.0.1", "::ffff:127.0.0.1", "8.8.8.8", "172.32.0.1", "100.100.1.1", "fd7a:115c:a1e0::1", "2001:db8::1", null, undefined, ""]) expect(privateLanPeer(address)).toBe(false);
});

describe("lanHttpsCertificate", () => {
  it("makes a self-signed certificate once, keeps its key private and reuses it", () => {
    const stateDir = tempDir();
    const first = lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]);
    const x509 = new X509Certificate(first.cert);
    expect(x509.checkIP("192.168.1.50")).toBe("192.168.1.50");
    expect(x509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(x509.checkHost("localhost")).toBe("localhost");
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(first.sha256).toBe(x509.fingerprint256);
    if (process.platform !== "win32") expect(statSync(join(stateDir, "lan-https", "key.pem")).mode & 0o077).toBe(0);
    expect(lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]).sha256).toBe(first.sha256);
  });

  it("makes a new one when the kept one does not load or does not name an address this PC has now", () => {
    const stateDir = tempDir();
    const first = lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]);
    const moved = lanHttpsCertificate(stateDir, { port: 7318 }, ["10.0.0.7"]);
    expect(moved.sha256).not.toBe(first.sha256);
    expect(new X509Certificate(moved.cert).checkIP("10.0.0.7")).toBe("10.0.0.7");
    writeFileSync(join(stateDir, "lan-https", "cert.pem"), "not a certificate");
    expect(lanHttpsCertificate(stateDir, { port: 7318 }, ["10.0.0.7"]).sha256).not.toBe(moved.sha256);
  });

  it("makes a new one when the kept one starts in the future (made while the clock ran ahead)", () => {
    const stateDir = tempDir();
    const first = lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]);
    const ahead = selfSignedCertificate(["192.168.1.50"], new Date(Date.now() + 86_400_000));
    writeFileSync(join(stateDir, "lan-https", "cert.pem"), ahead.cert);
    writeFileSync(join(stateDir, "lan-https", "key.pem"), ahead.key);
    const again = lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]);
    expect(again.sha256).not.toBe(new X509Certificate(ahead.cert).fingerprint256);
    expect(again.sha256).not.toBe(first.sha256);
    expect(Date.parse(new X509Certificate(again.cert).validFrom)).toBeLessThanOrEqual(Date.now());
  });

  it("narrows a kept key's permissions again before reusing it", () => {
    if (process.platform === "win32") return;
    const stateDir = tempDir();
    lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]);
    chmodSync(join(stateDir, "lan-https"), 0o755);
    chmodSync(join(stateDir, "lan-https", "key.pem"), 0o644);
    lanHttpsCertificate(stateDir, { port: 7318 }, ["192.168.1.50"]);
    expect(statSync(join(stateDir, "lan-https")).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "lan-https", "key.pem")).mode & 0o777).toBe(0o600);
  });

  it("makes certificates every parser takes, at most 825 days long, past 2049 too", () => {
    // a serial with a leading zero byte fails to parse about once in 170 certificates
    for (let made = 0; made < 400; made++) expect(() => new X509Certificate(selfSignedCertificate(["192.168.1.50"]).cert)).not.toThrow();
    for (const now of [new Date("2026-11-06T00:00:00Z"), new Date("2049-06-01T00:00:00Z")]) {
      const x509 = new X509Certificate(selfSignedCertificate(["192.168.1.50"], now).cert);
      expect(Date.parse(x509.validTo) - Date.parse(x509.validFrom)).toBe(825 * 86_400_000);
      expect(Date.parse(x509.validTo)).toBeGreaterThan(now.getTime());
    }
  });

  it("serves the operator's own certificate and key as they are", () => {
    const dir = tempDir();
    const own = selfSignedCertificate(["192.168.1.50"]);
    writeFileSync(join(dir, "c.pem"), own.cert);
    writeFileSync(join(dir, "k.pem"), own.key);
    const loaded = lanHttpsCertificate(tempDir(), { port: 7318, certFile: join(dir, "c.pem"), keyFile: join(dir, "k.pem") }, ["10.0.0.7"]);
    expect(loaded.cert).toBe(own.cert);
    expect(loaded.sha256).toBe(new X509Certificate(own.cert).fingerprint256);
  });
});

describe("the LAN HTTPS listener", () => {
  const base = { hostname: "127.0.0.1", port: 0, token: "", tailscaleOwner: null, machines: false, sidecar: false } as const;

  it("is not opened unless asked for", () => {
    const app = createServer({ ...base, stateDir: tempDir() });
    try {
      expect(app.lanHttps).toBeNull();
    } finally {
      app.stop();
    }
  });

  it("answers over HTTPS with the certificate it names, and refuses a peer that is not on a private network", async () => {
    const stateDir = tempDir();
    const app = createServer({ ...base, stateDir, lanHttps: { port: 0, host: "127.0.0.1" } });
    try {
      const listener = app.lanHttps;
      if (listener === null) throw new Error("expected the LAN HTTPS listener");
      expect(listener.port).not.toBe(app.port);
      const cert = readFileSync(join(stateDir, "lan-https", "cert.pem"), "utf8");
      expect(listener.sha256).toBe(new X509Certificate(cert).fingerprint256);
      expect(listener.addresses).toEqual(["127.0.0.1"]);
      // pinned to that certificate alone: the handshake verifies against it and nothing else; this test's loopback peer is then refused
      const response = await fetch(`https://127.0.0.1:${listener.port}/api/health`, { tls: { ca: cert } });
      expect(response.status).toBe(403);
    } finally {
      app.stop();
    }
  });

  // a peer on a private network needs a private address on this host: a CI runner has one, a bare sandbox may not
  it.skipIf(privateLanAddresses().length === 0)("lets a private peer in with the token, and tells it the main listener's port", async () => {
    const address = privateLanAddresses()[0]!;
    const stateDir = tempDir();
    const app = createServer({ ...base, stateDir, token: "the-token", lanHttps: { port: 0, host: address } });
    try {
      const listener = app.lanHttps;
      if (listener === null) throw new Error("expected the LAN HTTPS listener");
      const ca = readFileSync(join(stateDir, "lan-https", "cert.pem"), "utf8");
      const access = (authorization?: string) => fetch(`https://${address}:${listener.port}/api/access`, { tls: { ca }, headers: authorization ? { authorization } : {} });
      expect((await access()).status).toBe(401);
      const answer = await access("Bearer the-token");
      expect(answer.status).toBe(200);
      expect(((await answer.json()) as { port: number }).port).toBe(app.port);
    } finally {
      app.stop();
    }
  });

  it("leaves the main listener running when its port is taken", async () => {
    const taken = createTcpServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => taken.once("listening", resolve));
    const error = spyOn(console, "error").mockImplementation(() => {});
    const app = createServer({ ...base, stateDir: tempDir(), lanHttps: { port: (taken.address() as AddressInfo).port, host: "127.0.0.1" } });
    try {
      expect(app.lanHttps).toBeNull();
      expect(error.mock.calls.flat().join(" ")).toContain("LAN HTTPS");
      expect((await fetch(`http://127.0.0.1:${app.port}/api/devices`)).status).toBe(200);
    } finally {
      app.stop();
      error.mockRestore();
      taken.close();
    }
  });

  it("leaves the main listener running when the certificate does not load", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "c.pem"), "nope");
    writeFileSync(join(dir, "k.pem"), "nope");
    chmodSync(join(dir, "k.pem"), 0o600);
    const error = spyOn(console, "error").mockImplementation(() => {});
    const app = createServer({ ...base, stateDir: tempDir(), lanHttps: { port: 0, host: "127.0.0.1", certFile: join(dir, "c.pem"), keyFile: join(dir, "k.pem") } });
    try {
      expect(app.lanHttps).toBeNull();
      expect(error.mock.calls.flat().join(" ")).toContain("LAN HTTPS");
    } finally {
      app.stop();
      error.mockRestore();
    }
  });

  it("never lets a LAN peer in as an open install there, while the main listener still does", async () => {
    // Given: no token and nothing paired, the state in which the main listener lets a LAN request in as `open`
    const app = createServer({ ...base, stateDir: tempDir() });
    try {
      const devices = async (lanHttps: boolean) => {
        const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false, ...(lanHttps ? { lanHttps: true } : {}) };
        const response = await handleRequest(new Request("https://192.168.1.10:7318/api/devices", { headers: { host: "192.168.1.10:7318" } }), ctx);
        return { status: response!.status, body: await response!.json() };
      };
      expect(await devices(false)).toMatchObject({ status: 200 });
      expect(await devices(true)).toEqual({ status: 401, body: { error: { code: "unauthorized", message: "pair this device, or use the token" } } });
    } finally {
      app.stop();
    }
  });

  it("lets in a device paired with a code on the LAN listener", async () => {
    const app = createServer({ ...base, stateDir: tempDir() });
    try {
      const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false, lanHttps: true };
      const origin = "https://192.168.1.10:7318";
      const headers = { host: "192.168.1.10:7318", origin, "content-type": "application/json", "x-herdr-machine": "1" };
      const { code } = app.context.services.devices.startPairing();
      const paired = await handleRequest(new Request(`${origin}/api/devices/pair`, { method: "POST", headers, body: JSON.stringify({ code, label: "Phone" }) }), ctx);
      const cookie = paired!.headers.getSetCookie().find((line) => line.startsWith("ovis_device="));
      expect(cookie).toContain("Secure");
      const list = await handleRequest(new Request(`${origin}/api/devices`, { headers: { host: headers.host, cookie: cookie!.split(";")[0]! } }), ctx);
      expect(list!.status).toBe(200);
      expect(((await list!.json()) as { devices: Array<{ label: string }> }).devices.map((device) => device.label)).toContain("Phone");
    } finally {
      app.stop();
    }
  });

  const lanContext = (app: ReturnType<typeof createServer>, address = "192.168.1.50"): ServerContext => ({ ...app.context, requestIP: () => ({ address }), timeout: () => {}, upgrade: () => false, lanHttps: true });
  const origin = "https://192.168.1.10:7318";
  const pairRequest = (code: string) => new Request(`${origin}/api/devices/pair`, { method: "POST", headers: { host: "192.168.1.10:7318", origin, "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label: "Phone" }) });

  it("never redeems a code started through the relay, nor spends its guesses", async () => {
    const app = createServer({ ...base, stateDir: tempDir() });
    try {
      const store = app.context.services.devices;
      const { code } = store.startPairing(Date.now(), { remote: true, startedBy: null, memberRequired: false });
      for (const guess of [code, "000000", "111111", "222222", "333333", "444444"]) expect((await handleRequest(pairRequest(guess), lanContext(app)))!.status).toBe(401);
      expect(store.activePairing()?.code).toBe(code);
    } finally {
      app.stop();
    }
  });

  it("spends five guesses of its own on a code, never the ones a phone elsewhere types it in with", async () => {
    const app = createServer({ ...base, stateDir: tempDir() });
    try {
      const store = app.context.services.devices;
      const { code } = store.startPairing();
      const wrong = code === "123456" ? "654321" : "123456";
      for (let guess = 0; guess < 5; guess++) expect((await handleRequest(pairRequest(wrong), lanContext(app)))!.status).toBe(401);
      expect((await handleRequest(pairRequest(code), lanContext(app)))!.status).toBe(401);
      expect(store.activePairing()?.code).toBe(code);
      expect(store.pair(code, "Phone elsewhere", "drive")).not.toBeNull();
    } finally {
      app.stop();
    }
  });

  it("pauses code pairing there after twenty wrong codes, leaving relay pairing alone", async () => {
    const app = createServer({ ...base, stateDir: tempDir() });
    try {
      const store = app.context.services.devices;
      const first = store.startPairing().code;
      for (let wrong = 0; wrong < 20; wrong++) expect((await handleRequest(pairRequest(first === "123456" ? "654321" : "123456"), lanContext(app)))!.status).toBe(401);
      const { code } = store.startPairing();
      const paused = await handleRequest(pairRequest(code), lanContext(app));
      expect(paused!.status).toBe(429);
      expect(store.activePairing()?.code).toBe(code);
      expect(() => store.assertRelayPairing()).not.toThrow();
    } finally {
      app.stop();
    }
  });

  it("does not take Portal's proof there", async () => {
    const stateDir = tempDir();
    const portal = new PortalService({ stateDir });
    const proof = spyOn(portal, "vouches").mockReturnValue(true);
    const app = createServer({ ...base, stateDir, portal });
    try {
      const headers = { host: "192.168.1.10:7318", "x-portal-proof": "proof", "x-portal-user": "owner@example.com", "x-portal-auth": "oidc" };
      expect((await handleRequest(new Request(`${origin}/api/devices`, { headers }), lanContext(app)))!.status).toBe(401);
      expect((await handleRequest(new Request(`${origin}/api/devices`, { headers }), { ...lanContext(app), lanHttps: false }))!.status).toBe(200);
    } finally {
      app.stop();
      proof.mockRestore();
    }
  });

  it("does not take the bridge token there", async () => {
    const app = createServer({ ...base, stateDir: tempDir(), bridgeToken: "bridge-token" });
    try {
      const request = () => new Request(`${origin}/api/bridge`, { headers: { host: "192.168.1.10:7318", authorization: "Bearer bridge-token" } });
      expect((await handleRequest(request(), lanContext(app)))!.status).toBe(401);
    } finally {
      app.stop();
    }
  });

  it("holds every peer there once wrong tokens from many addresses fill one shared budget", async () => {
    const app = createServer({ ...base, stateDir: tempDir(), token: "the-token" });
    try {
      const guess = (address: string, lanHttps: boolean) => handleRequest(new Request(`${origin}/api/devices`, { headers: { host: "192.168.1.10:7318", authorization: "Bearer wrong" } }), { ...lanContext(app, address), lanHttps });
      for (let peer = 1; peer <= 50; peer++) expect((await guess(`192.168.2.${peer}`, true))!.status).toBe(401);
      expect((await guess("192.168.3.1", true))!.status).toBe(429);
      // the same addresses on the main listener each keep their own budget
      expect((await guess("192.168.3.1", false))!.status).toBe(401);
    } finally {
      app.stop();
    }
  });
});
