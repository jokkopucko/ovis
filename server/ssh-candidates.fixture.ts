import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

export function sshDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-candidates-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

export const twoPeers = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: {
    a: { DNSName: "box.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.64.0.1"] },
    b: { DNSName: "other.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.64.0.2", "fd7a:115c:a1e0::2"] },
  },
});
export const resolver = (table: Record<string, string[]>) => async (host: string): Promise<string[]> => table[host] ?? [];
