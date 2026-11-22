import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { agentStartArgs, claudeSettingsDir, settingsFile, settingsFileArgs } from "./claude-settings-file.ts";
import { powershellNativeArgs } from "./shell-agent.ts";

const ULTRACODE = JSON.stringify({ ultracode: true });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tempRoot = (): string => {
  // macOS's system temporary directory can itself be reached through /var's symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-settings-file-")));
  roots.push(root);
  return root;
};

const recorder = () => {
  const written: string[] = [];
  return { written, write: (json: string) => `C:\\settings\\${written.push(json)}.json` };
};

describe("settingsFileArgs", () => {
  it("swaps an inline JSON --settings for a file's path in both spellings", () => {
    const { written, write } = recorder();
    expect(settingsFileArgs(["--effort", "high", "--settings", ULTRACODE], write)).toEqual(["--effort", "high", "--settings", "C:\\settings\\1.json"]);
    expect(settingsFileArgs([`--settings=${ULTRACODE}`], write)).toEqual(["--settings=C:\\settings\\2.json"]);
    expect(written).toEqual([ULTRACODE, ULTRACODE]);
  });

  it("reads JSON as Claude Code does, trimmed, and writes the text as it was given", () => {
    const { written, write } = recorder();
    expect(settingsFileArgs(["--settings", ` ${ULTRACODE}\t`], write)).toEqual(["--settings", "C:\\settings\\1.json"]);
    expect(written).toEqual([` ${ULTRACODE}\t`]);
  });

  it("leaves a settings file's path, every other flag and a --settings with no value alone", () => {
    const { written, write } = recorder();
    const args = ["--permission-mode", "plan", "--model", "opus[1m]", "--settings", "C:\\Users\\a b\\settings.json", "--settings=/home/a/settings.json", "{\"ultracode\":true}", "--settings"];
    expect(settingsFileArgs(args, write)).toEqual(args);
    expect(written).toEqual([]);
  });

  it("reads nothing after a bare -- as a flag, and takes a -- right after --settings for its value", () => {
    const { written, write } = recorder();
    expect(settingsFileArgs(["--", "--settings", ULTRACODE], write)).toEqual(["--", "--settings", ULTRACODE]);
    expect(settingsFileArgs(["--settings", "--", "--settings", ULTRACODE], write)).toEqual(["--settings", "--", "--settings", "C:\\settings\\1.json"]);
    expect(written).toEqual([ULTRACODE]);
  });
});

describe("claudeSettingsDir", () => {
  it("is a folder of this Windows user's %LOCALAPPDATA%, not of a %TEMP% other accounts may share", () => {
    const home = "C:\\Users\\a b";
    const local = `${home}\\AppData\\Local`;
    expect(claudeSettingsDir({ LOCALAPPDATA: local, TEMP: "C:\\Temp", TMP: "C:\\Temp" }, home)).toBe(join(local, "ovis", "claude settings"));
    for (const env of [{}, { LOCALAPPDATA: "" }]) expect(claudeSettingsDir(env, home)).toBe(join(home, "AppData", "Local", "ovis", "claude settings"));
  });

  it("gives a path herdr-core's PowerShell start takes from a profile folder cmd would read part of (#3084)", () => {
    const dir = claudeSettingsDir({ LOCALAPPDATA: "C:\\Users\\R&D\\AppData\\Local" });
    const path = join(dir, `${"0".repeat(64)}.json`);
    for (const program of ["powershell", "pwsh"] as const) expect(powershellNativeArgs(program, ["--settings", path])).toEqual(["--settings", path]);
  });
});

describe("settingsFile", () => {
  /** renameSync refused as Windows refuses it for a moment, after `meanwhile` ran with its target */
  const refuseRenames = (meanwhile: (target: string) => void = () => {}) => spyOn(fs, "renameSync").mockImplementation((_from, target) => {
    meanwhile(String(target));
    throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  });
  const anotherLaunch = (target: string) => writeFileSync(target, ULTRACODE);

  it("names a file by its text and writes the same text once", () => {
    const dir = join(tempRoot(), "claude-settings");
    const path = settingsFile(ULTRACODE, dir);
    expect(dirname(path)).toBe(dir);
    expect(readFileSync(path, "utf8")).toBe(ULTRACODE);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const first = statSync(path);
    expect(settingsFile(ULTRACODE, dir)).toBe(path);
    expect(statSync(path).ino).toBe(first.ino);
    const other = settingsFile(JSON.stringify({ ultracode: false }), dir);
    expect(other).not.toBe(path);
    expect(readFileSync(other, "utf8")).toBe("{\"ultracode\":false}");
    expect(readdirSync(dir).sort()).toEqual([path, other].map((file) => file.slice(dir.length + 1)).sort());
  });

  it("makes the file and finds it again with no rename, which Windows can refuse for a moment", () => {
    const dir = tempRoot();
    const renames = refuseRenames();
    try {
      const path = settingsFile(ULTRACODE, dir);
      expect(readFileSync(path, "utf8")).toBe(ULTRACODE);
      expect(settingsFile(ULTRACODE, dir)).toBe(path);
      expect(renames).not.toHaveBeenCalled();
      writeFileSync(path, "{\"ultracode\":");
      expect(() => settingsFile(ULTRACODE, dir)).toThrow("EPERM");
      expect(renames).toHaveBeenCalledTimes(1);
      expect(readdirSync(dir)).toEqual([basename(path)]);
    } finally {
      renames.mockRestore();
    }
  });

  it("takes the file another launch put in place when Windows refuses the rename over it", () => {
    const dir = tempRoot();
    const path = settingsFile(ULTRACODE, dir);
    writeFileSync(path, "{\"ultracode\":");
    const renames = refuseRenames(anotherLaunch);
    try {
      expect(settingsFile(ULTRACODE, dir)).toBe(path);
      expect(renames).toHaveBeenCalledTimes(1);
      expect(readFileSync(path, "utf8")).toBe(ULTRACODE);
      expect(readdirSync(dir)).toEqual([basename(path)]);
    } finally {
      renames.mockRestore();
    }
  });

  it("still checks the file, and tells the rename's error, when the temporary file cannot be removed either", () => {
    const dir = tempRoot();
    const path = settingsFile(ULTRACODE, dir);
    let concurrent = true;
    const renames = refuseRenames((target) => { if (concurrent) anotherLaunch(target); });
    const removes = spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked, rm"), { code: "EBUSY" });
    });
    try {
      writeFileSync(path, "{\"ultracode\":");
      expect(settingsFile(ULTRACODE, dir)).toBe(path);
      expect(readFileSync(path, "utf8")).toBe(ULTRACODE);
      concurrent = false;
      writeFileSync(path, "{\"ultracode\":");
      expect(() => settingsFile(ULTRACODE, dir)).toThrow("EPERM");
      expect(removes).toHaveBeenCalledTimes(2);
    } finally {
      renames.mockRestore();
      removes.mockRestore();
    }
  });

  it("writes again over a file under its name that holds other text", () => {
    const dir = tempRoot();
    const path = settingsFile(ULTRACODE, dir);
    writeFileSync(path, "{\"ultracode\":");
    expect(settingsFile(ULTRACODE, dir)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(ULTRACODE);
  });
});

