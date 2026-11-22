import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Machine, MachineEvent } from "../shared/machines.ts";
import { paneTokenValues, type AgentRowTokens } from "../shared/pane-tokens.ts";
import { agentRowTokens, decidedRowTokens, HerdrSidebarConfig, herdrConfigPath, reportedTokenValues, withoutHiddenTokens } from "./herdr-sidebar.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-sidebar-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const configFile = (text?: string): string => {
  const path = join(dir, `config-${++files}.toml`);
  if (text !== undefined) writeFileSync(path, text);
  return path;
};
const parse = (text: string): AgentRowTokens | null => agentRowTokens(Bun.TOML.parse(text));
const changed = async (config: HerdrSidebarConfig, edit: () => void): Promise<void> => {
  const next = Promise.withResolvers<void>();
  const stop = config.subscribe(() => next.resolve());
  const timeout = setTimeout(() => next.reject(new Error("timed out waiting for sidebar config change")), 5_000);
  try {
    edit();
    await next.promise;
  } finally {
    clearTimeout(timeout);
    stop();
  }
};

const machineWith = (panes: Array<{ pane_id: string; agent?: string; tokens?: Record<string, unknown> }>, agents: Array<{ pane_id: string; agent: string; tokens?: Record<string, unknown> }> = []): Machine =>
  ({ id: "local", state: "connected", snapshot: { panes, agents } }) as unknown as Machine;

describe("herdrConfigPath", () => {
  test("follows herdr: HERDR_CONFIG_PATH, then XDG_CONFIG_HOME on any platform, then the platform's own place", () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: "/etc/h.toml", XDG_CONFIG_HOME: "/x" }, "linux", "/home/me")).toBe("/etc/h.toml");
    expect(herdrConfigPath({ XDG_CONFIG_HOME: "/x" }, "win32", "/home/me")).toBe(join("/x", "herdr", "config.toml"));
    expect(herdrConfigPath({}, "darwin", "/home/me")).toBe(join("/home/me", ".config", "herdr", "config.toml"));
    expect(herdrConfigPath({ APPDATA: "C:/Users/me/AppData/Roaming" }, "win32", "C:/Users/me")).toBe(join("C:/Users/me/AppData/Roaming", "herdr", "config.toml"));
    expect(herdrConfigPath({}, "win32", "C:/Users/me")).toBe(join("C:/Users/me", "AppData", "Roaming", "herdr", "config.toml"));
  });
});

describe("agentRowTokens", () => {
  test("takes the `$name` tokens of herdr's agent rows, in order, each place of one named twice, and leaves the built-ins and styles", () => {
    expect(parse(`
[ui.sidebar.agents]
rows = [["state_icon", "machine", "workspace", { token = "tab", rules = [{ equals = "Agent", hide = true }] }], ["agent"], [{ token = "$summary", dim = true, fg = "#89b4fa" }, "$progress"]]

[ui.sidebar.spaces]
rows = [["state_icon", "workspace"], ["$workspace_only"]]
`)).toEqual({ rows: [{ name: "summary" }, { name: "progress" }], by_agent: {} });
    // herdr tests each place's rules on its own: a place that hides the token leaves the other one
    expect(parse(`[ui.sidebar.agents]\nrows = [["state_icon", "workspace"], ["agent", { token = "$quota", rules = [{ equals = "unknown", hide = true }] }], ["$quota"]]`))
      .toEqual({ rows: [{ name: "quota", rules: [{ equals: "unknown", hide: true }] }, { name: "quota" }], by_agent: {} });
  });

  test("keeps a token's rules only when one of them hides it, without their styles", () => {
    expect(parse(`
[ui.sidebar.agents]
rows = [[
  { token = "$quota", rules = [{ starts_with = "5h", fg = "#f55" }, { equals = "none", ignore_case = true, hide = true }] },
  { token = "$load", fg = "#fff", rules = [{ gt = 80, fg = "#f55", bold = true }, { gt = 50, fg = "#fc0" }] },
  { token = "$eta", rules = [{ lt = 1, hide = true }, { gt = 1, ignore_case = true, hide = true }, { equals = "a", contains = "b", hide = true }, { hide = true }] },
]]
`)?.rows).toEqual([
      { name: "quota", rules: [{ starts_with: "5h" }, { equals: "none", ignore_case: true, hide: true }] },
      { name: "load" },
      // herdr refuses a rule with ignore_case on a number, two conditions, or none: they are left out
      { name: "eta", rules: [{ lt: 1, hide: true }] },
    ]);
  });

  test("an agent's own rows stand beside `rows`, which may be unset", () => {
    expect(parse(`
[ui.sidebar.agents]
rows = [["state_icon", "agent"]]

[ui.sidebar.agents.rows_by_agent]
claude = [["state_icon", "agent"], ["$quota", "$model"]]
codex = [["agent"]]
`)).toEqual({ rows: [], by_agent: { claude: [{ name: "quota" }, { name: "model" }], codex: [] } });
    expect(parse(`[ui.sidebar.agents.rows_by_agent]\nclaude = [["$quota"]]`)).toEqual({ rows: null, by_agent: { claude: [{ name: "quota" }] } });
  });

  test("a config that sets no agent rows, or rows herdr would refuse, names no token", () => {
    expect(parse("onboarding = false")).toBeNull();
    expect(parse("[ui]\nsidebar_width = 30")).toBeNull();
    expect(parse(`[ui.sidebar.agents]\nrow_gap = 1`)).toBeNull();
    expect(parse(`[ui.sidebar.agents]\nrows = ["$quota"]`)).toBeNull();
    expect(parse(`[ui.sidebar.agents]\nrows = [["$", "$has space", 3, { dim = true }, "$ok"]]`)).toEqual({ rows: [{ name: "ok" }], by_agent: {} });
    expect(agentRowTokens(null)).toBeNull();
    expect(agentRowTokens({ ui: [] })).toBeNull();
  });
});

