/**
 * Requires Docker and network; nothing on the host changes.
 *
 * ONE_LINE=1 is the other door: a box with curl and git but no Node, herdr or Bun, and this
 * checkout's install.sh piped into sh as `curl … | sh` would, before herdr ever runs. It installs
 * the plugin at `ref` (install.sh reads OVIS_REF), starts herdr (the box has no service manager:
 * once, in the background), and the startup hook brings the app up. install-service-docker.ts
 * covers a PC with systemd.
 *
 *   bun scripts/fresh-install-docker.ts [owner/repo] [ref]      KEEP=1 leaves the container behind
 */
import assert from "node:assert/strict";

const source = process.argv[2] ?? originSlug();
const ref = process.argv[3] ?? Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
const name = `herdr-fresh-install-${process.pid}`;
const oneLine = process.env["ONE_LINE"] === "1";
const NOISE = /cannot set terminal process group|no job control in this shell|tcsetattr: Inappropriate ioctl/;
const pluginRoot = `$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.ovis")?.plugin_root ?? "")')`;

function originSlug(): string {
  const url = Bun.spawnSync(["git", "remote", "get-url", "origin"]).stdout.toString().trim();
  const match = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  if (!match) throw new Error(`origin is not a GitHub repository: ${url}`);
  return match[1]!;
}

