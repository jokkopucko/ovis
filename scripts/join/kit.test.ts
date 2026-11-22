import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { version as packageVersion } from "../../package.json";
import { joinLine, KitError, kitCommand, kitLine, makeKit } from "./kit.ts";

const origins = { url: "https://kit.join.test:7443/kit", relay: "wss://relay.join.test:8443", account: "https://account.join.test:9443", app: "https://app.join.test:7441" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function programs(): { server: string; pty: string; at: string } {
  const at = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "join-kit-"));
  dirs.push(at);
  const server = join(at, "ovis-server");
  const pty = join(at, "ovis-pty-sidecar");
  writeFileSync(server, `#!/bin/sh\n# version ${JSON.stringify(packageVersion)}\necho 'usage: ovis-server <serve|plugin>' >&2\nexit 2\n`);
  writeFileSync(pty, "#!/bin/sh\necho 'pty-sidecar: usage: ovis-pty-sidecar <cols> <rows> <command>' >&2\nexit 2\n");
  chmodSync(server, 0o755);
  chmodSync(pty, 0o755);
  return { server, pty, at };
}

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("kit line", () => {
  test("the line printed again from an existing kit folder is the line its making printed", () => {
    const { server, pty, at } = programs();
    const made = makeKit({ server, pty, out: join(at, "kit"), ...origins });
    expect(kitLine(join(at, "kit"), origins).line).toBe(made.line);
    expect(made.line).toContain(' --trial "$@"');
  });

  test("the line parses pasted into sh, dash, bash and zsh, and so does the program it hands to sh", () => {
    const { server, pty, at } = programs();
    const { line } = makeKit({ server, pty, out: join(at, "kit"), ...origins });
    // the pasting shell parses the line; the program inside it is parsed by sh with -n, and nothing is run
    const parseOnly = line.replace(/^sh -c /, "sh -n -c ");
    for (const shell of ["sh", "dash", "bash", "zsh"].filter((name) => Bun.which(name) !== null)) {
      for (const text of [line, parseOnly]) {
        const parsed = Bun.spawnSync([shell, "-n", "-c", text], { stderr: "pipe" });
        expect([shell, parsed.exitCode, parsed.stderr.toString()]).toEqual([shell, 0, ""]);
      }
      const inner = Bun.spawnSync([shell, "-c", parseOnly], { stderr: "pipe" });
      expect([shell, inner.exitCode, inner.stderr.toString()]).toEqual([shell, 0, ""]);
    }
  });

  test("the line refuses a system other than Linux, limits its download, reads no curl config file, and removes its folder on INT, TERM or HUP", () => {
    const { server, pty, at } = programs();
    const { line } = makeKit({ server, pty, out: join(at, "kit"), ...origins });
    expect(line).toContain('[ "$(uname -s)" = Linux ] || { echo "Ovis: the join runs on Linux only; nothing was changed" >&2; exit 17; }; d=$(mktemp -d)');
    expect(line).toContain('trap "rm -rf \\"\\$d\\"; exit 130" INT TERM HUP; curl -q -fsSL --max-time 120 --proto "=https,file" ');
  });

  function pasted(dir: string, script: string, tmp: string, path = "") {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "join.sh"))) writeFileSync(join(dir, "join.sh"), script);
    const line = joinLine({ ...origins, url: `file://${dir}` }, createHash("sha256").update(script).digest("hex"), "0".repeat(64));
    // `exec`: the pasting shell becomes the line's own sh, so `child` is the shell that holds the trap
    const child = spawn("sh", ["-c", `exec ${line}`], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmp, PATH: `${path}${process.env["PATH"] ?? ""}` } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    const ended = new Promise<{ code: number | null; signal: string | null; out: string }>((done) => child.on("close", (code, signal) => done({ code, signal, out })));
    return { child, ended };
  }
  const scratch = (): { at: string; tmp: string } => {
    const at = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "join-line-"));
    dirs.push(at);
    mkdirSync(join(at, "tmp"));
    return { at, tmp: join(at, "tmp") };
  };

  test("the line removes its temporary folder when INT reaches it while join.sh downloads, and exits 130", async () => {
    const { at, tmp } = scratch();
    // a join.sh that is a FIFO: the download waits on it until a writer comes
    mkdirSync(join(at, "kit"));
    expect(Bun.spawnSync(["mkfifo", join(at, "kit", "join.sh")]).exitCode).toBe(0);
    const { child, ended } = pasted(join(at, "kit"), "never read", tmp);
    // opened for writing once curl has opened it for reading: the line is in its download, its trap set
    const writer = await open(join(at, "kit", "join.sh"), "w");
    await writer.write("#!/bin/sh\n");
    expect(readdirSync(tmp)).toHaveLength(1);
    process.kill(-child.pid!, "SIGINT");
    const result = await ended;
    await writer.close();
    expect([result.code, readdirSync(tmp)], result.out).toEqual([130, []]);
  });

  test("the line removes its temporary folder on TERM to it alone, once the download it waits for ends", async () => {
    const { at, tmp } = scratch();
    mkdirSync(join(at, "kit"));
    expect(Bun.spawnSync(["mkfifo", join(at, "kit", "join.sh")]).exitCode).toBe(0);
    const { child, ended } = pasted(join(at, "kit"), "never read", tmp);
    const writer = await open(join(at, "kit", "join.sh"), "w");
    await writer.write("#!/bin/sh\n");
    // the shell runs its trap when curl, which it waits for, ends: here when the writer goes
    child.kill("SIGTERM");
    await writer.close();
    const result = await ended;
    expect([result.code, readdirSync(tmp)], result.out).toEqual([130, []]);
  });

  test("join.sh runs with no trap of the line's: an INT to it does not remove the folder it runs from", async () => {
    const { at, tmp } = scratch();
    const script = '#!/bin/sh\necho "traps:[$(trap)]"\n[ -f "$0" ] && echo "its file is there"\nkill -INT $$\necho "not reached"\n';
    const { ended } = pasted(join(at, "kit"), script, tmp);
    const result = await ended;
    expect(result.out).toBe("traps:[]\nits file is there\n");
    expect(result.signal ?? result.code).not.toBe(0);
    expect(readdirSync(tmp)).toHaveLength(1);
    expect(readdirSync(join(tmp, readdirSync(tmp)[0]!))).toEqual(["join.sh"]);
  });

  test("the line says that the join runs on Linux only on another system, exits 17, and makes no folder", async () => {
    const { at, tmp } = scratch();
    mkdirSync(join(at, "bin"));
    writeFileSync(join(at, "bin", "uname"), "#!/bin/sh\necho Darwin\n");
    chmodSync(join(at, "bin", "uname"), 0o755);
    const { ended } = pasted(join(at, "kit"), "#!/bin/sh\necho ran\n", tmp, `${join(at, "bin")}:`);
    const result = await ended;
    expect([result.code, result.out, readdirSync(tmp)]).toEqual([17, "Ovis: the join runs on Linux only; nothing was changed\n", []]);
  });

  test("join.sh parses as POSIX sh (sh -n), as every kit carries it", () => {
    const parsed = Bun.spawnSync(["sh", "-n", resolve(import.meta.dir, "join.sh")], { stderr: "pipe" });
    expect(parsed.stderr.toString()).toBe("");
    expect(parsed.exitCode).toBe(0);
  });

  test("the terminal host's record names the SHA-256 of the host copied into the kit, even when its source changes after the copy", () => {
    const { server, pty, at } = programs();
    const copy = fs.copyFileSync;
    const spy = spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      copy(from, to, mode);
      if (from === pty) appendFileSync(pty, "# rebuilt\n");
    });
    try {
      const made = makeKit({ server, pty, out: join(at, "kit"), ...origins });
      const record = JSON.parse(readFileSync(join(made.dir, "bin", "bin", "ovis-pty-sidecar.json"), "utf8")) as { sha256: string };
      expect([spy.mock.calls.length > 0, record.sha256]).toEqual([true, createHash("sha256").update(readFileSync(join(made.dir, "bin", "bin", "ovis-pty-sidecar"))).digest("hex")]);
    } finally { spy.mockRestore(); }
  });

  test("only a kit made with --test-kit carries TEST-KIT, listed in its SHA256SUMS", () => {
    const { server, pty, at } = programs();
    const owner = makeKit({ server, pty, out: join(at, "owner"), ...origins });
    const tested = makeKit({ server, pty, out: join(at, "tested"), ...origins, testKit: true });
    expect(readdirSync(owner.dir)).not.toContain("TEST-KIT");
    expect(readFileSync(join(owner.dir, "SHA256SUMS"), "utf8")).not.toContain("TEST-KIT");
    expect(readFileSync(join(tested.dir, "SHA256SUMS"), "utf8")).toMatch(/^[0-9a-f]{64}  TEST-KIT$/m);
    expect(kitLine(tested.dir, origins).line).toBe(tested.line);
    expect(tested.sums).not.toBe(owner.sums);
  });

  test("the command: make prints the line on stdout, line prints the same line again; a bad flag is exit 2, stdout empty", () => {
    const { server, pty, at } = programs();
    const flags = ["--url", origins.url, "--relay", origins.relay, "--account", origins.account, "--app", origins.app];
    const run = (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = kitCommand(argv, (text) => { stdout += text; }, (text) => { stderr += text; });
      return { code, stdout, stderr };
    };
    const made = run(["make", "--server", server, "--pty", pty, "--out", join(at, "cmd"), ...flags]);
    expect(made.code).toBe(0);
    expect(made.stdout).toBe(`${kitLine(join(at, "cmd"), origins).line}\n`);
    expect(run(["line", "--kit", join(at, "cmd"), ...flags]).stdout).toBe(made.stdout);
    for (const argv of [["make", "--server", server, "--pty", pty, "--out", join(at, "cmd2"), ...flags, "--bogus"], ["line", ...flags], ["unknown"]]) {
      const refused = run(argv);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toStartWith("kit: ");
    }
  });

  test("make refuses an --out whose parent does not exist, and a server built from another version, as kit errors", () => {
    const { server, pty, at } = programs();
    expect(() => makeKit({ server, pty, out: join(at, "no", "such", "kit"), ...origins })).toThrow(KitError);
    const other = join(at, "other-server");
    writeFileSync(other, "#!/bin/sh\n# version \"0.0.0-other\"\necho 'usage: ovis-server <serve|plugin>' >&2\nexit 2\n");
    chmodSync(other, 0o755);
    expect(() => makeKit({ server: other, pty, out: join(at, "kit-other"), ...origins })).toThrow(/was not built from this checkout's version/);
    expect(readdirSync(at)).not.toContain("kit-other");
  });

  test("make refuses a folder that already holds something, and leaves what is there as it was", () => {
    const { server, pty, at } = programs();
    const out = join(at, "full");
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "his file\n");
    expect(() => makeKit({ server, pty, out, ...origins })).toThrow(KitError);
    expect(readdirSync(out)).toEqual(["keep.txt"]);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("his file\n");
  });

  test("make refuses this checkout and any folder inside it, and writes nothing there", () => {
    const { server, pty } = programs();
    const repo = resolve(import.meta.dir, "..", "..");
    const before = readdirSync(repo).sort();
    expect(() => makeKit({ server, pty, out: repo, ...origins })).toThrow(KitError);
    expect(readdirSync(repo).sort()).toEqual(before);
    const inside = mkdtempSync(join(repo, ".kit-test-"));
    dirs.push(inside);
    expect(() => makeKit({ server, pty, out: inside, ...origins })).toThrow(KitError);
    expect(readdirSync(inside)).toEqual([]);
  });

  test("an address with a user name or password gets no kit: the line would print it", () => {
    const { server, pty, at } = programs();
    for (const changed of [{ url: "https://user:secret@kit.join.test:7443/kit" }, { relay: "wss://relay:secret@relay.join.test:8443" }, { account: "https://user@account.join.test:9443" }]) {
      expect(() => makeKit({ server, pty, out: join(at, "kit"), ...origins, ...changed })).toThrow(/without a user name or password/);
    }
  });

  test("a kit folder whose file differs from SHA256SUMS, or that holds another file, gets no line", () => {
    const { server, pty, at } = programs();
    makeKit({ server, pty, out: join(at, "kit"), ...origins });
    writeFileSync(join(at, "kit", "extra"), "x");
    expect(() => kitLine(join(at, "kit"), origins)).toThrow(KitError);
    rmSync(join(at, "kit", "extra"));
    appendFileSync(join(at, "kit", "bin", "ovis-server"), "x");
    expect(() => kitLine(join(at, "kit"), origins)).toThrow(KitError);
  });
});
