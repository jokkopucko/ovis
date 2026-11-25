import type { Socket } from "node:net";
import { HARNESS_LIMITS, refuse } from "../../shared/harness-tool.ts";

/** A connection and an operation have separate lifetimes: an accepted launch may finish
 * after disconnect. It retains its work slot until it actually settles. */
export class HubConnections {
  private readonly sockets = new Set<Socket>();
  private active = 0;
  close(): void { for (const s of this.sockets) s.destroy(); }
  receive(s: Socket, call: (body: unknown, signal: AbortSignal, socket: Socket) => Promise<object>): void {
    if (this.sockets.size >= 64) { s.destroy(); return; }
    this.sockets.add(s);
    let buffer = "", bytes = 0;
    const controller = new AbortController();
    const end = () => { controller.abort(); s.destroy(); };
    const deadline = setTimeout(end, HARNESS_LIMITS.wait_seconds * 1000 + 50);
    const header = setTimeout(end, 2000);
    s.on("error", end);
    s.once("close", () => { controller.abort(); clearTimeout(deadline); clearTimeout(header); this.sockets.delete(s); });
    s.setEncoding("utf8");
    const data = (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) { end(); return; }
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      clearTimeout(header); s.off("data", data);
      if (this.active >= 32) { s.end(`${JSON.stringify(refuse("rate_limited", "Too many active calls."))}\n`); return; }
      let request: unknown;
      try { request = JSON.parse(buffer.slice(0, at)); } catch { s.end(`${JSON.stringify(refuse("bad_request", "Invalid JSON."))}\n`); return; }
      buffer = ""; this.active++;
      void call(request, controller.signal, s).catch(() => refuse("unavailable", "The requested session is unavailable.")).then(reply => {
        if (controller.signal.aborted) return;
        const text = JSON.stringify(reply);
        s.end(`${Buffer.byteLength(text) <= 262144 ? text : JSON.stringify(refuse("unavailable", "This response is too large."))}\n`);
      }).finally(() => this.active--);
    };
    s.on("data", data);
  }
}
