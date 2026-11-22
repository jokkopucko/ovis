/**
 * How an agent reaches the desktop app's built-in browser: never its debugging port, only these tools,
 * which the app runs on that agent's own tabs (app/electron/src/browserBroker.ts). The agent runs
 * `ovis-server browser-mcp` (server/browser-mcp.ts), an MCP server that passes each call to the app
 * over a unix socket of this PC with the pane's token (none on Windows yet: app/electron/src/browserBroker.ts brokerPath): one line of
 * JSON per request and per answer. A token is a file only the user can read in the server's state
 * folder (`browser-tokens/<pane>.token`); the app takes a call only while that file holds it.
 */

export const BROWSER_TOKENS_DIR = "browser-tokens";
/** a pane's token file name, without the folder: letters, digits, `-` and `_` */
export const BROWSER_TOKEN_FILE = /^([A-Za-z0-9_-]{1,120})\.token$/;
export const MAX_BROWSER_LINE = 64 * 1024;

export interface BrowserToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string; description: string }>; required?: string[] };
}

const TAB = { type: "number", description: "The tab's id, from browser_open or browser_tabs." };
const REF = { type: "string", description: "An element's ref from the tab's latest browser_snapshot, such as @e3." };

export const BROWSER_TOOLS: readonly BrowserToolDef[] = [
  { name: "browser_open", description: "Open an http(s) address in a new tab of your own in the Ovis built-in browser. Sites the user blocked and Ovis's own addresses are refused.", inputSchema: { type: "object", properties: { url: { type: "string", description: "The address to open." } }, required: ["url"] } },
  { name: "browser_tabs", description: "List your tabs: id, address (without its query), title, and whether the user has taken control of it.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_navigate", description: "Load another http(s) address in one of your tabs.", inputSchema: { type: "object", properties: { tab: TAB, url: { type: "string", description: "The address to load." } }, required: ["tab", "url"] } },
  { name: "browser_snapshot", description: "Read a tab from its accessibility tree: title, address, landmarks, headings, text and the elements you can act on, each with a ref (@e1, @e2, ...). No field's value is ever shown, a password's included.", inputSchema: { type: "object", properties: { tab: TAB }, required: ["tab"] } },
  { name: "browser_click", description: "Click an element of a tab by its ref.", inputSchema: { type: "object", properties: { tab: TAB, ref: REF }, required: ["tab", "ref"] } },
  { name: "browser_type", description: "Type text into an element of a tab by its ref, replacing what it holds; submit presses Enter after.", inputSchema: { type: "object", properties: { tab: TAB, ref: REF, text: { type: "string", description: "The text to type." }, submit: { type: "boolean", description: "Press Enter after typing." } }, required: ["tab", "ref", "text"] } },
  { name: "browser_screenshot", description: "A picture of a tab as it is drawn (PNG). Works while the tab is on the user's screen.", inputSchema: { type: "object", properties: { tab: TAB }, required: ["tab"] } },
  { name: "browser_close", description: "Close one of your tabs.", inputSchema: { type: "object", properties: { tab: TAB }, required: ["tab"] } },
];

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]["name"];

export interface BrowserRequest {
  id: number;
  token: string;
  tool: string;
  args: Record<string, unknown>;
}

export type BrowserContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" };

export interface BrowserAnswer {
  id: number;
  content: BrowserContent[];
  isError?: true;
}
