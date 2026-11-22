import { join } from "node:path";
import type { Page } from "playwright-core";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";

type Grid = { readonly cols: number; readonly rows: number };
type Frame = Grid & { readonly pane: string; readonly replay: boolean; readonly stream: string };
type Witness = { attach: number; requested: Grid | null; parsed: Frame | null };

declare global {
  interface Window { terminalGridWitness?: Witness }
}

/** Serve the existing hook-enabled client against the real bridge, without the demo transport. */
export async function gridTestServer(root: string) {
  await buildDemoApp(join(root, "dist"));
  process.env["OVIS_ASSETS"] = root;
  const [{ createServer }, { UsageService }] = await Promise.all([
    import("../server/index.ts"), import("../server/usage.ts"),
  ]);
  return createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
}

/** Observe the requested grid and the browser's post-parse witness, without reading PTY bytes. */
export async function terminalGrid(page: Page, pane: string) {
  await page.addInitScript(pane => {
    const witness: Witness = { attach: 0, requested: null, parsed: null };
    window.terminalGridWitness = witness;
    let connection: WebSocket | null = null;
    let stream: string | null = null;
    let detachFence: number | null = null;
    let nextFence = -1; // The app's ping IDs are positive.
    const receive = (event: MessageEvent) => {
      if (event.currentTarget !== connection || typeof event.data !== "string") return;
      const message: ServerMessage = JSON.parse(event.data);
      if (message.type === "pong" && message.id === detachFence) detachFence = null;
      if (detachFence === null && witness.requested && stream === null
        && message.type === "pty-data" && message.pane_id === pane && message.flow) {
        stream = message.flow.stream_id;
      }
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        const message: ClientMessage = JSON.parse(data);
        if ("pane_id" in message && message.pane_id === pane) {
          if (message.type === "attach") {
            if (connection !== this) {
              connection?.removeEventListener("message", receive, true);
              connection = this;
              stream = null;
              detachFence = null;
              connection.addEventListener("message", receive, true);
            }
            witness.requested = !message.keep_size ? { cols: message.cols, rows: message.rows } : null;
            witness.parsed = null;
            if (witness.requested) witness.attach++;
          } else if (message.type === "detach" && this === connection) {
            witness.requested = null;
            witness.parsed = null;
            stream = null;
            detachFence = nextFence--;
            // The bridge removes the old output subscription on detach. Its pong is ordered
            // after any old output already on this socket and before the next attach's output.
            send.call(this, data);
            send.call(this, JSON.stringify({ type: "ping", id: detachFence }));
            return;
          } else if (message.type === "resize" && this === connection && witness.requested &&
            (message.cols !== witness.requested.cols || message.rows !== witness.requested.rows)) {
            witness.requested = { cols: message.cols, rows: message.rows };
            witness.parsed = null;
          }
        }
      }
      send.call(this, data);
    };
    document.addEventListener("ovis:test-terminal-frame", (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const frame: Frame = event.detail;
      if (frame.pane === pane && frame.stream === stream
        && frame.cols === witness.requested?.cols && frame.rows === witness.requested.rows) witness.parsed = frame;
    });
  }, pane);
  let after = 0;
  return async (timeout: number, allowReplay = false): Promise<Grid> => {
    const ready = await page.waitForFunction(({ after, allowReplay }) => {
      const witness = window.terminalGridWitness;
      if (!witness || witness.attach <= after || !witness.parsed || (!allowReplay && witness.parsed.replay)) return null;
      const { cols, rows } = witness.parsed;
      return { attach: witness.attach, grid: { cols, rows } };
    }, { after, allowReplay }, { timeout });
    try {
      const receipt = await ready.jsonValue();
      if (!receipt) throw new Error(`pane ${pane} did not parse a complete frame at the requested grid`);
      after = receipt.attach;
      return receipt.grid;
    } finally {
      await ready.dispose();
    }
  };
}
