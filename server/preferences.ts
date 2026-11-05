import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MAX_PREFERENCES_BYTES, nextTabLabels, normalizeThemeChange, sharedPreferencesBody, type PreferencesChange, type SharedPreferences } from "../shared/preferences.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument, writeStateDocument } from "./state-document.ts";

/** The state folder's id (SharedPreferences.state_id), in a file of its own beside preferences.json. */
export const STATE_ID_FILE = "preferences-id.json";
const STATE_ID = /^[0-9a-f]{32}$/;

/** The id `dir` holds: undefined when it has none yet, null when its file is damaged. Throws when it cannot be read. */
export function readStateId(dir: string): string | null | undefined {
  const read = readStateDocument(join(dir, STATE_ID_FILE));
  if (read.kind === "missing") return undefined;
  const id = read.kind === "json" && isJsonObject(read.value) ? read.value["state_id"] : undefined;
  return typeof id === "string" && STATE_ID.test(id) ? id : null;
}

export function writeStateId(dir: string, id: string): void {
  writeStateDocument(join(dir, STATE_ID_FILE), `${JSON.stringify({ state_id: id }, null, 2)}\n`, false);
}
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The document a change would make is over MAX_PREFERENCES_BYTES; nothing was kept. */
export class PreferencesTooLarge extends Error {
  constructor() { super(`Shared preferences are at most ${MAX_PREFERENCES_BYTES / 1024} KB`); }
}

/**
 * The preferences every browser of this server shares (shared/preferences.ts), kept in the state
 * directory beside devices.json. One document: a browser sends the settings it changed (and the
 * pins when they changed), laid over what is held, last write wins per setting; the others take
 * the whole document from the event. A change is held, and told, only once it is on disk.
 * The muted panes are always in the document, empty while nothing is muted: a server with none
 * stored reads as none muted, without a write or a new revision, so a browser tells a server that
 * keeps the list from an older one by the list being there. They are stored in a document of their
 * own, muted-panes.json, not in preferences.json: a release from before them rewrites
 * preferences.json whole on its next save (a rollback, a downgrade), and would erase a list kept
 * there. preferences.json keeps the shape every release reads and writes. The tab labels
 * (`tab_labels`) are kept apart in tab-labels.json for the same reason; they are only ever added
 * (mergeTabLabels), and are absent from the document while none is kept. The state folder's id
 * (`state_id`) is made at the first save and kept in preferences-id.json, apart for the same reason:
 * a browser tells a folder that started over by it. A damaged one is left as it is and no id is sent
 * (browsers then go by the revision): a new one would tell them the folder started over when it did not.
 */
export class PreferenceStore {
  private current: SharedPreferences = { revision: 0, settings: {}, muted_panes: [] };
  private readonly path: string;
  private readonly mutesPath: string;
  private readonly labelsPath: string;
  private readonly stateDir: string;
  /** this state folder's id, once it is on disk (preferences-id.json); null while that file is damaged or unreadable */
  private stateId: string | null | undefined;
  private readonly listeners = new Set<(preferences: SharedPreferences) => void>();
  /** Until this store has replaced the file, a write reads it again first: it may have been damaged or repaired since. */
  private unsettled = true;
  /** As `unsettled`, for muted-panes.json. */
  private mutesUnsettled = true;
  /** As `unsettled`, for tab-labels.json. */
  private labelsUnsettled = true;

