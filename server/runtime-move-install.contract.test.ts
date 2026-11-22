import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse } from "../shared/runtime-move.ts";
import type { RuntimeService } from "./herdr-core/runtime-choice.ts";
import { createServer } from "./index.ts";
import type { HcInstaller } from "./runtime-move-service.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-move-install-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SECRET = "test-move-install-secret";
const auth = { authorization: `Bearer ${SECRET}` };

const facts = (change: Partial<HerdrRuntimeFacts> = {}): HerdrRuntimeFacts => ({ serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: null, locked: null, ...change });

it("offers to install herdr-core where only it is missing, installs it once asked from the app's page, and leaves the offer when the install fails", async () => {
  let current = facts();
  let installs = 0;
  let failWith: string | null = "the herdr-core download does not match its checksum";
  const installer: HcInstaller = {
    offer: () => ({ version: "0.1.17" }),
    install: async () => {
      installs++;
      if (failWith !== null) throw new Error(failWith);
      current = facts({ switch_to: "herdr-core" });
    },
  };
  const runtimeService: RuntimeService = { facts: () => current, request: () => ({ ok: false, status: 409, code: "runtime_locked", message: "test" }) };
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: SECRET, stateDir: join(root, "state"), runtimeService, herdrCoreInstaller: installer });
  const base = `http://127.0.0.1:${server.port}`;
  const read = async () => (await (await fetch(`${base}/api/runtime/move`, { headers: auth })).json()) as MovePlanResponse;
  const install = (headers: Record<string, string> = { ...auth, "x-herdr-update": "1" }) => fetch(`${base}/api/runtime/move/install`, { method: "POST", headers });
  const refusal = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];
  try {
    expect(await read()).toEqual({ available: false, reason: "no_herdr_core", install: { version: "0.1.17" }, status: { state: "idle" } });

    // a request from another page, or no request at all, installs nothing
    expect(await refusal(await install(auth))).toEqual([403, "forbidden"]);
    expect((await install({ "x-herdr-update": "1" })).status).toBe(401);
    expect(installs).toBe(0);

    expect(await refusal(await install())).toEqual([502, "install_failed"]);
    expect(installs).toBe(1);
    expect(await read()).toEqual({ available: false, reason: "no_herdr_core", install: { version: "0.1.17" }, status: { state: "idle" } });

    failWith = null;
    const done = await install();
    expect([done.status, await done.json()]).toEqual([200, { installed: true }]);
    expect(current.switch_to).toBe("herdr-core");

    expect(await refusal(await install())).toEqual([409, "unavailable"]);
    expect(installs).toBe(2);
  } finally {
    server.stop();
  }
});

it("offers no install where the Herdr app may arrange the core, the runtime cannot switch, or no installer is set", async () => {
  const installer: HcInstaller = { offer: () => ({ version: "0.1.17" }), install: async () => { throw new Error("not expected"); } };
  const cases: { facts: HerdrRuntimeFacts; installer?: HcInstaller; reason: string }[] = [
    { facts: facts({ app_installed: true }), installer, reason: "no_herdr_core" },
    { facts: facts({ locked: "unmanaged" }), installer, reason: "runtime_locked" },
    { facts: facts(), reason: "no_herdr_core" },
  ];
  for (const [index, entry] of cases.entries()) {
    const runtimeService: RuntimeService = { facts: () => entry.facts, request: () => ({ ok: false, status: 409, code: "runtime_locked", message: "test" }) };
    const server = createServer({ port: 0, hostname: "127.0.0.1", token: SECRET, stateDir: join(root, `state-${index}`), runtimeService, ...(entry.installer ? { herdrCoreInstaller: entry.installer } : {}) });
    try {
      const answer = (await (await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { headers: auth })).json()) as MovePlanResponse;
      expect(answer).toEqual({ available: false, reason: entry.reason, status: { state: "idle" } } as MovePlanResponse);
      const install = await fetch(`http://127.0.0.1:${server.port}/api/runtime/move/install`, { method: "POST", headers: { ...auth, "x-herdr-update": "1" } });
      expect(install.status).toBe(409);
    } finally {
      server.stop();
    }
  }
});
