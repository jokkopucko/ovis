import { join } from "node:path";
import { LINE_BYTES } from "../herdr/client.ts";
import { makeLineReader } from "../herdr/line-reader.ts";
import { MAX_PINS, type PreferencesChange, type SharedPreferences } from "../../shared/preferences.ts";
import { readStateDocument, writeStateDocument } from "../state-document.ts";
import type { HcConnection } from "./connection.ts";
import { isRecord, onOtherMachine } from "./snapshot.ts";

/**
 * Pinned agents, shared by every Herdr client (herdr-app docs/labels.md): present and non-empty,
 * the terminal is pinned; written empty, it is not.
 */
export const PINNED_LABEL = "herdr.pinned";
const REOPEN_MS = 1_000;
const AGREED_FILE = "herdr-core-pins.json";

type Hc = Pick<HcConnection, "call" | "open" | "hello">;
interface PinStore {
  get(): SharedPreferences;
  set(change: PreferencesChange): SharedPreferences;
  subscribe(listener: (preferences: SharedPreferences) => void): () => void;
}

export interface PinBridge {
  stop: () => void;
  idle: () => Promise<void>;
}

export function bridgePins(hc: Hc, store: PinStore, machineId: string, stateDir: string, reopenMs = REOPEN_MS): PinBridge {
  const agreedPath = join(stateDir, AGREED_FILE);
  const { agreed, shells, pending } = readAgreed(agreedPath);
  const live = new Map<string, boolean>();
  const refused = new Set<string>();
  /** pinned in the app but past a full list the bridge started: not unpinned for not being listed */
  const leftOut = new Set<string>();
  let unsaved = false;
  const sending = new Set<string>();
  let core = "";
  const keyOf = (address: string) => `${machineId}:${address}`;
  const agreedKey = (address: string) => `${core}/${address}`;
  const listed = (address: string) => (store.get().pins ?? []).includes(keyOf(address));
  let stopped = false;
  let closeStream: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const saveAgreed = () => {
    try {
      writeStateDocument(agreedPath, `${JSON.stringify({ ...Object.fromEntries(agreed), [SHELLS]: [...shells], [PENDING]: [...pending].filter((key) => !sending.has(key)) })}\n`, false);
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
  const landed = (address: string, pinned: boolean) => {
    const key = agreedKey(address);
    if (agents.has(address)) {
      setAgreed(address, pinned);
      if (listed(address) !== pinned && !refused.has(address)) { pending.add(key); sending.add(key); }
      return;
    }
    const choice = agreed.has(key) ? agreed.get(key) !== pending.has(key) : pinned;
    setAgreed(address, pinned);
    if (choice === pinned) return;
    pending.add(key);
    sending.delete(key);
    saveAgreed();
  };
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

  const writes = new Map<string, Promise<void>>();
  const echoes = new Map<string, { pinned: boolean; heard: boolean; answered: boolean }[]>();
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
      const key = agreedKey(address);
      if (agreed.has(key) && agreed.get(key) !== pinned && !pending.has(key)) {
        pending.add(key);
        sending.add(key);
      }
      // hc tells every label write back as a labels event, in order: that one is ours, not the app's
      const queued = echoes.get(address) ?? [];
      const echo = { pinned, heard: false, answered: false };
      queued.push(echo);
      echoes.set(address, queued);
      try {
        await hc.call("terminal.label", { terminal: address, labels: { [PINNED_LABEL]: pinned ? "1" : "" } });
        if (sending.delete(key) && pending.has(key)) saveAgreed();
        echo.answered = true;
        if (!echo.heard) {
          live.set(address, pinned);
          landed(address, pinned);
        }
        clearTimeout(retries.get(address)?.timer);
        retries.delete(address);
      } catch (error) {
        console.warn(`herdr-core: could not ${pinned ? "pin" : "unpin"} ${address} for the Herdr app:`, error);
        // a write hc refused sends no event back
        const index = queued.indexOf(echo);
        if (index >= 0) queued.splice(index, 1);
        if (sending.delete(key) || unsaved) saveAgreed();
        retry(address);
      }
    });
    writes.set(address, run);
    void run.then(() => { if (writes.get(address) === run) writes.delete(address); });
  };

  const heard = (address: string, labelPinned: boolean, told = false) => {
    const before = live.get(address);
    live.set(address, labelPinned);
    const queued = echoes.get(address);
    if (queued && queued.length > 0) {
      if (queued[0]!.pinned === labelPinned) {
        const echo = queued.shift()!;
        echo.heard = true;
        if (!echo.answered && (agents.has(address) || agreed.has(agreedKey(address)))) landed(address, labelPinned);
        return;
      }
      if (told && before === labelPinned) return;
      queued.length = 0;
    }
    if (before !== undefined && before !== labelPinned && pending.delete(agreedKey(address))) saveAgreed();
    // only an agent is in the Agents list: a shell's pin is never pruned from it as an unpin
    if (!agents.has(address)) return;
    refused.delete(address);
    const base = agreed.get(agreedKey(address));
    const ovis = listed(address);
    if (ovis || !labelPinned) leftOut.delete(address);
    const shell = shells.has(agreedKey(address)) && labelPinned === base && !pending.has(agreedKey(address));
    const mine = pending.has(agreedKey(address)) ? !base : ovis;
    const wanted = base === undefined || leftOut.has(address) || shell ? labelPinned || ovis : labelPinned !== base ? labelPinned : mine;
    if (ovis !== wanted && !list(address, wanted)) {
      refused.add(address);
      return;
    }
    if (shells.delete(agreedKey(address))) saveAgreed();
    if (labelPinned !== wanted) writeLabel(address);
    else setAgreed(address, wanted);
  };
  const pinnedIn = (labels: unknown) => isRecord(labels) && typeof labels[PINNED_LABEL] === "string" && labels[PINNED_LABEL] !== "";
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
    for (const address of [...refused]) heard(address, live.get(address) ?? false);
    // no browser has shared its pins yet: that is no unpin
    if (preferences.pins === undefined) return;
    let marked = false;
    for (const address of live.keys()) {
      const key = agreedKey(address);
      if (!agents.has(address) || !agreed.has(key)) continue;
      if (listed(address) === agreed.get(key)) marked = pending.delete(key) || marked;
      else if (writes.has(address) && !refused.has(address) && !pending.has(key)) { pending.add(key); sending.add(key); }
    }
    if (marked) saveAgreed();
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
        case "labels": if (live.has(params["terminal"])) heard(params["terminal"], pinnedIn(data["labels"]), true); return;
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

const SHELLS = "shells";
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