describe("agentStartArgs", () => {
  const args = ["--effort", "medium", "--settings", ULTRACODE];

  for (const component of ["claude-settings", "ovis"]) {
    it(`keeps inline JSON and writes nothing outside a redirected ${component} directory`, () => {
      const root = tempRoot();
      const outside = join(root, "outside");
      mkdirSync(outside);
      const dir = join(root, "ovis", "claude-settings");
      if (component === "claude-settings") mkdirSync(dirname(dir));
      symlinkSync(outside, component === "ovis" ? dirname(dir) : dir, "junction");
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(agentStartArgs("claude", args, { platform: "win32", dir })).toBe(args);
        expect(readdirSync(outside)).toEqual([]);
      } finally {
        logged.mockRestore();
      }
    });
  }

  it("keeps inline JSON instead of reusing a linked matching settings file", () => {
    const root = tempRoot();
    const dir = join(root, "claude-settings");
    mkdirSync(dir);
    const outside = join(root, "outside.json");
    writeFileSync(outside, ULTRACODE);
    const path = join(dir, `${createHash("sha256").update(ULTRACODE).digest("hex")}.json`);
    symlinkSync(outside, path, "file");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(agentStartArgs("claude", args, { platform: "win32", dir })).toBe(args);
      expect(readFileSync(outside, "utf8")).toBe(ULTRACODE);
    } finally {
      logged.mockRestore();
    }
  });

  it("refuses a matching entry replaced by a symlink during open", () => {
    const root = tempRoot();
    const dir = join(root, "claude-settings");
    const path = settingsFile(ULTRACODE, dir);
    const outside = join(root, "outside.json");
    writeFileSync(outside, ULTRACODE);
    const open = fs.openSync;
    const opens = spyOn(fs, "openSync").mockImplementation((...parameters) => {
      if (parameters[0] === path && (Number(parameters[1]) & fs.constants.O_CREAT) === 0) {
        rmSync(path);
        symlinkSync(outside, path, "file");
      }
      return open(...parameters);
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(agentStartArgs("claude", args, { platform: "win32", dir })).toBe(args);
      expect(readFileSync(outside, "utf8")).toBe(ULTRACODE);
    } finally {
      opens.mockRestore();
      logged.mockRestore();
    }
  });

  it("hands Claude Code's args on unchanged off Windows, and other agents' on Windows", () => {
    const dir = join(tempRoot(), "claude-settings");
    for (const platform of ["linux", "darwin"]) expect(agentStartArgs("claude", args, { platform, dir })).toBe(args);
    const codex = ["--config", "settings={\"a\":1}", "--settings", ULTRACODE];
    expect(agentStartArgs("codex", codex, { platform: "win32", dir })).toBe(codex);
    expect(existsSync(dir)).toBe(false);
  });

  it("gives Claude Code on Windows the path of a file holding its inline JSON", () => {
    const dir = join(tempRoot(), "claude-settings");
    const started = agentStartArgs("claude", args, { platform: "win32", dir });
    expect(started.slice(0, 3)).toEqual(["--effort", "medium", "--settings"]);
    expect(dirname(started[3]!)).toBe(dir);
    expect(readFileSync(started[3]!, "utf8")).toBe(ULTRACODE);
    expect(agentStartArgs("claude", args, { platform: "win32", dir })).toEqual(started);
    expect(args).toEqual(["--effort", "medium", "--settings", ULTRACODE]);
  });

  it("hands the JSON on as it is when the file cannot be written", () => {
    const blocker = join(tempRoot(), "a-file");
    writeFileSync(blocker, "");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(agentStartArgs("claude", args, { platform: "win32", dir: join(blocker, "claude-settings") })).toBe(args);
      expect(String(logged.mock.calls[0]?.[0])).toStartWith("claude --settings file: ");
    } finally {
      logged.mockRestore();
    }
  });
});
