import { join } from "node:path";
import { LINE_BYTES, makeLineReader } from "../herdr/client.ts";
import { MAX_PINS, type PreferencesChange, type SharedPreferences } from "../../shared/preferences.ts";
import { readStateDocument, writeStateDocument } from "../state-document.ts";
import type { HcConnection } from "./connection.ts";
import { isRecord, onOtherMachine } from "./snapshot.ts";

/**
 * Pinned agents, shared by every Herdr client (herdr-app docs/labels.md): present and non-empty,
 * the terminal is pinned; written empty, it is not.
 */
export const PINNED_LABEL = "herdr.pinned";
/** How long a line to hc that ended waits before the bridge looks again. */
const REOPEN_MS = 1_000;
/** What both sides last agreed on per terminal, beside preferences.json. */
const AGREED_FILE = "herdr-core-pins.json";

type Hc = Pick<HcConnection, "call" | "open" | "hello">;
interface PinStore {
  get(): SharedPreferences;
  set(change: PreferencesChange): SharedPreferences;
  subscribe(listener: (preferences: SharedPreferences) => void): () => void;
}

/**
 * Keeps the Agents list's pins (the shared preferences' `pins`, `<pc>:<pane>` for an agent) and
 * herdr-core's `herdr.pinned` labels the same for this PC's terminals. For each terminal it
 * remembers, on disk, the pin both sides last agreed on: the side that differs from it changed
 * (the Herdr app's when both did), so a pin or unpin made on one side while the other was away,
 * or a label write that failed, is settled the next time both are seen. A terminal never agreed
 * on keeps a pin from either side. A pin made in the app joins the end of the list, as one made
 * in Ovis does. Workspace pins have no label and stay Ovis's own.
 */
export interface PinBridge {
  stop: () => void;
  /** settles once every label write asked for so far has been answered */
  idle: () => Promise<void>;
}

