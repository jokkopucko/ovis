/**
 * `ovis-server browser-mcp --socket <path> --token-file <path>`: the MCP server (stdio, one JSON-RPC
 * message per line) an agent runs to use the desktop app's built-in browser. It offers only the
 * tools of shared/browser-broker.ts and passes each call to the app's socket with the pane's token,
 * read from its file on every call; it holds no browser and no state of its own.
 */
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { BROWSER_TOOLS, type BrowserAnswer } from "../shared/browser-broker.ts";

const PROTOCOL = "2025-06-18";
const CALL_TIMEOUT_MS = 120_000;

interface Message {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function brokerOptions(argv: readonly string[]): { socket: string; tokenFile: string } | null {
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 && typeof argv[at + 1] === "string" && argv[at + 1] !== "" ? argv[at + 1]! : null;
  };
  const socket = value("--socket"), tokenFile = value("--token-file");
  return socket === null || tokenFile === null ? null : { socket, tokenFile };
}

let nextId = 1;

/** One call on its own connection: the app answers it, or the call fails with words the agent reads. */
export function callBroker(socket: string, tokenFile: string, tool: string, args: Record<string, unknown>): Promise<Omit<BrowserAnswer, "id">> {
  const failed = (words: string): Omit<BrowserAnswer, "id"> => ({ content: [{ type: "text", text: words }], isError: true });
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return Promise.resolve(failed("The Ovis built-in browser is not open to this agent (its token is gone)."));
  }
  const id = nextId++;
  return new Promise((settle) => {
    const connection = connect(socket);
    let buffered = "";
    const timer = setTimeout(() => { connection.destroy(); settle(failed("The Ovis desktop app did not answer.")); }, CALL_TIMEOUT_MS);
    let answered = false;
    const done = (answer: Omit<BrowserAnswer, "id">) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      connection.end();
      settle(answer);
    };
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${JSON.stringify({ id, token, tool, args })}\n`));
    connection.on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      try {
        const answer = JSON.parse(buffered.slice(0, end)) as BrowserAnswer;
        done({ content: answer.content, ...(answer.isError ? { isError: true as const } : {}) });
      } catch {
        done(failed("The Ovis desktop app gave an answer that could not be read."));
      }
    });
    connection.on("error", () => done(failed("The Ovis desktop app is not running, or its built-in browser is off.")));
    // the app quit or its built-in browser was turned off before it answered
    connection.on("close", () => done(failed("The Ovis desktop app closed the connection before it answered.")));
  });
}

export async function handle(message: Message, options: { socket: string; tokenFile: string }): Promise<object | null> {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id ?? null, result });
  switch (message.method) {
    case "initialize":
      // the one version this server implements (2025-03-26 would need JSON-RPC batches): a client asking another gets it offered
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "ovis-browser", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: BROWSER_TOOLS });
    case "tools/call": {
      const name = message.params?.["name"];
      const args = message.params?.["arguments"];
      if (typeof name !== "string" || !BROWSER_TOOLS.some((tool) => tool.name === name)) return { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32602, message: `No tool named ${String(name)}` } };
      return reply(await callBroker(options.socket, options.tokenFile, name, typeof args === "object" && args !== null ? args as Record<string, unknown> : {}));
    }
    default:
      return message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

export function runBrowserMcp(argv = process.argv.slice(2)): void {
  const options = brokerOptions(argv);
  if (options === null) {
    console.error("usage: ovis-server browser-mcp --socket <path> --token-file <path>");
    process.exit(2);
  }
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return;
    }
    void handle(message, options).then((answer) => { if (answer !== null) process.stdout.write(`${JSON.stringify(answer)}\n`); });
  });
  lines.on("close", () => process.exit(0));
}

// run from its own file (from source, server/entries.ts entryCommand); the compiled binary runs it through server/main.ts
if (import.meta.main) runBrowserMcp();
