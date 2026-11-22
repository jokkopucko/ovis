import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Machine } from "../../shared/machines.ts";
import { advanceStateStamps, loadStateStamps, saveStateStamps, stateLooks, type LastLook, type StateStamps } from "./agentStateSince.ts";
import { stateWatch, type UnseenLook } from "./agentStateWatch.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

const NONE: StateStamps = {};
let published: StateStamps = NONE;
const listeners = new Set<() => void>();

function publish(stamps: StateStamps): void {
  if (stamps === published) return;
  published = stamps;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const current = (): StateStamps => published;

export function useAgentStateStamps(): StateStamps {
  return useSyncExternalStore(subscribe, current, current);
}

export function useAgentStateStamping(machines: readonly Machine[], activity: SidebarActivity): void {
  const looks = useMemo(() => stateLooks(machines, (machineId, pane) => activity.status(machineId, pane)), [machines, activity]);
  const signature = useMemo(() => looks.map((look) => `${look.id}|${look.lifetime ?? ""}|${look.epoch ?? ""}|${look.rows === null ? "-" : look.rows.map((row) => `${row.pane}@${row.terminal}=${row.state}${row.done ? "!" : ""}${row.wait ? "~" : ""}${row.own ? "*" : ""}#${row.seq ?? ""}/${row.finish ?? ""}`).join(",")}`).join("\n"), [looks]);
  const latest = useRef(looks);
  latest.current = looks;
  const [unseen, setUnseen] = useState<{ round: number; look: UnseenLook }>({ round: 0, look: "first" });
  const carried = useRef<{ own: StateStamps; last: LastLook; kept: boolean; round: number; shown: StateStamps } | null>(null);
  useLayoutEffect(() => {
    const page = carried.current ??= { own: loadStateStamps() ?? NONE, last: new Map(), kept: true, round: unseen.round, shown: NONE };
    // a roster of no PC is the loader's before the first one has come (a roster always has this PC): there is nothing
    // to look at yet, and a look at no PC would mark every kept stamp as its PC's having left the roster, for the
    // device's other tabs to read
    if (latest.current.length === 0) return;
    const told = page.round !== unseen.round ? unseen.look : null;
    page.round = unseen.round;
    if (told === "first" || stateWatch.blind()) page.last = new Map();
    const before = (page.kept ? loadStateStamps() : null) ?? page.own;
    const next = advanceStateStamps({ stamps: before, last: page.last }, latest.current, Date.now(), told !== "undated");
    if (next.stamps !== before) page.kept = saveStateStamps(next.stamps);
    page.own = next.stamps;
    page.last = next.last;
    const judged = latest.current.flatMap((look) => { const pc = look.rows === null ? undefined : next.stamps[look.id]; return pc === undefined ? [] : [[look.id, pc] as const]; });
    if (judged.length !== Object.keys(page.shown).length || judged.some(([id, pc]) => page.shown[id] !== pc)) page.shown = Object.fromEntries(judged);
    publish(page.shown);
  }, [signature, unseen]);
  useEffect(() => {
    const end = stateWatch.keep((look) => setUnseen((last) => ({ round: last.round + 1, look })));
    return () => { end(); publish(NONE); };
  }, []);
}
