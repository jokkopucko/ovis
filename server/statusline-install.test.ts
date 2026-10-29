import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStatusline, removeStatusline, statuslineInstallState } from "./statusline-install.ts";
import { readStatusline, readStatuslineContext } from "./statusline.ts";

let home: string;
const settings = (configDir = join(home, ".claude")) => join(configDir, "settings.json");
const readSettings = (configDir?: string) => JSON.parse(readFileSync(settings(configDir), "utf8"));
const own = (configDir = join(home, ".claude")) => join(configDir, "herdr-statusline");
const tee = (configDir?: string) => join(own(configDir), "statusline-tee.sh");
const capture = () => join(home, ".herdr", "statusline-last.json");
const env = (configDir = "") => ({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir });
/** the switch, as the server turns it on or off: exit 0 with what it did, or exit 1 with why not */
function run(args: string[], configDir?: string) {
  const options = { home, configDir };
  try {
    const said = args.includes("--remove") ? removeStatusline(options) : installStatusline(options);
    return { exitCode: 0, stdout: said, stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}
function install(...args: string[]) {
  const result = run(args);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}
/**
 * The capture runs in the background: fd 3, a copy of stdout it inherits, keeps stdout open until it
 * has written, so the spawn's read to the end waits for the capture rather than a guessed delay.
 */
const finished = (script: string): string[] => ["sh", "-c", `sh "$0" 3>&1`, script];
function draw(payload: string, configDir?: string) {
  const result = Bun.spawnSync(finished(tee(configDir)), { env: env(configDir), stdin: Buffer.from(payload), timeout: 10_000 });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}
const settingsCommand = (configDir?: string): string => readSettings(configDir).statusLine.command;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ovis-statusline-install-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(settings(), JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "~/.claude/statusline.sh" } }));
  writeFileSync(join(home, ".claude", "statusline.sh"), "#!/bin/sh\ncat\n", { mode: 0o755 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("status-line switch and capture", () => {
  it("wraps the tilde command from HOME and forwards the original payload unchanged", () => {
    install();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default-account" } }));
    const payload = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } }, cwd: "/private/project" });
    expect(draw(payload)).toBe(payload);
    expect(readStatusline(home)?.fiveHour?.usedPercent).toBe(12);
    expect(readStatusline(home)?.account?.id).toBe("default-account");
  });

  it("wraps a command with arguments and runs it unchanged", () => {
    writeFileSync(join(home, ".claude", "statusline.sh"), "#!/bin/sh\nprintf '%s|' \"$@\"\ncat\n");
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "sh ~/.claude/statusline.sh --color 'two words'" } }));
    install();
    expect(draw("{}")).toBe("--color|two words|{}");
  });

  it("draws nothing where no status line was set, and still captures the limits", () => {
    writeFileSync(settings(), JSON.stringify({ theme: "dark" }));
    install();
    expect(draw(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 23 } } }))).toBe("");
    expect(readStatusline(home)?.sevenDay?.usedPercent).toBe(23);
  });

  for (const [name, original] of [
    ["an existing status line", '{\n    "statusLine": {"type": "command", "command": "~/.claude/statusline.sh", "padding": 0},\n    "theme": "dark"\n}'],
    ["no status line", '{\n    "theme": "dark",\n    "model": "opus"\n}\n'],
    ["an empty settings object", "{}"],
  ] as const) {
    it(`--remove puts back settings.json with ${name} byte for byte and deletes everything install added`, () => {
      writeFileSync(settings(), original);
      install();
      expect(readFileSync(settings(), "utf8")).not.toBe(original);
      draw(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } }));
      expect(existsSync(capture())).toBe(true);
      install("--remove");
      expect(readFileSync(settings(), "utf8")).toBe(original);
      expect(existsSync(own())).toBe(false);
      expect(existsSync(capture())).toBe(false);
    });
  }

  it("--remove puts back only the status line when other settings changed since the install", () => {
    const original = { type: "command", command: "~/.claude/statusline.sh", padding: 2, refreshInterval: 30 };
    writeFileSync(settings(), JSON.stringify({ theme: "dark", statusLine: original }));
    install();
    expect(readSettings().statusLine).toEqual({ ...original, command: expect.stringContaining("herdr-statusline") });
    writeFileSync(settings(), JSON.stringify({ ...readSettings(), model: "opus" }, null, 2));
    install("--remove");
    expect(readSettings()).toEqual({ theme: "dark", statusLine: original, model: "opus" });
    expect(existsSync(own())).toBe(false);
  });

  it("a reinstall after the status line changed puts back the new one, not the first", () => {
    install();
    install("--remove");
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "echo second" } }));
    install();
    // replaced by hand while installed: the next install wraps this one
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "echo third" } }));
    install();
    expect(draw("{}")).toBe("third\n");
    install("--remove");
    expect(readSettings().statusLine.command).toBe("echo third");
  });

  it("installs into and removes from CLAUDE_CONFIG_DIR, leaving ~/.claude alone", () => {
    const before = readFileSync(settings(), "utf8");
    const configDir = join(home, ".claude-work");
    mkdirSync(configDir);
    const original = JSON.stringify({ statusLine: { type: "command", command: "printf work" } });
    writeFileSync(settings(configDir), original);
    expect(run([], configDir).exitCode).toBe(0);
    expect(readSettings(configDir).statusLine.command).toContain(join(".claude-work", "herdr-statusline"));
    expect(draw("{}", configDir)).toBe("work");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(existsSync(own())).toBe(false);
    expect(run(["--remove"], configDir).exitCode).toBe(0);
    expect(readFileSync(settings(configDir), "utf8")).toBe(original);
    expect(existsSync(own(configDir))).toBe(false);
  });

  it("never wraps its own wrapper, however the config dir or the command is spelled", () => {
    const real = join(home, ".claude-real");
    const link = join(home, ".claude-link");
    mkdirSync(real);
    symlinkSync(real, link);
    const original = JSON.stringify({ statusLine: { type: "command", command: "printf orig" } });
    writeFileSync(settings(real), original);
    expect(run([], real).exitCode).toBe(0);
    const again = run([], link);
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString()).toStartWith("already installed");
    expect(draw("{}", link)).toBe("orig");
    writeFileSync(settings(real), JSON.stringify({ statusLine: { type: "command", command: `sh ${settingsCommand(real)}` } }));
    const wrapped = readFileSync(settings(real), "utf8");
    expect(run([], real).exitCode).toBe(1);
    for (const command of [
      `sh ${join(real, "herdr-statusline")}//statusline-tee.sh`,
      `sh "${join(real, "herdr-statusline")}/./statusline-tee.sh"`,
      `sh '${join(link, ".", "herdr-statusline")}/./statusline-tee.sh'`,
      `sh ${join(real, "herdr-statusline").replaceAll("/", "\\/")}/.\\/statusline-tee.sh`,
      `# Claude's wrapper\nsh ${join(real, "herdr-statusline")}/./statusline-tee.sh`,
    ]) {
      writeFileSync(settings(real), JSON.stringify({ statusLine: { type: "command", command } }));
      expect(run([], real).exitCode).toBe(1);
    }
    writeFileSync(settings(real), wrapped);
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: settingsCommand(real) } }));
    const other = readFileSync(settings(), "utf8");
    expect(run([]).exitCode).toBe(1);
    expect(readFileSync(settings(), "utf8")).toBe(other);
    expect(readFileSync(settings(real), "utf8")).toBe(wrapped);
    expect(run(["--remove"], link).exitCode).toBe(0);
    expect(readSettings(real).statusLine.command).toBe("printf orig");
  });

  it("--remove leaves a newer command that only mentions the wrapper's path", () => {
    install();
    const mention = `printf '%s\\n' "${own()}/./statusline-tee.sh"`;
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: mention } }));
    install("--remove");
    expect(readSettings().statusLine.command).toBe(mention);
  });

  it("knows a wrapper path quoted with spaces in it", () => {
    const spaced = join(home, "Claude Config");
    mkdirSync(spaced);
    writeFileSync(settings(spaced), JSON.stringify({ statusLine: { type: "command", command: "printf orig" } }));
    expect(run([], spaced).exitCode).toBe(0);
    expect(draw("{}", spaced)).toBe("orig");
    writeFileSync(settings(spaced), JSON.stringify({ statusLine: { type: "command", command: `sh "${spaced}/herdr-statusline/./statusline-tee.sh"` } }));
    expect(run([], spaced).exitCode).toBe(1);
    expect(run(["--remove"], spaced).exitCode).toBe(0);
    expect(readSettings(spaced).statusLine.command).toBe("printf orig");
  });

  it("a wrapper run inside itself draws nothing instead of running forever", () => {
    install();
    const result = Bun.spawnSync(["sh", tee()], { env: { ...env(), HERDR_STATUSLINE_TEE: "1" }, stdin: Buffer.from("{}"), timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });

  it("hands the original command the payload byte for byte, trailing newline included", () => {
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "IFS= read -r payload && printf OK" } }));
    install();
    expect(draw("{}\n")).toBe("OK");
  });

  it("writes nothing through a link in its directory and leaves the user's files there alone", () => {
    mkdirSync(own());
    writeFileSync(join(home, "outside.txt"), "keep");
    symlinkSync(join(home, "outside.txt"), join(own(), "statusline-capture.ts"));
    const before = readFileSync(settings(), "utf8");
    expect(run([]).exitCode).toBe(1);
    expect(readFileSync(join(home, "outside.txt"), "utf8")).toBe("keep");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    rmSync(own(), { recursive: true });
    install();
    writeFileSync(join(own(), "user-notes.txt"), "keep");
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(readFileSync(join(own(), "user-notes.txt"), "utf8")).toBe("keep");
    expect(existsSync(tee())).toBe(false);
  });

  it("--remove deletes nothing through a linked directory", () => {
    install();
    const outside = join(home, "outside");
    mkdirSync(outside);
    for (const name of ["install.json", "statusline-tee.sh", "statusline-capture.ts"]) writeFileSync(join(outside, name), readFileSync(join(own(), name)));
    rmSync(own(), { recursive: true });
    symlinkSync(outside, own());
    expect(run(["--remove"]).exitCode).toBe(1);
    expect(existsSync(join(outside, "statusline-tee.sh"))).toBe(true);
    expect(existsSync(join(outside, "install.json"))).toBe(true);
  });

  it("draws the line and ends without waiting for the capture", () => {
    writeFileSync(settings(), JSON.stringify({ statusLine: { type: "command", command: "printf drawn" } }));
    install();
    const gate = join(home, "gate");
    expect(Bun.spawnSync(["mkfifo", gate]).exitCode).toBe(0);
    // the capture blocks until the test opens the gate, after the wrapper has already ended
    writeFileSync(join(own(), "statusline-capture.ts"), `require("node:fs").readFileSync(${JSON.stringify(gate)});\n`);
    const result = Bun.spawnSync(["sh", tee()], { env: env(), stdin: Buffer.from("{}"), timeout: 10_000 });
    writeFileSync(gate, "go");
    expect(result.signalCode ?? null).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("drawn");
  });

  it("clears what a killed install left behind instead of refusing the next one", () => {
    mkdirSync(own());
    const leftover = join(own(), ".install.json.4242.0b0e7f5c-8a1d-4c3e-9f2a-7d6b5c4a3e21.tmp");
    writeFileSync(leftover, "{");
    install();
    expect(existsSync(leftover)).toBe(false);
    expect(draw("{}")).toBe("{}");
    writeFileSync(leftover, "{");
    install("--remove");
    expect(existsSync(own())).toBe(false);
  });

  it("keeps settings.json whole when a write fails, so a later --remove still recovers it", () => {
    const before = readFileSync(settings(), "utf8");
    install();
    const installed = readFileSync(settings(), "utf8");
    const removal = `import { removeStatusline } from ${JSON.stringify(new URL("./statusline-install.ts", import.meta.url).pathname)}; removeStatusline({ home: process.env.HOME! });`;
    const failed = Bun.spawnSync(["sh", "-c", 'ulimit -f 0; exec "$0" -e "$1"', process.execPath, removal], { env: env() });
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(settings(), "utf8")).toBe(installed);
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("rewrites the file a linked settings.json points at and keeps the link", () => {
    const dotfiles = join(home, "dotfiles-settings.json");
    const original = JSON.stringify({ statusLine: { type: "command", command: "printf linked" } });
    writeFileSync(dotfiles, original);
    rmSync(settings());
    symlinkSync(dotfiles, settings());
    install();
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(draw("{}")).toBe("linked");
    install("--remove");
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(readFileSync(dotfiles, "utf8")).toBe(original);
  });

  it("keeps only the quota windows and the account from the payload", () => {
    install();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct", emailAddress: "me@example.com" } }));
    draw(JSON.stringify({
      session_id: "s", cwd: "/private/project", cost: { total_cost_usd: 3 }, model: { id: "m" },
      context_window: { used_percentage: 32 }, transcript_path: "/private/t.jsonl",
      rate_limits: { five_hour: { used_percentage: 17, resets_at: 1793190600, extra: true }, seven_day: { used_percentage: 64, resets_at: 1793343600 }, other: {} },
    }));
    expect(JSON.parse(readFileSync(capture(), "utf8"))).toEqual({
      rate_limits: { five_hour: { used_percentage: 17, resets_at: 1793190600 }, seven_day: { used_percentage: 64, resets_at: 1793343600 } },
      _herdr: { account: { id: "acct", label: "me@example.com" } },
    });
  });

  it("restricts the capture directory and the payload under umask 022 without blocking reads", () => {
    mkdirSync(join(home, ".herdr"), { mode: 0o755 });
    chmodSync(join(home, ".herdr"), 0o755);
    install();
    const payload = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 23 } } });
    const result = Bun.spawnSync(["sh", "-c", 'umask 022; exec sh "$0" 3>&1', tee()], { env: env(), stdin: Buffer.from(payload), timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(payload);
    expect(statSync(join(home, ".herdr")).mode & 0o777).toBe(0o700);
    expect(statSync(capture()).mode & 0o777).toBe(0o600);
    expect(readStatusline(home)?.sevenDay?.usedPercent).toBe(23);
  });

  it("snapshots the rendering CLI's account and does not relabel it after a sign-in change", () => {
    install();
    const configDir = join(home, ".claude-work");
    mkdirSync(configDir);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "personal" } }));
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "work", emailAddress: "work@example.com" } }));
    const result = Bun.spawnSync(finished(tee()), { env: env(configDir), stdin: Buffer.from(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 } } })), timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "other" } }));
    expect(readStatusline(home)?.account).toEqual({ id: "work", label: "work@example.com" });
  });

  it("still renders the original status line when the payload cannot be captured, keeping the last capture", () => {
    install();
    draw(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 40 } } }));
    expect(draw("not json")).toBe("not json");
    // a render without limits (before Claude's first answer) does not wipe the last reading
    draw(JSON.stringify({ model: { id: "m" } }));
    expect(readStatusline(home)?.fiveHour?.usedPercent).toBe(40);
  });

  it("is off until turned on, on once installed, and off again after removal", () => {
    expect(statuslineInstallState({ home })).toEqual({ installed: false, supported: true });
    install();
    expect(statuslineInstallState({ home })).toEqual({ installed: true, supported: true });
    install("--remove");
    expect(statuslineInstallState({ home })).toEqual({ installed: false, supported: true });
  });

  it("creates settings.json where Claude has none yet, and deletes it again on removal", () => {
    rmSync(settings());
    install();
    expect(readSettings().statusLine.command).toContain("herdr-statusline");
    install("--remove");
    expect(existsSync(settings())).toBe(false);
    expect(existsSync(own())).toBe(false);
  });

  it("removes what an install killed before its record left, without touching settings.json", () => {
    const before = readFileSync(settings(), "utf8");
    install();
    // as an install cut short after its own files and before its record and settings.json
    rmSync(join(own(), "install.json"));
    writeFileSync(settings(), before);
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(existsSync(own())).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("removes an install that failed after its record and before settings.json", () => {
    // settings.json is a dotfiles link whose directory cannot take the new file: the record is
    // written, the settings write fails, as a crash between the two would leave it
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles);
    const before = readFileSync(settings(), "utf8");
    writeFileSync(join(dotfiles, "settings.json"), before);
    rmSync(settings());
    symlinkSync(join(dotfiles, "settings.json"), settings());
    chmodSync(dotfiles, 0o500);
    try { expect(run([]).exitCode).toBe(1); } finally { chmodSync(dotfiles, 0o700); }
    expect(existsSync(join(own(), "install.json"))).toBe(true);
    expect(readFileSync(settings(), "utf8")).toBe(before);
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(existsSync(own())).toBe(false);
  });

  it("refuses a settings.json that links to a missing file, and leaves the link", () => {
    rmSync(settings());
    symlinkSync(join(home, "dotfiles", "settings.json"), settings());
    expect(run([]).exitCode).toBe(1);
    expect(lstatSync(settings()).isSymbolicLink()).toBe(true);
    expect(existsSync(own())).toBe(false);
  });

  it("leaves a statusline-tee.sh it did not write when there is no install to undo", () => {
    mkdirSync(own());
    writeFileSync(tee(), "#!/bin/sh\necho mine\n");
    install("--remove");
    expect(readFileSync(tee(), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("takes one change at a time across processes, and leaves a lock it cannot vouch for to be removed by hand", () => {
    const lock = join(home, ".claude", ".herdr-statusline.lock");
    const before = readFileSync(settings(), "utf8");
    // a lock is published with its owner: an empty one holds no change, and is replaced
    mkdirSync(lock);
    install();
    expect(existsSync(lock)).toBe(false);
    install("--remove");
    // one that names no holder it can check is refused, saying what to delete when nothing holds it
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "not a token");
    const refused = run([]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("in progress");
    expect(refused.stderr).toContain(lock);
    expect(readFileSync(settings(), "utf8")).toBe(before);
    rmSync(lock, { recursive: true });
    install();
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("without a record, removes only the capture helper it ships, never one of the user's by the same name", () => {
    mkdirSync(own());
    writeFileSync(join(own(), "statusline-capture.ts"), "console.log('mine');\n");
    install("--remove");
    expect(readFileSync(join(own(), "statusline-capture.ts"), "utf8")).toBe("console.log('mine');\n");
  });

  it("waits for a lock whose holder still runs however old it is, and takes over one whose holder is gone", () => {
    const lock = join(home, ".claude", ".herdr-statusline.lock");
    const before = readFileSync(settings(), "utf8");
    const held = `${process.pid}:${crypto.randomUUID()}`;
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), held);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(lock, old, old);
    expect(run([]).stderr).toContain("in progress");
    expect(readFileSync(join(lock, "owner"), "utf8")).toBe(held);
    const gone = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(lock, "owner"), `${gone}:${crypto.randomUUID()}`);
    install();
    expect(existsSync(lock)).toBe(false);
    install("--remove");
    expect(readFileSync(settings(), "utf8")).toBe(before);
  });

  it("never reads an owner file being written as a holder that is gone", () => {
    const lock = join(home, ".claude", ".herdr-statusline.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "");
    expect(run([]).stderr).toContain("in progress");
    writeFileSync(join(lock, "owner"), "12");
    expect(run([]).stderr).toContain("in progress");
    expect(existsSync(own())).toBe(false);
  });

  it("never takes over a lock that is a link, whatever it points at", () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    const gone = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(elsewhere, "owner"), `${gone}:${crypto.randomUUID()}`);
    symlinkSync(elsewhere, join(home, ".claude", ".herdr-statusline.lock"));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(elsewhere, old, old);
    expect(run([]).stderr).toContain("in progress");
    expect(readFileSync(join(elsewhere, "owner"), "utf8")).toStartWith(`${gone}:`);
    expect(lstatSync(join(home, ".claude", ".herdr-statusline.lock")).isSymbolicLink()).toBe(true);
  });
});

describe("session context through the installed wrapper", () => {
  const payload = (session = "session-a", capacity = 1_000_000) => JSON.stringify({
    session_id: session, model: { id: "claude-test" },
    context_window: { context_window_size: capacity, used_percentage: 4 },
    cwd: "/private/project", transcript_path: "/private/transcript", cost: { total_cost_usd: 3 },
  });
  const contextPath = (session = "session-a") => join(home, ".herdr", "statusline-context", session + ".json");

  it("captures context without subscription limits, preserving the original status line", () => {
    install();
    const input = payload();
    expect(draw(input)).toBe(input);
    expect(readStatuslineContext(home, "session-a", "claude-test")).toBe(1_000_000);
    const saved = JSON.parse(readFileSync(contextPath(), "utf8"));
    expect(saved).toEqual({ session_id: "session-a", model: "claude-test", window: 1_000_000, _herdr: { profile: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(statSync(contextPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".herdr", "statusline-context")).mode & 0o777).toBe(0o700);
    expect(existsSync(capture())).toBe(false);
    draw(payload("session-b", 200_000));
    expect(readStatuslineContext(home, "session-a", "claude-test")).toBe(1_000_000);
    expect(readStatuslineContext(home, "session-b", "claude-test")).toBe(200_000);
  });

  it("cleans its own session captures and preserves captures from other profiles", () => {
    install();
    draw(payload());
    const configDir = join(home, ".claude-work");
    mkdirSync(configDir);
    writeFileSync(settings(configDir), JSON.stringify({}));
    expect(run([], configDir).exitCode).toBe(0);
    draw(payload("session-work"), configDir);
    install("--remove");
    expect(existsSync(contextPath())).toBe(false);
    expect(readStatuslineContext(home, "session-work", "claude-test")).toBe(1_000_000);
    expect(run(["--remove"], configDir).exitCode).toBe(0);
    expect(existsSync(join(home, ".herdr", "statusline-context"))).toBe(false);
  });

  it("captures context when no custom status-line script exists", () => {
    writeFileSync(settings(), JSON.stringify({}));
    install();
    expect(draw(payload())).toBe("");
    expect(readStatuslineContext(home, "session-a", "claude-test")).toBe(1_000_000);
  });

  it("rejects unsafe session ids and a blocked context directory without losing quota", () => {
    install();
    expect(draw(payload("../escape"))).toBe(payload("../escape"));
    expect(existsSync(join(home, ".herdr", "escape.json"))).toBe(false);
    mkdirSync(join(home, ".herdr"), { recursive: true });
    writeFileSync(join(home, ".herdr", "statusline-context"), "user file");
    const input = JSON.parse(payload());
    input.rate_limits = { five_hour: { used_percentage: 12 } };
    expect(draw(JSON.stringify(input))).toBe(JSON.stringify(input));
    expect(readStatusline(home)?.fiveHour?.usedPercent).toBe(12);
  });
});
