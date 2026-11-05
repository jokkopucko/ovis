/**
 * GET /api/pane/artifacts: the pages a Claude Code pane's session published with its `Artifact`
 * tool, read back from the session's transcript for the composer's artifacts chip. Nothing new is
 * asked of Claude: the answer to a publish names the page (`toolUseResult.url` and `title`), and an
 * answer written without that record still names its URL in its text. Each page is listed once, by
 * its claude.ai URL (a republish keeps the URL), with the title and time of its latest publish,
 * newest first. Calls that read, list or open a page, a quickstart and an asset upload publish
 * nothing and are not taken; neither is a call that failed. The transcripts of subagents are not read.
 * A transcript is read from its start once, then only what was appended. The dispatcher in index.ts
 * runs the access gate first.
 */
import { basename } from "node:path";
import type { ClaudeArtifact } from "../shared/protocol.ts";
import { type ClaudeSubagentStatus, plain, readLines, remember, within } from "./claude-subagents.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";

const LINE_BUDGET = 8 * 1024 * 1024;
const MAX_FILES = 64;
const MAX_ARTIFACTS = 100;
/** a page's address: the only links the list gives, so a transcript can never make it link anywhere else */
const PAGE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/;

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
/** a tool answer's whole text, where its link can come after a long path: a string, or its text blocks */
const said = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => { const text = row(part)?.["text"]; return typeof text === "string" ? text : ""; }).join("\n") : "";

interface Read {
  id: string;
  offset: number;
  skipping: boolean;
  /** publish calls still waiting for their answer, by tool_use id: the published file's name */
  calls: Map<string, string | null>;
  /** by URL, oldest publish first */
  pages: Map<string, ClaudeArtifact>;
}
const reads = new Map<string, Read>();

/** The pages the transcript at `path` published, newest first. */
export function claudeArtifacts(path: string): ClaudeArtifact[] {
  const stat = plain(path);
  if (stat === null) return [];
  let read = reads.get(path);
  if (!read || read.id !== stat.id || read.offset > stat.size) read = { id: stat.id, offset: 0, skipping: false, calls: new Map(), pages: new Map() };
  remember(reads, path, read, MAX_FILES);
  const state = read;
  while (state.offset < stat.size) {
    const done = readLines(path, state.offset, stat.size, LINE_BUDGET, (line) => artifactLine(state, line), state.skipping);
    // a failed read is tried again at the next ask; what is left unread is a line still being written
    if (done.failed || done.offset === state.offset) break;
    state.offset = done.offset;
    state.skipping = done.skipping;
    if (!done.more) break;
  }
  return [...state.pages.values()].reverse();
}

/** Forgets every read (tests). */
export function forgetArtifacts(): void {
  reads.clear();
}

function artifactLine(read: Read, line: string): void {
  if (!line.includes('"name":"Artifact"') && !(read.calls.size > 0 && line.includes('"tool_result"'))) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const content = row(entry?.["message"])?.["content"];
  if (entry === null || !Array.isArray(content)) return;
  for (const value of content) {
    const block = row(value);
    if (block === null) continue;
    if (block["type"] === "tool_use" && block["name"] === "Artifact" && typeof block["id"] === "string") {
      const input = row(block["input"]) ?? {};
      // the name is taken from the whole path, never one cut to a title's length
      const file = typeof input["file_path"] === "string" ? words(basename(input["file_path"])) : null;
      if ((input["action"] ?? "publish") === "publish" && input["asset"] !== true) read.calls.set(block["id"], file);
      continue;
    }
    if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string" || !read.calls.has(block["tool_use_id"])) continue;
    const file = read.calls.get(block["tool_use_id"]) ?? null;
    read.calls.delete(block["tool_use_id"]);
    if (block["is_error"] === true) continue;
    const answer = row(entry["toolUseResult"]);
    const url = (typeof answer?.["url"] === "string" ? answer["url"].match(PAGE)?.[0] : undefined) ?? said(block["content"]).match(PAGE)?.[0];
    if (url === undefined) continue;
    const at = typeof entry["timestamp"] === "string" && Number.isFinite(Date.parse(entry["timestamp"])) ? new Date(entry["timestamp"]).toISOString() : null;
    remember(read.pages, url, { url, title: words(answer?.["title"]) ?? read.pages.get(url)?.title ?? file, at }, MAX_ARTIFACTS);
  }
  if (read.calls.size > MAX_ARTIFACTS) read.calls.clear();
}

/** The core's own tracker: the route reads it and never makes its own. */
export type ArtifactTrackers = { claudeAgents: Pick<ClaudeSubagentStatus, "sessionOf" | "ensure"> };

/** The answer for the artifacts route, or null when the path is not it. */
export async function handleArtifactsRequest(request: Request, url: URL, pathname: string, { claudeAgents }: ArtifactTrackers): Promise<Response | null> {
  if (pathname !== "/api/pane/artifacts") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  // the pane as herdr has it now, for a second at most: a session the background lookup has not got to yet, or
  // another one the pane runs since, is looked up here, as for a subagent's detail (background-agent.ts).
  // A pane herdr did not answer for in time, or that runs another agent, is told none
  const seen: { pane?: Awaited<ReturnType<typeof paneGet>> } = {};
  await within(1000, (async () => {
    const pane = seen.pane = await paneGet(paneId);
    if (pane.agent === "claude") await claudeAgents.ensure(pane);
  })());
  const claude = seen.pane?.agent === "claude" ? claudeAgents.sessionOf(paneId) : null;
  return jsonResponse({ artifacts: claude === null ? [] : claudeArtifacts(claude.path) });
}