describe("decidedRowTokens", () => {
  test("decides the hide rules for the values the PCs report, as the browser would, and names none of their operands", () => {
    const raw = parse(`
[ui.sidebar.agents]
rows = [
  ["agent", { token = "$quota", rules = [{ equals = "private-literal", hide = true }, { starts_with = "5h 100%", hide = true }] }, { token = "$load", rules = [{ gt = 80, hide = true }] }],
  [{ token = "$eta", rules = [{ equals = "soon", hide = true }] }, "$eta", "$model"],
]

[ui.sidebar.agents.rows_by_agent]
codex = [[{ token = "$quota", rules = [{ starts_with = "5h 4" }, { contains = "WK", ignore_case = true, hide = true }] }]]
`);
    const panes = [
      { pane_id: "w1:p1", agent: "claude", tokens: { quota: "5h 100% · Wk 3%", load: "95", eta: "soon", model: "opus" } },
      { pane_id: "w1:p2", agent: "codex", tokens: { quota: "5h 40% · wk 70%", load: "12", eta: "  " } },
      { pane_id: "w1:p3", agent: "codex" },
    ];
    const agents = [{ pane_id: "w1:p3", agent: "codex", tokens: { quota: "5h 10% · Wk 9%", load: 99 } }];
    const told = decidedRowTokens(raw, reportedTokenValues([machineWith(panes, agents), { id: "away", state: "disconnected", snapshot: null } as unknown as Machine]));
    const rest = { contains: "", hide: true };
    expect(told).toEqual({
      rows: [
        { name: "quota", rules: [{ equals: "5h 10% · Wk 9%" }, { equals: "5h 40% · wk 70%" }, rest] },
        { name: "load", rules: [{ equals: "12" }, rest] },
        { name: "eta", rules: [rest] },
        { name: "eta" },
        { name: "model" },
      ],
      // the first rule that matches decides: "5h 40%…" matches one that does not hide
      by_agent: { codex: [{ name: "quota", rules: [{ equals: "5h 40% · wk 70%" }, rest] }] },
    });
    const text = JSON.stringify(told);
    for (const operand of ["private-literal", "80", "WK", "starts_with", "\"contains\":\"W", "gt", "ignore_case"]) expect(text).not.toContain(operand);
    for (const agent of ["claude", "codex", null]) {
      for (const tokens of [...panes.map((pane) => pane.tokens), ...agents.map((record) => record.tokens)]) {
        expect(paneTokenValues(told, agent, tokens)).toEqual(paneTokenValues(raw, agent, tokens));
      }
    }
    expect(decidedRowTokens(raw, reportedTokenValues([machineWith([{ pane_id: "w1:p1", tokens: { load: "50" } }])]), reportedTokenValues([machineWith([{ pane_id: "w1:p1", tokens: { load: "95" } }, { pane_id: "w1:p2", tokens: { load: "12" } }])]))?.rows?.[1])
      .toEqual({ name: "load", rules: [{ equals: "12" }, { equals: "50" }, rest] });
    expect(decidedRowTokens(null, reportedTokenValues([machineWith(panes)]))).toBeNull();
    expect(decidedRowTokens(raw)).toEqual({
      rows: [{ name: "quota", rules: [rest] }, { name: "load", rules: [rest] }, { name: "eta", rules: [rest] }, { name: "eta" }, { name: "model" }],
      by_agent: { codex: [{ name: "quota", rules: [rest] }] },
    });
  });
});

