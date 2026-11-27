import { expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationResponse } from "../shared/protocol.ts";
import { paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { shellQuote } from "./machine-security.ts";

export function testTmuxOwnAppServers({ enabled, root, socket, home, rollout, tmux, port }: {
  readonly enabled: boolean;
  readonly root: string;
  readonly socket: string;
  readonly home: string;
  readonly rollout: string;
  readonly tmux: (...args: string[]) => Promise<string>;
  readonly port: () => number | undefined;
}): void {
  it.skipIf(!enabled).each([
    ["child", "codex-transcript"], ["sibling", "codex-transcript"],
    ["shared", "scrollback"], ["disconnected", "scrollback"],
  ] as const)("shows the right history for a remote tmux TUI with a %s app server", async (relation, source) => {
    const endpoint = `unix://${join(root, `${relation}.sock`)}`;
    const lockDir = join(home, "thread-writer-locks");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, "00000000-0000-4000-8000-000000000001.lock");
    const fixture = join(root, "own-server.py");
    const python = Bun.which("python3");
    if (python === null) throw new Error("The tmux fixture needs python3");
    writeFileSync(fixture, `import ctypes, fcntl, signal, socket, subprocess, sys
ctypes.CDLL(None).prctl(15, b"codex", 0, 0, 0)
signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
tmux = ["tmux", "-S", ${JSON.stringify(socket)}, "wait-for"]
ready = ${JSON.stringify(`${relation}-ready`)}
kind = ${JSON.stringify(relation)}
if sys.argv[1] == "app-server":
    rollout = open(${JSON.stringify(rollout)}, "r")
    lock = open(${JSON.stringify(lock)}, "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(sys.argv[3][len("unix://"):])
    listener.listen()
    subprocess.run(tmux + ["-S", ready + "-listen"], check=True)
    clients = [listener.accept()[0] for _ in range(2 if kind == "shared" else 1)]
    subprocess.run(tmux + ["-S", ready], check=True)
    signal.pause()
else:
    server = None
    extra = None
    if sys.argv[1] == "child":
        server = subprocess.Popen(["codex", __file__, "app-server", "--listen", sys.argv[3]], executable=${JSON.stringify(python)})
    try:
        subprocess.run(tmux + [ready + "-listen"], check=True)
        path = sys.argv[3][len("unix://"):]
        if kind != "disconnected":
            client = socket.socket(socket.AF_UNIX)
            client.connect(path)
        if kind in ("shared", "disconnected"):
            extra = subprocess.Popen([${JSON.stringify(python)}, "-c", "import signal,socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); signal.pause()", path])
        subprocess.run(tmux + [ready], check=True)
        subprocess.run(tmux + ["-S", ready + "-tui"], check=True)
        sys.stdin.read()
    finally:
        for child in (extra, server):
            if child is not None:
                child.terminate()
                child.wait()
`);
    const launch = (role: string, flag: string) =>
      [python, fixture, role, flag, endpoint].map(shellQuote).join(" ");
    const script = relation === "child" ? `exec -a codex ${launch(relation, "--remote")}` : [
      `(exec -a codex ${launch("app-server", "--listen")}) &`,
      "pid=$!",
      `trap 'kill "$pid" 2>/dev/null; wait "$pid"' EXIT`,
      `(exec -a codex ${launch(relation, "--remote")})`,
    ].join("\n");
    const launcher = join(root, `${relation}.sh`);
    writeFileSync(launcher, script);
    let remoteWorkspace: string | undefined;
    try {
      await tmux("new-session", "-d", "-s", relation, `exec /bin/bash --noprofile --norc ${shellQuote(launcher)}`);
      await tmux("wait-for", `${relation}-ready-tui`);
      const hook = `${relation}-attached`;
      await tmux("set-hook", "-g", "client-attached", `wait-for -S ${hook}`);
      const view = await workspaceCreate({ cwd: root, label: `ovis-test-tmux-app-server-${relation}` });
      remoteWorkspace = view.workspace.workspace_id;
      const paneId = view.root_pane.pane_id;
      await paneSendText(paneId, `exec env -u TMUX tmux -S ${shellQuote(socket)} attach-session -E -t ${relation}\n`);
      await tmux("wait-for", hook);
      const response = await fetch(`http://127.0.0.1:${port()}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
      expect(response.status).toBe(200);
      const conversation: ConversationResponse = await response.json();
      expect(conversation.source).toBe(source);
      if (source === "codex-transcript") expect(JSON.stringify(conversation)).toContain("Only this native conversation belongs");
    } finally {
      try {
        if (remoteWorkspace !== undefined) await workspaceClose(remoteWorkspace);
      } finally { await tmux("kill-session", "-t", relation); }
    }
  }, 15_000);
}
