import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHerdrProfiles, readHerdrProfiles, sameSshSession } from "./herdr-profiles.ts";

const row = (target = "BuildBox", session = "work", enabled = true) => ({ id: "profile-1", label: "Build machine", target, session, enabled, selected: false });
const parse = (target: string, session = "work") => parseHerdrProfiles(JSON.stringify([row(target, session)]))[0]!;
const root = mkdtempSync(join(tmpdir(), "herdr-profiles-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("saved herdr machine profiles", () => {
  it("retains labels, disabled profiles, aliases and named sessions; omits unknown fields", () => {
    expect(parseHerdrProfiles(JSON.stringify([{ ...row("BuildBox", "work", false), password: "not part of the contract" }]))).toEqual([
      { id: "profile-1", label: "Build machine", enabled: false, target: { destination: "BuildBox", session: "work" } },
    ]);
    expect(parseHerdrProfiles("[]")).toEqual([]);
  });
  it("splits SSH URI ports without lowercasing aliases or losing IPv6", () => {
    expect(parse("ssh://user@BuildBox:2222").target).toEqual({ destination: "user@BuildBox", port: 2222, session: "work" });
    expect(parse("ssh://user@[2001:db8::1]:2222").target).toEqual({ destination: "user@[2001:db8::1]", port: 2222, session: "work" });
    expect(parse("ssh://BuildBox", "default").target).toEqual({ destination: "BuildBox" });
    expect(parse("user@[::1]").target?.destination).toBe("user@[::1]");
  });
  it("keeps unrepresentable profiles visible but unusable", () => {
    for (const target of ["-oProxyCommand=bad", "$(id)", "host\ncommand", "ssh://u:password@host", "ssh://host/path", "ssh://host?x=1", "ssh://host#x", "ssh://host:0", "ssh://host:65536", "ssh://%2dhost", "ssh://host:"]) expect(parse(target).target).toBeNull();
    expect(parse("host", "../default").target).toBeNull();
  });
  it("rejects malformed catalogs rather than calling them empty", () => {
    for (const value of ["invalid", "{}", "null", "[null]", JSON.stringify([{ ...row(), enabled: "yes" }]), JSON.stringify([row(), row()])]) expect(() => parseHerdrProfiles(value)).toThrow();
  });
  it("matches the same explicit destination and session without guessing SSH aliases or ports", () => {
    expect(sameSshSession({ destination: "host" }, { destination: "host", session: "default" })).toBe(true);
    expect(sameSshSession({ destination: "host", session: "a" }, { destination: "host", session: "b" })).toBe(false);
    expect(sameSshSession({ destination: "host" }, { destination: "host", port: 22 })).toBe(false);
    expect(sameSshSession({ destination: "Host" }, { destination: "host" })).toBe(false);
    expect(sameSshSession({ destination: "host", port: 2222 }, { destination: "host", port: 2222 })).toBe(true);
    expect(sameSshSession({ destination: "host", port: "022" as unknown as number }, { destination: "host", port: 22 })).toBe(true);
  });
  it("runs only the read-only CLI command, honoring the configured binary and environment", async () => {
    const bin = join(root, "fake-herdr");
    const args = join(root, "args.json");
    writeFileSync(bin, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(args)}, JSON.stringify({args:process.argv.slice(2),config:process.env.HERDR_CONFIG_PATH})); console.log(${JSON.stringify(JSON.stringify([row()]))});`);
    chmodSync(bin, 0o700);
    const previous = process.env.OVIS_HERDR_BIN, config = process.env.HERDR_CONFIG_PATH;
    process.env.OVIS_HERDR_BIN = bin; process.env.HERDR_CONFIG_PATH = join(root, "custom.toml");
    try {
      expect((await readHerdrProfiles())[0]?.target?.session).toBe("work");
      expect(JSON.parse(readFileSync(args, "utf8"))).toEqual({ args: ["machine", "list", "--json"], config: join(root, "custom.toml") });
      writeFileSync(bin, `#!${process.execPath}\nconsole.error("private path or diagnostic"); process.exit(2);`);
      await expect(readHerdrProfiles()).rejects.toThrow("Could not read saved herdr machines");
      process.env.OVIS_HERDR_BIN = join(root, "missing");
      await expect(readHerdrProfiles()).rejects.toThrow("Could not read saved herdr machines");
    } finally {
      if (previous === undefined) delete process.env.OVIS_HERDR_BIN; else process.env.OVIS_HERDR_BIN = previous;
      if (config === undefined) delete process.env.HERDR_CONFIG_PATH; else process.env.HERDR_CONFIG_PATH = config;
    }
  });
});