describe("withoutHiddenTokens", () => {
  test("leaves out the values the rules hide wherever they name them, under each row's own agent, and changes no machine", () => {
    const raw = parse(`
[ui.sidebar.agents]
rows = [
  ["agent", { token = "$quota", rules = [{ equals = "private-literal", hide = true }, { starts_with = "5h 100%", hide = true }] }, { token = "$load", rules = [{ gt = 80, hide = true }] }],
  [{ token = "$eta", rules = [{ equals = "soon", hide = true }] }, "$eta", "$model"],
]

[ui.sidebar.agents.rows_by_agent]
codex = [[{ token = "$quota", rules = [{ starts_with = "5h 4" }, { contains = "WK", ignore_case = true, hide = true }] }]]
`);
    const panes = [
      { pane_id: "w1:p1", agent: "claude", tokens: { quota: "5h 100% · Wk 3%", load: "95", eta: "soon", model: "opus" } },
      { pane_id: "w1:p2", agent: "codex", tokens: { quota: "5h 40% · wk 70%", load: "12", eta: "  " } },
      { pane_id: "w1:p3", agent: "codex" },
      { pane_id: "w1:p4", agent: "  ", tokens: { load: "95" } },
      { pane_id: "w1:p5", agent: "claude", tokens: { load: "95" } },
    ];
    const agents = [
      { pane_id: "w1:p3", agent: "codex", tokens: { quota: "5h 10% · Wk 9%", load: 99 } },
      { pane_id: "w1:p4", agent: "codex" },
      { pane_id: "w1:p5", agent: "codex" },
    ];
    const machines = [machineWith(panes, agents as Array<{ pane_id: string; agent: string; tokens?: Record<string, unknown> }>), { id: "away", state: "disconnected", snapshot: null } as unknown as Machine];
    const before = JSON.stringify(machines);
    const shown = withoutHiddenTokens(raw, machines);
    expect(JSON.stringify(machines)).toBe(before);
    const snapshot = shown[0]!.snapshot!;
    expect(snapshot.panes.map((pane) => pane.tokens)).toEqual([
      { eta: "soon", model: "opus" },
      { quota: "5h 40% · wk 70%", load: "12", eta: "  " },
      undefined,
      { load: "95" },
      {},
    ]);
    expect(snapshot.agents.map((record) => record.tokens)).toEqual([{ load: 99 }, undefined, undefined]);
    expect(snapshot.panes[1]).toBe(machines[0]!.snapshot!.panes[1]!);
    expect(shown[1]).toBe(machines[1]!);
    const told = decidedRowTokens(raw, reportedTokenValues(shown));
    expect(JSON.stringify(told)).not.toMatch(/private-literal|starts_with|"contains":"[^"]|"gt"|ignore_case/);
    panes.forEach((pane, index) => {
      const record = agents.find((candidate) => candidate.pane_id === pane.pane_id);
      const agent = pane.agent.trim() || record?.agent || null;
      const shownRecord = snapshot.agents.find((candidate) => candidate.pane_id === pane.pane_id);
      expect(paneTokenValues(told, agent, snapshot.panes[index]!.tokens ?? shownRecord?.tokens)).toEqual(paneTokenValues(raw, agent, pane.tokens ?? record?.tokens));
    });
    expect(withoutHiddenTokens(null, machines)).toBe(machines);
  });

  test("keeps the background tag a rule hides, so the row still files under background agents, and the row still draws none of it", () => {
    const raw = parse(`
[ui.sidebar.agents]
rows = [["agent", { token = "$role", rules = [{ equals = "background", ignore_case = true, hide = true }] }]]
`);
    const shown = withoutHiddenTokens(raw, [machineWith([{ pane_id: "w1:p1", agent: "claude", tokens: { role: "Background" } }, { pane_id: "w1:p2", agent: "claude", tokens: { role: "BACKGROUND-ish" } }], [])]);
    expect(shown[0]!.snapshot!.panes.map((pane) => pane.tokens)).toEqual([{ role: "Background" }, { role: "BACKGROUND-ish" }]);
    const told = decidedRowTokens(raw, reportedTokenValues(shown));
    expect(paneTokenValues(told, "claude", { role: "Background" })).toEqual([]);
  });
});

