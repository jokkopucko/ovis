import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { PcAccountState } from "./account/pc-binding.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { ACCOUNT, registerSnapshotPc } from "./account/listed-pc.test-helpers.ts";

const root = mkdtempSync(join(tmpdir(), "address-https-"));
const crt = join(root, "loopback.pem"), key = join(root, "loopback.key");
beforeAll(async () => {
  if (process.platform === "linux") await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 -keyout ${key} -out ${crt}`.quiet();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(process.platform !== "linux").each(["unbound", "bound"] as const)(
  "Direct HTTPS address and code between Linux PCs with Step 2 enabled: %s", async mode => {
    const dir = mkdtempSync(join(root, "cell-")), bDir = join(dir, "b"), aDir = join(dir, "a");
    mkdirSync(bDir); mkdirSync(aDir);
    const service = new FakeAccountService();
    service.opensAll = true;
    if (mode === "bound") {
      await registerSnapshotPc(service, { stateDir: bDir });
      PcAccountState.open(bDir).migrate(ACCOUNT, true);
    }
    const b = createServer({ stateDir: bDir, port: 0, hostname: "127.0.0.1", platform: "linux", token: "fixture-b",
      accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch }, tailscaleOwner: null, sidecar: false, registerBridge: false });
    const tls = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(crt) },
      fetch(req) {
        const url = new URL(req.url);
        return fetch(`http://127.0.0.1:${b.port}${url.pathname}${url.search}`, {
          method: req.method, headers: req.headers, body: req.body, redirect: "manual", decompress: false,
        });
      },
    });
    try {
      const account = mode === "bound" ? ACCOUNT : null;
      expect(b.context.services.devices.account()).toBe(account);
      if (mode === "bound") expect(await b.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
      const { code } = b.context.services.devices.startPairing();
      // Bun reads the additional trust root at process start, so only this test client trusts it.
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "address-pc-https-client.test-helpers.ts"),
        aDir, `https://127.0.0.1:${tls.port}`, code, mode], { env: { ...process.env, NODE_EXTRA_CA_CERTS: crt },
        stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit, err).toBe(0);
      expect(JSON.parse(out.trim().split("\n").at(-1) ?? "{}")).toEqual({ account, status: 201, kind: "address", sessionStatus: 200 });
    } finally { await tls.stop(true); await b.stop(); }
  }, 30_000,
);
