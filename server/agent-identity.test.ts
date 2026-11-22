import { describe, expect, it } from "bun:test";
import { paneAgent, paneSession, reportedStatus, titleStatus } from "./agent-identity.ts";

describe("which agent a pane runs", () => {
  it("takes the app the program reported, in herdr's names", () => {
    expect(paneAgent({ reported: "codex" }, "linux")).toBe("codex");
    expect(paneAgent({ reported: "claude-code" }, "linux")).toBe("claude");
    expect(paneAgent({ reported: "antigravity" }, "linux")).toBe("agy");
    expect(paneAgent({ reported: "kimi-code" }, "linux")).toBe("kimi");
    // Grok Build 1.0.67 reports itself as `grok-build` (old-desktop, 2026-11-08)
    expect(paneAgent({ reported: "grok-build" }, "linux")).toBe("grok");
  });

  it("prefers the report to the process in front", () => {
    expect(paneAgent({ reported: "claude-code", foreground: ["/usr/bin/letta"] }, "linux")).toBe("claude");
  });

  it("names an agent that reports nothing from its process in front", () => {
    // Letta Code 0.34.44 as npm installs it: node running the bin script (hc's foreground, old-desktop 2026-11-08)
    expect(paneAgent({ foreground: ["node", "/home/u/.npm-global/lib/node_modules/.bin/letta", "--backend", "local"] }, "linux")).toBe("letta");
    expect(paneAgent({ foreground: ["devin"] }, "linux")).toBe("devin");
    expect(paneAgent({ foreground: ["/home/u/.local/bin/hermes", "chat"] }, "macos")).toBe("hermes");
    expect(paneAgent({ foreground: ["C:\\Users\\u\\AppData\\Roaming\\npm\\letta.cmd"] }, "windows")).toBe("letta");
    expect(paneAgent({ foreground: ["bun", "/opt/x/node_modules/.bin/dsh-tui"] }, "linux")).toBe("dsh-tui");
    expect(paneAgent({ foreground: ["node", "--enable-source-maps", "--no-warnings", "/home/u/.bin/letta", "--backend", "local"] }, "linux")).toBe("letta");
    expect(paneAgent({ foreground: ["python3", "-u", "/home/u/.local/bin/hermes"] }, "linux")).toBe("hermes");
    expect(paneAgent({ foreground: ["C:\\Program Files\\Claude\\Claude.EXE"] }, "windows")).toBe("claude");
  });

  it("names nothing a platform would decide when it is unknown, and no shim off Windows", () => {
    expect([["claude"], ["node", "/home/u/.bin/letta"], ["cmd"], ["C:\\Users\\u\\letta.cmd"], ["C:\\Program Files\\Claude\\Claude.EXE"]].map((foreground) => paneAgent({ foreground }, null)))
      .toEqual(["claude", "letta", null, null, null]);
    expect([["cmd"], ["/mnt/c/Users/u/letta.cmd"]].map((foreground) => paneAgent({ foreground }, "posix"))).toEqual(["cmd", null]);
  });

  // a backslash is part of a POSIX file name: only Windows reads it as a separator (#3319 review)
  it("splits a name at a backslash only where the platform does", () => {
    expect((["posix", "linux", "macos"] as const).map((platform) => paneAgent({ foreground: ["/home/u/a\\claude"] }, platform))).toEqual([null, null, null]);
    // Windows reads the same word as a folder `a` holding Claude
    expect(paneAgent({ foreground: ["/home/u/a\\claude"] }, "windows")).toBe("claude");
    expect(paneAgent({ foreground: ["/home/u/a\\claude"] }, null)).toBeNull();
  });

  // hc tells a terminal's own pid and the pid in front of it, never a process start (#3319 review)
  it("names a terminal from its start only while that same process is still in front", () => {
    expect(paneAgent({ foregroundPid: 7, launcher: { argv: ["node", "/home/u/.bin/letta"], pid: 7 } }, "linux")).toBe("letta");
    expect(paneAgent({ foreground: [], foregroundPid: 7, launcher: { argv: ["C:\\Users\\u\\letta.cmd"], pid: 7 } }, "windows")).toBe("letta");
    // a foreground the runtime names wins, even as the same pid: a claude start that exec()ed bash is bash now
    expect(paneAgent({ foreground: ["bash"], foregroundPid: 7, launcher: { argv: ["claude"], pid: 7 } }, "linux")).toBeNull();
    expect(paneAgent({ foreground: ["cmd.exe"], foregroundPid: 7, launcher: { argv: ["C:\\Users\\u\\letta.cmd"], pid: 7 } }, "windows")).toBeNull();
    expect(paneAgent({ launcher: { argv: ["claude"], pid: 7 }, foreground: ["codex"], foregroundPid: 9 }, "linux")).toBe("codex");
    expect(paneAgent({ launcher: { argv: ["claude"], pid: 7 }, foreground: ["bash"], foregroundPid: 9 }, "linux")).toBeNull();
    for (const facts of [
      { launcher: { argv: ["claude"], pid: 7 } },
      { launcher: { argv: ["claude"], pid: 7 }, foreground: null, foregroundPid: null },
      { launcher: { argv: ["claude"] }, foregroundPid: 7 },
    ]) expect(paneAgent(facts, "linux")).toBeNull();
    expect(paneAgent({ launcher: { argv: ["bash"], pid: 7 }, foregroundPid: 7 }, "linux")).toBeNull();
  });

  it("names none for a shell, an unknown program, or a program merely given an agent's name", () => {
    for (const foreground of [["bash"], ["-zsh"], ["vim", "letta"], ["sh", "-c", "letta"], ["node", "/srv/app/server.js"], ["python3", "-m", "letta"], ["node", "-e", "letta"], ["node", "--", "-letta"], ["node", "/srv/project/pi.js"], ["bun", "letta.ts"], ["/opt/x/letta.cmd"], []]) {
      expect(paneAgent({ foreground }, "linux")).toBeNull();
    }
    expect(paneAgent({}, "linux")).toBeNull();
    expect(paneAgent({ reported: "", foreground: null }, "linux")).toBeNull();
  });

  it("takes OpenCode's session as the one it named that alone carries the terminal's title", () => {
    expect(paneSession("opencode", { named: ["ses_a", "ses_b"], titled: ["ses_b"] })).toEqual({ agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_b" });
    expect(paneSession("opencode", { named: ["ses_a", "ses_b"], titled: ["ses_a", "ses_b"] })).toBeNull();
    expect(paneSession("opencode", { named: ["ses_a"], titled: ["ses_c"] })).toBeNull();
    expect(paneSession("opencode", { named: ["ses_a"] })).toBeNull();
    expect(paneSession("claude", { named: ["ses_a"], titled: ["ses_a"] })).toBeNull();
  });

  it("reads a reported status in herdr's words, an error or an unknown word as none", () => {
    expect(["working", "blocked", "idle", "done", "error", "thinking", "", null, undefined].map(reportedStatus))
      .toEqual(["working", "blocked", "idle", "done", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  });

  // letta-code 0.34.44's own titles on old-desktop, 2026-11-08: a spinner frame while a turn runs
  it("reads Letta's spinner title as work and its plain title as rest, and no other agent's title", () => {
    expect(["⠋ Tutor", "⠹ Tutor", "Tutor", "", null].map((title) => titleStatus("letta", title))).toEqual(["working", "working", "idle", null, null]);
    expect(titleStatus("claude", "⠋ Claude Code")).toBeNull();
    // while a tool call waits for the user's approval (standard permission mode), the title says so, blinking
    expect(titleStatus("letta", "[ . ] Action Required | Tutor")).toBe("blocked");
    expect(titleStatus("letta", "[ ! ] Action Required | Tutor")).toBe("blocked");
  });

  it("does not take a binary whose name proves nothing on that platform", () => {
    // Windows' own command prompt is cmd.exe; elsewhere `cmd` is the agent
    expect(paneAgent({ foreground: ["C:\\Windows\\System32\\cmd.exe"] }, "windows")).toBeNull();
    expect(paneAgent({ foreground: ["cmd"] }, "linux")).toBe("cmd");
  });
});
