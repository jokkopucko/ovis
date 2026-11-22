/**
 * The sessions Resume started a moment ago (lib/sessionHistory.ts RecentResume), kept by App for as
 * long as they stand: across the session list's openings, so a list reopened before herdr has
 * reported the new pane's session offers Open (the new pane) and not a second Resume.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { observeRecentResume, recentResumeEnded, type RecentResume } from "./sessionHistory.ts";

interface RosteredMachine { id: string; snapshot?: { panes: readonly HerdrPane[] } | null }

export function useRecentResumes(machines: readonly RosteredMachine[]): {
  standing: readonly RecentResume[];
  remember: (record: Omit<RecentResume, "at" | "seen" | "ran">) => void;
} {
  const [records, setRecords] = useState<readonly RecentResume[]>([]);
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const panesOf = useCallback((machineId: string) => machinesRef.current.find((machine) => machine.id === machineId)?.snapshot?.panes, []);
  useEffect(() => {
    setRecords((current) => {
      if (current.length === 0) return current;
      const now = Date.now();
      let changed = false;
      const next = current.flatMap((record) => {
        const panes = panesOf(record.machineId);
        const observed = observeRecentResume(record, panes);
        if (observed !== record) changed = true;
        if (recentResumeEnded(observed, panes, now)) { changed = true; return []; }
        return [observed];
      });
      return changed ? next : current;
    });
  }, [machines, panesOf]);
  const remember = useCallback((record: Omit<RecentResume, "at" | "seen" | "ran">) => {
    const now = Date.now();
    setRecords((current) => [
      ...current.filter((kept) => !(kept.machineId === record.machineId && kept.workspaceId === record.workspaceId && kept.agent === record.agent && kept.id === record.id && (kept.store ?? "") === (record.store ?? "")) && !recentResumeEnded(kept, panesOf(kept.machineId), now)),
      observeRecentResume({ ...record, at: now, seen: false }, panesOf(record.machineId)),
    ]);
  }, [panesOf]);
  const standing = useMemo(() => {
    const now = Date.now();
    return records.filter((record) => !recentResumeEnded(record, panesOf(record.machineId), now));
  }, [records, panesOf]);
  return { standing, remember };
}
