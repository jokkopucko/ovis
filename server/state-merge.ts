/**
 * Paired devices (devices.json) are an authorization record, so both dirs end with the same one:
 * a release before this one that ever reads either finds every device and a closed gate. Devices are
 * merged by id against the ids both held after the last merge (state-merge.json, kept in both dirs):
 * one only one side holds is new there and is kept, unless the last merge had it, which means it was
 * revoked on the other side since, and it stays revoked. The first merge has nothing to compare with
 * and keeps every device. The gate is closed from the earliest evidence either side holds, so a merge
 * never opens it. A registry or merge record that cannot be read fails closed: the store stays gated
 * and pairs nothing (devices.ts), neither registry is written, and a dir without a registry gets a
 * closed, empty one marked incomplete: its missing devices are never read as revoked.
 *
 * Push subscriptions go to the dir in use only, each taken over once, with the key pair it was made
 * for (push.ts PUSH_EXTRA_KEYS).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_PREFERENCES_BYTES, sharedPreferencesBody, type PreferencesChange } from "../shared/preferences.ts";
import type { RowOrigin } from "./account/admission-order.ts";
import { readDeviceRegistry, VOUCHED, type DeviceRegistry, type StoredDevice } from "./devices.ts";
import { preparePrivateState, publishPrivateState, writePrivateState } from "./private-state.ts";
import { normalizeEndpoint, PUSH_EXTRA_KEYS } from "./push.ts";
import { readStateId, STATE_ID_FILE, writeStateId } from "./preferences.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";
import { stateDirNames } from "./update-state.ts";

const RECORD = "state-merge.json";
const BACKUPS = "state-merge-backups";
/** Beside a registry written where one was missing: it may lack devices the other dir holds. */
const INCOMPLETE = "state-merge-devices-incomplete.json";

export interface SiblingMerge {
  /** why the device registries could not be merged: the store must stay gated (devices.ts) */
  devicesBlocked: string | null;
  legacyCredential?: (row: StoredDevice) => boolean;
}

export function siblingStateDir(active: string, env: Record<string, string | undefined> = process.env): string | null {
  const { legacy, next } = stateDirNames(env);
  const own = realpath(active);
  const other = own === realpath(legacy) ? next : own === realpath(next) ? legacy : null;
  if (other === null) return null;
  try {
    if (!statSync(other).isDirectory()) return null;
  } catch (error) {
    // an other dir that cannot be looked at may hold devices: the merge then fails closed
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : other;
  }
  return realpath(other) === own ? null : other;
}

function realpath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

interface Registry { gate_closed_at: string | null; devices: StoredDevice[] }
interface PreferencesSnapshot { settings: PreferencesChange["settings"]; pins?: string[]; muted_panes: string[] }
interface MergeRecord {
  version: 1;
  /** one more than the newest record of the two dirs: the clock may go back, this never does */
  seq: number;
  at: string;
  dirs: string[];
  devices: string[];
  /** Exact credentials witnessed in both folders by an ordinary Step 1 merge. Never an admission order. */
  legacy_credentials?: string[];
  /** The relay identity those credentials were witnessed under: a later reset or a foreign sibling does not unwitness them. */
  legacy_identity?: string;
  preferences: Record<string, PreferencesSnapshot>;
  preferences_target?: PreferencesSnapshot;
  push: Record<string, string[]>;
  /** whether the merged registry had a closed gate: with both registries gone, the install is still not a fresh one */
  gated?: boolean;
  /**
   * Written before a merge publishes its registries, and gone from the record that follows them: a
   * crash in between leaves it. The new bytes of each registry are prepared first, in a file of their
   * own (`temp`), and publishing is renaming that file into place. So a dir got the merge when it held
   * it already (`same`) or its prepared file is gone: its base is then the merged ids, and a device
   * revoked there since stays revoked, whatever bytes that left. A dir whose prepared file is still
   * there, or that was never written, did not get it, and keeps the base it was merged against.
   */
  pending?: { ids: string[]; sides: Record<string, { same: boolean; temp: string | null; base: string[] | null }> };
}

const text = (value: unknown): string => JSON.stringify(value);
const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url");
const earliest = (values: (string | null | undefined)[]): string | null =>
  values.filter((value): value is string => typeof value === "string").sort()[0] ?? null;

/**
 * Merges two registries by device id; `base` holds the ids both had after the last merge (null:
 * none happened). A device one side dropped since then stays dropped; one only one side added is
 * kept. A device both hold keeps this side's credential and label, the narrower role, its first
 * creation and its last sighting. A missing registry (`null`) says nothing was dropped there, nor
 * does an incomplete one (`incomplete`: written where a registry was missing, devices.ts placeholder).
 */
/**
 * With OVIS_ACCOUNT_OPENS_ALL on (T48, T27 in 2d): `holdImports` while the merged safety log holds a lock, a block or
 * a freeze in force, so a row only the other dir holds is no import now and stays in that dir's file; and
 * `dropConflictingKeys`, so a row whose key differs between the two copies is dropped rather than given either key.
 */
export interface MergeRules { readonly boundAccount?: string | null; readonly holdImports?: boolean; readonly dropConflictingKeys?: boolean; readonly onDropped?: (device: StoredDevice) => void; readonly sharedLegacyIdentity?: string }

const credentialFingerprint = (identity: string, row: StoredDevice): string =>
  createHash("sha256").update(text([identity, row.id, row.relay_public_key, row.token_hash])).digest("base64url");

