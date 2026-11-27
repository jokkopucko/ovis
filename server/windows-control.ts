import { LEAVE_WITHIN_MS, terminalEnv, writeLine } from "./pty/session.ts";
import { WatchStreamParser } from "./watch.ts";

type Grid = { cols: number; rows: number };

/** Match both ends of this CLI protocol. A daemon's JSON RPC version alone does not describe stdin. */
export function knownWindowsControl(platform: string, daemon: { version: string; protocol: number; runtime?: string }, cli: string): boolean {
  return platform === "win32" && daemon.runtime === undefined && daemon.protocol === 22
    && (daemon.version === "0.9.3" || daemon.version === "0.9.5") && cli.trim() === `herdr ${daemon.version}`;
}

export async function windowsControlBinary(daemon: { version: string; protocol: number; runtime?: string }): Promise<string | null> {
  if (!knownWindowsControl(process.platform, daemon, `herdr ${daemon.version}`)) return null;
  const command = Bun.which(process.env["OVIS_HERDR_BIN"] || "herdr");
  if (!command) return null;
  const output = async (args: string[]) => {
    const check = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 2_000, env: terminalEnv() });
    const [code, text] = await Promise.all([check.exited, new Response(check.stdout).text()]);
    return code === 0 ? text : "";
  };
  try {
    if (!knownWindowsControl(process.platform, daemon, await output(["--version"]))) return null;
    const help = await output(["terminal", "session", "control", "--help"]);
    return ["terminal session control", "--cols", "--rows", "--takeover"].every(flag => help.includes(flag)) ? command : null;
  } catch { return null; }
}

export interface WindowsControlOptions extends Grid {
  command: string;
  socket: string;
  target: string;
  takeover: boolean;
  onFrame(data: string, grid: Grid, full: boolean): void;
  onEnd(held: boolean, reason?: string): void;
}

/** One non-reconnecting child per grant. Never write into a replacement process. */
export class WindowsControl {
  readonly exited: Promise<void>;
  private readonly child;
  private live = true;
  private granted = false;
  private leaving?: ReturnType<typeof setTimeout>;
  private resumeRead?: ReturnType<typeof Promise.withResolvers<void>>;
  private readonly opening: ReturnType<typeof setTimeout>;
  constructor(options: WindowsControlOptions) {
    // Herdr derives its client socket from the API path and adds the pipe prefix itself.
    const env = terminalEnv({ HERDR_SOCKET_PATH: options.socket.replace(/^\\\\\.\\pipe\\/i, "") });
    delete env["HERDR_SESSION"];
    delete env["HERDR_CLIENT_SOCKET_PATH"];
    this.child = Bun.spawn([options.command, "terminal", "session", "control", options.target,
      "--cols", String(options.cols), "--rows", String(options.rows), ...(options.takeover ? ["--takeover"] : [])],
    { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const ended = (held: boolean, reason?: string) => {
      if (!this.live || this.leaving) return;
      this.kill();
      options.onEnd(held, reason);
    };
    this.opening = setTimeout(() => ended(false), 15_000);
    this.opening.unref?.();
    const parser = new WatchStreamParser({
      onFrame() {},
      onScreen: (data, cols, rows, full) => {
        if (!this.live || this.leaving || (!this.granted && !full)) return;
        if (!this.granted) clearTimeout(this.opening);
        this.granted = true;
        options.onFrame(data, { cols, rows }, full);
      },
      onEnd: (reason) => {
        ended(/already has an attached client|taken over|takeover/i.test(reason ?? ""), reason);
      },
    });
    const pump = async () => {
      const reader = this.child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (this.live) {
          if (this.resumeRead) await this.resumeRead.promise;
          if (!this.live) break;
          const part = await reader.read();
          if (part.done) break;
          parser.push(decoder.decode(part.value, { stream: true }));
        }
        if (this.live) { parser.push(decoder.decode()); parser.finish(); }
      } finally { reader.releaseLock(); ended(false); }
    };
    this.exited = Promise.all([pump().catch(() => {}), this.child.exited]).then(() => {
      clearTimeout(this.leaving);
      this.live = false;
    });
  }
  private send(frame: object): boolean {
    return this.live && this.granted && !this.leaving && writeLine(this.child.stdin, `${JSON.stringify(frame)}\n`);
  }
  resize(cols: number, rows: number): boolean { return this.send({ type: "terminal.resize", cols, rows }); }
  write(text: string): boolean { return this.send({ type: "terminal.input", text }); }
  pause(): void { this.resumeRead ??= Promise.withResolvers<void>(); }
  resume(): void { this.resumeRead?.resolve(); this.resumeRead = undefined; }
  leave(): void {
    if (this.leaving) return;
    this.resume();
    // The control CLI reads release on the same stdin as the input it accepted.
    if (!this.send({ type: "terminal.release" })) { this.kill(); return; }
    this.leaving = setTimeout(() => this.kill(), LEAVE_WITHIN_MS);
  }
  kill(): void {
    if (!this.live) return;
    this.live = false;
    clearTimeout(this.opening);
    clearTimeout(this.leaving);
    this.resume();
    this.child.kill();
  }
}
