import { spyOn } from "bun:test";
import { MachineManager } from "./machines.ts";
import { SshConnection } from "./ssh.ts";

type Tunnel = { tunnel(ssh: SshConnection, descriptor: { port: number; token: string }): Promise<{ url: string; token: string }> };
type Relay = ReturnType<typeof Bun.serve>;

/**
 * The SSH tunnel to a bridge, with `MachineManager.tunnel` itself run: it checks the descriptor's port and token, frees
 * a local port and has `forward` open it to the bridge's port. Its stand-in serves the bridge's relay (`serve`, given
 * the bridge's port, kept in `relays`) on a port of its own (port 0), never on the number freed for it, which another
 * process on a busy host may take first (machines.ts freePort). The address the tunnel returns is then pointed at that
 * relay: the same relay `forward` was asked to open at that number, with the token the tunnel returned.
 */
export function tunnelRelays(relays: Relay[], serve: (remotePort: number) => Relay): { mockRestore(): void }[] {
  const forwarded = new Map<number, Relay[]>();
  const prototype = MachineManager.prototype as unknown as Tunnel;
  const tunnel = prototype.tunnel;
  return [
    spyOn(SshConnection.prototype, "forward").mockImplementation(async (port, remotePort) => {
      const relay = serve(remotePort);
      relays.push(relay);
      forwarded.set(port, [...forwarded.get(port) ?? [], relay]);
    }),
    spyOn(prototype, "tunnel").mockImplementation(async function (this: Tunnel, ssh, descriptor) {
      const opened = await tunnel.call(this, ssh, descriptor);
      const url = new URL(opened.url);
      const relay = url.hostname === "127.0.0.1" ? forwarded.get(Number(url.port))?.shift() : undefined;
      if (!relay) throw new Error(`The tunnel's address ${opened.url} is no port it forwarded`);
      return { url: `http://127.0.0.1:${relay.port}`, token: opened.token };
    }),
  ];
}
