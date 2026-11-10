import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quietPort } from "./quiet-port.ts";

const ROOT = join(import.meta.dir, "..");
const DNS = "pc.example.ts.net";
/**
 * A `tailscale` that answers from files and records every call. PATH holds only its directory, so
 * the real Tailscale on the machine running the tests is never found, let alone changed; the tools
 * it runs are named by their full paths for the same reason.
 */
const FAKE = `#!/bin/sh
echo "$*" >> "$FAKE_TS/calls"
case "$1 $2" in
  "status --json") /bin/cat "$FAKE_TS/status.json" ;;
  "serve status") /bin/cat "$FAKE_TS/serve.json" ;;
  "serve --yes") /bin/cp "$FAKE_TS/after.json" "$FAKE_TS/serve.json" ;;
  *) exit 1 ;;
esac
`;

let scratch: string;
let fake: string;
let port: number;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "herdr-plugin-phone-"));
  fake = join(scratch, "fake");
  mkdirSync(join(fake, "bin"), { recursive: true });
  writeFileSync(join(fake, "bin", "tailscale"), FAKE);
  chmodSync(join(fake, "bin", "tailscale"), 0o755);
  writeFileSync(join(fake, "status.json"), JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.`, UserID: 1 }, User: { "1": { LoginName: "me@example.com" } } }));
  // a port nothing listens on: the app is "not running yet", which the phone step allows
  port = quietPort();
  mkdirSync(join(scratch, "config"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** `tailscale serve status --json` with the given HTTPS listeners, each proxying "/" to its target */
const serving = (sites: Record<string, string>) => JSON.stringify({
  TCP: Object.fromEntries(Object.keys(sites).map((https) => [https, { HTTPS: true }])),
  Web: Object.fromEntries(Object.entries(sites).map(([https, proxy]) => [`${DNS}:${https}`, { Handlers: { "/": { Proxy: proxy } } }])),
});

async function phone(chosen: string | null, before: Record<string, string>, after: Record<string, string> = before) {
  writeFileSync(join(fake, "serve.json"), serving(before));
  writeFileSync(join(fake, "after.json"), serving(after));
  writeFileSync(join(scratch, "config", "env"), `PORT=${port}\n${chosen === null ? "" : `OVIS_TAILSCALE_HTTPS_PORT=${chosen}\n`}`);
  const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "phone"], { cwd: ROOT, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
    PATH: join(fake, "bin"), HOME: scratch, FAKE_TS: fake, HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: ROOT,
    HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config"), HERDR_PLUGIN_STATE_DIR: join(scratch, "plugin-state"), OVIS_STATE_DIR: join(scratch, "app-state"),
  } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const callsFile = join(fake, "calls");
  const serves = existsSync(callsFile) ? readFileSync(callsFile, "utf8").split("\n").filter((line) => line.startsWith("serve --yes")) : [];
  return { out, err, code, serves };
}

describe.skipIf(process.platform === "win32")("the phone step's HTTPS port", () => {
  it("publishes on the port OVIS_TAILSCALE_HTTPS_PORT names, leaving 443 alone", async () => {
    const app = `http://127.0.0.1:${port}`;
    const result = await phone("9443", {}, { "9443": app });
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.serves).toEqual([`serve --yes --bg --https=9443 ${app}`]);
    expect(result.out).toContain(`https://${DNS}:9443`);
    expect(result.out).toContain("tailscale serve --https=9443 off");
  });

  it("stops, without publishing anywhere else, when another service holds the chosen port", async () => {
    const result = await phone("9443", { "9443": "http://127.0.0.1:8787" });
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.serves).toEqual([]);
    expect(result.out).toContain("already uses HTTPS port 9443, which OVIS_TAILSCALE_HTTPS_PORT names");
  });

  it("stops with an error for a value that names no port", async () => {
    const result = await phone("https", {});
    expect(result.code).toBe(1);
    expect(result.serves).toEqual([]);
    expect(result.out).toContain('OVIS_TAILSCALE_HTTPS_PORT is "https", which is not a port');
  });

  it("still takes the first free usual port when nothing is chosen", async () => {
    const app = `http://127.0.0.1:${port}`;
    const result = await phone(null, { "443": "http://127.0.0.1:8787" }, { "443": "http://127.0.0.1:8787", "8443": app });
    expect(result.code, result.out + result.err).toBe(0);
    expect(result.serves).toEqual([`serve --yes --bg --https=8443 ${app}`]);
    expect(result.out).toContain(`https://${DNS}:8443`);
  });
});
