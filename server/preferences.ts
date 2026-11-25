import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MAX_PREFERENCES_BYTES, nextTabLabels, normalizeThemeChange, sharedPreferencesBody, type PreferencesChange, type SharedPreferences } from "../shared/preferences.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument, writeStateDocument } from "./state-document.ts";
import { HARNESS_TOOL_OFF, harnessToolSetting, parseHarnessSetting } from "../shared/harness-tool.ts";

export const STATE_ID_FILE = "preferences-id.json";
const STATE_ID = /^[0-9a-f]{32}$/;

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

export class PreferencesTooLarge extends Error {
  constructor() { super(`Shared preferences are at most ${MAX_PREFERENCES_BYTES / 1024} KB`); }
}

/**
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
  private stateId: string | null | undefined;
  private readonly listeners = new Set<(preferences: SharedPreferences) => void>();
  private unsettled = true;
  private mutesUnsettled = true;
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
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); shared preferences start empty and are not saved until it can be read`);
    }
    if (typeof this.stateId === "string") this.current = { ...this.current, state_id: this.stateId };
    // Like muted panes, a security policy cannot live only in preferences.json: an older
    // server rewrites that document without keys it does not recognize.
    const policyPath = join(stateDir, "agent-harness-policy.json");
    try {
      const read = readStateDocument(policyPath);
      if (read.kind !== "missing") this.current.settings.agentHarnessTool = read.kind === "json" ? parseHarnessSetting(read.value) ?? HARNESS_TOOL_OFF : HARNESS_TOOL_OFF;
      else if (this.current.settings.agentHarnessTool !== undefined) writeStateDocument(policyPath, JSON.stringify(harnessToolSetting(this.current.settings.agentHarnessTool)), false);
    } catch (error) {
      // A non-directory cannot contain a policy (or a hub); the preference store remains empty.
      if (!(error instanceof Error && "code" in error && error.code === "ENOTDIR")) this.current.settings.agentHarnessTool = HARNESS_TOOL_OFF;
    }
    try {
      this.current = { ...this.current, muted_panes: this.readMutes() ?? [] };
    } catch (error) {
      console.error(`Cannot read ${this.mutesPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); no pane starts muted and the list is not saved until it can be read`);
    }
    try {
      const labels = this.current.settings.autoTabNames === false ? null : this.readLabels();
      if (labels !== null && Object.keys(labels).length > 0) this.current = { ...this.current, tab_labels: labels };
    } catch (error) {
      console.error(`Cannot read ${this.labelsPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); no tab starts with a label from its first message and none is saved until it can be read`);
    }
  }

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
    const labels = this.current.tab_labels;
    return { revision: Math.max(0, revision), ...(typeof this.stateId === "string" ? { state_id: this.stateId } : {}), settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }), muted_panes: this.current.muted_panes, ...(labels === undefined ? {} : { tab_labels: labels }) };
  }

  get(): SharedPreferences { return this.current; }

  set(change: PreferencesChange): SharedPreferences {
    const changingPolicy = Object.hasOwn(change.settings, "agentHarnessTool");
    const policy = changingPolicy ? parseHarnessSetting(change.settings.agentHarnessTool) : undefined;
    if (policy === null) throw new Error("Invalid agent harness policy.");
    let base = this.current;
    let keepDamaged = false;
    if (this.unsettled) {
      const held = this.readDisk();
      if (held) base = held;
      keepDamaged = held === null;
    }
    let labelsUnreadable = false;
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
    const muted = change.muted_panes ?? base.muted_panes ?? [];
    const settings = { ...base.settings, ...change.settings };
    if (policy) settings.agentHarnessTool = policy;
    else if (this.current.settings.agentHarnessTool !== undefined) settings.agentHarnessTool = this.current.settings.agentHarnessTool;
    const labels = labelsUnreadable ? undefined : nextTabLabels(base.tab_labels, change, settings);
    let kept = labels !== undefined && Object.keys(labels).length > 0 ? labels : undefined;
    const document = (): SharedPreferences => ({ revision: base.revision + 1, ...(stateId === undefined ? {} : { state_id: stateId }), settings, ...(pins === undefined ? {} : { pins }), muted_panes: muted, ...(kept === undefined ? {} : { tab_labels: kept }) });
    const labelsHeld = base.tab_labels;
    let labelsFit = true;
    if (kept !== undefined) {
      const bare = { ...document() };
      delete bare.tab_labels;
      if (byteLength(JSON.stringify(bare)) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
      if (byteLength(JSON.stringify(document())) > MAX_PREFERENCES_BYTES) { kept = undefined; labelsFit = false; }
    } else if (byteLength(JSON.stringify(document())) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
    const labelsChanged = !labelsUnreadable && labelsFit && (JSON.stringify(kept ?? {}) !== JSON.stringify(labelsHeld ?? {}) || (wasOff && this.labelsUnsettled));
    const keepDamagedMutes = change.muted_panes !== undefined && this.mutesUnsettled && this.readMutes() === null;
    const { muted_panes: _stored, tab_labels: _labels, state_id: _id, ...shared } = document();
    const { agentHarnessTool: _policy, ...general } = shared.settings;
    writeStateDocument(this.path, `${JSON.stringify({ ...shared, settings: general }, null, 2)}\n`, keepDamaged);
    // the labels before the mutes, and never in their way: mutes saved before a failed save of the labels
    // would otherwise silence panes though the browser was told they were not.
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
    this.unsettled = false;
    if (policy) writeStateDocument(join(this.stateDir, "agent-harness-policy.json"), JSON.stringify(policy), false);
    this.current = next;
    // every listener hears of the saved change; the first one that fails then fails the save's caller, so a
    // change that could not be followed through (a Hub account's hide not saved, #3428) is not taken as done
    let failure: { error: unknown } | null = null;
    for (const listener of [...this.listeners]) {
      try { listener(this.current); } catch (error) { failure ??= { error }; }
    }
    if (failure !== null) throw failure.error;
    return this.current;
  }

  subscribe(listener: (preferences: SharedPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** Tell clients the effective policy without storing it as an explicit choice. */
export const preferencesForClient = (doc: SharedPreferences): SharedPreferences =>
  ({ ...doc, settings: { ...doc.settings, agentHarnessTool: harnessToolSetting(doc.settings.agentHarnessTool) } });

/** /api/preferences: GET the shared document, PUT a change to it. A watching device's PUT is refused before this (index.ts). */
export async function handlePreferencesRequest(request: Request, store: PreferenceStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const tooLarge = () => reply({ error: { code: "too_large", message: new PreferencesTooLarge().message } }, 413);
  if (request.method === "GET") return reply(preferencesForClient(store.get()));
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
  if (Object.hasOwn(body.settings, "agentHarnessTool") && !parseHarnessSetting(body.settings.agentHarnessTool)) return badRequest("invalid_policy", "Invalid agent harness policy.");
  try { return reply(preferencesForClient(store.set(body))); }
  catch (error) {
    if (error instanceof PreferencesTooLarge) return tooLarge();
    return reply({ error: { code: "preferences_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
