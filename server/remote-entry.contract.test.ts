import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

describe("remote entry shell agents", () => {
  it.skipIf(process.platform === "win32")("offers an agent installed only on the login shell's PATH", async () => {
    const herdr = Bun.which("herdr");
    expect(herdr).not.toBeNull();
    const root = mkdtempSync("/tmp/hre-");
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    const login = join(root, "login bin");
    const bridges = join(home, ".config/herdr-web-ui/bridges");
    mkdirSync(login);
    mkdirSync(bridges, { recursive: true, mode: 0o700 });
    writeFileSync(join(login, "gjc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const shell = join(root, "login-shell");
    writeFileSync(shell, `#!/bin/sh\nif [ "$1" = "-l" ] && [ "$2" = "-c" ]; then PATH='${login}:/usr/bin:/bin'; export PATH; exec /bin/sh -c "$3"; fi\nexec /bin/sh "$@"\n`, { mode: 0o755 });
    const servicePath = "/usr/bin:/bin";
    expect(Bun.which("gjc", { PATH: servicePath })).toBeNull();
    const session = "t51";
    const env = { PATH: servicePath, HOME: home, SHELL: shell, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(root, "state"), HERDR_REMOTE_SESSION: session, HERDR_REMOTE_START_NEW: "1", OVIS_HERDR_BIN: herdr! };
    const socket = join(xdg, "herdr/sessions", session, "herdr.sock");
    const descriptor = join(bridges, createHash("sha256").update(socket).digest("hex") + ".json");
    const watcher = watch(bridges);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const registered = new Promise<{ port: number; token: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the bridge did not register within 60 s")), 60_000);
        const check = () => {
          if (!existsSync(descriptor)) return;
          clearTimeout(timer);
          resolve(JSON.parse(readFileSync(descriptor, "utf8")));
        };
        watcher.on("change", check);
        child = Bun.spawn([process.execPath, join(import.meta.dir, "remote-entry.ts")], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
        void child.exited.then((code) => { clearTimeout(timer); reject(new Error(`the bridge exited with ${code} before it registered`)); });
        check();
      });
      const { port, token } = await registered;
      const response = await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const { agents } = await response.json() as { agents: { kind: string; label: string; installed: boolean }[] };
      expect(agents).toContainEqual({ kind: "gjc", label: "Gajae Code", installed: true });
    } finally {
      watcher.close();
      if (child) { child.kill(); await child.exited; }
      Bun.spawnSync([herdr!, "--session", session, "server", "stop"], { env });
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
