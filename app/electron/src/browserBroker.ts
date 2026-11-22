/**
 * The agents' way into the built-in browser (shared/browser-broker.ts): a socket of this PC that
 * answers the Ovis-defined tools, each on the calling pane's own agent tabs only. A call names its
 * pane's token, which is checked against the token files on every call, so a token removed (the
 * pane ended, the setting turned off) stops working at once. No port is opened, and nothing of the
 * browser's own debugging protocol is reachable from it.
 */
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { BROWSER_TOKEN_FILE, MAX_BROWSER_LINE, type BrowserAnswer, type BrowserContent, type BrowserRequest } from "../../../shared/browser-broker.ts";
import { clickRef, snapshot, typeRef } from "./browserAgent.ts";
import type { BrowserTabs } from "./browserTabs.ts";

/**
 * Where the socket is: a unix socket in a folder only the user can open. None on Windows: a named pipe Node
 * makes takes remote clients too (it cannot ask for PIPE_REJECT_REMOTE_CLIENTS), so agents have no way in there yet.
 */
export function brokerPath(userData: string, platform: string): string | null {
  return platform === "win32" ? null : join(userData, "browser", "broker.sock");
}

/** the pane whose token file holds `token`, read now */
export function tokenOwner(tokensDir: string, token: string): string | null {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
  const given = Buffer.from(token);
  let names: string[];
  try {
    names = readdirSync(tokensDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const pane = BROWSER_TOKEN_FILE.exec(name)?.[1];
    if (pane === undefined) continue;
    let held: Buffer;
    try {
      held = Buffer.from(readFileSync(join(tokensDir, name), "utf8").trim());
    } catch {
      continue;
    }
    if (held.length === given.length && timingSafeEqual(held, given)) return pane;
  }
  return null;
}

const text = (words: string): BrowserContent[] => [{ type: "text", text: words }];
const number = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export class BrowserBroker {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  constructor(private tabs: () => BrowserTabs | null, private tokensDir: string, private path: string) {}

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    chmodSync(join(this.path, ".."), 0o700);
    rmSync(this.path, { force: true });
    const server = createServer((socket) => this.serve(socket));
    this.server = server;
    await new Promise<void>((listening, failed) => {
      server.once("error", failed);
      server.listen(this.path, () => {
        server.off("error", failed);
        listening();
      });
    });
    chmodSync(this.path, 0o600);
  }

  /**
   * Closes the socket and every connection, and removes every pane's token unless `keepTokens`: the
   * app quitting leaves its agents running in the core, and their tokens serve again once it is back.
   */
  stop(keepTokens = false): void {
    this.server?.close();
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    rmSync(this.path, { force: true });
    if (keepTokens) return;
    try {
      for (const name of readdirSync(this.tokensDir)) if (BROWSER_TOKEN_FILE.test(name)) rmSync(join(this.tokensDir, name), { force: true });
    } catch {}
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > MAX_BROWSER_LINE && !buffered.includes("\n")) return socket.destroy();
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        void this.answer(line).then((answer) => { if (answer && !socket.destroyed) socket.write(`${JSON.stringify(answer)}\n`); });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async answer(line: string): Promise<BrowserAnswer | null> {
    let request: BrowserRequest;
    try {
      request = JSON.parse(line) as BrowserRequest;
    } catch {
      return null;
    }
    if (typeof request !== "object" || request === null || typeof request.id !== "number") return null;
    const owner = typeof request.token === "string" ? tokenOwner(this.tokensDir, request.token) : null;
    const tabs = this.tabs();
    if (owner === null || tabs === null) return { id: request.id, content: text("The Ovis built-in browser is not open to this agent."), isError: true };
    try {
      const args = typeof request.args === "object" && request.args !== null ? request.args : {};
      const content = await this.run(tabs, owner, String(request.tool), args);
      return typeof content === "string" ? { id: request.id, content: text(content), isError: true } : { id: request.id, content };
    } catch (error) {
      return { id: request.id, content: text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  }

  /** a tool's answer, or the words of why it did nothing */
  private async run(tabs: BrowserTabs, owner: string, tool: string, args: Record<string, unknown>): Promise<BrowserContent[] | string> {
    if (tool === "browser_open") {
      if (typeof args["url"] !== "string") return "browser_open needs a url.";
      const id = await tabs.openFor(owner, args["url"]);
      if (id === null) return "That address was not opened: it is blocked, not a web address, failed to load, or you have the most tabs there may be.";
      return text(JSON.stringify(tabs.ownTabs(owner).find((tab) => tab.id === id)));
    }
    if (tool === "browser_tabs") return text(JSON.stringify(tabs.ownTabs(owner).map(({ id, address, title, held }) => ({ id, address, title, held }))));
    const id = number(args["tab"]);
    if (id === null) return `${tool} needs the tab's id.`;
    const tab = tabs.agentTab(owner, id);
    if (typeof tab === "string") return tab;
    switch (tool) {
      case "browser_navigate":
        if (typeof args["url"] !== "string") return "browser_navigate needs a url.";
        return tabs.navigate(id, args["url"]) ? text("Loading.") : "That address is blocked or is not a web address.";
      case "browser_snapshot":
        return text(await snapshot(tab.contents, tab.address));
      case "browser_click": {
        const ref = typeof args["ref"] === "string" ? args["ref"] : null;
        const may = () => typeof tabs.agentTab(owner, id) !== "string";
        if (ref !== null && await clickRef(tab.contents, ref, may)) return text("Clicked.");
        const now = tabs.agentTab(owner, id);
        return typeof now === "string" ? now : "No such element: take a new browser_snapshot.";
      }
      case "browser_type": {
        const ref = typeof args["ref"] === "string" ? args["ref"] : null;
        if (typeof args["text"] !== "string") return "browser_type needs the text.";
        const may = () => typeof tabs.agentTab(owner, id) !== "string";
        if (ref !== null && await typeRef(tab.contents, ref, args["text"], args["submit"] === true, may)) return text("Typed.");
        const now = tabs.agentTab(owner, id);
        return typeof now === "string" ? now : "No such element to type in: take a new browser_snapshot.";
      }
      case "browser_screenshot": {
        if (!tab.shown) return "The tab is not on the user's screen, so it has no picture: use browser_snapshot to read it.";
        const image = await tab.contents.capturePage();
        return [{ type: "image", data: image.toPNG().toString("base64"), mimeType: "image/png" }];
      }
      case "browser_close":
        tabs.close(id);
        return text("Closed.");
      default:
        return `No tool named ${tool}.`;
    }
  }
}