  constructor(stateDir: string) {
    this.path = join(stateDir, "preferences.json");
    this.mutesPath = join(stateDir, "muted-panes.json");
    this.labelsPath = join(stateDir, "tab-labels.json");
    this.stateDir = stateDir;
    try {
      this.stateId = readStateId(stateDir);
      if (this.stateId === null) console.error(`${join(stateDir, STATE_ID_FILE)} is not a state folder id; none is sent until it is repaired or removed and the server restarts`);
    } catch (error) {
      this.stateId = null;
      console.error(`Cannot read ${join(stateDir, STATE_ID_FILE)} (${(error as NodeJS.ErrnoException).code ?? "error"}); no state folder id is sent`);
    }
    try {
      const held = this.readDisk();
      if (held) this.current = held;
    } catch (error) {
      // a missing file is a server that has shared nothing yet; an unreadable one is not, and is never written over
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); shared preferences start empty and are not saved until it can be read`);
    }
    if (typeof this.stateId === "string") this.current = { ...this.current, state_id: this.stateId };
    try {
      this.current = { ...this.current, muted_panes: this.readMutes() ?? [] };
    } catch (error) {
      console.error(`Cannot read ${this.mutesPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); no pane starts muted and the list is not saved until it can be read`);
    }
    try {
      // while the setting is off none is shown, and the first save deletes what a failed delete left
      const labels = this.current.settings.autoTabNames === false ? null : this.readLabels();
      if (labels !== null && Object.keys(labels).length > 0) this.current = { ...this.current, tab_labels: labels };
    } catch (error) {
      console.error(`Cannot read ${this.labelsPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); no tab starts with a label from its first message and none is saved until it can be read`);
    }
  }

  /** The tab labels on disk: {} when there are none yet, null when the file is damaged. Throws when it cannot be read. */
  private readLabels(): Record<string, string> | null {
    const read = readStateDocument(this.labelsPath);
    if (read.kind === "missing") return {};
    const labels = read.kind === "json" && isJsonObject(read.value) ? sharedPreferencesBody({ settings: {}, tab_labels: read.value["tab_labels"] ?? {} })?.tab_labels : undefined;
    if (labels === undefined) {
      console.error(`${this.labelsPath} is not a tab labels document; no tab has a label from it, and the next one keeps it as ${damagedCopy(this.labelsPath)}`);
      return null;
    }
    return labels;
  }

  /** The muted panes on disk: [] when there is no list yet, null when the file is damaged. Throws when it cannot be read. */
  private readMutes(): string[] | null {
    const read = readStateDocument(this.mutesPath);
    if (read.kind === "missing") return [];
    const list = read.kind === "json" && isJsonObject(read.value) ? sharedPreferencesBody({ settings: {}, muted_panes: read.value["muted_panes"] })?.muted_panes : undefined;
    if (list === undefined) {
      console.error(`${this.mutesPath} is not a muted panes list; no pane is muted, and the next mute keeps it as ${damagedCopy(this.mutesPath)}`);
      return null;
    }
    return list;
  }

  /** The document on disk: undefined when there is none, null when it is damaged. Throws when it cannot be read. */
  private readDisk(): SharedPreferences | null | undefined {
    const read = readStateDocument(this.path);
    if (read.kind === "missing") return undefined;
    const parsed = read.kind === "json" ? read.value : undefined;
    const body = sharedPreferencesBody(parsed);
    if (body === null) {
      console.error(`${this.path} is ${read.kind === "malformed" ? "not JSON" : "not a preferences document"}; the next change keeps it as ${damagedCopy(this.path)}`);
      return null;
    }
    const revision = isJsonObject(parsed) && Number.isSafeInteger(parsed["revision"]) ? parsed["revision"] as number : 0;
    // the mutes are muted-panes.json's (readMutes), the labels tab-labels.json's: what this document holds of them is left out
    const labels = this.current.tab_labels;
    return { revision: Math.max(0, revision), ...(typeof this.stateId === "string" ? { state_id: this.stateId } : {}), settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }), muted_panes: this.current.muted_panes, ...(labels === undefined ? {} : { tab_labels: labels }) };
  }

  get(): SharedPreferences { return this.current; }

  set(change: PreferencesChange): SharedPreferences {
    let base = this.current;
    let keepDamaged = false;
    if (this.unsettled) {
      // the file as it is now, not as it was at start: a repair is kept and the change laid over it
      const held = this.readDisk();
      if (held) base = held;
      keepDamaged = held === null;
    }
    // labels on disk that this store has not read (a file repaired since a damaged start) are what the change
    // adds to and drops from (the setting turned off is a change of them: it deletes them). The labels never
    // stop a save of the settings, pins or mutes: a file that cannot be read or written (its rights, a
    // directory in its place) is logged, and the labels are left out of this save and of memory until a
    // later change of them can read it
    let labelsUnreadable = false;
    // labels a delete left on disk while the setting was off are no one's: they are deleted again, never read back
    const wasOff = base.settings.autoTabNames === false;
    if (this.labelsUnsettled && (wasOff || change.tab_labels !== undefined || change.tab_labels_removed !== undefined || change.settings.autoTabNames === false)) {
      try {
        const held = this.readLabels();
        if (held !== null && Object.keys(held).length > 0 && !wasOff) base = { ...base, tab_labels: held };
      } catch (error) {
        console.error(`Cannot read ${this.labelsPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); the change is saved without the tab labels`);
        labelsUnreadable = true;
      }
    }
    if (labelsUnreadable) {
      const { tab_labels: _added, tab_labels_removed: _removed, ...rest } = change;
      change = rest;
      const { tab_labels: _held, ...without } = base;
      base = without;
    }
    if (this.stateId === undefined) {
      // the folder's first save names it, before anything else is written: a save whose id cannot be
      // kept fails, so no document goes out that a browser could take for a folder's without one. An id
      // another server on this folder wrote since this one started is taken, never written over
      this.stateId = readStateId(this.stateDir);
      if (this.stateId === undefined) {
        const id = randomUUID().replaceAll("-", "");
        writeStateId(this.stateDir, id);
        this.stateId = id;
      }
    }
    const stateId = this.stateId ?? undefined;
    change = normalizeThemeChange(base.settings, change);
    const pins = change.pins ?? base.pins;
    // a change that names no list leaves the mutes; an empty list is the last one unmuted
    const muted = change.muted_panes ?? base.muted_panes ?? [];
    const settings = { ...base.settings, ...change.settings };
    // the setting turned off takes every label with it, on disk too
    const labels = labelsUnreadable ? undefined : nextTabLabels(base.tab_labels, change, settings);
    // a change that leaves the labels as they are writes no tab-labels.json
    let kept = labels !== undefined && Object.keys(labels).length > 0 ? labels : undefined;
    const document = (): SharedPreferences => ({ revision: base.revision + 1, ...(stateId === undefined ? {} : { state_id: stateId }), settings, ...(pins === undefined ? {} : { pins }), muted_panes: muted, ...(kept === undefined ? {} : { tab_labels: kept }) });
    // the labels never make a save too large: the settings, pins and mutes are measured without them, and
    // labels that would not fit beside them are left out of this save (the ones held stay on disk)
    const labelsHeld = base.tab_labels;
    // labels that do not fit are only left out of the document and memory: the file keeps them, unwritten
    let labelsFit = true;
    if (kept !== undefined) {
      const bare = { ...document() };
      delete bare.tab_labels;
      if (byteLength(JSON.stringify(bare)) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
      if (byteLength(JSON.stringify(document())) > MAX_PREFERENCES_BYTES) { kept = undefined; labelsFit = false; }
    } else if (byteLength(JSON.stringify(document())) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
    // a purge left undone while the setting was off goes again with every save until it is done
    const labelsChanged = !labelsUnreadable && labelsFit && (JSON.stringify(kept ?? {}) !== JSON.stringify(labelsHeld ?? {}) || (wasOff && this.labelsUnsettled));
    // the revision first: a save that fails there leaves the mutes as they were. One that fails at the
    // list puts the previous preferences.json back, so a refused save leaves nothing on disk that no
    // browser was told of. Two files cannot be swapped as one, so a window stays open, accepted for
    // a settings store: when putting preferences.json back fails too, or the process ends between the
    // two renames, preferences.json keeps the refused change and a restart reads it, although memory
    // and the client were told it failed. Nothing is lost; at worst a refused change comes back.
    const keepDamagedMutes = change.muted_panes !== undefined && this.mutesUnsettled && this.readMutes() === null;
    const { muted_panes: _stored, tab_labels: _labels, state_id: _id, ...shared } = document();
    writeStateDocument(this.path, `${JSON.stringify(shared, null, 2)}\n`, keepDamaged);
    // the labels before the mutes, and never in their way: mutes saved before a failed save of the labels
    // would otherwise silence panes though the browser was told they were not. A label save that fails
    // leaves the labels out of memory, so the next change of them reads the file again
    let labelsWritten = false;
    if (labelsChanged) {
      try {
        const keepDamagedLabels = this.labelsUnsettled && this.readLabels() === null;
        writeStateDocument(this.labelsPath, `${JSON.stringify({ tab_labels: kept ?? {} }, null, 2)}\n`, keepDamagedLabels);
        this.labelsUnsettled = false;
        labelsWritten = true;
      } catch (error) {
        console.error(`Cannot save ${this.labelsPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); the change is saved without the tab labels`);
        kept = undefined;
        this.labelsUnsettled = true;
      }
    }
    // labels this save could not read or write are not this store's any more, even when the mutes then fail
    // labels left out for their size are still on disk: the next change of them reads the file first
    if (!labelsFit) this.labelsUnsettled = true;
    if (labelsUnreadable || !labelsFit || (labelsChanged && !labelsWritten)) {
      const { tab_labels: _dropped, ...rest } = this.current;
      this.current = rest;
    }
    const next = document();
    if (change.muted_panes !== undefined) {
      try {
        writeStateDocument(this.mutesPath, `${JSON.stringify({ muted_panes: muted }, null, 2)}\n`, keepDamagedMutes);
      } catch (error) {
        // labels already on disk are what this store holds now, so a later save starts from them
        if (labelsWritten) {
          const { tab_labels: _was, ...rest } = this.current;
          this.current = { ...rest, ...(kept === undefined ? {} : { tab_labels: kept }) };
        }
        const { muted_panes: _held, tab_labels: _heldLabels, state_id: _heldId, ...before } = base;
        try { writeStateDocument(this.path, `${JSON.stringify(before, null, 2)}\n`, false); }
        catch (restore) { console.error(`Cannot put ${this.path} back after a failed save of ${this.mutesPath}: ${restore instanceof Error ? restore.message : String(restore)}`); }
        throw error;
      }
      this.mutesUnsettled = false;
    }
    // settled only once the whole save is on disk: after a put-back the file is read again first
    this.unsettled = false;
    this.current = next;
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  subscribe(listener: (preferences: SharedPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** /api/preferences: GET the shared document, PUT a change to it. A watching device's PUT is refused before this (index.ts). */
export async function handlePreferencesRequest(request: Request, store: PreferenceStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const tooLarge = () => reply({ error: { code: "too_large", message: new PreferencesTooLarge().message } }, 413);
  if (request.method === "GET") return reply(store.get());
  if (request.method !== "PUT") return reply({ error: { code: "method_not_allowed", message: "Use GET or PUT /api/preferences" } }, 405);
  // a body announced over the limit is refused unread; one that lies about its length is measured
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_PREFERENCES_BYTES) return tooLarge();
  const text = await request.text();
  if (byteLength(text) > MAX_PREFERENCES_BYTES) return tooLarge();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const body = sharedPreferencesBody(raw);
  if (body === null) return badRequest("invalid_body", "Send { settings: object, pins?: string[], muted_panes?: string[], tab_labels?: { [pane|terminal]: string }, tab_labels_removed?: string[] }");
  try { return reply(store.set(body)); }
  catch (error) {
    if (error instanceof PreferencesTooLarge) return tooLarge();
    return reply({ error: { code: "preferences_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
