/**
 * An account's plan limits as another tool on this PC recorded them for its own sign-in. This server reads that
 * record and never that sign-in: no token of the tool is read, nothing is asked of a provider in its name, and its
 * store is only read. A tool that keeps no record of the limits gives no account here: an account only it is signed
 * in to is then one this server cannot show.
 */
import type { ProviderUsage, UsageProviderId, UsageRecorded, UsageRecorder, UsageWindow } from "../shared/protocol.ts";
import type { UsageContext } from "./usage.ts";

export type RecordedContext = Pick<UsageContext, "home" | "env" | "platform" | "now">;

export interface RecordedWindow {
  readonly kind: UsageWindow["kind"];
  readonly scope: string | null;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly seconds: number;
}

export interface RecordedReading {
  readonly accountId: string;
  readonly label: string | null;
  readonly readAt: number;
  readonly windows: readonly RecordedWindow[];
}

export interface RecordedSource {
  readonly by: UsageRecorder;
  readonly staleAfterMs: number;
  read(ctx: RecordedContext): RecordedReading[];
}

export type RecordedUsage = ProviderUsage & { readonly checked_at: string; readonly recorded: UsageRecorded };

const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

function current(window: RecordedWindow, readAt: number, now: number): UsageWindow | null {
  const length = window.seconds * 1000;
  if (window.resetsAt === null ? now - readAt >= length : window.resetsAt <= now) return null;
  return {
    kind: window.kind, scope: window.scope, used_percent: percent(window.usedPercent),
    resets_at: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
    starts_at: window.resetsAt === null ? null : new Date(window.resetsAt - length).toISOString(),
  };
}

/** Each is given as known from its record alone (`signed_in` false): whether this PC also signs in to it is the caller's to say. */
export function recordedUsages(provider: UsageProviderId, sources: readonly RecordedSource[], ctx: RecordedContext,
  read: (source: RecordedSource) => RecordedReading[] = (source) => source.read(ctx)): RecordedUsage[] {
  const now = ctx.now();
  const latest = new Map<string, RecordedUsage>();
  for (const source of sources) {
    let readings: RecordedReading[];
    try {
      readings = read(source);
    } catch (error) {
      console.warn(`usage: ${source.by}'s record could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const reading of readings) {
      const windows = reading.windows.flatMap((window) => current(window, reading.readAt, now) ?? []);
      if (windows.length === 0) continue;
      const key = `${provider}:${reading.accountId}`;
      const held = latest.get(key);
      if (held && Date.parse(held.checked_at) >= reading.readAt) continue;
      latest.set(key, {
        id: provider, key, account: reading.label, plan: null, windows, problem: null,
        checked_at: new Date(reading.readAt).toISOString(), recorded: { by: source.by, stale: now - reading.readAt > source.staleAfterMs, signed_in: false },
      });
    }
  }
  return [...latest.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
