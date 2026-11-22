/**
 * The trial join's two lines (scripts/join/README.md), run as a person runs them, in containers: the CI runner image
 * (an account, no service manager: the trial server runs in the background) and the systemd image built on it from
 * scripts/join/systemd-qa.Dockerfile, as ovis-join-systemd:local when missing (systemd as PID 1, a user manager: the
 * trial server is a user unit). The world is the repository's own test account service and Bun relay
 * (scripts/join/test-world.ts) behind a TLS proxy with a test CA, on a docker network of the test's own with no way
 * out. Every container is pinned to CPUs 112-127, labelled `ovis-join-qa` and removed at the end.
 *
 * The server in the kit is built from this checkout, which has the machine profile. The cases run with the test switch
 * OVIS_JOIN_TEST_PLAIN_SERVER=1 on a kit made with --test-kit; the cases that need a plain server (the interlock's refusal,
 * an open pairing gate) use one built without the machine profile (OVIS_JOIN_PLAIN_SERVER_BIN), and OVIS_JOIN_QA_REAL_PROFILE=1 runs case 1
 * on the real profile with no switch.
 *
 * The person's steps that are stood in: the sign-in at the link page is the test account service's own approval call
 * (`approveOnLinkPage`); the phone's scan of the QR code is NOT run (no scripted device client exists for it), so each
 * join here ends at the QR code with Ctrl+C, after the account listing and the server's own answers are checked.
 *
 *   OVIS_JOIN_CONTAINER_QA=1 OVIS_JOIN_HERDR_BIN=<herdr 0.9> OVIS_PTY_SIDECAR_BIN=<host> [OVIS_SERVER_BIN=<server>]
 *   [OVIS_JOIN_EVIDENCE=<dir>] bun test scripts/join/join.contract.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { joinLine, makeKit, type Kit } from "./kit.ts";

const QA = process.env["OVIS_JOIN_CONTAINER_QA"] === "1";
const HERDR = process.env["OVIS_JOIN_HERDR_BIN"];
const PTY = process.env["OVIS_PTY_SIDECAR_BIN"];
const EVIDENCE = process.env["OVIS_JOIN_EVIDENCE"];
const ready = QA && HERDR !== undefined && existsSync(HERDR) && PTY !== undefined && existsSync(PTY);
const REPO = resolve(import.meta.dir, "..", "..");
const LABEL = "ovis-join-qa";
const SYSTEMD_IMAGE = "ovis-join-systemd:local";
const CPUS = process.env["OVIS_HEAVY_CPUS"] ?? "112-127";
const NET = `ovis-join-${process.pid}`;
/** the test network: a documentation range (RFC 5737), internal to docker, routed nowhere */
const WORLD_IP = "198.51.100.10";
const ORIGINS = { url: "https://kit.join.test:7443/kit", relay: "wss://relay.join.test:8443", account: "https://account.join.test:9443", app: "https://app.join.test:7441" };
/** this checkout's version, which a stand-in server must carry (kit.ts refuses a server built from another one) */
const VERSION = JSON.stringify((JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version);
const PLAIN = "OVIS_JOIN_TEST_PLAIN_SERVER=1";
/** OVIS_JOIN_QA_REAL_PROFILE=1: the kit is made as for a person (no TEST-KIT) and case 1's machine has no test switch, so
 * its server must be the machine profile (OVIS_PROFILE=machine) to pass the interlock. Run with -t "1, 5, 7" only. */
const REAL_PROFILE = process.env["OVIS_JOIN_QA_REAL_PROFILE"] === "1";
const TRIAL = ".local/share/ovis-machine";

function note(name: string, text: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  appendFileSync(join(EVIDENCE, `${name}.log`), `${text}\n`);
}

async function docker(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["docker", ...args], { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

interface Who { readonly user: string; readonly env: readonly string[] }
const envArgs = (env: readonly string[]) => env.flatMap((pair) => ["-e", pair]);
const sh = (name: string, script: string, who: Who) => docker(["exec", "-i", "-u", who.user, ...envArgs(who.env), name, "sh", "-c", `cd && ${script}`]);

function stream(argv: string[]) {
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let text = "";
  const waiting = new Set<{ re: RegExp; done: (match: RegExpMatchArray) => void }>();
  const take = async (from: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of from) {
      text += decoder.decode(chunk, { stream: true });
      for (const waiter of [...waiting]) { const match = text.match(waiter.re); if (match) { waiting.delete(waiter); waiter.done(match); } }
    }
  };
  const exited = Promise.all([take(child.stdout), take(child.stderr)]).then(() => child.exited);
  return {
    get text() { return text; },
    exited,
    kill: () => child.kill(),
    type(input: string) { child.stdin.write(input); child.stdin.flush(); },
    until(re: RegExp, ms = 120_000): Promise<RegExpMatchArray> {
      const now = text.match(re);
      if (now) return Promise.resolve(now);
      return new Promise((resolveMatch, reject) => {
        const waiter = { re, done: (match: RegExpMatchArray) => { clearTimeout(timer); resolveMatch(match); } };
        const timer = setTimeout(() => { waiting.delete(waiter); reject(new Error(`no ${re} within ${ms} ms; output so far:\n${text}`)); }, ms);
        waiting.add(waiter);
        void exited.then(() => { if (waiting.delete(waiter)) { clearTimeout(timer); reject(new Error(`ended before ${re}; output:\n${text}`)); } });
      });
    },
  };
}
/** a command at a terminal of `who` in container `name` (script(1) gives it a pty; its input is what `type` writes) */
const terminal = (name: string, who: Who, command: string) =>
  stream(["docker", "exec", "-i", "-u", who.user, ...envArgs(who.env), name, "script", "-qfec", `stty rows 60 cols 120; cd && ${command}`, "/dev/null"]);

let kit: Kit;
/** kits whose server is the plain one, OVIS_JOIN_PLAIN_SERVER_BIN (a server built from a tree without the machine
 * profile): this checkout's server is the machine profile, with its pairing gate closed from the start, so the
 * interlock's refusal and an open gate (exit 34) can only be shown with such a server */
const PLAIN_SERVER = process.env["OVIS_JOIN_PLAIN_SERVER_BIN"];
let plainKit: Kit;
let plainOwnerKit: Kit;
/** a kit whose server is a stand-in that names the machine profile to the join's probe only (a HOME under the probe's
 * folder): the installed server then answers as a plain one, the only way to reach the refusal after the start */
let shiftyKit: Kit;
let silentKit: Kit;
let fakeKit: Kit;
let server = "";
let scratch = "";
let kits = "";
const containers: string[] = [];
const streams: { kill: () => void }[] = [];
let accounts = 0;
const newAccount = () => `acct_join_${++accounts}`;

async function container(prefix: string, args: string[]): Promise<string> {
  const name = `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  const started = await docker(["run", "-d", "--name", name, "--label", LABEL, "--cpuset-cpus", CPUS, "--network", NET, ...args]);
  expect(started.code, started.stderr).toBe(0);
  containers.push(name);
  return name;
}

const control = (path: string, body?: unknown) => docker(["exec", `ovis-join-world-${process.pid}`, "curl", "-fsS",
  ...(body === undefined ? [] : ["-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify(body)]), `http://${WORLD_IP}:9090${path}`]);
const world = {
  async pcs(account: string): Promise<{ server_id: string }[]> {
    const got = await control(`/pcs?account=${account}`);
    expect(got.code, got.stderr).toBe(0);
    return JSON.parse(got.stdout) as { server_id: string }[];
  },
  async approve(userCode: string, account: string): Promise<void> {
    const got = await control("/approveLink", { userCode, account });
    expect(got.code, got.stderr).toBe(0);
  },
};

/** the home, outside herdr's own folders (herdr writes its logs and session there by itself), and /tmp */
const HOME_TREE = "find . \\( -path ./.config/herdr -o -path ./.local/state/herdr \\) -prune -o \\( -type f -exec sha256sum {} + \\) -o \\( ! -type f -printf '%p %y %m\\n' \\) | sort"
  // the folder line of herdr's own state folder's parent (herdr makes it when it first writes there)
  + " | grep -vx './.local/state d 755'"
  + "; echo ---tmp; ls -A /tmp";
const PROCESSES = "ps -eo pid,args --no-headers | awk '$2 ~ /(herdr|ovis-server)/' | sort -n";
const herdrProcesses = (table: string) => table.split("\n").filter((line) => /\/herdr( |$)/.test(line)).join("\n");

interface Machine {
  readonly name: string;
  readonly who: Who;
  readonly home: () => Promise<string>;
  readonly processes: () => Promise<string>;
  readonly sh: (script: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly root: (script: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}
function machineOf(name: string, who: Who): Machine {
  return {
    name, who,
    // the plain server (test switch only) records itself in ~/.config/herdr-web-ui/bridges (server/bridge.ts:25-26), as
    // the join's start settings say it does: under the switch that folder is left out of the comparison, never otherwise
    home: async () => {
      const tree = (await sh(name, HOME_TREE, who)).stdout;
      return who.env.includes(PLAIN) ? tree.split("\n").filter((line) => !line.includes("./.config/herdr-web-ui")).join("\n") : tree;
    },
    processes: async () => (await sh(name, PROCESSES, who)).stdout,
    sh: (script) => sh(name, script, who),
    root: (script) => docker(["exec", "-i", "-u", "root", name, "sh", "-c", script]),
  };
}

/** a machine of the CI runner image: the runner account, herdr linked into ~/.local/bin as its installer puts it, the test CA trusted */
async function runnerMachine(options: { herdr?: boolean; mounts?: string[]; env?: string[]; args?: string[] } = {}): Promise<Machine> {
  const name = await container("ovis-join-m", ["--init", "--tmpfs", "/usr/local/bin", "-e", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", ...(options.args ?? []),
    "-v", `${HERDR}:/opt/eng/herdr:ro`, "-v", `${scratch}/certs/ca.pem:/certs/ca.pem:ro`,
    ...(options.mounts ?? []).flatMap((mount) => ["-v", mount]), "--entrypoint", "sleep", "herdr-ci-runner:local", "infinity"]);
  const m = machineOf(name, { user: "runner", env: ["NODE_EXTRA_CA_CERTS=/certs/ca.pem", ...(options.env ?? [PLAIN])] });
  expect((await m.root("cp /certs/ca.pem /usr/local/share/ca-certificates/join-test.crt && update-ca-certificates >/dev/null 2>&1")).code).toBe(0);
  expect((await m.sh("mkdir -p ~/.local/share/other-app && echo kept > ~/.local/share/other-app/data")).code).toBe(0);
  if (options.herdr !== false) expect((await m.sh("mkdir -p ~/.local/bin && ln -s /opt/eng/herdr ~/.local/bin/herdr")).code).toBe(0);
  return m;
}

async function serveHerdr(m: Machine, session?: string, agent = true): Promise<ReturnType<typeof stream>> {
  const flag = session === undefined ? "" : ` --session ${session}`;
  const herdr = stream(["docker", "exec", "-u", m.who.user, ...envArgs(m.who.env), m.name, "sh", "-c", `cd && exec ~/.local/bin/herdr${flag} server`]);
  streams.push(herdr);
  await herdr.until(/herdr server running/, 60_000);
  const made = await m.sh(`~/.local/bin/herdr${flag} workspace create --label agent --no-focus`);
  expect(made.code, made.stderr).toBe(0);
  const pane = /"pane_id"\s*:\s*"([^"]+)"/.exec(made.stdout)?.[1];
  expect(pane, made.stdout).toBeDefined();
  const report = agent ? ` && ~/.local/bin/herdr${flag} pane report-agent --source manual --agent claude --state working ${pane}` : "";
  expect((await m.sh(`~/.local/bin/herdr${flag} pane run ${pane} 'sleep 4242'${report}`)).code).toBe(0);
  return herdr;
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

type Health = { herdr?: { terminal_attach?: boolean }; web_ui?: { server_id?: string } };
/** the trial server's health as its local owner reads it, on its owner socket: its TCP port says only that it is alive */
const health = async (m: Machine): Promise<Health | null> => {
  const got = await m.sh(`curl -fsS --max-time 5 --unix-socket ${TRIAL}/state/serve.sock http://localhost/api/health`);
  return got.code === 0 ? JSON.parse(got.stdout) as Health : null;
};
const trialPort = async (m: Machine) => Number((await m.sh(`sed -n 's/^port //p' ${TRIAL}/trial`)).stdout.trim());

/** What every consent must show, read as a program reads it: both languages, the three origins as given, an undo line. */
function consentShown(text: string): string {
  expect(text).toMatch(/[가-힣]/);
  for (const [label, value] of [["app", ORIGINS.app], ["account service", ORIGINS.account], ["relay", ORIGINS.relay]] as const) {
    expect(new RegExp(`^ +${label}: +(\\S+)\\r?$`, "m").exec(text)?.[1]).toBe(value);
  }
  const undo = /Undo at any time: {2}(.+?)\r?$/m.exec(text)?.[1];
  expect(undo).toBeDefined();
  return undo!;
}

async function joinToQr(m: Machine, line: string, account: string, answers: [RegExp, string][] = [], stopAt: "qr" | "code" = "qr"): Promise<{ text: string; code: number; undo: string }> {
  const run = terminal(m.name, m.who, line);
  for (const [prompt, answer] of answers) { await run.until(prompt); run.type(`${answer}\r`); }
  await run.until(/Type yes to go on/);
  run.type("yes\r");
  const code = (await run.until(/enter the code: (\S+)/, 180_000))[1]!;
  if (stopAt === "qr") {
    await world.approve(code, account);
    await run.until(new RegExp(`Signed in as Ovis account ${account} .*Press Enter to show the QR code`), 120_000);
    // fixed wait: a person reads the question first; the add drops a line that comes within 1.5 s of it (DWELL_MS, scripts/plugin-link.ts)
    await Bun.sleep(2_000);
    run.type("\r");
    await run.until(/Scan this QR code/, 120_000);
  }
  run.type("\x03");
  const exit = await run.exited;
  return { text: run.text, code: exit, undo: consentShown(run.text) };
}

/**
 * The TCP addresses a program listens on, from its own sockets (/proc/<pid>/fd matched to /proc/net/tcp): ss shows no
 * process column in these containers.
 */
async function listening(m: Machine, program: string): Promise<string[]> {
  const rows = (await m.sh(`for p in $(ps -eo pid,args --no-headers | awk '$2 == "${program}" { print $1 }'); do for i in $(ls -l /proc/$p/fd 2>/dev/null | sed -n 's/.*socket:\\[\\([0-9]*\\)\\]$/\\1/p'); do awk -v i=$i '$4 == "0A" && $10 == i { print $2 }' /proc/net/tcp; done; done`)).stdout.trim();
  return rows === "" ? [] : rows.split("\n").map((row) => {
    const [ip, port] = row.split(":") as [string, string];
    const bytes = ip.match(/../g)!.map((pair) => Number.parseInt(pair, 16)).reverse();
    return `${bytes.join(".")}:${Number.parseInt(port, 16)}`;
  }).sort();
}

/**
 * The doors of a stand-in server, as the machine profile has them: its owner socket `serve.sock` in its state folder
 * (made 0700 when absent, a socket file left there removed), served before its TCP port; both give the same answers.
 */
const STAND_IN_DOOR = `import { mkdirSync as standInDir, rmSync as standInRm } from "node:fs";
function serveAsProfile(fetch: (request: Request) => Response) {
  const state = process.env.OVIS_STATE_DIR ?? "";
  standInDir(state, { recursive: true, mode: 0o700 });
  standInRm(state + "/serve.sock", { force: true });
  Bun.serve({ unix: state + "/serve.sock", fetch });
  Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch });
}`;

/** a socket that listens and answers nothing, as a stand-in engine (python3: the machines have no Bun or Node) */
const LISTEN = "import socket, sys, time; s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(); print(\"listening\", flush=True); time.sleep(1e9)";

describe.skipIf(!ready)("the trial join by one pasted line, in containers", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "ovis-join-qa-"));
    if ((await docker(["image", "inspect", SYSTEMD_IMAGE])).code !== 0) {
      const image = await docker(["build", "-t", SYSTEMD_IMAGE, "-"], readFileSync(join(import.meta.dir, "systemd-qa.Dockerfile"), "utf8"));
      if (image.code !== 0) throw new Error(`building ${SYSTEMD_IMAGE} failed: ${image.stderr}`);
    }
    server = process.env["OVIS_SERVER_BIN"] ?? "";
    if (server === "") {
      const built = Bun.spawnSync([process.execPath, join(REPO, "scripts", "build-server.ts"), "linux-x64", join(scratch, "server")], { stdout: "pipe", stderr: "pipe" });
      if (built.exitCode !== 0) throw new Error(`building ovis-server failed: ${built.stderr.toString()}`);
      server = join(scratch, "server", "ovis-server");
    }
    // the kits the world serves, in a folder others may read: the world's server runs as another user than this test
    kits = join(scratch, "kits");
    mkdirSync(kits, { mode: 0o755 });
    kit = makeKit({ server, pty: PTY!, out: join(kits, "kit"), testKit: !REAL_PROFILE, ...ORIGINS });
    if (PLAIN_SERVER === undefined) throw new Error("OVIS_JOIN_PLAIN_SERVER_BIN is needed: a server built without the machine profile, for the interlock and open-gate cases");
    const plain = PLAIN_SERVER;
    plainKit = makeKit({ server: plain, pty: PTY!, out: join(kits, "kit-plain"), testKit: true, ...ORIGINS, url: ORIGINS.url.replace(/\/kit$/, "/kit-plain") });
    const shifty = join(scratch, "shifty");
    mkdirSync(shifty, { recursive: true });
    writeFileSync(join(shifty, "server.ts"), `${STAND_IN_DOOR}
const [command] = process.argv.slice(2);
if (command === "--version") console.log(${VERSION});
if (command !== "serve") { process.stderr.write("usage: ovis-server <command>\\n"); process.exit(2); }
const probe = (process.env.HOME ?? "").includes("/probe/");
serveAsProfile(() => Response.json({ ok: true, ...(probe ? { machine_profile: { engine: "herdr" } } : {}), herdr: { terminal_attach: true } }));
`);
    const builtShifty = Bun.spawnSync([process.execPath, "build", "--compile", join(shifty, "server.ts"), "--outfile", join(shifty, "ovis-server")], { stdout: "pipe", stderr: "pipe" });
    if (builtShifty.exitCode !== 0) throw new Error(builtShifty.stderr.toString());
    shiftyKit = makeKit({ server: join(shifty, "ovis-server"), pty: PTY!, out: join(kits, "kit-shifty"), ...ORIGINS, url: ORIGINS.url.replace(/\/kit$/, "/kit-shifty") });
    writeFileSync(join(shifty, "silent.ts"), `const [command] = process.argv.slice(2);
if (command === "--version") console.log(${VERSION});
if (command !== "serve") { process.stderr.write("usage: ovis-server <command>\\n"); process.exit(2); }
setInterval(() => {}, 1 << 30);
`);
    const builtSilent = Bun.spawnSync([process.execPath, "build", "--compile", join(shifty, "silent.ts"), "--outfile", join(shifty, "silent", "ovis-server")], { stdout: "pipe", stderr: "pipe" });
    if (builtSilent.exitCode !== 0) throw new Error(builtSilent.stderr.toString());
    silentKit = makeKit({ server: join(shifty, "silent", "ovis-server"), pty: PTY!, out: join(kits, "kit-silent"), testKit: true, ...ORIGINS, url: ORIGINS.url.replace(/\/kit$/, "/kit-silent") });
    writeFileSync(join(shifty, "fake.ts"), `${STAND_IN_DOOR}
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const [command, sub] = process.argv.slice(2);
// /var/tmp/fake-status-<how> holds how many account status reads are still answered that way: fails (an error status,
// the server restarting, say), cut (a body cut off after "account":null, sent whole), stall (that body, then nothing),
// stall-whole ({"account":null} whole, then nothing: only the download's exit status says it is no answer),
// stall-nested (a body cut at a nested closing brace, then nothing) or malformed (a whole answer that is no JSON
// object, holding "account":null)
function statusAnswers(how: string): boolean {
  const file = "/var/tmp/fake-status-" + how;
  const left = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (!(left > 0)) return false;
  writeFileSync(file, String(left - 1));
  return true;
}
const CUT = '{"account":null';
const stalled = (body: string) => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(body)); } }), { headers: { "content-type": "application/json" } });
if (command === "--version") console.log(${VERSION});
if (command === "plugin") {
  if (sub !== "add") process.exit(0);
  // a device of some account pairs during the add: the server names that account from then on
  if (existsSync("/var/tmp/fake-add-links")) writeFileSync("/var/tmp/fake-account-listed", "");
  // the server is back by the time the add has run
  for (const how of ["fails", "cut", "stall", "stall-whole", "stall-nested", "malformed"]) rmSync("/var/tmp/fake-status-" + how, { force: true });
  if (existsSync("/var/tmp/fake-add-fails")) { console.log("stand-in add: failed"); process.exit(1); }
  console.log("stand-in add: done");
  process.exit(0);
}
if (command !== "serve") { process.stderr.write("usage: ovis-server <command>\\n"); process.exit(2); }
if ((process.env.HOME ?? "").includes("/probe/") && existsSync("/var/tmp/fake-probe-hangs")) {
  if (existsSync("/var/tmp/fake-probe-ignores-term")) process.on("SIGTERM", () => {});
  if (existsSync("/var/tmp/fake-probe-leaves")) rmSync(process.execPath, { force: true });
  writeFileSync("/var/tmp/probe-started", String(process.pid));
  setInterval(() => {}, 1 << 30);
} else {
  serveAsProfile((request) => new URL(request.url).pathname === "/api/account/status"
    ? (statusAnswers("fails") ? new Response("restarting", { status: 503 })
      : statusAnswers("cut") ? new Response(CUT, { headers: { "content-type": "application/json" } })
      : statusAnswers("malformed") ? new Response('<p>"account":null</p>', { headers: { "content-type": "application/json" } })
      : statusAnswers("stall") ? stalled(CUT)
      : statusAnswers("stall-whole") ? stalled('{"account":null}')
      : statusAnswers("stall-nested") ? stalled('{"account":null,"server":{"id":"s1"}')
      // an account named by /var/tmp/fake-account-id, whatever its id
      : existsSync("/var/tmp/fake-account-id") ? Response.json({ account: readFileSync("/var/tmp/fake-account-id", "utf8") })
      : existsSync("/var/tmp/fake-account-listed") ? Response.json({ account: "acct_standin" })
      : existsSync("/var/tmp/fake-account-null") ? Response.json({ account: null }) : new Response("no account here", { status: 503 }))
    : Response.json({ ok: true, machine_profile: { engine: "herdr" }, herdr: { terminal_attach: true },
      // its pairing gate as /var/tmp/fake-gate-open or -closed says; with neither, its health names none
      ...(existsSync("/var/tmp/fake-gate-open") ? { security: { pairing_gate: "open" } } : existsSync("/var/tmp/fake-gate-closed") ? { security: { pairing_gate: "closed" } } : {}) }));
}
`);
    const builtFake = Bun.spawnSync([process.execPath, "build", "--compile", join(shifty, "fake.ts"), "--outfile", join(shifty, "fake", "ovis-server")], { stdout: "pipe", stderr: "pipe" });
    if (builtFake.exitCode !== 0) throw new Error(builtFake.stderr.toString());
    fakeKit = makeKit({ server: join(shifty, "fake", "ovis-server"), pty: PTY!, out: join(kits, "kit-fake"), ...ORIGINS, url: ORIGINS.url.replace(/\/kit$/, "/kit-fake") });
    plainOwnerKit = makeKit({ server: plain, pty: PTY!, out: join(kits, "kit-plain-owner"), ...ORIGINS, url: ORIGINS.url.replace(/\/kit$/, "/kit-plain-owner") });
    note("kit", `line: ${kit.line}\nsums: ${kit.sums}\n${JSON.stringify(kit.files, null, 2)}`);
    const certs = join(scratch, "certs");
    mkdirSync(certs);
    const openssl = (args: string) => expect(Bun.spawnSync(["sh", "-c", `cd '${certs}' && openssl ${args}`], { stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
    openssl("req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=ovis join test CA' -keyout ca.key -out ca.pem");
    openssl("req -newkey rsa:2048 -nodes -subj '/CN=join.test' -keyout key.pem -out leaf.csr");
    writeFileSync(join(certs, "leaf.ext"), "subjectAltName=DNS:relay.join.test,DNS:account.join.test,DNS:kit.join.test\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
    openssl("x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile leaf.ext -out cert.pem");
    Bun.spawnSync(["chmod", "644", join(certs, "ca.pem"), join(certs, "cert.pem"), join(certs, "key.pem")]);
    writeFileSync(join(scratch, "Caddyfile"), `{\n\tauto_https off\n\tadmin off\n}\nhttps://relay.join.test:8443 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy ${WORLD_IP}:8787\n}\nhttps://account.join.test:9443 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy ${WORLD_IP}:9080\n}\nhttps://kit.join.test:7443 {\n\ttls /certs/cert.pem /certs/key.pem\n\treverse_proxy ${WORLD_IP}:9180\n}\n`);
    const net = await docker(["network", "create", "--internal", "--label", LABEL, "--subnet", "198.51.100.0/24", NET]);
    expect(net.code, net.stderr).toBe(0);
    const worldName = `ovis-join-world-${process.pid}`;
    const worldRun = stream(["docker", "run", "--rm", "--name", worldName, "--label", LABEL, "--cpuset-cpus", CPUS, "--network", NET, "--ip", WORLD_IP,
      "-e", `JOIN_BIND=${WORLD_IP}`, "-v", `${REPO}:/opt/ovis:ro`, "-v", `${kits}:/srv:ro`, "--workdir", "/opt/ovis", "--entrypoint", "bun", "herdr-ci-runner:local", "scripts/join/test-world.ts"]);
    streams.push(worldRun);
    containers.push(worldName);
    await worldRun.until(/"event":"ready"/, 120_000);
    await container("ovis-join-tls", ["--ip", "198.51.100.11", "--network-alias", "relay.join.test", "--network-alias", "account.join.test", "--network-alias", "kit.join.test",
      "-v", `${certs}:/certs:ro`, "-v", `${join(scratch, "Caddyfile")}:/etc/caddy/Caddyfile:ro`, "caddy:2"]);
  }, 900_000);

  afterAll(async () => {
    for (const s of streams) s.kill();
    if (containers.length > 0) await docker(["rm", "-f", ...containers]);
    await docker(["network", "rm", NET]);
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  test("1, 5, 7: a fresh machine with a user manager joins as far as the QR code, is listed once, and the undo gives everything back", async () => {
    // systemd as PID 1 makes cgroups for the user manager and the trial's unit: under docker that takes --privileged,
    // the host's cgroup namespace and /sys/fs/cgroup mounted writable. systemd keeps to the cgroup docker gives the
    // container, and no test here writes under /sys/fs/cgroup
    const name = await container("ovis-join-sd", ["--privileged", "--cgroupns=host", "--tmpfs", "/run", "--tmpfs", "/run/lock", "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      "-v", `${HERDR}:/opt/eng/herdr:ro`, "-v", `${scratch}/certs/ca.pem:/certs/ca.pem:ro`, SYSTEMD_IMAGE]);
    const root = (script: string) => docker(["exec", "-i", "-u", "root", name, "sh", "-c", script]);
    // no event exists for PID 1's control socket appearing (the image has no inotify tool): a bounded look for it; then
    // systemd's own wait for the end of its start-up, which answers running or degraded
    const booted = await root("timeout 60 sh -c 'while [ ! -S /run/systemd/private ]; do sleep 0.1; done' && s=$(timeout 120 systemctl is-system-running --wait); echo $s; case $s in running | degraded) exit 0 ;; esac; exit 1");
    expect(booted.code, booted.stdout + booted.stderr).toBe(0);
    const uid = (await root("id -u ovis")).stdout.trim();
    const started = await root(`cp /certs/ca.pem /usr/local/share/ca-certificates/join-test.crt && update-ca-certificates >/dev/null 2>&1 && systemctl start user@${uid}.service`);
    expect(started.code, started.stderr).toBe(0);
    const m = machineOf(name, { user: "ovis", env: [`XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, "NODE_EXTRA_CA_CERTS=/certs/ca.pem", ...(REAL_PROFILE ? [] : [PLAIN])] });
    expect((await m.sh("mkdir -p ~/.local/bin ~/.local/share/other-app && ln -s /opt/eng/herdr ~/.local/bin/herdr && echo kept > ~/.local/share/other-app/data")).code).toBe(0);
    const herdrServer = await serveHerdr(m);
    note("case1", `herdr in the container: ${(await m.sh("~/.local/bin/herdr --version")).stdout}`);
    const lingerBefore = (await root("loginctl show-user ovis -p Linger --value")).stdout.trim();
    const lingerSeen = (await m.sh("loginctl show-user ovis -p Linger --value 2>/dev/null")).stdout.trim();
    const homeBefore = await m.home();
    const enginesBefore = herdrProcesses(await m.processes());
    const account = newAccount();

    // the user manager's own environment carries names the server must never get: the unit runs serve.sh (env -i)
    expect((await m.sh("systemctl --user set-environment OVIS_PTY_SIDECAR_BIN=/nowhere NODE_OPTIONS=--max-old-space-size=4096 OVIS_TOKEN=leaked")).code).toBe(0);
    const joined = await joinToQr(m, kit.line, account);
    expect(joined.text).not.toContain("cannot open");
    // stopped at the QR code: the trial server names no account yet (no device paired) and the add proves nothing else,
    // so the ending says it could not tell, with the status command
    expect(joined.text).toContain("it could not tell whether the machine is listed in your Ovis account; check with:");
    expect(joined.text).not.toContain("was not added");
    // the exit status script(1) reports for a session ended by Ctrl+C is the terminal's, not the join's: recorded only
    note("case1", `${joined.text}\n[the terminal session ended with ${joined.code}]`);
    expect((await m.sh("systemctl --user is-active ovis-machine.service")).stdout.trim()).toBe("active");
    const answer = await health(m);
    expect(answer?.herdr?.terminal_attach).toBe(true);
    // the add turned the relay on, which closes the pairing gate: no device pairs without the account's approval
    expect((answer as { security?: { pairing_gate?: string } } | null)?.security?.pairing_gate).toBe("closed");
    expect((await world.pcs(account)).map((pc) => pc.server_id)).toEqual([answer!.web_ui!.server_id!]);
    // server.env: exactly the start line's names, and the running server has exactly those values
    const file = (await m.sh(`cat ${TRIAL}/server.env`)).stdout.trim().split("\n");
    expect(file.map((line) => line.slice(0, line.indexOf("="))).sort()).toEqual(["HERDR_SOCKET", "HOME", "NODE_EXTRA_CA_CERTS", "OVIS_ACCOUNT_SERVICE_URL", "OVIS_HERDR_BIN", "OVIS_PREVIEW", "OVIS_PROFILE",
      "OVIS_RELAY_APP_URL", "OVIS_RELAY_URL", "OVIS_RUNTIME", "OVIS_STATE_DIR", "OVIS_TELEMETRY", "PATH", "PORT", "SHELL", "XDG_RUNTIME_DIR"]);
    const mainPid = (await m.sh("systemctl --user show -p MainPID --value ovis-machine.service")).stdout.trim();
    const environ = (await m.sh(`tr '\\000' '\\n' < /proc/${mainPid}/environ`)).stdout.split("\n");
    for (const line of file) expect(environ).toContain(line);
    expect(environ.some((line) => /^(HOST|OVIS_TOKEN)=/.test(line))).toBe(false);
    const unit = (await m.sh("systemctl --user show -p EnvironmentFiles -p Environment -p UnsetEnvironment -p ExecStart ovis-machine.service; cat ~/.config/systemd/user/ovis-machine.service")).stdout;
    note("case1", `--- ${TRIAL}/server.env:\n${file.join("\n")}\n--- the unit as systemd holds it:\n${unit}\n--- ss -ltnp after the add, relay on:\n${(await m.root("ss -ltnp")).stdout}`);
    expect(herdrProcesses(await m.processes())).toBe(enginesBefore);
    const lingerNow = (await root("loginctl show-user ovis -p Linger --value")).stdout.trim();
    const inReceipt = (await m.sh(`grep -c '^linger ' ${TRIAL}/receipt`)).stdout.trim() === "1";
    // the receipt names lingering (before enable-linger runs) only when the join read an explicit "no"; an unreadable
    // state is left as it is, and said so
    expect(inReceipt).toBe(lingerSeen === "no");
    if (lingerSeen !== "no" && lingerSeen !== "yes") expect(joined.text).toContain("Lingering was left as it is (its state could not be read)");
    note("case1", `lingering before ${lingerBefore} (as root), as the user reads it ${lingerSeen || "(no answer)"}, after the join ${lingerNow}, in the receipt ${inReceipt}`);

    const trialPid = (await m.sh("systemctl --user show -p MainPID --value ovis-machine.service")).stdout.trim();
    const serverEnv = (await m.sh(`tr '\\0' '\\n' < /proc/${trialPid}/environ | cut -d= -f1 | sort`)).stdout;
    note("case1", `the trial server's environment names (pid ${trialPid}):\n${serverEnv}`);
    expect(serverEnv.split("\n").filter((name) => ["OVIS_PTY_SIDECAR_BIN", "NODE_OPTIONS", "OVIS_TOKEN"].includes(name))).toEqual([]);
    expect((await m.sh(`readlink /proc/${trialPid}/exe`)).stdout.trim()).toBe("/home/ovis/.local/share/ovis-machine/bin/ovis-server");
    expect((await m.sh("systemctl --user unset-environment OVIS_PTY_SIDECAR_BIN NODE_OPTIONS OVIS_TOKEN")).code).toBe(0);
    expect((await m.sh("~/.local/bin/herdr server stop")).code).toBe(0);
    await within(herdrServer.exited, 30_000, "herdr's server ending");
    expect((await health(m))?.herdr?.terminal_attach).not.toBe(true);
    expect(herdrProcesses(await m.processes())).toBe("");
    note("case7", `herdr stopped; the process table then:\n${await m.processes()}`);
    await serveHerdr(m);
    expect((await health(m))?.herdr?.terminal_attach).toBe(true);
    expect((await m.sh("systemctl --user show -p MainPID --value ovis-machine.service")).stdout.trim()).toBe(trialPid);
    const enginesNow = herdrProcesses(await m.processes());
    note("case7", `herdr started again by the user; the trial server (pid ${trialPid}) attaches again; the process table:\n${await m.processes()}`);

    // the undo where the user's service manager cannot be reached (as from su or sudo): refused, nothing removed, the
    // service still active
    const noBus = await m.sh(`env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR ${joined.undo}`);
    note("case5", `[no user bus] exit ${noBus.code}\n${noBus.stdout}${noBus.stderr}`);
    expect(noBus.code).toBe(14);
    expect((await m.sh("systemctl --user is-active ovis-machine.service")).stdout.trim()).toBe("active");
    expect((await m.sh(`test -f ~/.config/systemd/user/ovis-machine.service && test -f ${TRIAL}/receipt && echo kept`)).stdout.trim()).toBe("kept");

    expect((await root("printf '#!/bin/sh\\ncase \" $* \" in *\" restart \"*) /usr/bin/systemctl \"$@\"; touch /var/tmp/restarted; exit 1 ;; *\" stop \"* | *\" disable \"*) [ -e /var/tmp/restarted ] && exit 1 ;; esac\\nexec /usr/bin/systemctl \"$@\"\\n' > /usr/local/bin/systemctl && chmod 755 /usr/local/bin/systemctl && rm -f /var/tmp/restarted")).code).toBe(0);
    const unconfirmed = await m.sh(`${kit.line} --yes </dev/null`);
    note("case5", `[a run again, its start and stops failing] exit ${unconfirmed.code}\n${unconfirmed.stdout}${unconfirmed.stderr}`);
    expect((await root("rm /usr/local/bin/systemctl /var/tmp/restarted")).code).toBe(0);
    expect((await root("printf '#!/bin/sh\\ncase \" $* \" in *\" restart \"*) /usr/bin/systemctl \"$@\"; s=$?; touch /var/tmp/restarted; exit $s ;; *\" stop \"* | *\" disable \"*) [ -e /var/tmp/restarted ] && exit 1 ;; esac\\nexec /usr/bin/systemctl \"$@\"\\n' > /usr/local/bin/systemctl && chmod 755 /usr/local/bin/systemctl && rm -f /var/tmp/restarted")).code).toBe(0);
    const plainRun = await m.sh(`env -u OVIS_JOIN_TEST_PLAIN_SERVER ${shiftyKit.line} --yes </dev/null`);
    note("case5", `[a run again with a plain server, its stops failing] exit ${plainRun.code}\n${plainRun.stdout}${plainRun.stderr}`);
    expect((await root("rm /usr/local/bin/systemctl /var/tmp/restarted")).code).toBe(0);
    expect(plainRun.code).toBe(29);
    expect(plainRun.stderr).toContain("whether its server stopped could not be confirmed (undo: sh ");
    expect(plainRun.stderr).not.toContain("earlier install");
    expect((await m.sh("systemctl --user is-active ovis-machine.service")).stdout.trim()).toBe("active");
    expect(unconfirmed.code).toBe(14);
    expect(unconfirmed.stderr).toContain("whether its server stopped could not be confirmed (undo: sh ");
    expect(unconfirmed.stderr).not.toContain("nothing was kept");
    expect((await m.sh("systemctl --user is-active ovis-machine.service")).stdout.trim()).toBe("active");

    const undo = await m.sh(joined.undo);
    note("case5", `${joined.undo}\n${undo.stdout}${undo.stderr}`);
    expect(undo.code).toBe(0);
    expect(undo.stdout).toMatch(/[가-힣]/);
    expect(await m.home()).toBe(homeBefore);
    expect((await m.sh("systemctl --user is-active ovis-machine.service")).stdout.trim()).not.toBe("active");
    expect((await m.processes()).includes("ovis-server")).toBe(false);
    if (!REAL_PROFILE) {
      // exit 34 under a user manager, on a fresh install (its gate open: the relay never went on): the service is stopped
      // AND disabled (it would start again at the next login, or at boot with lingering)
      const gate = await m.sh(`export OVIS_JOIN_TEST_ADD_DONE=1; ${plainKit.line} --yes </dev/null`);
      note("case5", `[a fresh install, the gate open, under a user manager] exit ${gate.code}\n${gate.stdout}${gate.stderr}`);
      expect(gate.code).toBe(34);
      expect(gate.stdout).toContain("so the trial server was stopped");
      expect((await m.sh("systemctl --user is-enabled ovis-machine.service")).stdout.trim()).toBe("disabled");
      expect((await m.sh("systemctl --user is-active ovis-machine.service")).stdout.trim()).not.toBe("active");
      expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
      // the same, where is-enabled gives no answer and lingering's state cannot be read (show-user prints "no" but fails): the stop is not
      // claimed, lingering is neither turned on nor noted, and the undo leaves it alone (a recording loginctl sees no change)
      expect((await root("printf '#!/bin/sh\\ncase \" $* \" in *\" is-enabled \"*) exit 1 ;; esac\\nexec /usr/bin/systemctl \"$@\"\\n' > /usr/local/bin/systemctl && printf '#!/bin/sh\\ncase \" $* \" in *\" show-user \"*) echo no; exit 1 ;; *\" enable-linger \"* | *\" disable-linger \"*) echo \"$*\" >> /var/tmp/loginctl-calls; exit 1 ;; esac\\nexec /usr/bin/loginctl \"$@\"\\n' > /usr/local/bin/loginctl && : > /var/tmp/loginctl-calls && chmod 666 /var/tmp/loginctl-calls && chmod 755 /usr/local/bin/systemctl /usr/local/bin/loginctl")).code).toBe(0);
      const unsure = await m.sh(`export OVIS_JOIN_TEST_ADD_DONE=1; ${plainKit.line} --yes </dev/null`);
      note("case5", `[a fresh install, the gate open, is-enabled silent, enable-linger failing] exit ${unsure.code}\n${unsure.stdout}${unsure.stderr}`);
      const receipt = (await m.sh(`cat ${TRIAL}/receipt`)).stdout;
      expect((await root("rm /usr/local/bin/systemctl")).code).toBe(0);
      expect(unsure.code).toBe(34);
      expect(unsure.stdout).toContain("the trial server could not be seen stopped: stop it now: systemctl --user disable --now ovis-machine.service");
      expect(unsure.stdout).toContain("Lingering was left as it is (its state could not be read)");
      // and the consent promised no attempt to turn it on
      expect(unsure.stdout).not.toContain("It will try to turn lingering on");
      expect(receipt).not.toContain("linger ");
      expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
      expect((await m.sh("cat /var/tmp/loginctl-calls")).stdout).toBe("");
      expect((await root("rm /usr/local/bin/loginctl /var/tmp/loginctl-calls")).code).toBe(0);
    }
    expect(herdrProcesses(await m.processes())).toBe(enginesNow);
    expect((await root("loginctl show-user ovis -p Linger --value")).stdout.trim()).toBe(lingerBefore);
  }, 900_000);

  test("2: without a yes nothing changes: no terminal and no --yes, the answer no, Ctrl+C at the question", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const account = newAccount();
    const home = await m.home();
    const table = await m.processes();
    const quiet = await m.sh(`${kit.line} </dev/null`);
    expect(quiet.code).toBe(22);
    const no = terminal(m.name, m.who, kit.line);
    await no.until(/Type yes to go on/);
    no.type("no\r");
    expect(await no.exited).toBe(22);
    const stopped = terminal(m.name, m.who, kit.line);
    await stopped.until(/Type yes to go on/);
    stopped.type("\x03");
    expect(await stopped.exited).not.toBe(0);
    note("case2", [quiet.stdout + quiet.stderr, no.text, stopped.text].join("\n=====\n"));
    consentShown(no.text);
    expect(await m.home()).toBe(home);
    expect(await m.processes()).toBe(table);
    expect(await world.pcs(account)).toEqual([]);
  }, 600_000);

  test("2b: the interlock: without the test switch, a kit whose server is not the machine profile is refused and rolled back", async () => {
    const m = await runnerMachine({ env: [] });
    await serveHerdr(m);
    const home = await m.home();
    const run = await m.sh(`${plainKit.line} --yes`);
    note("case2b", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect(run.code).toBe(29);
    expect(run.stderr.trim().split("\n").filter((l) => l.startsWith("Ovis: "))).toHaveLength(1);
    expect(await m.home()).toBe(home);
    expect((await m.processes()).includes("ovis-server")).toBe(false);
  }, 300_000);

  test("3: beside his own Ovis on a herdr with six sessions, by flag and by question, his Ovis first and second; his files, process and port stay; the trial's command reads only its own settings", async () => {
    // his shell exports settings of his own Ovis: they must not reach the trial (scripts/plugin.ts:72-76, :172)
    const leaked = ["PORT=17999", "OVIS_TOKEN=his-own-token", "HOST=0.0.0.0"];
    const m = await runnerMachine({ mounts: [`${server}:/opt/own/ovis-server:ro`], env: [PLAIN, ...leaked] });
    // his Ovis plugin's settings, where herdr keeps a plugin's config and in the default folder, and the paths the rehearsal compares
    expect((await m.sh("mkdir -p ~/.config/herdr/plugins/config/devswha.ovis ~/.config/ovis ~/.claude/herdr-statusline ~/.herdr"
      + " && printf 'PORT=17998\\nOVIS_TOKEN=his-own-token\\n' | tee ~/.config/herdr/plugins/config/devswha.ovis/env > ~/.config/ovis/env"
      + " && echo '{}' > ~/.claude/settings.json && echo line > ~/.claude/herdr-statusline/status.sh && echo kept > ~/.herdr/note")).code).toBe(0);
    // plain terminals, no agent reported: his Ovis records an agent's state changes in its own state folder
    // (completions.json, server/core/status.ts:140) as herdr reports them, which the comparison would take for the trial's doing
    await serveHerdr(m, undefined, false);
    for (const session of ["s1", "s2", "s3", "s4", "s5"]) await serveHerdr(m, session, false);
    let ownServer: ReturnType<typeof stream> | undefined;
    const startOwn = async () => {
      const own = stream(["docker", "exec", "-u", "runner", m.name, "sh", "-c", "cd && exec env -u HOST -u OVIS_TOKEN PORT=17317 OVIS_RUNTIME=herdr HERDR_SOCKET=$HOME/.config/herdr/herdr.sock OVIS_HERDR_BIN=$HOME/.local/bin/herdr /opt/own/ovis-server serve"]);
      streams.push(own);
      ownServer = own;
      // its own line once it listens (server/index.ts:832): no request reaches his Ovis (it would log it in its own state)
      await own.until(/Ovis listening on http:\/\/127\.0\.0\.1:17317/, 60_000);
    };
    await startOwn();
    const HIS = "for p in .config/herdr-web-ui .config/ovis .claude/settings.json .claude/herdr-statusline .herdr .config/herdr/plugins .config/herdr/config.toml; do"
      + " [ -e \"$p\" ] && find \"$p\" -type f -exec sha256sum {} +; done | sort; echo ---units; ls ~/.config/systemd/user 2>/dev/null; echo ---cron; crontab -l 2>/dev/null";
    // the plain server of the test switch may register itself as this socket's bridge: that is recorded, not compared
    // his Ovis writes its record of agents' finishes (.config/ovis/completions.json, server/core/status.ts:140) by itself
    // at its first reading of the session, whenever herdr's events lead it to read one: that one file is recorded in the
    // evidence, not compared; every other file of his is compared byte for byte
    const his = async () => (await m.sh(HIS)).stdout.split("\n").filter((line) => !/\/bridges\//.test(line) && !line.endsWith(" .config/ovis/completions.json")).join("\n");
    const bridges = async () => (await m.sh("for f in ~/.config/herdr-web-ui/bridges/* ~/.config/ovis/bridges/*; do [ -f \"$f\" ] && { echo \"== $f\"; cat \"$f\"; echo; }; done")).stdout;
    const ownPid = async () => (await m.sh("ps -eo pid,args --no-headers | awk '$2 == \"/opt/own/ovis-server\" { print $1 }'")).stdout.trim();
    const sockets = async () => (await m.root("ss -Hltn | awk '{ print $4 }' | sort")).stdout;
    const identity = (path: string) => m.sh(`sha256sum ${path}/relay/identity.json 2>/dev/null | cut -c1-64`).then((r) => r.stdout.trim());

    const before = { files: await his(), pid: await ownPid(), sockets: await sockets() };
    expect(before.pid).not.toBe("");
    note("case3", `--- his completions record before: ${(await m.sh("sha256sum .config/ovis/completions.json 2>&1")).stdout}--- his Ovis first. before:\n${JSON.stringify(before, null, 1)}\n--- bridges:\n${await bridges()}`);
    const byFlag = await joinToQr(m, `${kit.line} --session s3`, newAccount());
    note("case3", byFlag.text);
    expect(/process (\d+)\)/.exec(byFlag.text)?.[1]).toBe(before.pid);
    expect((await m.sh(`sed -n 's/^session //p' ${TRIAL}/trial`)).stdout.trim()).toBe("s3");
    const port = await trialPort(m);
    const status = await m.sh(`${TRIAL}/bin/ovis-machine status`);
    note("case3", `--- ovis-machine status with ${leaked.join(" ")} exported:\n${status.stdout}${status.stderr}`);
    expect(status.stdout).toMatch(new RegExp(`^running http://127\\.0\\.0\\.1:${port}\\b`, "m"));
    expect(/^config: (.*)$/m.exec(status.stdout)?.[1]).toBe(`/home/runner/${TRIAL}/config/env`);
    const trialPid = (await m.sh(`cat ${TRIAL}/run/server.pid`)).stdout.trim();
    expect((await m.sh(`tr '\\000' '\\n' < /proc/${trialPid}/environ | grep -c -e '^OVIS_TOKEN=' -e '^HOST=' -e '^PORT=17999$'`)).stdout.trim()).toBe("0");
    const trialId = await identity(`${TRIAL}/state`);
    expect(trialId).not.toBe("");
    expect(trialId).not.toBe(await identity(".config/ovis"));
    note("case3", `--- during the join: sockets\n${await sockets()}--- bridges:\n${await bridges()}--- trial identity ${trialId}, his ${await identity(".config/ovis") || "(none: his Ovis has no relay on)"}`);
    expect({ files: await his(), pid: await ownPid() }).toEqual({ files: before.files, pid: before.pid });
    const undo1 = await m.sh(byFlag.undo);
    note("case3", undo1.stdout);
    expect(undo1.code).toBe(0);
    expect({ files: await his(), pid: await ownPid(), sockets: await sockets() }).toEqual(before);

    // the event: his Ovis's process ends (its sockets close with it)
    await m.sh("pkill -TERM -x -f '/opt/own/ovis-server serve'");
    await within(ownServer!.exited, 30_000, "his Ovis ending");
    const byQuestion = await joinToQr(m, kit.line, newAccount(), [[/Number \/ 번호:/, "4"]]);
    note("case3", `--- the trial server first:\n${byQuestion.text}`);
    expect(byQuestion.text).toMatch(/^ +4\) session s3\r?$/m);
    expect((await m.sh(`sed -n 's/^session //p' ${TRIAL}/trial`)).stdout.trim()).toBe("s3");
    await startOwn();
    const second = { files: await his(), pid: await ownPid(), sockets: await sockets() };
    const table = (await m.root("ps -eo pid,args --no-headers; ss -Hltnp")).stdout;
    note("case3", `--- the process and socket tables with both servers running:\n${table}`);
    const trialSockets = await listening(m, `/home/runner/${TRIAL}/bin/ovis-server`);
    expect(trialSockets).toContain(`127.0.0.1:${await trialPort(m)}`);
    note("case3", `--- his Ovis started second: sockets\n${second.sockets}--- the trial server's own (ss -ltnp, every ovis-server but his):\n${trialSockets.join("\n")}\n--- bridges:\n${await bridges()}`);
    const undo2 = await m.sh(byQuestion.undo);
    note("case3", undo2.stdout);
    expect(undo2.code).toBe(0);
    const after = { files: await his(), pid: await ownPid(), sockets: await sockets() };
    note("case3", `--- after the second undo: bridges\n${await bridges()}`);
    expect(after.pid).toBe(second.pid);
    expect(after.files).toBe(second.files);
    expect(after.sockets).toBe(second.sockets.split("\n").filter((line) => !trialSockets.includes(line)).join("\n"));
  }, 900_000);

  test("4: run again after an end between the install and the add, and twice: one folder, one identity, one entry, one server", async () => {
    const m = await runnerMachine();
    // a tailscale on the machine's PATH (/usr/bin) that records every call: nothing of the join, its server or the undo may put a serve or funnel entry in
    // front of the trial's port (reading tailscale's own status is no such entry)
    expect((await m.root("printf '#!/bin/sh\\necho \"$*\" >> /var/tmp/tailscale-calls\\nexit 1\\n' > /usr/bin/tailscale && chmod 755 /usr/bin/tailscale && : > /var/tmp/tailscale-calls && chmod 666 /var/tmp/tailscale-calls")).code).toBe(0);
    await serveHerdr(m);
    const account = newAccount();
    const home = await m.home();
    const cut = terminal(m.name, m.who, kit.line);
    await cut.until(/Type yes to go on/);
    cut.type("yes\r");
    await cut.until(/attaches the terminals of herdr session/, 180_000);
    await m.sh("pkill -KILL -f '[j]oin.sh --kit'; pkill -TERM -f '[o]vis-server plugin'; true");
    await cut.exited;
    expect((await health(m))?.herdr?.terminal_attach).toBe(true);

    const again = await joinToQr(m, kit.line, account);
    const first = await health(m);
    expect(first?.web_ui?.server_id).toBeDefined();
    const third = await joinToQr(m, kit.line, account);
    note("case4", [cut.text, again.text, third.text].join("\n=====\n"));
    expect((await health(m))?.web_ui?.server_id).toBe(first!.web_ui!.server_id!);
    expect((await world.pcs(account)).map((pc) => pc.server_id)).toEqual([first!.web_ui!.server_id!]);
    expect((await m.sh(`ps -eo args --no-headers | grep -c '^/home/runner/${TRIAL}/bin/ovis-server serve'`)).stdout.trim()).toBe("1");
    expect((await m.sh(`ls -d ~/.local/share/ovis-machine* | wc -l; sort ${TRIAL}/receipt | uniq -d | wc -l`)).stdout.trim().split("\n")).toEqual(["1", "0"]);
    const undo = await m.sh(third.undo);
    note("case4", undo.stdout);
    expect(undo.code).toBe(0);
    const calls = (await m.sh("cat /var/tmp/tailscale-calls")).stdout.trim().split("\n").filter(Boolean);
    note("case4", `--- tailscale calls (a recording stub on PATH):\n${calls.join("\n") || "(none)"}`);
    expect(calls.filter((call) => /^(serve|funnel)\b/.test(call) && !/^(serve|funnel) status\b/.test(call))).toEqual([]);
    const [tree, tmp] = (await m.home()).split("---tmp");
    note("case4", `/tmp after the undo:${tmp}`);
    expect(tree).toBe(home.split("---tmp")[0]!);
  }, 900_000);

  test("2c: a trial kit's line without --trial is refused and leaves the machine as it was before the line ran", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    const table = await m.processes();
    const line = kit.line.replace(' --trial "$@"', ' "$@"');
    expect(line).not.toBe(kit.line);
    const run = await m.sh(`${line} --yes`);
    note("case2c", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect(run.code).toBe(31);
    expect(run.stdout).toBe("");
    expect(run.stderr.trim().split("\n")).toHaveLength(2);
    expect(await m.home()).toBe(home);
    expect((await m.sh("ls -A /tmp")).stdout).toBe(home.split("---tmp\n")[1] ?? "");
    expect(await m.processes()).toBe(table);
  }, 300_000);

  test("2d: a trial state folder that leads into his Ovis's folder is refused; his folder is untouched and no server starts", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    // the trial folder can hold no link (each entry point refuses one), so the state folder leads elsewhere only through
    // a parent: ~/.local/share a link to his Ovis's folder, so the trial's state would be inside it
    expect((await m.sh("mkdir -p ~/.config/ovis && echo his-key > ~/.config/ovis/key && rm -rf ~/.local/share && ln -s ~/.config/ovis ~/.local/share")).code).toBe(0);
    const his = async () => (await m.sh("find ~/.config/ovis -exec ls -ld --time-style=full-iso {} + | sort; find ~/.config/ovis -type f -exec sha256sum {} +")).stdout;
    const before = await his();
    const run = await m.sh(`${kit.line} --yes </dev/null`);
    note("case2d", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect(run.code).toBe(33);
    expect(await his()).toBe(before);
    expect((await m.processes()).includes("ovis-server")).toBe(false);
  }, 300_000);

  test("A: two herdr programs on the machine: the trial server is given the one whose server owns the socket", async () => {
    const m = await runnerMachine({ herdr: false });
    // the session's server runs from ~/herdr-b/herdr; the herdr first on PATH and in ~/.local/bin is another program,
    // one that answers status as an old herdr would (so the join refuses if it ever asks that one)
    expect((await m.sh("mkdir -p ~/herdr-b ~/.local/bin && cp /opt/eng/herdr ~/herdr-b/herdr && printf '#!/bin/sh\\n[ \"$1 $2\" = \"status server\" ] && printf \"status: running\\\\nversion: 0.8.9\\\\nprivate_protocol: 21\\\\n\"\\n' > ~/.local/bin/herdr && chmod 755 ~/.local/bin/herdr")).code).toBe(0);
    const owner = stream(["docker", "exec", "-u", "runner", ...envArgs(m.who.env), m.name, "sh", "-c", "cd && exec ~/herdr-b/herdr server"]);
    streams.push(owner);
    await owner.until(/herdr server running/, 60_000);
    const home = await m.home();
    const run = await m.sh(`PATH=$HOME/.local/bin:$PATH ${kit.line} --yes </dev/null`);
    note("caseA", `exit ${run.code}\n${run.stdout}${run.stderr}\n--- server.env:\n${(await m.sh(`cat ${TRIAL}/server.env`)).stdout}`);
    expect(run.code).toBe(30);
    expect((await m.sh(`sed -n 's/^OVIS_HERDR_BIN=//p' ${TRIAL}/server.env`)).stdout.trim()).toBe("/home/runner/herdr-b/herdr");
    expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("5b: a changed receipt cannot make the undo touch anything outside the trial folder", async () => {
    const m = await runnerMachine();
    expect((await m.sh("rm -rf ~/.local/share/other-app && echo his > ~/victim && mkdir -p ~/other && echo his-unit > ~/other/ovis-machine.service")).code).toBe(0);
    await serveHerdr(m);
    const home = await m.home();
    const outside = async () => (await m.sh("sha256sum ~/victim ~/other/ovis-machine.service; ls -ld ~/.local/share | cut -c1-10")).stdout;
    const was = await outside();
    const installed = await m.sh(`${kit.line} --yes </dev/null`);
    expect(installed.code).toBe(30);
    // a same-named unit elsewhere under HOME: refused, nothing removed or stopped
    expect((await m.sh(`printf 'unit %s/other/ovis-machine.service\\n' "$HOME" >> ${TRIAL}/receipt`)).code).toBe(0);
    const trialWas = (await m.sh(`find ${TRIAL} | sort | sha256sum; pgrep -f '^/home/runner/${TRIAL}/bin/ovis-server serve'`)).stdout;
    const refused = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("case5b", `[a same-named unit elsewhere] exit ${refused.code}\n${refused.stdout}${refused.stderr}`);
    expect(refused.code).toBe(14);
    expect(await outside()).toBe(was);
    expect((await m.sh(`find ${TRIAL} | sort | sha256sum; pgrep -f '^/home/runner/${TRIAL}/bin/ovis-server serve'`)).stdout).toBe(trialWas);
    expect((await m.sh(`sed -i '$d' ${TRIAL}/receipt`)).code).toBe(0);
    // a unit at the trial's own path that the join did not write (no marker): refused, the file intact
    expect((await m.sh("mkdir -p ~/.config/systemd/user && echo his-own > ~/.config/systemd/user/ovis-machine.service")).code).toBe(0);
    const unmarked = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("case5b", `[a unit without the join's marker at its path] exit ${unmarked.code}\n${unmarked.stdout}${unmarked.stderr}`);
    expect(unmarked.code).toBe(14);
    expect((await m.sh("cat ~/.config/systemd/user/ovis-machine.service")).stdout).toBe("his-own\n");
    expect((await m.sh("rm -r ~/.config/systemd")).code).toBe(0);
    // the run folder a link to an outside folder whose server.pid names a foreign process: refused (exit 14), that file
    // intact and that process not signalled
    expect((await m.sh(`mkdir ~/outside-run && (setsid nohup sleep 4243 >/dev/null 2>&1 & echo $! > ~/outside-run/server.pid) && mv ${TRIAL}/run ~/run-real && ln -s ~/outside-run ${TRIAL}/run`)).code).toBe(0);
    const foreign = async () => (await m.sh("sha256sum ~/outside-run/server.pid; ps -o pid=,args= -p $(cat ~/outside-run/server.pid)")).stdout;
    const foreignWas = await foreign();
    expect(foreignWas).toContain("sleep 4243");
    const runLinked = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("case5b", `[the run folder is a link] exit ${runLinked.code}\n${runLinked.stdout}${runLinked.stderr}`);
    expect(runLinked.code).toBe(14);
    expect(await foreign()).toBe(foreignWas);
    expect((await m.sh(`kill $(cat ~/outside-run/server.pid); rm ${TRIAL}/run && mv ~/run-real ${TRIAL}/run && rm -r ~/outside-run`)).code).toBe(0);
    // a changed receipt that names paths outside (a .. path, a file outside, the pre-existing ~/.local/share as a folder
    // the join made): the undo takes nothing it removes from the receipt (links in the folder are refused above)
    const tamper = `printf 'file %s/${TRIAL}/../../../victim\\nfile %s/victim\\ndir %s/.local/share\\n' "$HOME" "$HOME" "$HOME" >> ${TRIAL}/receipt`;
    expect((await m.sh(tamper)).code).toBe(0);
    expect((await m.sh(`cp ${TRIAL}/join.sh ${TRIAL}-join.sh`)).code).toBe(0);
    const undo = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("case5b", `[.., outside file, ~/.local/share in the receipt] exit ${undo.code}\n${undo.stdout}${undo.stderr}`);
    expect(undo.code).toBe(0);
    expect(await outside()).toBe(was);
    // the trial folder replaced by a link to another folder that holds a receipt and join.sh: refused with its own words
    expect((await m.sh(`mkdir ~/elsewhere && cp ${TRIAL}-join.sh ~/elsewhere/join.sh && printf 'home %s/${TRIAL}\\n' "$HOME" > ~/elsewhere/receipt && ln -s ~/elsewhere ${TRIAL}`)).code).toBe(0);
    const elsewhere = async () => (await m.sh("find ~/elsewhere -type f -exec sha256sum {} + | sort")).stdout;
    const elsewhereWas = await elsewhere();
    const linked = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("case5b", `[the trial folder is a link] exit ${linked.code}\n${linked.stdout}${linked.stderr}`);
    expect(linked.code).toBe(14);
    expect(linked.stderr).toContain("is a link");
    expect(await elsewhere()).toBe(elsewhereWas);
    expect((await m.sh(`rm ${TRIAL} ${TRIAL}-join.sh && rm -r ~/elsewhere`)).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("5b-stop: ovis-machine stop with its run folder a link to an outside folder says it stopped nothing and signals nothing", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const installed = await m.sh(`${kit.line} --yes </dev/null`);
    expect(installed.code).toBe(30);
    expect((await m.sh(`mkdir ~/outside-run && (setsid nohup sleep 4243 >/dev/null 2>&1 & echo $! > ~/outside-run/server.pid) && mv ${TRIAL}/run ~/run-real && ln -s ~/outside-run ${TRIAL}/run`)).code).toBe(0);
    const foreign = async () => (await m.sh("sha256sum ~/outside-run/server.pid; ps -o pid=,args= -p $(cat ~/outside-run/server.pid)")).stdout;
    const foreignWas = await foreign();
    expect(foreignWas).toContain("sleep 4243");
    // the trial's own stop, through the same link: it says it stopped nothing, and signals nothing
    const stopLinked = await m.sh(`${TRIAL}/bin/ovis-machine stop`);
    note("case5b", `[ovis-machine stop, the run folder a link] exit ${stopLinked.code}\n${stopLinked.stdout}${stopLinked.stderr}`);
    expect(stopLinked.code).not.toBe(0);
    expect(stopLinked.stdout).not.toContain("stopped.");
    expect(stopLinked.stderr).toContain("is a link");
    expect(await foreign()).toBe(foreignWas);
    expect((await m.sh(`kill $(cat ~/outside-run/server.pid); rm ${TRIAL}/run && mv ~/run-real ${TRIAL}/run && rm -r ~/outside-run`)).code).toBe(0);
    const serverPid = (await m.sh(`cat ${TRIAL}/run/server.pid`)).stdout.trim();
    const stopped = await m.sh(`${TRIAL}/bin/ovis-machine stop`);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopped.");
    // a login that exports OVIS_MACHINE_CLEAN=1 still gets the clean run: an env on PATH that records its arguments sees -i
    expect((await m.sh("mkdir -p /var/tmp/env-stub && printf '#!/bin/sh\\necho \"$1\" >> /var/tmp/env-stub/calls\\nexec /usr/bin/env \"$@\"\\n' > /var/tmp/env-stub/env && chmod 755 /var/tmp/env-stub/env")).code).toBe(0);
    const cleaned = await m.sh(`export OVIS_MACHINE_CLEAN=1 PATH=/var/tmp/env-stub:$PATH; ${TRIAL}/bin/ovis-machine stop`);
    note("case5b", `[ovis-machine stop, OVIS_MACHINE_CLEAN=1 exported] exit ${cleaned.code}\n${cleaned.stdout}${cleaned.stderr}`);
    expect(cleaned.code).toBe(0);
    expect((await m.sh("cat /var/tmp/env-stub/calls")).stdout.split("\n")).toContain("-i");
    expect((await m.sh(`kill -0 ${serverPid}`)).code).not.toBe(0);
    expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("5b-log: the server's log a link to an outside file: the start, a run again and the undo refuse, and that file is unchanged", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const installed = await m.sh(`${kit.line} --yes </dev/null`);
    expect(installed.code).toBe(30);
    expect((await m.sh(`${TRIAL}/bin/ovis-machine stop`)).code).toBe(0);
    // the server's log a link to an outside file: the start, a run of the line again and the undo each refuse, and
    // that file is unchanged by all three
    expect((await m.sh(`echo his-log > ~/outside.log && mv ${TRIAL}/logs/server.log ~/log-real && ln -s ~/outside.log ${TRIAL}/logs/server.log`)).code).toBe(0);
    const logHash = async () => (await m.sh("sha256sum ~/outside.log")).stdout;
    const logWas = await logHash();
    for (const [label, command] of [["ovis-machine start", `${TRIAL}/bin/ovis-machine start`], ["the line again", `${kit.line} --yes </dev/null`], ["the undo", `sh ${TRIAL}/join.sh --uninstall`]] as const) {
      const through = await m.sh(command);
      note("case5b", `[server.log a link: ${label}] exit ${through.code}\n${through.stdout}${through.stderr}`);
      expect(through.code, label).toBe(14);
      expect(through.stderr, label).toContain("is a link");
      expect(await logHash(), label).toBe(logWas);
    }
    expect((await m.processes()).includes("ovis-server serve")).toBe(false);
    expect((await m.sh(`rm ${TRIAL}/logs/server.log ~/outside.log && mv ~/log-real ${TRIAL}/logs/server.log`)).code).toBe(0);
    expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("an add stopped at the sign-in code: the ending says it could not tell, never that the machine was not added", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const stopped = await joinToQr(m, kit.line, newAccount(), [], "code");
    note("caseCode", `exit ${stopped.code}\n${stopped.text}`);
    // the join ends with 30 after its ending; script(1), which gives it the terminal here, reports a Ctrl+C as 130
    expect([30, 130]).toContain(stopped.code);
    expect(stopped.text).toContain("it could not tell whether the machine is listed in your Ovis account; check with:");
    expect(stopped.text).not.toContain("was not added");
    expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("Ctrl+C in the attach wait, after the yes: rolled back as a refusal is, and said so", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    const run = terminal(m.name, m.who, `${silentKit.line} --yes`);
    await run.until(/runs in the background/, 180_000);
    run.type("\x03");
    const code = await run.exited;
    note("caseInterrupt", `exit ${code}\n${run.text}`);
    expect(run.text).toContain("Ovis: interrupted; nothing was kept");
    expect((await m.processes()).includes("ovis-server serve")).toBe(false);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("a failed add whose server names an account: exit 37, rolled back, no server left", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-add-links /var/tmp/fake-account-null")).code).toBe(0);
    const run = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseListed", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    // regression (exit 30 with the server left running before): the account it names may not be the one signed in to
    expect(run.code).toBe(37);
    expect((await m.processes()).includes("ovis-server serve")).toBe(false);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("a failed add whose server names no account, the gate closed: the server is kept (exit 30)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    const run = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseUnknown", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect([run.code, (await m.processes()).includes("ovis-server serve")]).toEqual([30, true]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again ended before it touches the earlier install, and one on a --port another program holds: the earlier trial server keeps running", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const serving = async () => (await m.processes()).includes(`${TRIAL}/bin/ovis-server serve`);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(30);
    expect(await serving()).toBe(true);
    // TERM while the run again checks the kit's server, before it stops anything of the install
    expect((await m.sh("touch /var/tmp/fake-probe-hangs")).code).toBe(0);
    const run = terminal(m.name, m.who, `( ${fakeKit.line} --yes ); echo JOIN-ENDED; exec sleep 600`);
    // no event exists for the stand-in's start inside the probe (the image has no inotify tool): a bounded look for the
    // file it writes as it starts
    expect((await m.sh("timeout 120 sh -c 'until [ -s /var/tmp/probe-started ]; do sleep 0.2; done'")).code).toBe(0);
    const probe = (await m.sh("cat /var/tmp/probe-started")).stdout.trim();
    expect((await m.sh(`kill -TERM $(ps -o ppid= -p ${probe})`)).code).toBe(0);
    await run.until(/JOIN-ENDED/, 120_000);
    run.type("\x03");
    await run.exited;
    note("caseAgainEnded", run.text);
    expect(run.text).toContain("Ovis: interrupted; nothing was changed");
    expect(await serving()).toBe(true);
    expect((await m.sh("rm /var/tmp/fake-probe-hangs /var/tmp/probe-started")).code).toBe(0);
    // a run again on a port another program listens on is refused before the earlier trial server is stopped
    const held = stream(["docker", "exec", "-u", "runner", m.name, "python3", "-c", "import socket, time; s = socket.socket(); s.bind(('127.0.0.1', 17698)); s.listen(); print('listening', flush=True); time.sleep(1e9)"]);
    streams.push(held);
    await held.until(/listening/);
    const busy = await m.sh(`${fakeKit.line} --yes --port 17698 </dev/null`);
    note("caseAgainEnded", `[--port held] exit ${busy.code}\n${busy.stdout}${busy.stderr}`);
    expect(busy.code).toBe(14);
    expect(busy.stderr).toContain("port 17698 is already in use here");
    expect(await serving()).toBe(true);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a failed add whose server's account cannot be read: the server is stopped, the install kept for the undo (exit 39)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-gate-closed")).code).toBe(0);
    const run = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseUnreadable", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect([run.code, (await m.processes()).includes("ovis-server serve"), (await m.sh(`test -f ${TRIAL}/receipt`)).code]).toEqual([39, false, 0]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose add fails while the server names an account removes the install; a fresh run in an account says that account (exit 38)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(30);
    // another account's device linked it during the add, and the add failed: on a run again too, nothing stays
    expect((await m.sh("touch /var/tmp/fake-add-links")).code).toBe(0);
    const second = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseRunAgain37", `exit ${second.code}\n${second.stdout}${second.stderr}`);
    expect([second.code, (await m.sh(`test -e ${TRIAL}`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([37, 1, false]);
    expect(await m.home()).toBe(home);
    // the line again, the add returning at once: the machine is in an account no sign-in of this run put it in
    expect((await m.sh("rm /var/tmp/fake-add-fails /var/tmp/fake-add-links")).code).toBe(0);
    const third = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseRunAgain37", `exit ${third.code}\n${third.stdout}${third.stderr}`);
    expect([third.code, third.stdout.includes("acct_standin"), (await m.processes()).includes("ovis-server serve")]).toEqual([38, true, true]);
    expect((await m.sh(`rm /var/tmp/fake-account-listed /var/tmp/fake-account-null /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose add fails while the server names the account it named before: the install is kept (exit 38)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-account-listed /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(38);
    expect((await m.sh("touch /var/tmp/fake-add-fails")).code).toBe(0);
    const again = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseSameAccount", `exit ${again.code}\n${again.stdout}${again.stderr}`);
    expect([again.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([38, 0, true]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-listed /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose account read before the add fails once and then answers, the add failing: the same account as before, kept (exit 38)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-account-listed /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(38);
    expect((await m.sh("echo 1 > /var/tmp/fake-status-fails && touch /var/tmp/fake-add-fails")).code).toBe(0);
    const again = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseBeforeUnread", `[one failed read] exit ${again.code}\n${again.stdout}${again.stderr}`);
    expect([again.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([38, 0, true]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-listed /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose account cannot be read before the add, the add failing and the server naming an account after it: stopped, the install kept (exit 39)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-account-listed /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(38);
    expect((await m.sh("echo 99 > /var/tmp/fake-status-fails && touch /var/tmp/fake-add-fails")).code).toBe(0);
    const again = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseBeforeUnread", `[no read answered] exit ${again.code}\n${again.stdout}${again.stderr}`);
    expect([again.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([39, 0, false]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-listed /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose account reads before the add get a cut-off body naming no account, the add failing: kept (exit 39 or 38), never removed", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-account-listed /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(38);
    expect((await m.sh("echo 99 > /var/tmp/fake-status-cut && touch /var/tmp/fake-add-fails")).code).toBe(0);
    const cut = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseBodyCut", `[cut off, every read] exit ${cut.code}\n${cut.stdout}${cut.stderr}`);
    expect([cut.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([39, 0, false]);
    expect((await m.sh("echo 1 > /var/tmp/fake-status-stall")).code).toBe(0);
    const stalled = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseBodyCut", `[cut off, then a timeout, once] exit ${stalled.code}\n${stalled.stdout}${stalled.stderr}`);
    expect([stalled.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([38, 0, true]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-listed /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose account reads before the add get a whole answer that is no JSON object, holding \"account\":null, the add failing: kept (exit 39)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-account-listed /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(38);
    expect((await m.sh("echo 99 > /var/tmp/fake-status-malformed && touch /var/tmp/fake-add-fails")).code).toBe(0);
    const malformed = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseBodyMalformed", `exit ${malformed.code}\n${malformed.stdout}${malformed.stderr}`);
    expect([malformed.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([39, 0, false]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-listed /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a run again whose account reads before the add get a whole answer, or one cut at a nested closing brace, and then nothing, the add failing: no answer by the download's exit status alone, kept (exit 39)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-account-listed /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(38);
    // each body passes the check that it is one whole object: only curl's exit status (a timeout) makes it no answer
    for (const how of ["stall-whole", "stall-nested"]) {
      expect((await m.sh(`echo 99 > /var/tmp/fake-status-${how} && touch /var/tmp/fake-add-fails`)).code).toBe(0);
      const again = await m.sh(`${fakeKit.line} --yes </dev/null`);
      note("caseBodyExitStatus", `[${how}] exit ${again.code}\n${again.stdout}${again.stderr}`);
      expect([how, again.code, (await m.sh(`test -f ${TRIAL}/receipt`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([how, 39, 0, false]);
    }
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-listed /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a machine in an account whose id is the text null: named as that account (exit 38), never read as no account, and the undo says so", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("printf null > /var/tmp/fake-account-id && touch /var/tmp/fake-gate-closed")).code).toBe(0);
    const run = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseAccountNullText", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect([run.code, run.stdout.includes("this machine is in the Ovis account null:"), (await m.processes()).includes("ovis-server serve")]).toEqual([38, true, true]);
    const undo = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("caseAccountNullText", `[undo] exit ${undo.code}\n${undo.stdout}${undo.stderr}`);
    expect([undo.code, undo.stdout.includes("This machine was in the Ovis account null.")]).toEqual([0, true]);
    expect((await m.sh("rm /var/tmp/fake-account-id /var/tmp/fake-gate-closed")).code).toBe(0);
  }, 300_000);

  test("a fresh install whose account cannot be read before the add, the add failing while a device pairs it: removed (exit 37)", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh("echo 99 > /var/tmp/fake-status-fails && touch /var/tmp/fake-add-fails /var/tmp/fake-add-links")).code).toBe(0);
    const run = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseFresh37", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect([run.code, (await m.sh(`test -e ${TRIAL}`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([37, 1, false]);
    expect((await m.sh("rm /var/tmp/fake-add-fails /var/tmp/fake-add-links /var/tmp/fake-account-listed")).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("a run again on a machine already in an account, the add returning at once: exit 38 naming it, the server kept only with the gate closed", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    expect((await m.sh(`${fakeKit.line} --yes </dev/null`)).code).toBe(30);
    expect((await m.sh("rm /var/tmp/fake-add-fails /var/tmp/fake-account-null && touch /var/tmp/fake-account-listed")).code).toBe(0);
    const again = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseAlready", `exit ${again.code}\n${again.stdout}${again.stderr}`);
    // regression (before: exit 0, the machine said to be in the account of whoever ran the line)
    expect([again.code, again.stdout.includes("acct_standin"), (await m.processes()).includes("ovis-server serve")]).toEqual([38, true, true]);
    expect((await m.sh("rm /var/tmp/fake-gate-closed && touch /var/tmp/fake-gate-open")).code).toBe(0);
    const open = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseAlready", `exit ${open.code}\n${open.stdout}${open.stderr}`);
    expect([open.code, (await m.processes()).includes("ovis-server serve")]).toEqual([34, false]);
    expect((await m.sh(`rm /var/tmp/fake-account-listed /var/tmp/fake-gate-open && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("a failed add with no account named and the pairing gate open: the server is stopped first, exit 34", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-open")).code).toBe(0);
    const run = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseFailedGateOpen", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    // regression (before: exit 30, the gate never read, the server kept running)
    expect([run.code, (await m.processes()).includes("ovis-server serve")]).toEqual([34, false]);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-open && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("Ctrl+C after the add returned (in the gate check): rolled back as a refusal is, no server left", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    const run = terminal(m.name, m.who, `${fakeKit.line} --yes`);
    await run.until(/Reading the trial server's pairing gate/, 180_000);
    run.type("\x03");
    await run.exited;
    note("caseGateInterrupt", run.text);
    expect(run.text).toContain("Ovis: interrupted; nothing was kept");
    // the add ran, so a device may have listed the machine in an account that the roll back does not reach
    expect(run.text).toContain("If the add already listed this machine, your account may still show it");
    expect((await m.processes()).includes("ovis-server serve")).toBe(false);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("HUP after the add returned (a dropped connection, in the gate check): rolled back, no server left, nothing kept", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    const run = terminal(m.name, m.who, `${fakeKit.line} --yes`);
    await run.until(/Reading the trial server's pairing gate/, 180_000);
    expect((await m.sh("pkill -HUP -f '[j]oin.sh --kit'")).code).toBe(0);
    await run.exited;
    note("caseHup", run.text);
    expect((await m.processes()).includes("ovis-server serve")).toBe(false);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("the undo of a background server finds it with its pid file gone, and with it naming another process, which it leaves alone", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    const servers = async () => (await m.processes()).split("\n").filter((line) => line.includes(`${TRIAL}/bin/ovis-server serve`)).length;
    expect((await m.sh(`${kit.line} --yes </dev/null`)).code).toBe(30);
    expect(await servers()).toBe(1);
    expect((await m.sh(`rm ${TRIAL}/run/server.pid`)).code).toBe(0);
    const gone = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("caseUndoPid", `[pid file gone] exit ${gone.code}\n${gone.stdout}${gone.stderr}`);
    expect([gone.code, await servers()]).toEqual([0, 0]);
    expect((await m.sh(`${kit.line} --yes </dev/null`)).code).toBe(30);
    expect((await m.sh(`(setsid nohup sleep 4244 >/dev/null 2>&1 & echo $! > ${TRIAL}/run/server.pid)`)).code).toBe(0);
    const other = (await m.sh(`cat ${TRIAL}/run/server.pid`)).stdout.trim();
    const foreign = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("caseUndoPid", `[pid file naming another process] exit ${foreign.code}\n${foreign.stdout}${foreign.stderr}`);
    expect([foreign.code, await servers(), (await m.sh(`kill -0 ${other}`)).code]).toEqual([0, 0, 0]);
    expect((await m.sh(`kill ${other}`)).code).toBe(0);
    // a login whose QUOTING_STYLE quotes every name ls prints: the undo still finds the server
    expect((await m.sh(`${kit.line} --yes </dev/null`)).code).toBe(30);
    const quoting = await m.sh(`QUOTING_STYLE=c sh ${TRIAL}/join.sh --uninstall`);
    note("caseUndoPid", `[QUOTING_STYLE=c] exit ${quoting.code}\n${quoting.stdout}${quoting.stderr}`);
    expect([quoting.code, await servers()]).toEqual([0, 0]);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("TERM during the check of the kit's server: that server is stopped and gone before the join reports", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh("touch /var/tmp/fake-probe-hangs /var/tmp/fake-probe-ignores-term")).code).toBe(0);
    const run = terminal(m.name, m.who, `( ${fakeKit.line} --yes ); echo JOIN-ENDED; exec sleep 600`);
    // no event exists for the stand-in's start inside the probe (the image has no inotify tool): a bounded look for the
    // file it writes as it starts
    expect((await m.sh("timeout 120 sh -c 'until [ -s /var/tmp/probe-started ]; do sleep 0.2; done'")).code).toBe(0);
    const probe = (await m.sh("cat /var/tmp/probe-started")).stdout.trim();
    expect((await m.sh(`kill -TERM $(ps -o ppid= -p ${probe})`)).code).toBe(0);
    await run.until(/JOIN-ENDED/, 120_000);
    const probeLeft = (await m.sh(`kill -0 ${probe} 2>/dev/null && echo alive || echo gone`)).stdout.trim();
    const serversLeft = (await m.processes()).includes("ovis-server");
    run.type("\x03");
    await run.exited;
    note("caseProbeTerm", `probe pid ${probe}\n${run.text}`);
    expect(run.text).toContain("Ovis: interrupted; nothing was kept");
    expect(probeLeft).toBe("gone");
    expect(serversLeft).toBe(false);
    expect((await m.sh("rm /var/tmp/fake-probe-hangs /var/tmp/fake-probe-ignores-term /var/tmp/probe-started")).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("a kit's server that never answers its check and ignores TERM: stopped by KILL, and the join refuses (exit 24) instead of hanging", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh("touch /var/tmp/fake-probe-hangs /var/tmp/fake-probe-ignores-term")).code).toBe(0);
    // bounded by timeout(1) in the container: the check's 60 s, 5 s for TERM, then KILL, well within 100 s
    expect((await m.sh(`printf '%s --yes </dev/null\\n' '${fakeKit.line.replaceAll("'", "'\\''")}' > /var/tmp/line.sh`)).code).toBe(0);
    const run = await m.sh("timeout 100 sh /var/tmp/line.sh; echo \"rc=$?\"");
    note("caseProbeHangs", `${run.stdout}${run.stderr}`);
    const probe = (await m.sh("cat /var/tmp/probe-started")).stdout.trim();
    expect([run.stdout.trim().split("\n").pop(), (await m.sh(`kill -0 ${probe}`)).code === 0, (await m.processes()).includes("ovis-server")]).toEqual(["rc=24", false, false]);
    expect((await m.sh("rm /var/tmp/fake-probe-hangs /var/tmp/fake-probe-ignores-term /var/tmp/probe-started /var/tmp/line.sh")).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("on a machine without ps, a check of the kit's server whose process is no longer that server: not signalled, said so, and the join refuses (exit 14) instead of hanging", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh("touch /var/tmp/fake-probe-hangs /var/tmp/fake-probe-leaves")).code).toBe(0);
    expect((await m.sh(`printf '%s --yes </dev/null\\n' '${fakeKit.line.replaceAll("'", "'\\''")}' > /var/tmp/line.sh`)).code).toBe(0);
    expect((await m.root("mv /usr/bin/ps /usr/bin/ps.off")).code).toBe(0);
    expect((await m.sh("command -v ps")).code).not.toBe(0);
    // bounded by timeout(1) in the container: the check's 60 s, then 1 s and 2 s of looking, well within 100 s
    const run = await m.sh("timeout 100 sh /var/tmp/line.sh; echo \"rc=$?\"");
    expect((await m.root("mv /usr/bin/ps.off /usr/bin/ps")).code).toBe(0);
    note("caseProbeLeft", `${run.stdout}${run.stderr}`);
    const probe = (await m.sh("cat /var/tmp/probe-started")).stdout.trim();
    // regression (before: the join waited on that process for ever, ended only by timeout's TERM: rc=124). The refusal
    // names the pid, says no signal was sent, and gives no command that signals it (it could not be identified)
    expect([run.stdout.trim().split("\n").pop(), run.stderr.includes(`(pid ${probe})`), /kill -/.test(run.stderr), run.stderr.includes("TERM"),
      (await m.sh(`kill -0 ${probe}`)).code]).toEqual(["rc=14", true, false, false, 0]);
    // the join names it and leaves it; the test ends it, inside its own machine, only while its program still reads as
    // the stand-in's own, which it deleted
    expect((await m.sh(`case "$(readlink /proc/${probe}/exe)" in */bin/ovis-server" (deleted)") kill -KILL ${probe} ;; *) exit 1 ;; esac`)).code).toBe(0);
    expect((await m.sh("rm /var/tmp/fake-probe-hangs /var/tmp/fake-probe-leaves /var/tmp/probe-started /var/tmp/line.sh")).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("a check of the kit's server whose /proc entry cannot be read while it lives (the join in a PID namespace of its own): refused (exit 14) naming its pid, no hang", async () => {
    // SYS_ADMIN for this machine only: root enters a PID namespace (without a /proc of its own), then runs the join as runner
    const m = await runnerMachine({ args: ["--cap-add", "SYS_ADMIN"] });
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh(`printf '%s --yes </dev/null\\n' '${fakeKit.line.replaceAll("'", "'\\''")}' > /var/tmp/line.sh`)).code).toBe(0);
    // the probe's pid ($!) is the namespace's own, which /proc (the machine's) does not show as the join's child; it
    // answers its check, so only the stop is in question. Bounded by timeout(1): before, the join waited on it for ever
    const run = await m.root("timeout 100 unshare --pid --fork --kill-child setpriv --reuid=runner --regid=runner --init-groups "
      + "env -i HOME=/home/runner PATH=/usr/sbin:/usr/bin:/sbin:/bin NODE_EXTRA_CA_CERTS=/certs/ca.pem sh -c 'cd && sh /var/tmp/line.sh'; echo \"rc=$?\"");
    note("caseProbeUnreadable", `${run.stdout}${run.stderr}`);
    expect([run.stdout.trim().split("\n").pop(), /\(pid \d+\)/.test(run.stderr), /kill -/.test(run.stderr)]).toEqual(["rc=14", true, false]);
    // the namespace ends with the join, and the probe with it; nothing was installed
    expect([(await m.processes()).includes("ovis-server"), (await m.sh(`test -e ${TRIAL}`)).code]).toEqual([false, 1]);
    expect((await m.sh("rm /var/tmp/line.sh")).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("a sha256sum that fails once the programs are copied: refused (exit 14) and rolled back, never taken for a match", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.sh(`mkdir -p ~/stub && printf '%s\\n' '#!/bin/sh' '[ ! -d "$HOME/${TRIAL}/bin" ] || exit 1' 'exec /usr/bin/sha256sum "$@"' > ~/stub/sha256sum && chmod 755 ~/stub/sha256sum`)).code).toBe(0);
    const run = await m.sh(`PATH=$HOME/stub:$PATH ${kit.line} --yes </dev/null`);
    note("caseHashFails", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    // regression (before: both hashes empty, taken as equal: exit 30, installed and running)
    expect([run.code, (await m.sh(`test -e ${TRIAL}`)).code, (await m.processes()).includes("ovis-server serve")]).toEqual([14, 1, false]);
    expect((await m.sh("rm -r ~/stub")).code).toBe(0);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("on a machine without cmp (no diffutils), the join installs and starts its server, and the undo gives everything back", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    expect((await m.root("mv /usr/bin/cmp /usr/bin/cmp.off")).code).toBe(0);
    expect((await m.sh("command -v cmp")).code).not.toBe(0);
    const run = await m.sh(`${kit.line} --yes </dev/null`);
    note("caseNoCmp", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    const running = (await m.processes()).includes(`${TRIAL}/bin/ovis-server serve`);
    const undo = await m.sh(`sh ${TRIAL}/join.sh --uninstall`);
    note("caseNoCmp", `[undo] exit ${undo.code}\n${undo.stdout}${undo.stderr}`);
    expect((await m.root("mv /usr/bin/cmp.off /usr/bin/cmp")).code).toBe(0);
    expect([run.code, running, undo.code]).toEqual([30, true, 0]);
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("34: the pairing gate not closed after the add: the trial server is stopped first, and said stopped", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    // the add counted as done without a device (a switch of the test switch only): the relay never went on, so the
    // trial server's own health says the gate is open
    // a login that names an http proxy (a closed port) without no_proxy: requests to 127.0.0.1 never go through it
    const run = await m.sh(`export OVIS_JOIN_TEST_ADD_DONE=1 http_proxy=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 no_proxy= NO_PROXY=; ${plainKit.line} --yes </dev/null`);
    note("case34", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect(run.code).toBe(34);
    expect(run.stdout).toContain("pairing gate is open");
    expect(run.stdout).toContain("so the trial server was stopped");
    expect((await m.processes()).includes("ovis-server serve")).toBe(false);
    expect((await m.sh(`sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  test("B: a kit made for a person ignores the test switches: its plain server is refused by the interlock", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    const home = await m.home();
    const run = await m.sh(`export OVIS_JOIN_TEST_ADD_DONE=1; ${plainOwnerKit.line} --yes </dev/null`);
    note("caseB", `exit ${run.code}\n${run.stdout}${run.stderr}`);
    expect(run.code).toBe(29);
    expect(run.stdout).toContain("this kit was not made for tests (it carries no TEST-KIT): both are ignored");
    expect(run.stdout).not.toContain("TEST SWITCH");
    expect(await m.home()).toBe(home);
  }, 300_000);

  test("A: HOME reached through a linked parent: the join, stop, start, exit 34 and the undo each find their own server", async () => {
    const m = await runnerMachine();
    await serveHerdr(m);
    expect((await m.root("ln -s /home /var/hl")).code).toBe(0);
    const as = "export HOME=/var/hl/runner/; cd;";
    const serving = async () => (await m.processes()).includes("ovis-server serve");
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    const joined = await m.sh(`${as} ${fakeKit.line} --yes </dev/null`);
    note("caseHome", `[join] exit ${joined.code}\n${joined.stdout}${joined.stderr}`);
    expect(joined.code).toBe(30);
    expect(joined.stdout).toContain("sh /home/runner/.local/share/ovis-machine/join.sh --uninstall");
    expect(await serving()).toBe(true);
    const status = await m.sh(`${as} ~/.local/share/ovis-machine/bin/ovis-machine status`);
    note("caseHome", `[status] exit ${status.code}\n${status.stdout}${status.stderr}`);
    const stopped = await m.sh(`${as} ~/.local/share/ovis-machine/bin/ovis-machine stop`);
    note("caseHome", `[stop] exit ${stopped.code}\n${stopped.stdout}${stopped.stderr}`);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("stopped.");
    expect(await serving()).toBe(false);
    expect((await m.sh("rm /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed && touch /var/tmp/fake-gate-open")).code).toBe(0);
    const gate = await m.sh(`${as} ${fakeKit.line} --yes </dev/null`);
    note("caseHome", `[a run again, the gate open] exit ${gate.code}\n${gate.stdout}${gate.stderr}`);
    expect(gate.code).toBe(34);
    expect(gate.stdout).toContain("so the trial server was stopped");
    expect(await serving()).toBe(false);
    const undo = await m.sh(`${as} sh ~/.local/share/ovis-machine/join.sh --uninstall`);
    note("caseHome", `[undo] exit ${undo.code}\n${undo.stdout}${undo.stderr}`);
    expect(undo.code).toBe(0);
    expect(await serving()).toBe(false);
    expect((await m.sh("test -e ~/.local/share/ovis-machine && echo there || echo none")).stdout.trim()).toBe("none");
    expect((await m.sh("rm /var/tmp/fake-gate-open")).code).toBe(0);
  }, 300_000);

  test("A: herdr started under a HOME spelled through a link: the join finds its session by the socket herdr bound", async () => {
    const runner = await runnerMachine();
    expect((await runner.root("ln -s /home /var/hl")).code).toBe(0);
    // herdr and the join both see HOME=/var/hl/runner: herdr binds its socket by that spelling, the join's paths are canonical
    const m = machineOf(runner.name, { user: runner.who.user, env: [...runner.who.env, "HOME=/var/hl/runner"] });
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    const joined = await m.sh(`cd; ${fakeKit.line} --yes </dev/null`);
    note("caseHomeHerdr", `[join] exit ${joined.code}\n${joined.stdout}${joined.stderr}`);
    expect(joined.code).toBe(30);
    expect((await m.processes()).includes("/home/runner/.local/share/ovis-machine/bin/ovis-server serve")).toBe(true);
    expect((await m.sh("sed -n 's/^socket //p' ~/.local/share/ovis-machine/trial")).stdout.trim()).toBe("/home/runner/.config/herdr/herdr.sock");
    expect((await m.sh("rm /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed && sh ~/.local/share/ovis-machine/join.sh --uninstall")).code).toBe(0);
  }, 300_000);

  test("A: herdr's config folder a link (dotfiles): the join reads herdr's status where herdr keeps it, and joins", async () => {
    const m = await runnerMachine();
    expect((await m.sh("mkdir -p ~/dotfiles/herdr-config ~/.config && ln -s ~/dotfiles/herdr-config ~/.config/herdr")).code).toBe(0);
    await serveHerdr(m);
    expect((await m.sh("touch /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed")).code).toBe(0);
    const joined = await m.sh(`${fakeKit.line} --yes </dev/null`);
    note("caseConfigLink", `[join] exit ${joined.code}\n${joined.stdout}${joined.stderr}`);
    expect(joined.code).toBe(30);
    expect((await m.processes()).includes(`${TRIAL}/bin/ovis-server serve`)).toBe(true);
    expect((await m.sh(`rm /var/tmp/fake-add-fails /var/tmp/fake-account-null /var/tmp/fake-gate-closed && sh ${TRIAL}/join.sh --uninstall`)).code).toBe(0);
  }, 300_000);

  describe("6: refusals, each one plain line, nothing installed", () => {
    const refused = async (m: Machine, line: string, code: number, label: string, who?: Who) => {
      const home = await m.home();
      const run = await sh(m.name, `${line} --yes`, who ?? m.who);
      note("case6", `[${label}] exit ${run.code}\n${run.stdout}${run.stderr}`);
      expect(run.code).toBe(code);
      expect(run.stderr.trim().split("\n").filter((l) => l.startsWith("Ovis: "))).toHaveLength(1);
      expect(await m.home()).toBe(home);
      expect((await m.sh(`test -e ${TRIAL} && echo there || echo none`)).stdout.trim()).toBe("none");
    };
    const listener = async (m: Machine, path: string) => {
      const held = stream(["docker", "exec", "-u", "runner", m.name, "sh", "-c", `cd && mkdir -p "$(dirname "$HOME/${path}")" && exec python3 -c '${LISTEN}' "$HOME/${path}"`]);
      streams.push(held);
      await held.until(/listening/);
    };

    test("a --port another program already listens on, answering a health that looks live", async () => {
      const m = await runnerMachine();
      await serveHerdr(m);
      const standIn = "import http.server as h\nclass H(h.BaseHTTPRequestHandler):\n  def do_GET(s):\n    b = b'{\"herdr\":{\"terminal_attach\":true},\"security\":{\"pairing_gate\":\"closed\"}}'\n    s.send_response(200); s.send_header('Content-Type', 'application/json'); s.end_headers(); s.wfile.write(b)\n  def log_message(s, *a): pass\nserver = h.HTTPServer(('127.0.0.1', 17777), H)\nprint('listening', flush=True)\nserver.serve_forever()\n";
      const held = stream(["docker", "exec", "-u", "runner", m.name, "python3", "-c", standIn]);
      streams.push(held);
      await held.until(/listening/);
      expect((await m.sh("curl -fsS http://127.0.0.1:17777/api/health")).stdout).toContain('"terminal_attach":true');
      await refused(m, `${kit.line} --port 17777`, 14, "a --port another program already listens on");
    }, 300_000);

    test("a trial folder with a receipt this join did not write: refused, its files unchanged", async () => {
      const m = await runnerMachine();
      await serveHerdr(m);
      expect((await m.sh(`mkdir -p ${TRIAL} && echo mine > ${TRIAL}/receipt && echo mine > ${TRIAL}/join.sh`)).code).toBe(0);
      const before = (await m.sh(`sha256sum ${TRIAL}/*`)).stdout;
      const run = await m.sh(`${kit.line} --yes </dev/null`);
      note("case6", `[a receipt this join did not write] exit ${run.code}\n${run.stdout}${run.stderr}`);
      expect([run.code, (await m.sh(`sha256sum ${TRIAL}/*`)).stdout, (await m.processes()).includes("ovis-server serve")]).toEqual([14, before, false]);
    }, 300_000);

    test("a HOME holding a line break: refused (exit 2), the line's download folder removed", async () => {
      const m = await runnerMachine();
      const run = await m.sh(`export TMPDIR=$HOME/tq && mkdir -p $TMPDIR && HOME="$(printf '%s\\nx' "$HOME")" ${kit.line} --yes </dev/null; echo "rc=$?"; ls -A $TMPDIR | wc -l`);
      note("case6", `[HOME with a line break] ${run.stdout}${run.stderr}`);
      expect(run.stdout.trim().split("\n").slice(-2)).toEqual(["rc=2", "0"]);
    }, 300_000);

    test("no herdr", async () => { await refused(await runnerMachine({ herdr: false }), kit.line, 20, "no herdr"); }, 300_000);

    test("herdr below protocol 22", async () => {
      // the session's server must itself be a program named herdr: the join reads the program from the socket's owner
      const dir = join(scratch, "old-herdr");
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      writeFileSync(join(dir, "old.ts"), `const [a, b] = process.argv.slice(2);
if (a === "server") { const path = \`\${process.env.HOME}/.config/herdr/herdr.sock\`; require("node:fs").mkdirSync(require("node:path").dirname(path), { recursive: true }); Bun.listen({ unix: path, socket: { data() {} } }); console.log("herdr server running"); setInterval(() => {}, 1 << 30); }
else if (a === "status" && b === "server") console.log("status: running\\nversion: 0.8.9\\nprivate_protocol: 21");
`);
      const built = Bun.spawnSync([process.execPath, "build", "--compile", join(dir, "old.ts"), "--outfile", join(dir, "herdr")], { stdout: "pipe", stderr: "pipe" });
      expect(built.exitCode, built.stderr.toString()).toBe(0);
      const m = await runnerMachine({ herdr: false, mounts: [`${join(dir, "herdr")}:/opt/old/herdr:ro`] });
      expect((await m.sh("mkdir -p ~/.local/bin && ln -s /opt/old/herdr ~/.local/bin/herdr")).code).toBe(0);
      const old = stream(["docker", "exec", "-u", "runner", m.name, "sh", "-c", "cd && exec ~/.local/bin/herdr server"]);
      streams.push(old);
      await old.until(/herdr server running/, 60_000);
      await refused(m, kit.line, 23, "protocol 21");
    }, 300_000);

    test("a herdr socket owned by another user", async () => {
      const m = await runnerMachine();
      expect((await m.root("useradd -m other && mkdir -p /srv/shared && chmod 1777 /srv/shared && mkdir -p /home/other/.local/bin && ln -s /opt/eng/herdr /home/other/.local/bin/herdr")).code).toBe(0);
      const herdr = stream(["docker", "exec", "-u", "other", "-e", "XDG_CONFIG_HOME=/srv/shared", m.name, "sh", "-c", "cd && exec ~/.local/bin/herdr server"]);
      streams.push(herdr);
      await herdr.until(/herdr server running/, 60_000);
      await refused(m, kit.line, 20, "another user's socket", { user: "runner", env: [...m.who.env, "XDG_CONFIG_HOME=/srv/shared"] });
    }, 300_000);

    test("herdr-core only", async () => {
      const m = await runnerMachine({ herdr: false });
      await listener(m, ".local/state/herdr-core/main/main.sock");
      await refused(m, kit.line, 25, "herdr-core only");
    }, 300_000);

    test("a kit file that differs, is missing, or is extra", async () => {
      const bad = (label: string, change: (dir: string) => void) => {
        const dir = join(kits, `kit-${label}`);
        Bun.spawnSync(["cp", "-a", kit.dir, dir]);
        change(dir);
        return dir;
      };
      const differs = bad("differs", (dir) => appendFileSync(join(dir, "bin", "bin", "ovis-pty-sidecar"), "x"));
      const missing = bad("missing", (dir) => rmSync(join(dir, "bin", "ovis-server")));
      const extra = bad("extra", (dir) => copyFileSync(join(dir, "join.sh"), join(dir, "bin", "extra")));
      const m = await runnerMachine({ mounts: [`${differs}:/kit-differs:ro`, `${missing}:/kit-missing:ro`, `${extra}:/kit-extra:ro`] });
      await serveHerdr(m);
      for (const label of ["differs", "missing", "extra"]) {
        await refused(m, joinLine({ ...ORIGINS, url: `file:///kit-${label}` }, kit.files["join.sh"]!, kit.sums), 16, `kit ${label}`);
      }
      expect(readFileSync(join(differs, "SHA256SUMS"), "utf8")).toBe(readFileSync(join(kit.dir, "SHA256SUMS"), "utf8"));
    }, 300_000);

    test("an https kit whose SHA256SUMS lists a sixth name, even with the line made for that SHA256SUMS", async () => {
      const dir = join(kits, "kit-sixth");
      Bun.spawnSync(["cp", "-a", kit.dir, dir]);
      writeFileSync(join(dir, "bin", "extra"), "#!/bin/sh\necho extra\n");
      const extraSum = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "bin", "extra"))).digest("hex");
      appendFileSync(join(dir, "SHA256SUMS"), `${extraSum}  bin/extra\n`);
      const sums = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "SHA256SUMS"))).digest("hex");
      const m = await runnerMachine();
      await serveHerdr(m);
      await refused(m, joinLine({ ...ORIGINS, url: "https://kit.join.test:7443/kit-sixth" }, kit.files["join.sh"]!, sums), 16, "https kit with a sixth name");
    }, 300_000);
  });
});
