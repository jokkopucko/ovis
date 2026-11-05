import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { AgentDetector } from "./agent-catalog-detect.ts";
import { createServer } from "./index.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";

describe("GET /api/agents", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let bin: string;
  // installers' folders are looked up under this home, never the user's
  let emptyHome: string;
  const savedPath = process.env["PATH"];
  // the shell-started agents this server finds: gjc and DeepSeek Harness's dsh-tui here, omo not
  const located: string[] = [];
  const shellAgents = { executable: async (kind: string) => { located.push(kind); return kind === "gjc" || kind === "dsh-tui" ? `/opt/${kind}/bin/${kind}` : null; }, stop: async () => undefined } as unknown as ShellAgentLocator;
  const manifests = spyOn(herdr, "agentManifests").mockImplementation(async () => ({ manifests: [{ agent: "codex" }, { agent: "pi" }, { agent: "someagent" }, { agent: "cmd" }, { agent: "copilot" }, { agent: "letta" }] }) as unknown as Awaited<ReturnType<typeof herdr.agentManifests>>);
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-agents-route-"));
    bin = mkdtempSync(join(tmpdir(), "ovis-agents-bin-"));
    emptyHome = mkdtempSync(join(tmpdir(), "ovis-agents-empty-home-"));
    // only codex is on this server's PATH
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false, shellAgents, agentDetector: new AgentDetector({ home: emptyHome, locate: async () => null }) });
  });
  afterEach(() => {
    process.env["PATH"] = savedPath;
    located.length = 0;
    manifests.mockClear();
  });
  afterAll(() => {
    server.stop();
    manifests.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it("offers herdr's agents, Oh My Pi and Claude Code always, and the shell agents this server finds, by label, not by kind", async () => {
    process.env["PATH"] = bin;
    const response = await fetch(url("/api/agents"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        { kind: "claude", label: "Claude Code", installed: false },
        { kind: "codex", label: "Codex", installed: true },
        { kind: "cmd", label: "Command Code", installed: false },
        { kind: "gjc", label: "Gajae Code", installed: true },
        { kind: "copilot", label: "GitHub Copilot", installed: false },
        { kind: "letta", label: "Letta Code", installed: false },
        { kind: "omp", label: "Oh My Pi", installed: false },
        { kind: "pi", label: "pi", installed: false },
        { kind: "someagent", label: "someagent", installed: false },
      ],
    });
    // dsh-tui is on the locator's PATH, but dsh, which it needs to run, is nowhere: not offered, and not looked for
    expect(located.sort()).toEqual(["gjc", "omo"]);
  });

  it("offers DeepSeek Harness as dsh-tui, by its label, once dsh, which it needs, is found too", async () => {
    const found = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false, shellAgents,
      agentDetector: new AgentDetector({ home: emptyHome, locate: async (binary) => binary === "dsh" ? "/home/someone/.local/bin/dsh" : null }) });
    try {
      process.env["PATH"] = bin;
      const response = await fetch(`http://127.0.0.1:${found.port}/api/agents`);
      const { agents } = await response.json() as { agents: { kind: string; label: string; installed: boolean }[] };
      expect(agents.find((agent) => agent.kind === "dsh-tui")).toEqual({ kind: "dsh-tui", label: "DeepSeek Harness", installed: true });
    } finally {
      found.stop();
    }
  });

  it("counts an agent the catalog finds on the login shell's PATH as installed, as the catalog does", async () => {
    // an installer put claude in ~/.local/bin, which a server run as a service lacks on its own PATH
    const found = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false, shellAgents,
      agentDetector: new AgentDetector({ home: emptyHome, locate: async (binary) => binary === "claude" ? "/home/someone/.local/bin/claude" : null }) });
    try {
      process.env["PATH"] = bin;
      const response = await fetch(`http://127.0.0.1:${found.port}/api/agents`);
      const { agents } = await response.json() as { agents: { kind: string; installed: boolean }[] };
      expect(agents.find((agent) => agent.kind === "claude")?.installed).toBe(true);
      expect(agents.find((agent) => agent.kind === "copilot")?.installed).toBe(false);
    } finally {
      found.stop();
    }
  });

  it("offers a shell agent its install just put on the login PATH, read again once, but not one found only in an installer folder no PATH has", async () => {
    const home = mkdtempSync(join(tmpdir(), "ovis-agents-home-"));
    for (const [dir, binary] of [[".opencode/bin", "opencode"], [".local/bin", "omo"]] as const) {
      mkdirSync(join(home, dir), { recursive: true });
      writeFileSync(join(home, dir, binary), "#!/bin/sh\n");
      chmodSync(join(home, dir, binary), 0o755);
    }
    manifests.mockImplementation(async () => ({ manifests: [{ agent: "opencode" }] }) as unknown as Awaited<ReturnType<typeof herdr.agentManifests>>);
    // the shell-agent locator keeps a login PATH from before the install: reading it again finds omo
    let fresh = false;
    let refreshes = 0;
    const shellLocator = { executable: async (kind: string) => kind === "omo" && fresh ? join(home, ".local/bin/omo") : null, refresh: async () => { refreshes += 1; fresh = true; }, stop: async () => undefined } as unknown as ShellAgentLocator;
    // opencode's folder is on no PATH this server reads, however often it is read
    const detector = new AgentDetector({ home, locate: async () => null });
    const found = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false, shellAgents: shellLocator, agentDetector: detector });
    try {
      process.env["PATH"] = bin;
      const read = async () => (await (await fetch(`http://127.0.0.1:${found.port}/api/agents`)).json() as { agents: { kind: string; installed: boolean }[] }).agents;
      const first = await read();
      expect(first.find((agent) => agent.kind === "omo")?.installed).toBe(true);
      expect(first.find((agent) => agent.kind === "opencode")?.installed).toBe(false);
      expect(refreshes).toBe(1);
      // a later read does not ask the login shell again for the same install
      await read();
      expect(refreshes).toBe(1);
    } finally {
      found.stop();
      rmSync(home, { recursive: true, force: true });
      manifests.mockImplementation(async () => ({ manifests: [{ agent: "codex" }, { agent: "pi" }, { agent: "someagent" }, { agent: "cmd" }, { agent: "copilot" }, { agent: "letta" }] }) as unknown as Awaited<ReturnType<typeof herdr.agentManifests>>);
    }
  });

  it("passes herdr's own error through, hides any other, and refuses anything but GET", async () => {
    manifests.mockImplementationOnce(async () => { throw new HerdrError("connect_failed", "herdr is not answering"); });
    const unreachable = await fetch(url("/api/agents"));
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { error: { code: string } }).error.code).toBe("connect_failed");
    manifests.mockImplementationOnce(async () => { throw new Error("ENOENT /home/someone/.config/herdr/manifests"); });
    const broken = await fetch(url("/api/agents"));
    expect(broken.status).toBe(500);
    const body = await broken.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("ENOENT");
    const post = await fetch(url("/api/agents"), { method: "POST", headers: { origin: url("") } });
    expect(post.status).toBe(400);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });
});