// Rollback cannot transfer a held credential to a live twin, in either direction.
function separateHeldTwins(own: StoredDevice, other: StoredDevice): boolean {
  return (Object.hasOwn(own, "held") || Object.hasOwn(other, "held"))
    && (own.relay_public_key !== other.relay_public_key || own.token_hash !== other.token_hash);
}

export function mergeRegistries(own: Registry | null, other: Registry | null,
  bases: { own: ReadonlySet<string> | null; other: ReadonlySet<string> | null },
  incomplete: { own: boolean; other: boolean } = { own: false, other: false }, rules: MergeRules = {}): Registry & { held: StoredDevice[] } {
  const mine = own?.devices ?? [];
  const theirs = other?.devices ?? [];
  const theirIds = new Set(theirs.map((device) => device.id));
  const myIds = new Set(mine.map((device) => device.id));
  const devices: StoredDevice[] = [];
  const held: StoredDevice[] = [];
  for (const original of mine) {
    // revoked through the other dir since the last merge
    if (other !== null && !incomplete.other && bases.other?.has(original.id) && !theirIds.has(original.id)) continue;
    const twin = theirs.find((candidate) => candidate.id === original.id);
    if (!twin) {
      devices.push(original);
      continue;
    }
    let device = original;
    // The other folder can still contain the settled pairing after this folder's link was cleared.
    // Require the same credential: the mere absence of a binding does not turn a member into a paired row.
    if (rules.boundAccount !== undefined && original.account !== undefined && original.account !== rules.boundAccount &&
      twin.account === undefined && original.token_hash === twin.token_hash && original.relay_public_key === twin.relay_public_key) {
      const { account: _account, linked_at: _linked, account_add: _add, member_approved_in: _member, joined_by: _joined, ...paired } = original;
      device = paired;
    }
    if (rules.dropConflictingKeys && twin.relay_public_key !== device.relay_public_key) { rules.onDropped?.(device); continue; }
    const history = {
      role: device.role === "watch" || twin.role === "watch" ? "watch" : "drive",
      // Step 2 uses a keyless cookie's own pairing time against a freeze. Never backdate it from its twin.
      created_at: rules.dropConflictingKeys && device.relay_public_key === undefined ? device.created_at : earliest([device.created_at, twin.created_at])!,
      last_seen_at: [device.last_seen_at, twin.last_seen_at].filter((seen): seen is string => seen !== null).sort().at(-1) ?? null,
    } satisfies Pick<StoredDevice, "role" | "created_at" | "last_seen_at">;
    if (!rules.dropConflictingKeys && separateHeldTwins(device, twin)) {
      devices.push({ ...device, ...history });
      continue;
    }
    // the credential is chosen apart from the rest: whichever is kept, the role is never widened
    if (twin.token_hash !== device.token_hash) console.error(`Paired device ${device.id} has another credential in the other state dir; the one in use is kept`);
    // a link done in the other dir moved the row to the account key (docs/account.md); an older copy must not undo it
    // the later link wins: an unlinked copy, or one linked earlier, takes the other's account key
    const staleMembership = rules.boundAccount !== undefined && twin.account !== undefined && twin.account !== rules.boundAccount;
    const takes = twin.account !== undefined && !staleMembership
      && (device.account === undefined || (twin.linked_at ?? "") > (device.linked_at ?? ""));
    // how the row joined is merged apart from the account and key: a link on the device's own word (any mark but a
    // vouched one, `null` included) is kept whichever copy holds it and whichever account the row takes, as no later
    // link undoes it. Otherwise the kept copy's mark, or, where both copies are in that account, the other's when the
    // kept one has none: a vouched mark goes with its own account only. Only a missing mark is none
    const { joined_by: own, origin: ownOrigin, account_add: ownAdd, ...rest } = device;
    const add = [ownAdd, twin.account_add].find(record => record !== undefined &&
      (rules.boundAccount === undefined || (rules.boundAccount !== null && isObject(record) && record["account"] === rules.boundAccount)));
    // this dir keeps its own origin for the key it admitted; only a copy that carries another origin, or another key,
    // takes it away: a copy with none erases nothing, and the sibling's never comes here (P22, T27 in 2d). Main never
    // writes an origin, so this holds with the release flag off too
    const mergedKey = takes ? twin.relay_public_key : device.relay_public_key;
    const origin = keptOrigin(device, twin, mergedKey);
    // a key this dir never held is no row of its own here: its one-time legacy pass never stamps it (T50)
    const notOwnKey = mergedKey !== device.relay_public_key;
    const keptMark = takes ? twin.joined_by : own;
    const otherMark = takes ? own : staleMembership ? undefined : twin.joined_by;
    const marks = [keptMark, otherMark].filter((mark) => mark !== undefined);
    const word = marks.findIndex((mark) => !VOUCHED.has(mark));
    const joinedBy = word >= 0 ? marks[word] : device.account !== undefined && device.account === twin.account ? marks[0] : keptMark;
    // the tailnet nodes the same credential came from in either dir: a removal must keep every one of them out
    const nodes = twin.token_hash === device.token_hash ? [...new Set([...device.tailnet_nodes ?? [], ...twin.tailnet_nodes ?? []])] : device.tailnet_nodes ?? [];
    devices.push({
      ...rest,
      ...(nodes.length === 0 ? {} : { tailnet_nodes: nodes }),
      ...(rules.dropConflictingKeys && twin.held && !device.held ? { held: twin.held } : {}),
      ...(joinedBy === undefined ? {} : { joined_by: joinedBy }),
      ...(origin === undefined ? {} : { origin }),
      ...(notOwnKey ? { imported: true as const } : {}),
      ...history,
      // the signed add behind the row, kept from either copy (/api/account/status lists it)
      ...(add === undefined ? {} : { account_add: add }),
      ...(takes
        ? { relay_public_key: twin.relay_public_key, account: twin.account, ...(twin.added_by === undefined ? {} : { added_by: twin.added_by }), ...(twin.linked_at === undefined ? {} : { linked_at: twin.linked_at }), ...(twin.link_moved_key === undefined ? {} : { link_moved_key: twin.link_moved_key }) } : {}),
    });
  }
  for (const device of theirs) {
    // revoked here since the last merge
    if (myIds.has(device.id) || own !== null && !incomplete.own && bases.own?.has(device.id)) continue;
    // a row only the other dir holds has no place in this dir's order, and is marked as no row of this dir's own, so
    // this dir's one-time legacy pass never stamps it (T50)
    const { origin: _elsewhere, ...copied } = device;
    if (rules.holdImports) held.push(device);
    else devices.push({ ...copied, imported: true });
  }
  // every piece of evidence that either side was ever gated keeps the merge gated
  const gate = earliest([own?.gate_closed_at, other?.gate_closed_at, ...mine.map((d) => d.created_at), ...theirs.map((d) => d.created_at)]);
  return { gate_closed_at: gate, devices, held };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isSnapshot = (value: unknown): value is PreferencesSnapshot =>
  isObject(value) && isObject(value["settings"]) && isStrings(value["muted_panes"]) && (value["pins"] === undefined || isStrings(value["pins"]));
const isRecord = (value: unknown): value is MergeRecord =>
  isObject(value) && value["version"] === 1 && Number.isSafeInteger(value["seq"]) && typeof value["at"] === "string"
  && isStrings(value["dirs"]) && isStrings(value["devices"])
  && (value["legacy_credentials"] === undefined || isStrings(value["legacy_credentials"]))
  && (value["legacy_identity"] === undefined || typeof value["legacy_identity"] === "string")
  && isObject(value["preferences"]) && Object.values(value["preferences"]).every(isSnapshot)
  && (value["preferences_target"] === undefined || isSnapshot(value["preferences_target"]))
  && isObject(value["push"]) && Object.values(value["push"]).every(isStrings)
  && (value["gated"] === undefined || typeof value["gated"] === "boolean")
  && (value["pending"] === undefined || isObject(value["pending"]) && isStrings(value["pending"]["ids"])
    && isObject(value["pending"]["sides"]) && Object.values(value["pending"]["sides"]).every((side) =>
      isObject(side) && typeof side["same"] === "boolean" && (side["temp"] === null || typeof side["temp"] === "string")
      && (side["base"] === null || isStrings(side["base"]))));

function readRecord(dirs: string[], pair: string[]): MergeRecord | null {
  let found: MergeRecord | null = null;
  for (const dir of dirs) {
    const read = readStateDocument(join(dir, RECORD));
    if (read.kind === "missing") continue;
    const value = read.kind === "json" ? read.value : null;
    if (!isRecord(value)) throw new Error(`${join(dir, RECORD)} is not a state merge record`);
    if (text(value.dirs) !== text(pair)) continue;
    if (found === null || value.seq > found.seq) found = value;
  }
  return found;
}

/**
 * A merge that cannot run leaves the store gated in this process only. So that a release before
 * this one, which knows nothing of the merge, stays gated on this dir too, the dir's own registry
 * gets a closed gate, its devices as they are; a damaged one is left alone (it keeps every release gated).
 */
function closeFailedMergeGate(active: string, now: Date, opensAll: boolean): void {
  const path = join(active, "devices.json");
  const own = readDeviceRegistry(path, opensAll);
  if (own.kind === "bad" || own.kind === "ok" && (own.gateClosedAt !== null || own.devices.length > 0)) return;
  try {
    backUp(active, "devices.json", now.toISOString().replace(/[:.]/g, "-"));
    // where there was no registry, the marks keep the next merge from reading its empty list as
    // every device revoked: one in the registry, and one beside it that an older release saving the
    // registry does not erase
    if (own.kind === "missing") markIncomplete(active, true);
    writePrivateState(path, { gate_closed_at: now.toISOString(), devices: own.kind === "ok" ? own.devices : [], ...(own.kind === "missing" ? { placeholder: true } : {}) });
  } catch (error) {
    console.error(`Cannot close the gate in ${path}: a release before this one may start on it ungated: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function markIncomplete(dir: string, incomplete: boolean): void {
  if (incomplete) writePrivateState(join(dir, INCOMPLETE), { devices_incomplete: true });
  else rmSync(join(dir, INCOMPLETE), { force: true });
}

function backUp(dir: string, name: string, stamp: string): void {
  const from = join(dir, name);
  try { statSync(from); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const to = join(dir, BACKUPS, stamp);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  copyFileSync(from, join(to, name));
}

function readPreferences(dir: string): { doc: PreferencesSnapshot & { revision: number }; written: number } | null {
  const read = readStateDocument(join(dir, "preferences.json"));
  const mutes = readStateDocument(join(dir, "muted-panes.json"));
  const body = read.kind === "missing" ? { settings: {} } : sharedPreferencesBody(read.kind === "json" ? read.value : undefined);
  const muted = mutes.kind === "missing" ? [] : mutes.kind === "json" ? sharedPreferencesBody({ settings: {}, muted_panes: (mutes.value as { muted_panes?: unknown } | null)?.muted_panes })?.muted_panes : undefined;
  if (body === null || muted === undefined) return null;
  const raw = read.kind === "json" ? read.value as { revision?: unknown } : {};
  const revision = Number.isSafeInteger(raw.revision) ? Math.max(0, raw.revision as number) : 0;
  let written = 0;
  try { written = statSync(join(dir, "preferences.json")).mtimeMs; } catch {}
  return { doc: { revision, settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }), muted_panes: muted ?? [] }, written };
}

type Intent = (ids: string[], sides: NonNullable<MergeRecord["pending"]>["sides"], gated: boolean) => string | null;

/** Whether a release before this one reading `read` keeps its gate closed. */
const closedFor = (read: ReturnType<typeof readDeviceRegistry>): boolean =>
  read.kind === "bad" || read.kind === "ok" && (read.gateClosedAt !== null || read.devices.length > 0);

/**
 * The origin a folder's copy keeps after a merge whose row holds `key` (P22, T27 in 2d): its own exactly when its copy
 * holds that key. Only another origin the other copy gives the same key takes it away; one for another key decides
 * nothing.
 */
function keptOrigin(copy: StoredDevice, other: StoredDevice, key: string | undefined): RowOrigin | undefined {
  const own = copy.origin;
  if (own === undefined || copy.relay_public_key !== key) return undefined;
  const theirs = other.origin;
  if (theirs === undefined || other.relay_public_key !== key) return own;
  return own.from === theirs.from && own.how === theirs.how && own.by === theirs.by && own.admit_no === theirs.admit_no && own.at === theirs.at ? own : undefined;
}

function registryMergeInputs([active, sibling]: readonly [string, string], [own, other]: readonly [DeviceRegistry, DeviceRegistry], base: MergeRecord | null) {
  const baseOf = (dir: string): ReadonlySet<string> | null => {
    if (base === null) return null;
    const side = base.pending?.sides[realpath(dir)];
    if (base.pending === undefined || side === undefined) return new Set(base.devices);
    if (side.same || side.temp !== null && !existsSync(side.temp)) return new Set(base.pending.ids);
    return side.base === null ? null : new Set(side.base);
  };
  // An incomplete registry adds its devices and its closed gate, and revokes nothing.
  const incomplete = {
    own: own.kind === "ok" && own.placeholder || existsSync(join(active, INCOMPLETE)),
    other: other.kind === "ok" && other.placeholder || existsSync(join(sibling, INCOMPLETE)),
  };
  const registry = (read: DeviceRegistry): Registry | null => read.kind === "ok" ? { gate_closed_at: read.gateClosedAt, devices: read.devices } : null;
  return { bases: { own: baseOf(active), other: baseOf(sibling) }, incomplete, mine: registry(own), theirs: registry(other) };
}

/** The registry startup would give the active folder, without publishing a merge or its intent. */
export function projectMergedMembers(folders: readonly [string, string], registries: readonly [DeviceRegistry, DeviceRegistry], rules: Pick<MergeRules, "holdImports" | "boundAccount">): readonly StoredDevice[] {
  const base = readRecord([...folders], folders.map(realpath).sort());
  const { bases, incomplete, mine, theirs } = registryMergeInputs(folders, registries, base);
  return mergeRegistries(mine, theirs, bases, incomplete, { ...rules, dropConflictingKeys: true }).devices;
}

function mergeDevices(active: string, sibling: string, base: MergeRecord | null, stamp: string, intend: Intent, now: Date, rules: MergeRules, identity: string | undefined, legacy: Set<string>): { blocked: string | null; ids: string[] | null; changed: number; gated?: boolean } {
  const ownPath = join(active, "devices.json");
  const otherPath = join(sibling, "devices.json");
  const opensAll = rules.dropConflictingKeys === true;
  const own = readDeviceRegistry(ownPath, opensAll);
  const other = readDeviceRegistry(otherPath, opensAll);
  const unreadable = own.kind === "bad" ? ownPath : other.kind === "bad" ? otherPath : null;
  if (unreadable !== null) {
    return { ids: null, changed: 0, blocked: `Cannot read ${unreadable}, so the paired devices of ${active} and ${sibling} cannot be merged. Restore a valid devices.json there or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.` };
  }
  const { bases, incomplete, mine, theirs } = registryMergeInputs([active, sibling], [own, other], base);
  if (rules.dropConflictingKeys && identity !== undefined && base !== null && !incomplete.own && !incomplete.other) {
    const eligible = (row: StoredDevice): boolean => !row.invalid_origin && row.held === undefined
      && (row.origin === undefined || row.origin.from === "legacy")
      && row.carried_notice === undefined && row.paired_over === undefined;
    const twins = new Map(theirs?.devices.filter(eligible).map(row => [row.id, row]));
    const previouslyVerified = new Set(base.legacy_credentials);
    for (const row of mine?.devices ?? []) {
      const twin = twins.get(row.id);
      if (!twin || !eligible(row) || row.imported && twin.imported || !bases.own?.has(row.id) || !bases.other?.has(row.id)) continue;
      const fingerprint = credentialFingerprint(identity, row);
      if (fingerprint === credentialFingerprint(identity, twin)
        && (base.legacy_credentials === undefined || previouslyVerified.has(fingerprint))) legacy.add(fingerprint);
    }
  }
  if (mine === null && theirs === null) {
    // both gone after a merge that knew paired devices or a closed gate: this is no first installation
    if (base !== null && (base.devices.length > 0 || base.gated === true || (base.pending?.ids.length ?? 0) > 0)) {
      return { ids: null, changed: 0, blocked: `Neither ${ownPath} nor ${otherPath} exists, although the last merge of these dirs knew ${base.devices.length} paired device(s)${base.gated ? " and a closed gate" : ""}. Restore devices.json from ${join(active, BACKUPS)} or ${join(sibling, BACKUPS)}, then restart the server. External access without a token or trusted Tailscale login remains blocked.` };
    }
    return { blocked: null, ids: [], changed: 0 };
  }
  const { held, ...merged } = mergeRegistries(mine, theirs, bases, incomplete, rules);
  // the sibling's file is its own word on its own rows: a row only it held keeps its origin
  // and mark there, a twin the origin both copies agree on, and a row only this dir held is a copy there (P22, T50)
  const myCopy = new Map((mine?.devices ?? []).map((device) => [device.id, device]));
  const theirCopy = new Map((theirs?.devices ?? []).map((device) => [device.id, device]));
  const otherMerged = { ...merged, devices: merged.devices.map(({ origin: _here, imported: _marked, recovered_over: _hereRecovery, ...device }) => {
    const copy = theirCopy.get(device.id);
    if (copy === undefined) return { ...device, imported: true as const };
    const mineToo = myCopy.get(device.id);
    if (!rules.dropConflictingKeys && mineToo && separateHeldTwins(mineToo, copy)) return { ...copy, role: device.role };
    const kept = mineToo === undefined ? copy.origin : keptOrigin(copy, mineToo, device.relay_public_key);
    const other = { ...device, ...(kept === undefined ? {} : { origin: kept }),
      ...(kept?.from === "recover" && copy.recovered_over ? { recovered_over: copy.recovered_over } : {}),
      ...(copy.imported || copy.relay_public_key !== device.relay_public_key ? { imported: true as const } : {}) };
    if (rules.dropConflictingKeys && device.relay_public_key === undefined) {
      other.created_at = copy.created_at;
      if (copy.token_hash !== device.token_hash) other.untrusted_created_at = copy.created_at;
      else if (copy.untrusted_created_at === undefined) delete other.untrusted_created_at;
      else other.untrusted_created_at = copy.untrusted_created_at;
      if (copy.token_hash === device.token_hash && copy.off_pair_binding !== undefined) other.off_pair_binding = copy.off_pair_binding;
      else delete other.off_pair_binding;
    }
    if (!rules.dropConflictingKeys && mineToo) {
      if (Object.hasOwn(copy, "held")) other.held = copy.held;
      else delete other.held;
    }
    return other;
  }) };
  // rows held back from an import stay in the other dir's file, and out of the ids this merge records
  if (held.length) otherMerged.devices.push(...held);
  // with a complete registry in it, the result holds every device not revoked since the last merge
  const complete = mine !== null && !incomplete.own || theirs !== null && !incomplete.other;
  const onDisk = (read: typeof own) => read.kind === "ok" ? { gate_closed_at: read.gateClosedAt, devices: read.devices, ...(read.placeholder ? { placeholder: true } : {}) } : null;
  const added = merged.devices.filter((device) => !mine?.devices.some((held) => held.id === device.id)).length;
  const needOwn = text(onDisk(own)) !== text(merged);
  const needOther = text(onDisk(other)) !== text(otherMerged);
  const ownFailed = (error: unknown) => ({ ids: null, changed: 0, blocked: `Cannot write the paired devices of ${sibling} into ${ownPath} (${error instanceof Error ? error.message : String(error)}). Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.` });
  let ownTemp: string | null = null;
  let otherTemp: string | null = null;
  let otherUnprepared: unknown = null;
  if (needOwn) {
    try { ownTemp = preparePrivateState(ownPath, merged); } catch (error) { return ownFailed(error); }
  }
  if (needOther) {
    try { otherTemp = preparePrivateState(otherPath, otherMerged); } catch (error) { otherUnprepared = error; }
  }
  if (needOwn || needOther) {
    const side = (need: boolean, temp: string | null, base: ReadonlySet<string> | null) => ({ same: !need, temp, base: base === null ? null : [...base] });
    const failed = intend(merged.devices.map((device) => device.id), { [realpath(active)]: side(needOwn, ownTemp, bases.own), [realpath(sibling)]: side(needOther, otherTemp, bases.other) }, merged.gate_closed_at !== null);
    if (failed !== null) {
      for (const temp of [ownTemp, otherTemp]) if (temp !== null) rmSync(temp, { force: true });
      return { ids: null, changed: 0, blocked: failed };
    }
  }
  if (ownTemp !== null) {
    try {
      backUp(active, "devices.json", stamp);
      publishPrivateState(ownTemp, ownPath);
    } catch (error) { return ownFailed(error); }
  }
  try { markIncomplete(active, !complete); }
  catch (error) {
    return { ids: null, changed: 0, blocked: `Cannot mark whether ${ownPath} is complete (${error instanceof Error ? error.message : String(error)}). Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.` };
  }
  if (needOther) {
    try {
      if (otherTemp === null) throw otherUnprepared;
      backUp(sibling, "devices.json", stamp);
      publishPrivateState(otherTemp, otherPath);
    } catch (error) {
      const reason = `Cannot write the merged paired devices into ${otherPath}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(reason);
      // that release must at least find a closed gate there, and no device revoked here
      if (!closedFor(readDeviceRegistry(otherPath, opensAll))) closeFailedMergeGate(sibling, now, opensAll);
      const left = readDeviceRegistry(otherPath, opensAll);
      const revokedThere = left.kind === "ok" && left.devices.some((device) => !merged.devices.some((kept) => kept.id === device.id));
      const risk = !closedFor(left) ? "have no sign-in gate" : revokedThere ? "still let in a device revoked here" : null;
      const known = new Set([...merged.devices.map((device) => device.id), ...bases.other ?? []]);
      const blocked = risk === null ? null : `${reason}. An Ovis release before 0.4.16 starting on ${sibling} would ${risk}. Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      return { blocked, ids: (theirs?.devices ?? []).map((device) => device.id).filter((id) => known.has(id)), changed: added, gated: merged.gate_closed_at !== null };
    }
  }
  try { markIncomplete(sibling, !complete); }
  catch (error) { console.error(`Cannot mark whether ${otherPath} is complete: ${error instanceof Error ? error.message : String(error)}`); }
  return { blocked: null, ids: merged.devices.map((device) => device.id), changed: added, gated: merged.gate_closed_at !== null };
}

function mergePreferences(active: string, sibling: string, base: MergeRecord | null, stamp: string): { snapshots: Record<string, PreferencesSnapshot>; target: PreferencesSnapshot } | null {
  const own = readPreferences(active);
  const other = readPreferences(sibling);
  if (own === null || other === null) {
    console.error(`The shared preferences of ${own === null ? active : sibling} cannot be read; those of ${sibling} are not merged into ${active}`);
    return null;
  }
  const target = base?.preferences_target ?? null;
  const ownBefore = target === null ? null : base?.preferences[realpath(active)] ?? null;
  const otherBefore = target === null ? null : base?.preferences[realpath(sibling)] ?? null;
  const theirsNewer = other.written > own.written;
  const changed = (value: unknown, was: PreferencesSnapshot | null, at: (snapshot: PreferencesSnapshot) => unknown) =>
    value !== undefined && (was === null || text(value) !== text(at(was)));
  const pick = (mine: unknown, theirs: unknown, at: (snapshot: PreferencesSnapshot) => unknown): unknown => {
    if (target === null) return theirs !== undefined && (mine === undefined || theirsNewer) ? theirs : mine;
    const mineChanged = changed(mine, ownBefore, at);
    const theirsChanged = changed(theirs, otherBefore, at);
    if (mineChanged && theirsChanged && text(mine) !== text(theirs)) return theirsNewer ? theirs : mine;
    return mineChanged ? mine : theirsChanged ? theirs : at(target);
  };
  const settings: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(own.doc.settings), ...Object.keys(other.doc.settings), ...Object.keys(target?.settings ?? {})]);
  for (const key of keys) {
    const read = (held: { settings: PreferencesChange["settings"] }) => (held.settings as Record<string, unknown>)[key];
    const value = pick(read(own.doc), read(other.doc), read);
    if (value !== undefined) settings[key] = value;
  }
  const pins = pick(own.doc.pins, other.doc.pins, (snapshot) => snapshot.pins) as string[] | undefined;
  let muted: string[];
  if (target === null) muted = [...own.doc.muted_panes, ...other.doc.muted_panes.filter((pane) => !own.doc.muted_panes.includes(pane))];
  else {
    const set = new Set(target.muted_panes);
    for (const [now, was] of [[own.doc.muted_panes, ownBefore?.muted_panes], [other.doc.muted_panes, otherBefore?.muted_panes]] as const) {
      for (const pane of now) if (!was?.includes(pane)) set.add(pane);
      for (const pane of was ?? []) if (!now.includes(pane)) set.delete(pane);
    }
    muted = [...set];
  }
  const merged = { settings: settings as PreferencesChange["settings"], ...(pins === undefined ? {} : { pins }), muted_panes: muted };
  const document = { revision: Math.max(own.doc.revision, other.doc.revision) + 1, settings: merged.settings, ...(pins === undefined ? {} : { pins }) };
  if (sharedPreferencesBody(merged) === null || new TextEncoder().encode(text({ ...document, muted_panes: muted })).length > MAX_PREFERENCES_BYTES) {
    console.error(`The shared preferences of ${sibling} and ${active} together are too large; those of ${sibling} are not merged`);
    return null;
  }
  const write = (dir: string, held: PreferencesSnapshot): boolean => {
    try {
      if (text(merged.settings) !== text(held.settings) || text(pins) !== text(held.pins)) {
        backUp(dir, "preferences.json", stamp);
        writeStateDocument(join(dir, "preferences.json"), `${JSON.stringify(document, null, 2)}\n`, false);
      }
      if (text(muted) !== text(held.muted_panes)) {
        backUp(dir, "muted-panes.json", stamp);
        writeStateDocument(join(dir, "muted-panes.json"), `${JSON.stringify({ muted_panes: muted }, null, 2)}\n`, false);
      }
      return true;
    } catch (error) {
      console.error(`Cannot write the merged shared preferences into ${dir}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  write(active, own.doc);
  write(sibling, other.doc);
  mergeStateId(active, sibling, stamp);
  const held = (dir: string, fallback: PreferencesSnapshot | null): PreferencesSnapshot | null => {
    const read = readPreferences(dir);
    if (read === null) return fallback;
    const { revision: _revision, ...snapshot } = read.doc;
    return snapshot;
  };
  const snapshots: Record<string, PreferencesSnapshot> = {};
  for (const [dir, before] of [[active, ownBefore], [sibling, otherBefore]] as const) {
    const snapshot = held(dir, before);
    if (snapshot !== null) snapshots[realpath(dir)] = snapshot;
  }
  return { snapshots, target: merged };
}

function mergeStateId(active: string, sibling: string, stamp: string): void {
  try {
    const own = readStateId(active);
    const other = readStateId(sibling);
    if (own === null || other === null) return;
    if (own !== undefined && other !== own) {
      if (other !== undefined) backUp(sibling, STATE_ID_FILE, stamp);
      writeStateId(sibling, own);
    } else if (own === undefined && other !== undefined) writeStateId(active, other);
  } catch (error) {
    console.error(`Cannot give ${active} and ${sibling} one state folder id: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } } & Record<string, unknown>;

function readPushFile(path: string): unknown {
  const read = readStateDocument(path);
  if (read.kind === "malformed") throw new Error(`${path} is not JSON`);
  return read.kind === "json" ? read.value : undefined;
}

function subscriptionsIn(value: unknown): Subscription[] {
  return (Array.isArray(value) ? value : []).filter((entry): entry is Subscription => {
    const { endpoint, keys } = (entry ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    return typeof endpoint === "string" && typeof keys?.p256dh === "string" && typeof keys.auth === "string";
  });
}

type Vapid = { publicKey: string; privateKey: string };

function vapidIn(value: unknown): Vapid | null {
  const { publicKey, privateKey } = (value ?? {}) as { publicKey?: unknown; privateKey?: unknown };
  return typeof publicKey === "string" && typeof privateKey === "string" ? { publicKey, privateKey } : null;
}

function mergePush(active: string, sibling: string, base: MergeRecord | null, stamp: string): { record: Record<string, string[]>; taken: number } | null {
  try {
    const theirs = subscriptionsIn(readPushFile(join(sibling, "push-subscriptions.json")));
    const theirKey = vapidIn(readPushFile(join(sibling, "vapid.json")));
    const before = base?.push[realpath(sibling)] ?? [];
    // an endpoint counts as taken over once it is here, or kept out on purpose: never one skipped for a key it lacks
    const recorded = (done: Subscription[]) => ({ [realpath(sibling)]: [...new Set([...before, ...done.map((subscription) => endpointHash(subscription.endpoint))])] });
    if (theirs.length === 0) return { record: recorded([]), taken: 0 };
    // the key each of their subscriptions was made for: one they took over keeps its own
    const theirExtra = new Map<string, Vapid>();
    const extraFile = readPushFile(join(sibling, PUSH_EXTRA_KEYS)) as { keys?: unknown } | undefined;
    for (const entry of Array.isArray(extraFile?.keys) ? extraFile.keys as { endpoints?: unknown }[] : []) {
      const key = vapidIn(entry);
      if (key !== null && isStrings(entry.endpoints)) for (const endpoint of entry.endpoints) theirExtra.set(endpoint, key);
    }
    const keyOf = (endpoint: string): Vapid | null => theirExtra.get(endpoint) ?? theirKey;
    const mine = subscriptionsIn(readPushFile(join(active, "push-subscriptions.json")));
    const myFile = readPushFile(join(active, "vapid.json"));
    let myKey = vapidIn(myFile);
    // push.ts never replaces a damaged key file (every subscription made for it would go): neither does this
    if (myFile !== undefined && myKey === null) throw new Error(`${join(active, "vapid.json")} is malformed`);
    let retired: string[] = [];
    try {
      const value = readPushFile(join(active, "push-retired.json"));
      retired = (Array.isArray(value) ? value : []).map((entry) => (entry as { hash?: unknown } | null)?.hash).filter((hash): hash is string => typeof hash === "string");
    } catch {}
    // push.ts keys a retired mark by the normalized endpoint (a mark from before #2012 by the spelling handed over)
    const settled = (subscription: Subscription) => mine.some((held) => held.endpoint === subscription.endpoint)
      || before.includes(endpointHash(subscription.endpoint))
      || retired.includes(endpointHash(subscription.endpoint)) || retired.includes(endpointHash(normalizeEndpoint(subscription.endpoint)));
    const taken = theirs.filter((subscription) => !settled(subscription) && keyOf(subscription.endpoint) !== null);
    const record = recorded(theirs.filter((subscription) => settled(subscription) || taken.includes(subscription)));
    if (taken.length === 0) return { record, taken: 0 };
    if (myKey === null && theirKey !== null) {
      // this dir has signed nothing yet: the other dir's key becomes its own
      writePrivateState(join(active, "vapid.json"), theirKey);
      myKey = theirKey;
    }
    const foreign = taken.filter((subscription) => keyOf(subscription.endpoint)!.publicKey !== myKey?.publicKey);
    if (foreign.length > 0) {
      const path = join(active, PUSH_EXTRA_KEYS);
      const stored = readPushFile(path) as { keys?: unknown } | undefined;
      const keys = (Array.isArray(stored?.keys) ? stored.keys : []) as { publicKey?: unknown; privateKey?: unknown; endpoints?: unknown }[];
      for (const subscription of foreign) {
        const key = keyOf(subscription.endpoint)!;
        const index = keys.findIndex((held) => held.publicKey === key.publicKey);
        const endpoints = index === -1 ? [] : isStrings(keys[index]!.endpoints) ? keys[index]!.endpoints as string[] : [];
        const entry = { ...key, endpoints: [...new Set([...endpoints, subscription.endpoint])] };
        if (index === -1) keys.push(entry);
        else keys[index] = entry;
      }
      backUp(active, PUSH_EXTRA_KEYS, stamp);
      writePrivateState(path, { keys });
    }
    backUp(active, "push-subscriptions.json", stamp);
    writePrivateState(join(active, "push-subscriptions.json"), [...mine, ...taken]);
    return { record, taken: taken.length };
  } catch (error) {
    console.error(`Cannot merge the push subscriptions of ${sibling} into ${active}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The exact credentials this folder's last successful merge witnessed. */
export function recordedLegacyCredential(active: string): ((row: StoredDevice) => boolean) | undefined {
  const read = readStateDocument(join(active, RECORD));
  const record = read.kind === "json" && isRecord(read.value) ? read.value : null;
  const identity = record?.legacy_identity;
  if (!record?.dirs.includes(realpath(active)) || identity === undefined || !record.legacy_credentials?.length) return undefined;
  const verified = new Set(record.legacy_credentials);
  return row => verified.has(credentialFingerprint(identity, row));
}

export function mergeSiblingState(active: string, sibling: string, now = new Date(), rules: MergeRules = {}): SiblingMerge {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let blocked: string | null;
  try {
    blocked = merge(active, sibling, now, stamp, rules);
  } catch (error) {
    // whatever went wrong, the server still starts, gated: a start that failed would fall back to an older release
    blocked = `Cannot merge the state of ${sibling} into ${active} (${error instanceof Error ? error.message : String(error)}). External access without a token or trusted Tailscale login remains blocked; restart the server once it is fixed.`;
  }
  if (blocked !== null) closeFailedMergeGate(active, now, rules.dropConflictingKeys === true);
  const legacyCredential = blocked === null && rules.dropConflictingKeys ? recordedLegacyCredential(active) : undefined;
  return { devicesBlocked: blocked, ...(legacyCredential ? { legacyCredential } : {}) };
}

function merge(active: string, sibling: string, now: Date, stamp: string, rules: MergeRules): string | null {
  const pair = [realpath(active), realpath(sibling)].sort();
  let base: MergeRecord | null;
  try {
    base = readRecord([active, sibling], pair);
  } catch (error) {
    // without the last merge a revoked device could come back: nothing is merged, and the store stays gated
    return `${error instanceof Error ? error.message : String(error)}, so the paired devices of ${active} and ${sibling} cannot be merged. Restore or remove it, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
  }
  // Reset does not change the identity used to hash old witnesses. Revalidate those exact twins;
  // only a merge without a previous witness list may establish witnesses with today's shared identity.
  const identity = (base?.legacy_credentials !== undefined ? base.legacy_identity : undefined) ?? rules.sharedLegacyIdentity;
  const legacy = new Set<string>();
  const witnessed = () => !rules.dropConflictingKeys ? {} : {
    legacy_credentials: [...legacy], ...(identity === undefined ? {} : { legacy_identity: identity }),
  };
  let intent: MergeRecord | null = null;
  const intend: Intent = (ids, sides, gated) => {
    intent = { version: 1, seq: (base?.seq ?? 0) + 1, at: now.toISOString(), dirs: pair, devices: base?.devices ?? [],
      ...witnessed(),
      gated: gated || base?.gated === true, preferences: base?.preferences ?? {},
      ...(base?.preferences_target ? { preferences_target: base.preferences_target } : {}), push: base?.push ?? {}, pending: { ids, sides } };
    try { writePrivateState(join(active, RECORD), intent); }
    catch (error) {
      intent = null;
      return `Cannot write ${join(active, RECORD)} before publishing the merged paired devices (${error instanceof Error ? error.message : String(error)}). Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
    }
    try { writePrivateState(join(sibling, RECORD), intent); } catch {}
    return null;
  };
  const devices = mergeDevices(active, sibling, base, stamp, intend, now, rules, identity, legacy);
  const written = intent as MergeRecord | null;
  const preferences = mergePreferences(active, sibling, base, stamp);
  const push = mergePush(active, sibling, base, stamp);
  if (devices.changed > 0 || push !== null && push.taken > 0) {
    console.log(`Ovis took over ${devices.changed} paired device(s) and ${push?.taken ?? 0} push subscription(s) from ${sibling} into ${active}; replaced files are kept in ${join(active, BACKUPS)}`);
  }
  const record: MergeRecord = {
    version: 1,
    seq: (written?.seq ?? base?.seq ?? 0) + 1,
    at: now.toISOString(),
    dirs: pair,
    devices: devices.ids ?? base?.devices ?? [],
    ...witnessed(),
    ...(devices.ids === null && (written?.pending ?? base?.pending) ? { pending: written?.pending ?? base?.pending } : {}),
    gated: devices.gated === true || base?.gated === true,
    preferences: preferences?.snapshots ?? base?.preferences ?? {},
    ...(preferences?.target ?? base?.preferences_target ? { preferences_target: preferences?.target ?? base?.preferences_target } : {}),
    push: { ...base?.push, ...push?.record },
  };
  let blocked = devices.blocked;
  let recorded = false;
  for (const dir of [active, sibling]) {
    try {
      writePrivateState(join(dir, RECORD), record);
      recorded = true;
    } catch (error) {
      const reason = `Cannot write ${join(dir, RECORD)}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(reason);
      // without it the next merge compares with an older one, and would bring back a device revoked
      // until then: blocked, the device store changes nothing while this server runs, so none is revoked
      if (dir === active) blocked ??= `${reason}. Fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
    }
  }
  if (recorded && record.pending === undefined) {
    for (const pending of [written?.pending, base?.pending]) {
      for (const side of Object.values(pending?.sides ?? {})) if (side.temp !== null) rmSync(side.temp, { force: true });
    }
  }
  return blocked;
}
