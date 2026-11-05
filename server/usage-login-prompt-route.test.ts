import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { UsageLoginService } from "./usage-login.ts";

const root = mkdtempSync(join(tmpdir(), "usage-login-prompt-"));
const bin = join(root, "bin");
const spies: { mockRestore(): void }[] = [];
const typed: { pane: string; text: string }[] = [];
const keys: { pane: string; keys: string[] }[] = [];

beforeAll(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho --device-auth\n", { mode: 0o755 });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho login\n", { mode: 0o755 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); typed.length = 0; keys.length = 0; });

function stubHerdr(): void {
  spies.push(
    spyOn(herdr, "sessionSnapshot").mockResolvedValue({ workspaces: [{ workspace_id: "w1" }], panes: [{ pane_id: "w1:p9", terminal_id: "t9" }] } as never),
    spyOn(herdr, "tabCreate").mockResolvedValue({ root_pane: { pane_id: "w1:p9", terminal_id: "t9" }, tab: { workspace_id: "w1" } } as never),
    spyOn(herdr, "paneSendText").mockImplementation(async (pane: string, text: string) => { typed.push({ pane, text }); return undefined as never; }),
    spyOn(herdr, "paneSendKeys").mockImplementation(async (pane: string, sent: string[]) => { keys.push({ pane, keys: sent }); return undefined as never; }),
  );
}

describe("a first sign-in, in the agent's own home", () => {
  it("runs the CLI with its home variable removed, so the plain command finds the sign-in", async () => {
    stubHerdr();
    const service = new UsageLoginService(root, { PATH: bin });
    const started = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "codex", default: true }) }));
    expect(started.status).toBe(200);
    expect(typed.map((entry) => entry.text).join("")).toBe(`exec 'env' '-u' 'CODEX_HOME' '${join(bin, "codex")}' 'login' '--device-auth'\n`);
  });

  it("asks too when the PC's only sign-in is in another account's home: discovery may stop before the default one (a keychain)", async () => {
    stubHerdr();
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "other@example.test" } })).toString("base64url");
    mkdirSync(join(root, ".codex-other"), { recursive: true });
    writeFileSync(join(root, ".codex-other", "auth.json"), JSON.stringify({ tokens: { access_token: `header.${claims}.signature` } }));
    try {
      const service = new UsageLoginService(root, { PATH: bin });
      const asked = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "codex", default: true }) }));
      expect(((await asked.json()) as { error: { code: string } }).error.code).toBe("account_confirmation_required");
      expect(typed).toEqual([]);
    } finally {
      rmSync(join(root, ".codex-other"), { recursive: true, force: true });
    }
  });

  it("asks before replacing a sign-in the PC already has, and takes no name", async () => {
    stubHerdr();
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "codex@example.test" } })).toString("base64url");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: `header.${claims}.signature` } }));
    try {
      const service = new UsageLoginService(root, { PATH: bin });
      const ask = (body: unknown) => service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify(body) }));
      const refused = await ask({ provider: "codex", default: true });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("account_confirmation_required");
      expect((await ask({ provider: "codex", default: true, name: "work" })).status).toBe(400);
      // a sign-in it cannot read is still one: unreadable, it is asked about all the same
      rmSync(join(root, ".codex", "auth.json"));
      writeFileSync(join(root, ".codex", "auth.json"), "{}", { mode: 0o000 });
      const unreadable = await ask({ provider: "codex", default: true });
      expect(((await unreadable.json()) as { error: { code: string } }).error.code).toBe("account_confirmation_required");
      expect((await ask({ provider: "grok", default: true })).status).toBe(400);
      expect(typed).toEqual([]);
    } finally {
      rmSync(join(root, ".codex"), { recursive: true, force: true });
    }
  });
});