describe("HerdrSidebarConfig", () => {
  test("reads the file, and tells a listener when what the rows draw changes, not when the file merely changes", async () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["agent", "$quota"]]`);
    const config = new HerdrSidebarConfig(path, 10);
    expect(config.get()).toEqual({ rows: [{ name: "quota" }], by_agent: {} });
    const told: (AgentRowTokens | null)[] = [];
    const stop = config.subscribe((layout) => told.push(layout));
    try {
      writeFileSync(path, `# a comment\n[ui.sidebar.agents]\nrows = [["state_icon", "agent", "$quota"]]`);
      expect(config.get()).toEqual({ rows: [{ name: "quota" }], by_agent: {} });
      expect(told).toEqual([]);
      writeFileSync(path, `[ui.sidebar.agents]\nrows = [["agent", "$quota", "$summary"]]`);
      expect(config.get()).toEqual({ rows: [{ name: "quota" }, { name: "summary" }], by_agent: {} });
      expect(told).toEqual([{ rows: [{ name: "quota" }, { name: "summary" }], by_agent: {} }]);
      await changed(config, () => writeFileSync(path, `[ui.sidebar.agents\nrows = [[`));
      expect(told[1]).toBeNull();
      await changed(config, () => {
        rmSync(path);
        writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$eta"]]`);
      });
      expect(told[2]).toEqual({ rows: [{ name: "eta" }], by_agent: {} });
    } finally { stop(); }
    writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$other", "$names"]]`);
    expect(config.get()).toEqual({ rows: [{ name: "other" }, { name: "names" }], by_agent: {} });
    expect(told).toHaveLength(3);
  });

  test("a missing config names no token", () => {
    expect(new HerdrSidebarConfig(configFile()).get()).toBeNull();
  });

  test.each(["\n", "\r\n"])("keeps custom rows with line-start BOMs using %j line endings", (newline) => {
    const path = configFile([
      "\uFEFF# herdr config",
      "\uFEFF[ui.sidebar.agents]",
      '\uFEFFrows = [["$quota", { token = "$summary", rules = [{ equals = "a\uFEFFb", hide = true }] }]]',
      "\uFEFF[ui.sidebar.agents.rows_by_agent]",
      '\uFEFFcodex = [["$progress"]]',
    ].join(newline));
    expect(new HerdrSidebarConfig(path).get()).toEqual({
      rows: [{ name: "quota" }, { name: "summary", rules: [{ equals: "a\uFEFFb", hide: true }] }],
      by_agent: { codex: [{ name: "progress" }] },
    });
  });

  test("falls back when a config becomes a directory", () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["$quota"]]`);
    const config = new HerdrSidebarConfig(path);
    expect(config.get()).toEqual({ rows: [{ name: "quota" }], by_agent: {} });
    rmSync(path);
    mkdirSync(path);
    expect(config.get()).toBeNull();
  });

  test.each(['"""', "'''"])("preserves line-start BOMs inside %s multiline rule values", (quote) => {
    const path = configFile([
      "# Delimiters in comments do not open strings: \"\"\" '''",
      `literal = '"""'`,
      `basic = "''' and \\"quoted\\""`,
      "\uFEFF[ui.sidebar.agents]",
      `rows = [[{ token = "$summary", rules = [{ equals = ${quote}first`,
      "\uFEFFsecond",
      `${quote}, hide = true }] }]]`,
      "\uFEFF[ui.sidebar.agents.rows_by_agent]",
      'codex = [["$progress"]]',
    ].join("\n"));
    expect(new HerdrSidebarConfig(path).get()).toEqual({
      rows: [{ name: "summary", rules: [{ equals: "first\n\uFEFFsecond\n", hide: true }] }],
      by_agent: { codex: [{ name: "progress" }] },
    });
  });

  test("honours escaped quotes and quote runs in multiline basic strings", () => {
    const path = configFile([
      "[ui.sidebar.agents]",
      'rows = [[{ token = "$summary", rules = [{ equals = """first\\"""',
      "\uFEFFsecond",
      'last""""", hide = true }] }]]',
      '\uFEFFrows_by_agent = { codex = [["$progress"]] }',
    ].join("\r\n"));
    expect(new HerdrSidebarConfig(path).get()).toEqual({
      rows: [{ name: "summary", rules: [{ equals: 'first"""\n\uFEFFsecond\nlast""', hide: true }] }],
      by_agent: { codex: [{ name: "progress" }] },
    });
  });

  test("falls back for a config larger than the size cap", () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["$quota"]]\n#${"x".repeat(1024 * 1024)}`);
    expect(new HerdrSidebarConfig(path).get()).toBeNull();
  });

  test.skipIf(process.platform === "win32")("does not wait for a writer when the config is a FIFO", async () => {
    const path = configFile();
    expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
    const child = Bun.spawn([process.execPath, "-e", `
      import { HerdrSidebarConfig } from ${JSON.stringify(new URL("./herdr-sidebar.ts", import.meta.url).href)};
      console.log(JSON.stringify(new HerdrSidebarConfig(${JSON.stringify(path)}).get()));
    `], { stdout: "pipe", stderr: "pipe", timeout: 2_000 });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("null\n");
  });
});

