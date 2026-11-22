import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_TOOLS } from "../shared/browser-broker.ts";
import { brokerOptions, handle } from "./browser-mcp.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(): { socket: string; tokenFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "ovis-browser-mcp-"));
  dirs.push(dir);
  return { socket: join(dir, "broker.sock"), tokenFile: join(dir, "pane.token") };
}

/** a broker that answers every line with what it was sent */
async function echoBroker(socket: string, seen: unknown[]): Promise<void> {
  const server = createServer((connection) => {
    connection.setEncoding("utf8");
    connection.on("data", (line: string) => {
      const request = JSON.parse(line.trim()) as { id: number };
      seen.push(request);
      connection.write(`${JSON.stringify({ id: request.id, content: [{ type: "text", text: "done" }] })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(socket, listening));
}

describe("the built-in browser's MCP server", () => {
  it("needs the socket and the token file", () => {
    expect(brokerOptions(["--socket", "/s", "--token-file", "/t"])).toEqual({ socket: "/s", tokenFile: "/t" });
    expect(brokerOptions(["--socket", "/s"])).toBeNull();
    expect(brokerOptions(["--socket", "", "--token-file", "/t"])).toBeNull();
  });

  it("offers only the Ovis-defined tools", async () => {
    const options = place();
    expect(await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, options)).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, options)).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: BROWSER_TOOLS } });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "evaluate", arguments: {} } }, options)).toMatchObject({ id: 3, error: { code: -32602 } });
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, options)).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }, options)).toMatchObject({ id: 4, error: { code: -32601 } });
  });

  it("passes a call to the app with the token its file holds now", async () => {
    const options = place();
    const seen: unknown[] = [];
    await echoBroker(options.socket, seen);
    writeFileSync(options.tokenFile, "first-token-0123456789abcdef0123456789\n");
    expect(await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browser_tabs", arguments: {} } }, options)).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "done" }] } });
    writeFileSync(options.tokenFile, "second-token-0123456789abcdef012345678");
    await handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "browser_open", arguments: { url: "https://site.example/" } } }, options);
    expect(seen).toMatchObject([
      { token: "first-token-0123456789abcdef0123456789", tool: "browser_tabs", args: {} },
      { token: "second-token-0123456789abcdef012345678", tool: "browser_open", args: { url: "https://site.example/" } },
    ]);
  });

  it("ends a call the app closes without answering, at once", async () => {
    const options = place();
    writeFileSync(options.tokenFile, "a-token-0123456789abcdef0123456789abcdef");
    const server = createServer((connection) => connection.once("data", () => connection.end()));
    servers.push(server);
    await new Promise<void>((listening) => server.listen(options.socket, listening));
    const answer = await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_tabs", arguments: {} } }, options);
    expect(answer).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("closed the connection") }] } });
  });

  it("says so when the token is gone or the app is not there", async () => {
    const options = place();
    const call = { jsonrpc: "2.0" as const, id: 7, method: "tools/call", params: { name: "browser_tabs", arguments: {} } };
    expect(await handle(call, options)).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("token is gone") }] } });
    writeFileSync(options.tokenFile, "a-token-0123456789abcdef0123456789abcdef");
    expect(await handle(call, options)).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("not running") }] } });
  });
});
