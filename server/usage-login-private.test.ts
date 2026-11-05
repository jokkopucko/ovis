import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import * as ptyHost from "./pty/host.ts";
import * as ptySidecar from "./pty/sidecar.ts";
import { readProcessBirth } from "./process-owner.ts";
import * as usage from "./usage.ts";
import { UsageLoginService } from "./usage-login.ts";

/**
 * A sign-in the browser follows runs through the server's private PTY host, never in a
 * herdr pane, so no other device can read its sign-in address or the code typed into it. The stand-in CLIs
 * print what the real ones printed (server/fixtures/usage-login/*.pty) and read a pasted code like Claude's.
 */
const root = mkdtempSync(join(tmpdir(), "usage-login-private-"));
const bin = join(root, "bin");
const fixtures = join(import.meta.dir, "fixtures/usage-login");
const receipt = (name: string) => join(root, `${name}.receipt`);
const spies: { mockRestore(): void }[] = [];
const services = new Set<UsageLoginService>();
let names = 0;

// The server PC's own sign-ins stay out of these tests: a Mac signed in to Claude Code keeps one in its
// keychain, which no test home shows, and a default-home sign-in would then ask to replace it.
let keychain: { mockRestore(): void } | null = null;

beforeAll(() => {
  const system = usage.systemUsageContext();
  keychain = spyOn(usage, "systemUsageContext").mockReturnValue({ ...system, keychain: async () => ({ status: "missing" }) });
  mkdirSync(bin);
  // --help answers what the real ones list; a login prints its recorded screen, then waits as the real one does
  writeFileSync(join(bin, "claude"), `#!/bin/sh
case "$*" in *--help*) echo "login"; exit 0;; esac
echo "\${CLAUDE_CONFIG_DIR:-default}" > "${receipt("claude-home")}"
cat "${join(fixtures, "claude.pty")}"
IFS= read -r code
printf '%s' "$code" > "${receipt("claude-code")}"
echo "Login successful."
`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!/bin/sh
case "$*" in *--help*) echo "--device-auth"; exit 0;; esac
cat "${join(fixtures, "codex-device.pty")}"
exec sleep 600
`, { mode: 0o755 });
  writeFileSync(join(bin, "grok"), "#!/bin/sh\necho --device-auth\n", { mode: 0o755 });
});
afterAll(() => {
  keychain?.mockRestore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all([...services].map((service) => service.stopAll()));
  services.clear();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** herdr is never asked for a tab, a workspace or a key: each call fails the test that made it. */
function noHerdr(): string[] {
  const asked: string[] = [];
  for (const name of ["tabCreate", "workspaceCreate", "paneSendText", "paneSendKeys", "paneRead", "sessionSnapshot"] as const) {
    spies.push(spyOn(herdr, name).mockImplementation((async () => { asked.push(name); throw new Error(`herdr.${name} called`); }) as never));
  }
  return asked;
}

/** the cookie each started login set, sent back as the browser that started it does (undefined: that cookie; null: none) */
const jar = new Map<string, string>();
const cookieOf = (login: unknown, cookie: string | null | undefined): Record<string, string> => {
  const sent = cookie === undefined ? jar.get(String(login)) : cookie;
  return sent ? { cookie: sent } : {};
};
const post = (service: UsageLoginService, path: string, body: unknown, owner = "device:a", cookie?: string | null) =>
  service.handlePrompt(new Request(`http://x/api/usage/login/${path}`, { method: "POST", headers: cookieOf((body as { login?: unknown }).login, cookie), body: JSON.stringify(body) }), false, owner);
const read = (service: UsageLoginService, login: string, readOnly = false, owner = "device:a", cookie?: string | null) =>
  service.handlePrompt(new Request(`http://x/api/usage/login/prompt?login=${encodeURIComponent(login)}`, { headers: cookieOf(login, cookie) }), readOnly, owner);

async function start(service: UsageLoginService, body: Record<string, unknown>): Promise<Response> {
  services.add(service);
  const response = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ follow: true, ...body }) }), undefined, "device:a");
  const set = response.headers.get("set-cookie");
  if (response.ok && set !== null) {
    const { login_id: login } = (await response.clone().json()) as { login_id: string };
    jar.set(login, set.split(";")[0]!);
  }
  return response;
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("login event did not arrive")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Subscribe before reading so output between the read and the wait cannot be lost. */
async function promptWhen(service: UsageLoginService, login: string, until: (prompt: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (;;) {
    const changed = service.changed(login);
    const response = await read(service, login);
    const prompt = (await response.json()) as Record<string, unknown>;
    // a refused read answers at once and never changes: waiting on it again would spin without yielding to a timer
    if (!response.ok) throw new Error(`reading sign-in ${login} answered ${response.status}: ${JSON.stringify(prompt)}`);
    if (until(prompt)) return prompt;
    if (prompt["ended"]) throw new Error("login ended before the expected prompt");
    await within(changed);
  }
}

describe("a sign-in the browser follows", () => {
  for (const endpoint of ["prompt", "code", "cancel"]) {
    it(`refuses another owner holding the real id at ${endpoint}`, async () => {
      noHerdr();
      const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
      const { login_id: login } = await (await start(service, { provider: "codex", name: `owner-${++names}` })).json() as { login_id: string };
      const response = endpoint === "prompt" ? await read(service, login, false, "device:b")
        : await post(service, endpoint, { login, code: "fixture-code" }, "device:b");
      expect(response.status).toBe(404);
      expect((await read(service, login)).status).toBe(200);
    });
  }

  it("signals the next output and the end without timed polling", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const { login_id: login } = await (await start(service, { provider: "claude", name: `signal-${++names}` })).json() as { login_id: string };
    for (;;) {
      const changed = service.changed(login);
      const prompt = await (await read(service, login)).json() as { wants_code: boolean; ended: boolean };
      if (prompt.wants_code) break;
      if (prompt.ended) throw new Error("login ended before its prompt");
      await within(changed);
    }
    const ended = service.changed(login);
    expect((await post(service, "code", { login, code: "signal#state" })).status).toBe(204);
    await within(ended);
    await within(service.settled(login));
    expect((await (await read(service, login)).json() as { ended: boolean }).ended).toBe(true);
  });

  it("offers terminal fallback when neither out of process PTY host exists", async () => {
    noHerdr();
    spies.push(spyOn(ptyHost, "rustSidecar").mockReturnValue(null), spyOn(ptySidecar, "nodeSidecarAvailable").mockReturnValue(false));
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const response = await start(service, { provider: "codex", name: `no-host-${++names}` });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "follow_unsupported" } });
  });

  it("opens a terminal with the same account name after awaited cancellation", async () => {
    spies.push(
      spyOn(herdr, "sessionSnapshot").mockResolvedValue({ workspaces: [{ workspace_id: "w1" }], panes: [] } as never),
      spyOn(herdr, "tabCreate").mockResolvedValue({ root_pane: { pane_id: "w1:p9", terminal_id: "t9" }, tab: { workspace_id: "w1" } } as never),
      spyOn(herdr, "paneSendText").mockResolvedValue(undefined as never),
    );
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const name = `handoff-${++names}`;
    const { login_id: login } = await (await start(service, { provider: "codex", name })).json() as { login_id: string };
    expect((await post(service, "cancel", { login })).status).toBe(204);
    const terminal = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "codex", name }) }));
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toMatchObject({ pane_id: "w1:p9" });
  });

  it("runs in a private terminal: herdr opens no tab and no pane holds its address", async () => {
    const asked = noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const started = await start(service, { provider: "codex", name: `work-${++names}` });
    expect(started.status).toBe(200);
    const body = (await started.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("pane_id");
    expect(body["login_id"]).toMatch(/^[0-9a-f-]{36}$/);
    const prompt = await promptWhen(service, body["login_id"] as string, (shown) => shown["user_code"] !== null);
    expect(prompt).toEqual({ provider: "codex", url: "https://auth.openai.com/codex/device", user_code: "PG8L-CV4AR", wants_code: false, ended: false });
    expect(asked).toEqual([]);
    await post(service, "cancel", { login: body["login_id"] });
  });

  it("answers only the browser that holds its id, and never a device that only watches", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const { login_id: login } = (await (await start(service, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
    expect((await read(service, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await read(service, login, true)).status).toBe(403);
    expect((await post(service, "code", { login: "00000000-0000-4000-8000-000000000000", code: "abc" })).status).toBe(404);
    await post(service, "cancel", { login });
  });

  it("types a pasted code into the CLI's own terminal, ends with it, and has the usage read again", async () => {
    noHerdr();
    let ended = 0;
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    service.onLoginEnded(() => { ended += 1; });
    const { login_id: login } = (await (await start(service, { provider: "claude", name: `work-${++names}` })).json()) as { login_id: string };
    const prompt = await promptWhen(service, login, (shown) => shown["wants_code"] === true);
    expect(prompt["url"]).toStartWith("https://claude.com/cai/oauth/authorize?");
    for (const shellish of ["touch${IFS}/tmp/x", "a;b", "$(id)", "a b"]) expect((await post(service, "code", { login, code: shellish })).status).toBe(400);
    expect((await post(service, "code", { login, code: "abc123#state-xyz" })).status).toBe(204);
    await promptWhen(service, login, (shown) => shown["ended"] === true);
    expect(readFileSync(receipt("claude-code"), "utf8")).toBe("abc123#state-xyz");
    expect(ended).toBe(1);
  });

  it("stops the CLI when the browser cancels, and frees its home for the next sign-in", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const first = (await (await start(service, { provider: "codex", default: true })).json()) as { login_id: string };
    expect((await start(service, { provider: "codex", default: true })).status).toBe(409);
    expect((await post(service, "cancel", { login: first.login_id })).status).toBe(204);
    expect(((await (await read(service, first.login_id)).json()) as { ended: boolean }).ended).toBe(true);
    const again = await start(service, { provider: "codex", default: true });
    expect(again.status).toBe(200);
    await post(service, "cancel", { login: ((await again.json()) as { login_id: string }).login_id });
  });

  it("signs in to the CLI's own home with its home variable removed", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: "/elsewhere" });
    const { login_id: login } = (await (await start(service, { provider: "claude", default: true })).json()) as { login_id: string };
    await promptWhen(service, login, (shown) => shown["wants_code"] === true);
    expect(readFileSync(receipt("claude-home"), "utf8").trim()).toBe("default");
    await post(service, "cancel", { login });
  });

  it("keeps its id out of the shared lock file, which another device can read, in a shape older servers read", async () => {
    noHerdr();
    const state = mkdtempSync(join(root, "state-"));
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    service.persistTo(state);
    const { login_id: login } = (await (await start(service, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
    const saved = readFileSync(join(state, "usage-logins.json"), "utf8");
    expect(saved).not.toContain(login);
    const [entry] = (JSON.parse(saved) as { logins: Record<string, unknown>[] }).logins;
    expect(entry).toMatchObject({ launch: expect.any(String), pid: process.pid, at: expect.any(Number), private: true });
    await post(service, "cancel", { login });
  });

  it("lets no second server in this process take a home a followed sign-in holds", async () => {
    noHerdr();
    const state = mkdtempSync(join(root, "state-"));
    const first = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const second = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    first.persistTo(state); second.persistTo(state);
    const { login_id: login } = (await (await start(first, { provider: "codex", default: true })).json()) as { login_id: string };
    expect((await start(second, { provider: "codex", default: true })).status).toBe(409);
    await post(first, "cancel", { login });
  });

  it("stops a sign-in no browser came back to read, and every one when the server stops", async () => {
    noHerdr();
    const unread = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` }, undefined, { leaseMs: 150, maxMs: 60_000 });
    const { login_id: lost } = (await (await start(unread, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
    await unread.settled(lost);
    expect(((await (await read(unread, lost)).json()) as { ended: boolean }).ended).toBe(true);
    const stopping = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const { login_id: running } = (await (await start(stopping, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
    await stopping.stopAll();
    expect(((await (await read(stopping, running)).json()) as { ended: boolean }).ended).toBe(true);
  });

  it("opens no private terminal when shutdown happens during the CLI help probe", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const spawn = Bun.spawn;
    spies.push(spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const proc = spawn(...args);
      void service.stopAll();
      return proc;
    }) as typeof spawn));
    const response = await start(service, { provider: "codex", name: `stopping-${++names}` });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "request_cancelled" } });
  });

  it("keeps an expired foreign reservation until its identified owner releases it", async () => {
    noHerdr();
    const state = mkdtempSync(join(root, "foreign-"));
    const birth = readProcessBirth(process.ppid);
    if (birth.state !== "identified") throw new Error("fixture parent has no readable process birth");
    writeFileSync(join(state, "usage-logins.json"), JSON.stringify({ logins: [{
      home: `codex:${join(root, ".codex")}`, launch: crypto.randomUUID(), pid: process.ppid,
      at: Date.now() - 31 * 60_000, private: true, birth: birth.birth,
    }] }));
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    service.persistTo(state);
    expect((await start(service, { provider: "codex", default: true })).status).toBe(409);
  });

  it("reclaims a foreign reservation when the live PID has a different process birth", async () => {
    noHerdr();
    const state = mkdtempSync(join(root, "reused-pid-"));
    const reading = readProcessBirth(process.ppid);
    if (reading.state !== "identified") throw new Error("fixture parent has no readable process birth");
    const birth = { ...reading.birth, value: reading.birth.value.replace(/\d$/, (digit) => digit === "0" ? "1" : "0") };
    writeFileSync(join(state, "usage-logins.json"), JSON.stringify({ logins: [{
      home: `codex:${join(root, ".codex")}`, launch: crypto.randomUUID(), pid: process.ppid,
      at: Date.now(), private: true, birth,
    }] }));
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    service.persistTo(state);
    expect((await start(service, { provider: "codex", default: true })).status).toBe(200);
  });

  it("stops a launcher's children with it, so no second CLI is left writing the home", async () => {
    noHerdr();
    spies.push(spyOn(ptyHost, "rustSidecar").mockReturnValue(null));
    const launcherBin = join(root, "launcher-bin");
    mkdirSync(launcherBin, { recursive: true });
    const childPid = join(root, "launcher-child.pid");
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const listener = Bun.listen({
      hostname: "127.0.0.1", port: 0,
      socket: { open: () => connected.resolve(), close: () => closed.resolve(), data: () => {} },
    });
    const childScript = join(launcherBin, "child.ts");
    writeFileSync(childScript, `
process.on("SIGHUP", () => {});
process.on("SIGTERM", () => {});
await Bun.write(${JSON.stringify(childPid)}, String(process.pid));
await Bun.connect({ hostname: "127.0.0.1", port: ${listener.port}, socket: { data() {}, close() {} } });
process.stdout.write(await Bun.file(${JSON.stringify(join(fixtures, "codex-device.pty"))}).text());
setInterval(() => {}, 60000);
`);
    writeFileSync(join(launcherBin, "codex"), `#!/bin/sh
case "$*" in *--help*) echo "--device-auth"; exit 0;; esac
"${process.execPath}" "${childScript}" &
wait
`, { mode: 0o755 });
    const service = new UsageLoginService(root, { PATH: `${launcherBin}:/usr/bin:/bin` });
    try {
      const { login_id: login } = (await (await start(service, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
      await within(connected.promise);
      await promptWhen(service, login, (shown) => shown["user_code"] !== null);
      expect((await within(post(service, "cancel", { login }))).status).toBe(204);
      await within(closed.promise);
    } finally {
      if (existsSync(childPid)) { try { process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL"); } catch { /* already stopped */ } }
      listener.stop(true);
    }
  }, 15_000);

  it("passes the CLI none of Ovis's own secrets", async () => {
    noHerdr();
    const envBin = join(root, "env-bin");
    mkdirSync(envBin, { recursive: true });
    writeFileSync(join(envBin, "codex"), `#!/bin/sh
case "$*" in *--help*) echo "--device-auth"; exit 0;; esac
echo "token=\${OVIS_TOKEN:-none}" > "${receipt("env")}"
cat "${join(fixtures, "codex-device.pty")}"
exec sleep 600
`, { mode: 0o755 });
    const scoped = new UsageLoginService(root, { PATH: `${envBin}:/usr/bin:/bin`, OVIS_TOKEN: "secret-token" });
    const { login_id: login } = (await (await start(scoped, { provider: "codex", name: `work-${++names}` })).json()) as { login_id: string };
    await promptWhen(scoped, login, (shown) => shown["user_code"] !== null);
    expect(readFileSync(receipt("env"), "utf8").trim()).toBe("token=none");
    await post(scoped, "cancel", { login });
  });

  it("removes the empty home a cancelled sign-in made, so the same account name can be tried again", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const name = `retry-${++names}`;
    const first = (await (await start(service, { provider: "codex", name })).json()) as { login_id: string };
    expect((await post(service, "cancel", { login: first.login_id })).status).toBe(204);
    expect(existsSync(join(root, `.codex-${name}`))).toBe(false);
    const again = await start(service, { provider: "codex", name });
    expect(again.status).toBe(200);
    await post(service, "cancel", { login: ((await again.json()) as { login_id: string }).login_id });
  });

  it("reaches a sign-in only from the browser that started it, by a cookie no page script reads", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    const started = await start(service, { provider: "codex", name: `work-${++names}` });
    const set = started.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\/api\/usage\/login/);
    const { login_id: login } = (await started.json()) as { login_id: string };
    // another browser signed in the same way (the server's token: the same owner) that knows the id
    expect((await read(service, login, false, "device:a", null)).status).toBe(404);
    expect((await read(service, login, false, "device:a", `${jar.get(login)!.split("=")[0]}=forged`)).status).toBe(404);
    expect((await post(service, "code", { login, code: "abc" }, "device:a", null)).status).toBe(404);
    expect((await post(service, "cancel", { login }, "device:a", null)).status).toBe(404);
    expect((await read(service, login)).status).toBe(200);
    expect((await post(service, "cancel", { login })).status).toBe(204);
  });

  it("hands the home a cancelled Claude sign-in set up to the terminal sign-in of the same account", async () => {
    noHerdr();
    const claudeBin = join(root, "claude-init-bin");
    mkdirSync(claudeBin, { recursive: true });
    // Claude writes its config into the new home as soon as it starts, before any sign-in
    writeFileSync(join(claudeBin, "claude"), `#!/bin/sh\ncase "$*" in *--help*) echo "auth login"; exit 0;; esac\necho '{}' > "$CLAUDE_CONFIG_DIR/.claude.json"\ncat "${join(fixtures, "claude.pty")}"\nexec sleep 600\n`, { mode: 0o755 });
    const service = new UsageLoginService(root, { PATH: `${claudeBin}:/usr/bin:/bin` });
    const name = `init-${++names}`;
    const { login_id: login } = (await (await start(service, { provider: "claude", name })).json()) as { login_id: string };
    await promptWhen(service, login, (shown) => shown["url"] !== null);
    expect((await post(service, "cancel", { login })).status).toBe(204);
    const tab = await service.handle(new Request("http://x/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "claude", name }) }), undefined, "device:a");
    const answer = (await tab.json()) as { error?: { code?: string } };
    expect(answer.error?.code).not.toBe("account_exists");
  });

  it("follows only Claude Code and Codex", async () => {
    noHerdr();
    const service = new UsageLoginService(root, { PATH: `${bin}:/usr/bin:/bin` });
    expect((await start(service, { provider: "grok" })).status).toBe(400);
    expect(existsSync(receipt("grok"))).toBe(false);
  });
});