describe("the machine events", () => {
  test("say herdr's agent rows when a browser connects, and again when they change", async () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [["$quota"]]`);
    const config = new HerdrSidebarConfig(path, 10);
    const manager = { subscribe: () => () => undefined } as unknown as MachineManager;
    const abort = new AbortController();
    const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager, undefined, undefined, false, config);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const events: MachineEvent[] = [];
    let buffer = "";
    const read = async (): Promise<void> => {
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    };
    try {
      while (events.length === 0) await read();
      expect(events).toEqual([{ type: "herdr-sidebar", agents: { rows: [{ name: "quota" }], by_agent: {} } }]);
      writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$quota", "$progress"]]`);
      while (events.length === 1) await read();
      expect(events[1]).toEqual({ type: "herdr-sidebar", agents: { rows: [{ name: "quota" }, { name: "progress" }], by_agent: {} } });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  test("tell a PC's relayed snapshot without the token values the rows hide, as the roster (#2160)", async () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [[{ token = "$quota", rules = [{ starts_with = "off", hide = true }] }, "$eta"]]`);
    const config = new HerdrSidebarConfig(path, 10);
    const snapshot = machineWith([{ pane_id: "w1:p1", agent: "claude", tokens: { quota: "off · private", eta: "soon" } }]).snapshot!;
    const relayed: MachineEvent = { type: "machine-message", machine_id: "pc1", message: { type: "snapshot", snapshot } };
    const manager = { subscribe: (listener: (event: MachineEvent) => void) => { listener({ type: "machines", machines: [] }); listener(relayed); return () => undefined; } } as unknown as MachineManager;
    const abort = new AbortController();
    const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager, undefined, undefined, true, config);
    const reader = response.body!.getReader();
    let text = "";
    try {
      while (!text.includes('"machine-message"')) text += new TextDecoder().decode((await reader.read()).value);
      const frame = text.split("\n\n").find((part) => part.includes('"machine-message"'))!;
      const told = JSON.parse(frame.slice("data: ".length)) as MachineEvent;
      expect(told.type === "machine-message" && told.message.type === "snapshot" ? told.message.snapshot.panes[0]!.tokens : null).toEqual({ eta: "soon" });
      expect(text).not.toContain("off · private");
      expect(snapshot.panes[0]!.tokens).toEqual({ quota: "off · private", eta: "soon" });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  test("never let a browser draw a value the rules hide, streamed, polled or after a reconnect, nor tell it their operands", async () => {
    const path = configFile(`[ui.sidebar.agents]\nrows = [[{ token = "$quota", rules = [{ equals = "private-literal", hide = true }, { starts_with = "off", hide = true }] }, { token = "$eta", rules = [{ equals = "soon", hide = true }] }, "$eta"]]`);
    const config = new HerdrSidebarConfig(path, 10);
    const machine = machineWith([]);
    let emit: ((event: MachineEvent) => void) | undefined;
    const report = (tokens: Record<string, string>) => { machine.snapshot = machineWith([{ pane_id: "w1:p1", agent: "claude", tokens }]).snapshot; };
    const manager = {
      list: () => [machine],
      subscribe: (listener: (event: MachineEvent) => void) => { emit = listener; listener({ type: "machines", machines: [machine] }); return () => undefined; },
    } as unknown as MachineManager;
    let rows: AgentRowTokens | null = null;
    let held: Machine[] = [];
    const drawn = () => paneTokenValues(rows, "claude", held[0]?.snapshot?.panes[0]?.tokens);
    let text = "";
    const apply = (event: MachineEvent) => {
      if (event.type === "herdr-sidebar") rows = event.agents;
      if (event.type === "machines") held = event.machines;
      expect(drawn().filter((value) => value.startsWith("off"))).toEqual([]);
    };
    const poll = async () => {
      const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines"), manager, undefined, undefined, true, config);
      expect(response.status).toBe(200);
      const body = await response.text();
      text += body;
      apply({ type: "machines", machines: (JSON.parse(body) as { machines: Machine[] }).machines });
    };
    const open = async () => {
      const abort = new AbortController();
      const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager, undefined, undefined, true, config);
      const reader = response.body!.getReader();
      const events: MachineEvent[] = [];
      let buffer = "";
      const until = async (count: number): Promise<MachineEvent[]> => {
        while (events.length < count) {
          const { value } = await reader.read();
          const chunk = new TextDecoder().decode(value);
          text += chunk;
          buffer += chunk;
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!frame.startsWith("data: ")) continue;
            const event = JSON.parse(frame.slice(6)) as MachineEvent;
            events.push(event);
            apply(event);
          }
        }
        return events;
      };
      return { until, close: async () => { abort.abort(); await reader.cancel().catch(() => undefined); } };
    };
    report({ quota: "off · Z", eta: "soon" });
    await poll();
    expect(drawn()).toEqual(["soon"]);
    report({ quota: "5h 95%", eta: "later" });
    const first = await open();
    try {
      expect((await first.until(2)).map((event) => event.type)).toEqual(["herdr-sidebar", "machines"]);
      expect(drawn()).toEqual(["5h 95%", "later"]);
      // hidden wherever named: in no roster; drawn at its other place: that place is decided, without the operand
      report({ quota: "off · A", eta: "soon" });
      emit!({ type: "machines", machines: [machine] });
      const events = await first.until(3);
      expect(events.map((event) => event.type)).toEqual(["herdr-sidebar", "machines", "machines"]);
      expect(drawn()).toEqual(["soon"]);
      report({ quota: "off · B", eta: "soon" });
      await poll();
      emit!({ type: "machines", machines: [machine] });
      const rest = { contains: "", hide: true };
      expect((await first.until(5))[3]).toEqual({ type: "herdr-sidebar", agents: { rows: [{ name: "quota", rules: [rest] }, { name: "eta", rules: [rest] }, { name: "eta" }], by_agent: {} } });
    } finally { await first.close(); }
    report({ quota: "off · C", eta: "soon" });
    const second = await open();
    try {
      await second.until(2);
      expect(drawn()).toEqual(["soon"]);
      report({ quota: "5h 50%", eta: "later" });
      emit!({ type: "machines", machines: [machine] });
      await second.until(4);
      expect(drawn()).toEqual(["5h 50%", "later"]);
      writeFileSync(path, `[ui.sidebar.agents]\nrows = [[{ token = "$eta", rules = [{ contains = "late", hide = true }] }, { token = "$quota", rules = [{ starts_with = "off", hide = true }] }]]`);
      const events = await second.until(6);
      expect(events.slice(4).map((event) => event.type)).toEqual(["herdr-sidebar", "machines"]);
      expect(drawn()).toEqual(["5h 50%"]);
    } finally { await second.close(); }
    // every hidden value stayed on the server; rows that do not name a token then let its value go
    expect(text).not.toMatch(/private-literal|starts_with|"contains":"[^"]|"off ·/);
    writeFileSync(path, `[ui.sidebar.agents]\nrows = [["$eta"]]`);
    report({ quota: "off · D", eta: "soon" });
    await poll();
    writeFileSync(path, `[ui.sidebar.agents]\nrows = [[{ token = "$quota", rules = [{ starts_with = "off", hide = true }] }, "$eta"]]`);
    const third = await open();
    try {
      // the reconnect's decision, read with that kept roster before its own lands, hides the value it never decided
      await third.until(2);
      expect(drawn()).toEqual(["soon"]);
    } finally { await third.close(); }
    expect(text).not.toMatch(/private-literal|starts_with|"contains":"[^"]/);
  });
});
