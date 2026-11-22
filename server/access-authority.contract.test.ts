import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { TailnetIdentitySource } from "./tailscale.ts";

/**
 * A page whose own name was rebound to 127.0.0.1 reaches a loopback server from loopback, with that
 * name as Host and Origin. Neither the open grant of an install with nothing paired nor a Tailscale
 * login the page types itself may let it in.
 */
const OWNER = "owner@example.com";
const NODE = "pc.tail5cc90b.ts.net";
const IP = "100.101.102.103";
const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${NODE}.`, UserID: 7, TailscaleIPs: [IP] }, Peer: {}, User: { "7": { LoginName: OWNER } } });

type Server = { port: number; stop: (force?: boolean) => void };

function upgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = ["GET /ws HTTP/1.1", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="];
    const socket = connect(port, "127.0.0.1", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
    let answer = "";
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("no answer to the upgrade")); });
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      if (answer.includes("\r\n")) { socket.destroy(); resolve(answer.slice(0, answer.indexOf("\r\n"))); }
    });
    socket.on("error", reject);
  });
}

describe("a rebound name on a loopback server", () => {
  const states: string[] = [];
  let open: Server;
  let owned: Server;
  let named: Server;
  beforeAll(() => {
    const state = () => { const dir = mkdtempSync(join(tmpdir(), "ovis-authority-")); states.push(dir); return dir; };
    open = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state(), tailscaleOwner: null, tailnet: new TailnetIdentitySource(async () => null) }) as Server;
    owned = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state(), tailnet: new TailnetIdentitySource(async () => status) }) as Server;
    // a tagged node's owner named in OVIS_TAILSCALE_OWNER: the login still counts only at this PC's tailnet name
    named = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state(), tailscaleOwner: OWNER, tailnet: new TailnetIdentitySource(async () => status) }) as Server;
  });
  afterAll(() => {
    open?.stop(true);
    owned?.stop(true);
    named?.stop(true);
    for (const dir of states) rmSync(dir, { recursive: true, force: true });
  });
  const rebound = (port: number) => ({ host: `rebind.example:${port}`, origin: `http://rebind.example:${port}`, "sec-fetch-site": "same-origin" });

  it("regression: the open grant does not reach it, for reads, changes or the terminal socket", async () => {
    const headers = rebound(open.port);
    expect((await fetch(`http://127.0.0.1:${open.port}/api/devices`, { headers })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${open.port}/api/probe-unknown`, { method: "POST", headers })).status).toBe(401);
    expect(await upgrade(open.port, headers)).toBe("HTTP/1.1 401 Unauthorized");
    // control: this PC under its own name keeps its local access
    expect((await fetch(`http://127.0.0.1:${open.port}/api/devices`)).status).toBe(200);
  });

  it("regression: a Tailscale login and tailnet address the page states do not reach it", async () => {
    for (const server of [owned, named]) {
      const headers = { ...rebound(server.port), "tailscale-user-login": OWNER, "x-forwarded-for": "100.64.0.9" };
      expect((await fetch(`http://127.0.0.1:${server.port}/api/devices`, { headers })).status).toBe(401);
      expect(await upgrade(server.port, headers)).toBe("HTTP/1.1 401 Unauthorized");
      // control: tailscale serve keeps the device's Host, this PC's tailnet name or address, and the owner gets in
      for (const host of [NODE, `${NODE.toUpperCase()}.`, `${IP}:443`]) {
        expect((await fetch(`http://127.0.0.1:${server.port}/api/devices`, { headers: { ...headers, host, origin: `https://${host}` } })).status).toBe(200);
      }
    }
  });
});