async function docker(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdin: input ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // an interactive bash echoes its prompt and "logout" on stderr; only a failure needs them
  const noise = stderr.split("\n").filter((line) => line && !NOISE.test(line)).join("\n");
  if (code !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed (${code}):\n${stdout.slice(-1500)}\n${noise.slice(-1500)}`);
  return stdout;
}
/** as the user, in a shell like a terminal's: login (~/.local/bin) and interactive (~/.bashrc, where Bun puts itself) */
const asUser = (script: string) => docker(["exec", "-i", "-u", "alice", "-w", "/home/alice", name, "bash", "-li"], script);
const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const result = await run();
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
};

console.log(`fresh install of ${source}@${ref} in a clean Ubuntu 24.04 (${oneLine ? "no Node, herdr or Bun: install.sh" : "Node 18"}, no Python, make or compiler)`);
try {
  await step(`container: base image, curl, git, ${oneLine ? "" : "Node 18, "}a user`, async () => {
    await docker(["run", "-d", "--name", name, "--hostname", "fresh-pc", "ubuntu:24.04", "sleep", "infinity"]);
    await docker(["exec", name, "bash", "-c", `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends curl ca-certificates git unzip xz-utils ${oneLine ? "" : "nodejs"} >/dev/null && useradd -m -s /bin/bash alice`]);
    const tools = await docker(["exec", name, "bash", "-c", "node --version; for t in python3 make g++ cc; do command -v $t >/dev/null && echo \"$t present\"; done; true"]);
    if (!oneLine) assert.match(tools, /^v18\./m, "the distro Node is 18");
    assert.doesNotMatch(tools, /present/, "no build toolchain in the box");
  });
  if (oneLine) await oneLineInstall();
  else await pluginInstall();
} finally {
  if (process.env["KEEP"] === "1") console.log(`container kept: docker exec -it -u alice ${name} bash -li`);
  else await docker(["rm", "-f", name]).catch(() => {});
}

async function oneLineInstall(): Promise<void> {
  await docker(["cp", "install.sh", `${name}:/tmp/install.sh`]);
  const out = await step("install.sh: herdr, Bun, the plugin, and Node where the Rust PTY host cannot run", () => asUser(`cat /tmp/install.sh | OVIS_REF=${ref} sh 2>&1; echo "exit=$?"`));
  assert.match(out, /exit=0/, `install.sh failed:\n${out.slice(-2500)}`);
  assert.match(out, /Installed /, `the plugin install did not finish:\n${out.slice(-2500)}`);
  assert.doesNotMatch(out, /gyp ERR|node-gyp/, "nothing compiled");
  // no service manager in the box: install.sh starts herdr once in the background, and the app with it
  assert.match(out, /in herdr, which was started in the background: this PC has no user service manager/, `install.sh left the app running:\n${out.slice(-1500)}`);
  assert.match(out, /install Tailscale/, `the phone step names what is missing:\n${out.slice(-1500)}`);
  assert.doesNotMatch(await asUser("herdr --version; bun --version; command -v node || true"), /\.local\/bin\/node/, "install.sh puts no node on a new terminal's PATH (#596)");
  await step("the app answers, herdr started by install.sh", async () => {
    const health = await asUser('for i in $(seq 1 30); do if curl -sf http://127.0.0.1:7317/api/health >/dev/null; then echo "up after ${i}s"; exit 0; fi; sleep 1; done; echo TIMEOUT; herdr plugin log list 2>&1 | tail -c 1500; exit 1');
    console.log(`  ${/up after \d+s/.exec(health)?.[0] ?? health.trim().split("\n").pop()}`);
  });
  await step("a terminal through the sidecar, on install.sh's Node where it installed one", async () => {
    const out = await asUser(`cd "${pluginRoot}" && node=~/.local/share/ovis/node/bin/node; if [ -x "$node" ]; then "$node" server/pty/smoke.mjs && echo PTY_OK; else echo NO_APP_NODE; timeout 10 bin/ovis-pty-sidecar 1 1 true </dev/null >/dev/null && echo RUST_PTY_OK; fi; true`);
    if (out.includes("NO_APP_NODE")) {
      assert.match(out, /RUST_PTY_OK/, `install.sh installed no Node, and the Rust PTY host opens no pty:\n${out.slice(-1500)}`);
      console.log("  install.sh installed no Node: the Rust PTY host runs this PC's terminals");
    } else assert.match(out, /PTY_OK/, `the bundled PTY smoke test failed:\n${out.slice(-1500)}`);
  });
  const again = await step("install.sh again: keeps what is there", () => asUser(`cat /tmp/install.sh | sh 2>&1; echo "exit=$?"`));
  assert.match(again, /exit=0/, again.slice(-1500));
  assert.match(again, /already installed/);
  assert.doesNotMatch(again, /not running yet/, "the app is up");
  // the usual case: herdr already runs, and builds the plugin with its own PATH, not install.sh's
  await asUser("herdr plugin uninstall devswha.ovis >/dev/null 2>&1; curl -sf http://127.0.0.1:7317/api/health >/dev/null && pkill -f server/managed.ts; true");
  const running = await step("install.sh with herdr running: builds, starts and waits", () => asUser(`cat /tmp/install.sh | OVIS_REF=${ref} sh 2>&1; echo "exit=$?"`));
  assert.match(running, /exit=0/, running.slice(-2500));
  assert.match(running, /Installed /, running.slice(-2500));
  assert.doesNotMatch(running, /not running yet|did not start/, running.slice(-1500));
  console.log(`\nA bare Ubuntu 24.04 goes from one line to Ovis running. install.sh said:\n${out.split("\n").filter((line) => /^Ovis|Installed /.test(line)).map((l) => `  ${l.trim()}`).join("\n")}`);
}

async function pluginInstall(): Promise<void> {
  await step("herdr and Bun from their installers", async () => {
    await asUser("curl -fsSL https://herdr.dev/install.sh | sh >/dev/null 2>&1; curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1");
    const versions = await asUser("herdr --version; bun --version");
    assert.match(versions, /herdr \d/, "herdr on the PATH of a terminal shell");
    assert.match(versions, /^1\.[4-9]|^[2-9]\./m, "Bun 1.4+ on the PATH of a terminal shell");
  });
  await step("a headless herdr", async () => {
    await asUser("setsid nohup herdr server > ~/herdr-server.log 2>&1 < /dev/null & sleep 3; herdr status server");
  });
  const install = await step("herdr plugin install", async () => {
    const out = await asUser(`herdr plugin install ${source} --ref ${ref} --yes 2>&1`);
    assert.match(out, /Installed /, `the install did not finish:\n${out.slice(-2500)}`);
    assert.doesNotMatch(out, /gyp ERR|node-gyp/, "nothing compiled");
    return out;
  });
  assert.match(await asUser("herdr plugin list"), /enabled/);
  await step("start action, then /api/health", async () => {
    await asUser("herdr plugin action invoke devswha.ovis.start >/dev/null");
    const health = await asUser('for i in $(seq 1 20); do if curl -sf http://127.0.0.1:7317/api/health; then exit 0; fi; sleep 1; done; echo TIMEOUT; cat ~/.local/state/herdr/plugins/*/server.log 2>/dev/null | tail -20; exit 1');
    assert.match(health, /"ok":true/);
  });
  await step("a terminal through the sidecar, on the box's own Node", async () => {
    const out = await asUser(`cd "${pluginRoot}" && node server/pty/smoke.mjs && echo PTY_OK`);
    assert.match(out, /PTY_OK/, `the bundled PTY smoke test failed:\n${out.slice(-1500)}`);
  });
  await step("startup hook: herdr restarts, the app comes back by itself", async () => {
    await asUser("herdr plugin action invoke devswha.ovis.stop >/dev/null 2>&1; sleep 1; herdr server stop >/dev/null 2>&1; sleep 2; setsid nohup herdr server > ~/herdr-server2.log 2>&1 < /dev/null &");
    const health = await asUser('for i in $(seq 1 25); do if curl -sf http://127.0.0.1:7317/api/health >/dev/null; then echo "up after ${i}s"; exit 0; fi; sleep 1; done; echo TIMEOUT; herdr plugin log list 2>&1 | tail -c 1500; exit 1');
    console.log(`  ${/up after \d+s/.exec(health)?.[0] ?? health.trim().split("\n").pop()}`);
  });
  const said = install.split("\n").filter((line) => /Installed |Config:/.test(line));
  console.log(`\nA new user on a bare Ubuntu 24.04 gets Ovis working. herdr said:\n${said.map((l) => `  ${l.trim()}`).join("\n")}`);
}
