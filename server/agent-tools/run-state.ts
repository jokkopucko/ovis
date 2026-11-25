import { rmSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_LIMITS, isRecord } from "../../shared/harness-tool.ts";
import { readStateDocument, writeStateDocument } from "../state-document.ts";
import type { PaneKey } from "./pane-proof.ts";

export interface Run {
  readonly id: string;
  readonly self: string;
  readonly depth: number;
  readonly started_by: string | null;
  readonly root: string;
  readonly harness: string;
  readonly created_ms: number;
}
export interface RunState { readonly run: Run; readonly starts?: readonly { key: string; run: string }[]; readonly calls?: readonly number[] }
export interface Saved extends RunState { readonly hash: string; readonly foreground?: { pid: number; birth: string } }
export interface PaneSaved extends RunState { readonly key: PaneKey; readonly epoch?: string }
export const idPattern = /^[a-f0-9]{16}$/;
export const paneRegistry = (dir: string): string => join(dir, "pane-runs.json");

function runState(value: unknown): value is RunState {
  if (!isRecord(value)) return false;
  if ("starts" in value && (!Array.isArray(value.starts) || !value.starts.every(s => isRecord(s) && typeof s.key === "string" && typeof s.run === "string" && idPattern.test(s.run)))) return false;
  if ("calls" in value && (!Array.isArray(value.calls) || value.calls.length > HARNESS_LIMITS.calls_per_minute || !value.calls.every(Number.isFinite))) return false;
  const r = value.run;
  return isRecord(r) && typeof r.id === "string" && idPattern.test(r.id) && typeof r.root === "string" && idPattern.test(r.root)
    && (r.started_by === null || typeof r.started_by === "string" && idPattern.test(r.started_by))
    && typeof r.self === "string" && typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0 && r.depth <= 3
    && typeof r.created_ms === "number" && Number.isFinite(r.created_ms) && typeof r.harness === "string";
}

function saved(value: unknown): value is Saved {
  return runState(value) && "hash" in value && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash);
}

function readRows(path: string): readonly unknown[] | null {
  try {
    const read = readStateDocument(path);
    if (read.kind === "json" && Array.isArray(read.value)) return read.value;
    if (read.kind === "missing") return [];
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("Agent tool: could not read run registry; existing credentials will not be accepted.");
    return null;
  }
  console.warn("Agent tool: unreadable run registry; existing credentials will not be accepted.");
  return [];
}

export function readTokenRuns(dir: string): readonly Saved[] {
  const rows = readRows(join(dir, "runs.json"));
  return rows?.every(saved) ? rows : [];
}

function paneKey(value: unknown): value is PaneKey {
  return isRecord(value) && typeof value.pane === "string" && typeof value.created_ms === "number" && Number.isFinite(value.created_ms)
    && typeof value.root === "number" && Number.isInteger(value.root) && value.root > 0 && typeof value.birth === "string";
}

export function readPaneRuns(dir: string, epoch: string | null): readonly PaneSaved[] {
  const file = paneRegistry(dir);
  const stored = readRows(file);
  if (!stored) return [];
  const rows: PaneSaved[] = [];
  const oldRows: RunState[] = [];
  for (const value of stored) {
    if (!runState(value)) continue;
    const { run } = value;
    if (run.harness !== "hc-pane" || run.depth !== 0 || run.started_by !== null || run.root !== run.id) continue;
    const storedEpoch = "epoch" in value ? value.epoch : null;
    if (storedEpoch !== epoch) continue;
    if ("key" in value) {
      if (paneKey(value.key) && value.key.pane === run.self) rows.push({ ...value, key: value.key, ...(epoch === null ? {} : { epoch }) });
    } else if (epoch === null) oldRows.push(value);
  }

  const legacyFile = join(dir, "pane-grants.json");
  try {
    const old = readStateDocument(legacyFile);
    if (old.kind === "missing") return rows;
    const before = rows.length;
    if (oldRows.length > 0 && old.kind === "json" && Array.isArray(old.value)) {
      const proofs = new Map<string, PaneKey>();
      for (const grant of old.value) {
        if (isRecord(grant) && grant.state === "allowed" && typeof grant.run === "string" && paneKey(grant.key)) proofs.set(grant.run, grant.key);
      }
      for (const row of oldRows) {
        const key = proofs.get(row.run.id);
        if (key?.pane === row.run.self) rows.push({ ...row, key });
      }
    }
    // Keep the only copy of the proof until the combined record is on disk.
    if (rows.length > before) writeStateDocument(file, JSON.stringify(rows), false);
    rmSync(legacyFile, { force: true });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("Agent tool: could not finish migrating the old pane registry; it will be retried at startup.");
  }
  return rows;
}