export function bridgePins(hc: Hc, store: PinStore, machineId: string, stateDir: string, reopenMs = REOPEN_MS): PinBridge {
  const agreedPath = join(stateDir, AGREED_FILE);
  /**
   * `<core id>/<terminal>` → the pin both sides last agreed on; `shells`, the agreed terminals seen
   * without an agent since, until an agent runs there again (kept on disk, as a restart may come between)
   */
  const { agreed, shells, pending } = readAgreed(agreedPath);
  /** each live terminal of the current core: whether its label says pinned, as last heard */
  const live = new Map<string, boolean>();
  /**
   * a pin or unpin of the Herdr app's that Ovis's list could not take (full, or not saved): no label
   * is written for it meanwhile, and it is tried again once the list changes
   */
  const refused = new Set<string>();
  /** pinned in the app but past a full list the bridge started: not unpinned for not being listed */
  const leftOut = new Set<string>();
  /** the agreed pins on disk are behind memory: the next agreement writes them, even an unchanged one */
  let unsaved = false;
  let core = "";
  const keyOf = (address: string) => `${machineId}:${address}`;
  const agreedKey = (address: string) => `${core}/${address}`;
  const listed = (address: string) => (store.get().pins ?? []).includes(keyOf(address));
  let stopped = false;
  let closeStream: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const saveAgreed = () => {
    try {
      writeStateDocument(agreedPath, `${JSON.stringify({ ...Object.fromEntries(agreed), [SHELLS]: [...shells], [PENDING]: [...pending] })}\n`, false);
      unsaved = false;
    } catch (error) {
      unsaved = true;
      console.warn(`herdr-core: could not save ${agreedPath}:`, error);
    }
  };
  const setAgreed = (address: string, pinned: boolean) => {
    const settled = pending.delete(agreedKey(address));
    if (agreed.get(agreedKey(address)) === pinned) {
      if (unsaved || settled) saveAgreed();
      return;
    }
    agreed.set(agreedKey(address), pinned);
    saveAgreed();
  };
  /** Ovis's list made to say `pinned`; false when it cannot hold another pin */
  const list = (address: string, pinned: boolean): boolean => {
    const pins = store.get().pins;
    const key = keyOf(address);
    if ((pins ?? []).includes(key) === pinned) return true;
    let next: string[];
    let over: string[] = [];
    if (!pinned) next = (pins ?? []).filter((pin) => pin !== key);
    else if (pins) {
      if (pins.length >= MAX_PINS) return false;
      next = [...pins, key];
    } else {
      // a list started here holds every agent pinned in the app, so none is then taken for an unpin
      const all = [...live].filter(([other, on]) => agents.has(other) && (on || other === address)).map(([other]) => other);
      over = all.slice(MAX_PINS);
      next = all.slice(0, MAX_PINS).map(keyOf);
      if (!next.includes(key)) return false;
    }
    for (const other of over) leftOut.add(other);
    try {
      store.set({ settings: {}, pins: next });
      return true;
    } catch (error) {
      for (const other of over) leftOut.delete(other);
      console.warn("herdr-core: could not keep a pin from the Herdr app:", error);
      return false;
    }
  };

  /** Each terminal's label writes in order, each one the pin wanted when its turn comes. */
  const writes = new Map<string, Promise<void>>();
  /** per terminal, the pins our label writes set, whose labels events have not come back yet */
  const echoes = new Map<string, { pinned: boolean; heard: boolean; answered: boolean }[]>();
  /** a write hc refused is tried again, waiting longer each time */
  const retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>();
  const retry = (address: string) => {
    const wait = Math.min((retries.get(address)?.wait ?? reopenMs / 2) * 2, 30_000);
    clearTimeout(retries.get(address)?.timer);
    retries.set(address, { wait, timer: setTimeout(() => writeLabel(address), wait) });
  };
  const writeLabel = (address: string) => {
    const run = (writes.get(address) ?? Promise.resolve()).then(async () => {
      // no browser has shared its pins yet: not being listed is no unpin
      if (stopped || !live.has(address) || refused.has(address) || !agents.has(address) || store.get().pins === undefined) return;
      const pinned = listed(address);
      if (live.get(address) === pinned) { setAgreed(address, pinned); return; }
      // hc tells every label write back as a labels event, in order: that one is ours, not the app's
      const queued = echoes.get(address) ?? [];
      const echo = { pinned, heard: false, answered: false };
      queued.push(echo);
      echoes.set(address, queued);
      try {
        await hc.call("terminal.label", { terminal: address, labels: { [PINNED_LABEL]: pinned ? "1" : "" } });
        echo.answered = true;
        // once its event came, that event and any after it (the app's) already say what the label is
        if (!echo.heard) {
          live.set(address, pinned);
          setAgreed(address, pinned);
        }
        clearTimeout(retries.get(address)?.timer);
        retries.delete(address);
      } catch (error) {
        // left unagreed: tried again later, and the next snapshot settles it from what each side says then
        console.warn(`herdr-core: could not ${pinned ? "pin" : "unpin"} ${address} for the Herdr app:`, error);
        // a write hc refused sends no event back
        const index = queued.indexOf(echo);
        if (index >= 0) queued.splice(index, 1);
        // Ovis's change stays Ovis's, even once the terminal is a shell whose row the list prunes:
        // pending while Ovis's list differs from what was agreed (a newer change may have taken it back),
        // never for a write that landed
        const key = agreedKey(address);
        // a shell's row the list may have pruned tells nothing of Ovis's change
        const differs = agreed.has(key) && agents.has(address) && listed(address) !== agreed.get(key);
        // saved again while an earlier save failed, so a restart still finds the mark
        if (!echo.heard && (differs !== pending.has(key) || unsaved)) {
          if (differs) pending.add(key);
          else pending.delete(key);
          saveAgreed();
        }
        retry(address);
      }
    });
    writes.set(address, run);
    void run.then(() => { if (writes.get(address) === run) writes.delete(address); });
  };

  /** A terminal's label heard: settled against what both sides last agreed on. */
  const heard = (address: string, labelPinned: boolean) => {
    const before = live.get(address);
    live.set(address, labelPinned);
    // the event of a write of ours, early or late: no change of the app's
    const queued = echoes.get(address);
    if (queued && queued.length > 0) {
      if (queued[0]!.pinned === labelPinned) {
        // our write landed: both sides held this pin then, so an app change after it is the app's
        const echo = queued.shift()!;
        echo.heard = true;
        // an answered write already agreed, and a later write of ours may have agreed past it since
        if (!echo.answered && agents.has(address)) setAgreed(address, labelPinned);
        return;
      }
      // a label neither of our writes set: the app's, and what we sent no longer tells its order
      queued.length = 0;
    }
    // the app changed the pin after Ovis's failed write: its change is the last one
    if (before !== undefined && before !== labelPinned && pending.delete(agreedKey(address))) saveAgreed();
    // only an agent is in the Agents list: a shell's pin is never pruned from it as an unpin
    if (!agents.has(address)) return;
    refused.delete(address);
    const base = agreed.get(agreedKey(address));
    const ovis = listed(address);
    if (ovis || !labelPinned) leftOut.delete(address);
    // back from a shell, Ovis's list may have pruned the row: only a pin there tells Ovis's side,
    // unless Ovis changed it itself and the label write failed
    const shell = shells.has(agreedKey(address)) && labelPinned === base && !pending.has(agreedKey(address));
    const wanted = base === undefined || leftOut.has(address) || shell ? labelPinned || ovis : labelPinned !== base ? labelPinned : ovis;
    if (ovis !== wanted && !list(address, wanted)) {
      refused.add(address);
      return;
    }
    if (shells.delete(agreedKey(address))) saveAgreed();
    if (labelPinned !== wanted) writeLabel(address);
    else setAgreed(address, wanted);
  };
  const pinnedIn = (labels: unknown) => isRecord(labels) && typeof labels[PINNED_LABEL] === "string" && labels[PINNED_LABEL] !== "";
  /**
   * Whether a terminal runs an agent, as the Agents list draws it (an agent its status names). One
   * that is not one, however first seen (a snapshot after a restart or a reconnect included), leaves
   * the sync but keeps what was agreed of it: once an agent runs there again, a label changed since
   * still wins, while a pin missing from Ovis's list is no unpin, as the list prunes a shell's row.
   */
  const agents = new Set<string>();
  const isAgent = (status: unknown) => isRecord(status) && typeof status["app"] === "string" && status["app"] !== "";
  const agentIs = (address: string, status: unknown) => {
    const agent = isAgent(status);
    if (agent) {
      if (agents.has(address)) return;
      agents.add(address);
      if (live.has(address)) heard(address, live.get(address)!);
      return;
    }
    agents.delete(address);
    refused.delete(address);
    leftOut.delete(address);
    const key = agreedKey(address);
    if (agreed.has(key) && !shells.has(key)) { shells.add(key); saveAgreed(); }
  };
  const record = (value: unknown) => {
    if (!isRecord(value) || typeof value["address"] !== "string" || value["state"] !== "live") return;
    live.set(value["address"], pinnedIn(value["labels"]));
    // a record told again (a remote PC back) may no longer run an agent
    agentIs(value["address"], value["status"]);
    heard(value["address"], pinnedIn(value["labels"]));
  };
  const gone = (address: string) => {
    live.delete(address);
    echoes.delete(address);
    agents.delete(address);
    refused.delete(address);
    leftOut.delete(address);
    clearTimeout(retries.get(address)?.timer);
    retries.delete(address);
    const shell = shells.delete(agreedKey(address));
    const unwritten = pending.delete(agreedKey(address));
    if (agreed.delete(agreedKey(address)) || shell || unwritten) saveAgreed();
  };

  const unsubscribe = store.subscribe((preferences) => {
    // a change a full or unsaved list left out gets another look, even one that would start the list
    for (const address of [...refused]) heard(address, live.get(address) ?? false);
    // no browser has shared its pins yet: that is no unpin
    if (preferences.pins === undefined) return;
    // a change in Ovis's list taken back before its label was written leaves nothing pending
    let undone = false;
    for (const address of live.keys()) {
      const key = agreedKey(address);
      if (agents.has(address) && pending.has(key) && listed(address) === agreed.get(key)) undone = pending.delete(key);
    }
    if (undone) saveAgreed();
    for (const address of live.keys()) writeLabel(address);
  });

  const reopen = () => {
    closeStream = null;
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void open(); }, reopenMs);
  };
  const open = async () => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      closeStream?.();
      reopen();
    };
    // events before the snapshot wait for it; a new reader per stream, so a cut line never joins the next
    let early: unknown[] | null = [];
    const apply = (message: unknown) => {
      if (!isRecord(message)) return;
      if (message["method"] === "missed") { end(); return; }
      const params = message["params"];
      if (message["method"] !== "event" || !isRecord(params) || typeof params["terminal"] !== "string") return;
      // another machine's terminal is no row of this PC's list (snapshot.ts `onOtherMachine`): its pin is left alone
      if (onOtherMachine(params["terminal"])) return;
      const data = isRecord(params["data"]) ? params["data"] : {};
      switch (params["type"]) {
        case "created": record(data); return;
        case "labels": if (live.has(params["terminal"])) heard(params["terminal"], pinnedIn(data["labels"])); return;
        case "status": if (live.has(params["terminal"])) agentIs(params["terminal"], data["status"]); return;
        case "finished":
        case "removed": gone(params["terminal"]); return;
        default: return;
      }
    };
    const lines = makeLineReader(LINE_BYTES, (line) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { end(); return; }
      if (early) early.push(message);
      else apply(message);
    }, end);
    try {
      const hello = await hc.hello();
      const { result, channel } = await hc.open("events.subscribe", {}, { onData: lines, onClose: end });
      if (stopped) { void channel.close(); return; }
      closeStream = () => { closeStream = null; void channel.close(); };
      core = hello.core.id;
      live.clear();
      echoes.clear();
      agents.clear();
      refused.clear();
      leftOut.clear();
      const terminals = result.terminals.filter((terminal) => !onOtherMachine(terminal.address));
      const shown = new Set(terminals.filter((terminal) => terminal.state === "live").map((terminal) => agreedKey(terminal.address)));
      let pruned = false;
      for (const key of agreed.keys()) if (key.startsWith(`${core}/`) && !shown.has(key)) { agreed.delete(key); shells.delete(key); pending.delete(key); pruned = true; }
      if (pruned) saveAgreed();
      // every terminal known before any is settled, so a list started for one holds the others' pins
      for (const terminal of terminals) {
        if (terminal.state !== "live") continue;
        live.set(terminal.address, pinnedIn(terminal.labels));
        if (isAgent(terminal.status)) agents.add(terminal.address);
      }
      for (const terminal of terminals) record(terminal);
      const waiting = early;
      early = null;
      for (const message of waiting) apply(message);
      if (ended) closeStream?.();
    } catch (error) {
      console.warn("herdr-core: pins are not shared with the Herdr app until its events can be read:", error);
      end();
    }
  };
  void open();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      for (const pending of retries.values()) clearTimeout(pending.timer);
      unsubscribe();
      closeStream?.();
    },
    idle: async () => { while (writes.size > 0) await Promise.all(writes.values()); },
  };
}

/** the key in herdr-core-pins.json listing `shells`; never a terminal's, which holds a `/` */
const SHELLS = "shells";
/** the key listing agreed terminals whose last label write of Ovis's change failed */
const PENDING = "pending";

function readAgreed(path: string): { agreed: Map<string, boolean>; shells: Set<string>; pending: Set<string> } {
  try {
    const read = readStateDocument(path);
    if (read.kind === "json" && isRecord(read.value)) {
      const agreed = new Map(Object.entries(read.value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
      const listed = read.value[SHELLS];
      const keys = (value: unknown) => Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && agreed.has(key)) : [];
      return { agreed, shells: new Set(keys(listed)), pending: new Set(keys(read.value[PENDING])) };
    }
  } catch (error) {
    console.warn(`herdr-core: could not read ${path}; pins are settled as if first seen:`, error);
  }
  return { agreed: new Map(), shells: new Set(), pending: new Set() };
}
