import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { opencodeSessionVersion } from "./opencode.ts";

/**
 * The version of the agent that wrote a pane's session, read from the agent's own store, never by
 * running the agent. Claude and Codex keep it in their transcript JSONL, OpenCode in its session
 * row; every other agent keeps none, so its commands stay unverified (null).
 */

/** At most this much of a transcript is read: its start for Codex, its end for Claude. */
export const VERSION_WINDOW_BYTES = 64 * 1024;

export interface ByteReader {
  size(path: string): number;
  read(path: string, position: number, length: number): Uint8Array;
}

export const fileReader: ByteReader = {
  size(path) {
    const fd = openSync(path, "r");
    try { return fstatSync(fd).size; } finally { closeSync(fd); }
  },
  read(path, position, length) {
    const fd = openSync(path, "r");
    try {
      const buffer = new Uint8Array(length);
      return buffer.subarray(0, readSync(fd, buffer, 0, length, position));
    } finally { closeSync(fd); }
  },
};

export interface VersionSource {
  path: string;
  sessionId?: string | null;
}

const VERSION = /^\d+\.\d+/;

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

const versionOf = (value: unknown): string | null => typeof value === "string" && VERSION.test(value) ? value : null;

/** Codex: `payload.cli_version` of the `session_meta` record, the rollout's first line. */
function codexVersion(path: string, reader: ByteReader): string | null {
  const bytes = reader.read(path, 0, Math.min(VERSION_WINDOW_BYTES, reader.size(path)));
  const text = new TextDecoder().decode(bytes);
  const end = text.indexOf("\n");
  if (end === -1 && bytes.length === VERSION_WINDOW_BYTES) return truncatedCodexVersion(text);
  const record = parse(end === -1 ? text : text.slice(0, end));
  if (record?.type !== "session_meta") return null;
  const payload = record.payload;
  return payload !== null && typeof payload === "object" ? versionOf((payload as Record<string, unknown>).cli_version) : null;
}

/**
 * A `session_meta` line longer than the window (Codex embeds its instructions in it) cannot be
 * parsed, but Codex writes `cli_version` before those instructions: read it from the record's head.
 */
function truncatedCodexVersion(text: string): string | null {
  const payload = text.indexOf('"payload":{');
  if (payload === -1 || !text.slice(0, payload).includes('"type":"session_meta"')) return null;
  return versionOf(/"cli_version":"([^"\\]*)"/.exec(text.slice(payload))?.[1]);
}

/** Claude: the `version` of the last record that carries one, within the transcript's last 64 KiB. */
function claudeVersion(path: string, reader: ByteReader): string | null {
  const size = reader.size(path);
  const start = Math.max(0, size - VERSION_WINDOW_BYTES);
  const lines = new TextDecoder().decode(reader.read(path, start, size - start)).split("\n");
  if (start > 0) lines.shift();
  for (let index = lines.length - 1; index >= 0; index--) {
    const version = versionOf(parse(lines[index]!)?.version);
    if (version !== null) return version;
  }
  return null;
}

export function storeAgentVersion(agent: string | null | undefined, source: VersionSource | null, reader: ByteReader = fileReader): string | null {
  if (source === null) return null;
  try {
    if (agent === "claude") return claudeVersion(source.path, reader);
    if (agent === "codex") return codexVersion(source.path, reader);
    if (agent === "opencode") return source.sessionId ? versionOf(opencodeSessionVersion(source.path, source.sessionId)) : null;
  } catch {
    return null;
  }
  return null;
}
