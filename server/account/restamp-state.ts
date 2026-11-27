/** Read the restamp inputs without opening stores or running their repair and merge paths. */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isIsoTime } from "../../shared/account-records.ts";
import { futureLegacyPairing, parseDeviceRegistry, parseTombstones, repairEvidenceRows, type AccountTombstone, type DeviceRegistry } from "../devices.ts";
import { isJsonObject } from "../http.ts";
import { privateStateRefusal } from "../private-state.ts";
import { relayIdentityPath, savedServerId } from "../relay/identity.ts";
import { projectMergedMembers } from "../state-merge.ts";
import { parseAccountDevicesForIdentity } from "./account-device-state.ts";
import { mergedRemovalEvidence } from "./account-merge.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { endedJournalRows, isJournalDoc, restampJournalProblem } from "./device-journal.ts";
import { mergePcBinding, parsePcAccount, restampMemberProblem, rowNumberProblem } from "./pc-binding.ts";
import { localRevokeId, parseEvidence, REMOVAL_FILE, RemovalEvidence, type Unrevoke } from "./removal-evidence.ts";
import { DEVICE_JOURNAL_FILE, parseLog, SAFETY_LOG_FILE, SAFETY_OVERFLOW_FILE, SafetyLog } from "./safety-log.ts";

export type RestampField = "created_at" | "confirmed_at" | "removed_at" | "at";
export type RestampAddress = { readonly store: string; readonly ref: string; readonly field: RestampField };
export type RestampMove = RestampAddress & { readonly old: string; readonly new: string };
export type RestampLink = { readonly store: string; readonly ref: string; readonly old: string; readonly new: string };
export type RestampFolders = { readonly stateDir: string; readonly sibling?: string | null | undefined };
type Doc = Record<string, unknown>;
type Slot = RestampAddress & { readonly value: string; readonly row: Doc };

export function readRestampJson(path: string): unknown {
  checkRestampFile(path);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${path}`, { cause: error });
  }
}

/** Restamp trusts the file as found. In particular, never soften the safety log's or ledger's write-mode rule. */
export function checkRestampFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || (stat.mode & 0o022) !== 0)) throw new RestampTrustError(`${path} is not a private regular file`);
  const refused = privateStateRefusal(path, undefined, undefined, false);
  if (refused !== null) throw new RestampTrustError(refused);
}

export class RestampTrustError extends Error {}

export function restampRelayId(dir: string): string | null {
  const path = relayIdentityPath(dir);
  checkRestampFile(path);
  const id = savedServerId(dir);
  if (id === undefined && lstatSync(path, { throwIfNoEntry: false })) throw new Error(`Cannot read ${path}`);
  return id ?? null;
}

/** Check all paths before a refusal audit: a later trust refusal must not leave earlier writes behind. */
export function checkRestampInputs({ stateDir, sibling }: RestampFolders): void {
  for (const dir of sibling ? [stateDir, sibling] : [stateDir]) {
    for (const file of ["devices.json", ACCOUNT_DEVICES_FILE, DEVICE_JOURNAL_FILE, ADMISSION_FILE, REMOVAL_FILE,
      "account-tombstones.json", "account-tombstones.pending.json", SAFETY_LOG_FILE]) checkRestampFile(join(dir, file));
  }
}

/** An authenticated plan may be refused before the full state parses; audit only against healthy companions. */
export function openRestampAudit(dir: string): ReturnType<typeof readRestampJson> {
  const path = (file: string) => join(dir, file);
  const journal = readRestampJson(path(DEVICE_JOURNAL_FILE));
  const binding = parsePcAccount(readRestampJson(path(ADMISSION_FILE)));
  const evidence = parseEvidence(readRestampJson(path(REMOVAL_FILE)));
  const log = parseLog(readRestampJson(path(SAFETY_LOG_FILE)));
  if (journal === undefined || typeof binding === "string" || evidence === null || typeof log === "string" || log.overflowed) {
    throw new Error(`Cannot trust the restamp audit companions in ${dir}`);
  }
  const problem = restampJournalProblem(journal, evidence.row_drops ?? []);
  if (problem !== null) throw new Error(`${path(DEVICE_JOURNAL_FILE)} ${problem}`);
  return journal;
}

export function restampAddress({ store, ref, field }: RestampAddress): string {
  return JSON.stringify([store, ref, field]);
}

export function readRestampState(folders: RestampFolders, serverId: string | null) {
  const own = new Map<string, Slot>();
  const docs = new Map<string, { path: string; doc: Doc; original: string }>();
  const revokes = new Set<Slot>();
  const localTombstones = new Set<Slot>();
  const unrevokes = new Map<string, readonly Unrevoke[]>();
  const bindings: { dir: string; path: string; pc: Exclude<ReturnType<typeof parsePcAccount>, string> | null;
    registry: Exclude<DeviceRegistry, { kind: "bad" }>; log: Exclude<ReturnType<typeof parseLog>, string> | undefined }[] = [];
  const tombstones: AccountTombstone[] = [];
  const ledgers: NonNullable<ReturnType<typeof parseEvidence>>[] = [];
  const journals = new Map<string, unknown>();
  let nonOwn = -Infinity;
  const floor = (value: string) => {
    if (!isIsoTime(value)) throw new Error(`A timestamp from elsewhere is not ISO: ${value}`);
    nonOwn = Math.max(nonOwn, Date.parse(value));
  };
  const sibling = folders.sibling;
  const read = (dir: string, store: string, file: string) => {
    const path = join(dir, file);
    const doc = readRestampJson(path);
    if (doc === undefined) return undefined;
    if (!isJsonObject(doc)) throw new Error(`Cannot read ${path}`);
    docs.set(store, { path, doc, original: JSON.stringify(doc) });
    return doc;
  };
  const slot = (store: string, ref: string, field: RestampField, row: Doc) => {
    const value = row[field];
    if (!isIsoTime(value)) throw new Error(`Malformed own timestamp in ${store} (${ref}, ${field}): not ISO`);
    const address = restampAddress({ store, ref, field });
    if (own.has(address)) throw new Error(`Duplicate timestamp reference in ${store}: ${ref}`);
    const entry = { store, ref, field, value, row };
    own.set(address, entry);
    return entry;
  };
  const rows = (list: unknown, each: (row: Doc, index: number) => void) => {
    if (!Array.isArray(list)) throw new Error("A timestamp store has no row list");
    for (const [index, row] of list.entries()) {
      if (!isJsonObject(row)) throw new Error("A timestamp row is not an object");
      each(row, index);
    }
  };

  const main = folders.stateDir;
  const dirs = [{ dir: main, prefix: "" }];
  if (sibling && resolve(main) !== resolve(sibling)) {
    if (!existsSync(sibling)) throw new Error(`Restamp participant ${sibling} is unavailable`);
    if (realpathSync(main) !== realpathSync(sibling)) dirs.push({ dir: sibling, prefix: "sibling/" });
  }
  for (const { dir, prefix } of dirs) {
    // Sibling merges share the ordinary registry and evidence; their old copies must not be imported again.
    if (lstatSync(join(dir, "revoke-all.json"), { throwIfNoEntry: false })) throw new RestampTrustError("Finish the pending device removal before repairing the clock");
    const store = prefix + "devices.json";
    const devices = read(dir, store, "devices.json");
    const journal = readRestampJson(join(dir, DEVICE_JOURNAL_FILE));
    journals.set(dir, journal);
    const hasJournal = journal !== undefined;
    const binding = readRestampJson(join(dir, ADMISSION_FILE));
    const pc = binding === undefined ? null : parsePcAccount(binding);
    if (typeof pc === "string" || (pc === null && hasJournal)) throw new Error(`Cannot read ${prefix}${ADMISSION_FILE}`);
    const bindingPath = join(dir, ADMISSION_FILE);
    let registry: Exclude<DeviceRegistry, { kind: "bad" }> = { kind: "missing" };
    if (devices !== undefined) {
      const parsed = parseDeviceRegistry(devices, true);
      if (parsed.kind !== "ok") throw new Error(`Cannot read ${store}`);
      registry = parsed;
      const orderProblem = rowNumberProblem(bindingPath, pc?.next_admit ?? null, registry.devices);
      if (orderProblem !== null) throw new Error(orderProblem);
      const entries = isJournalDoc(journal) ? journal.entries : [];
      rows(devices.devices, (row, index) => {
        const device = parsed.devices[index];
        if (device && !device.imported && device.untrusted_created_at !== device.created_at && !futureLegacyPairing(device, entries, Date.now())) {
          slot(store, device.id, "created_at", row);
        }
      });
    }
    if (prefix === "" && serverId !== null) {
      const listed = read(dir, ACCOUNT_DEVICES_FILE, ACCOUNT_DEVICES_FILE);
      if (listed !== undefined) {
        if (!parseAccountDevicesForIdentity(listed, serverId).foreign) {
          rows(listed.devices, (row) => slot(ACCOUNT_DEVICES_FILE, String(row.id), "confirmed_at", row));
        }
      }
    }
    for (const file of ["account-tombstones.json", "account-tombstones.pending.json"]) {
      const store = prefix + file;
      const doc = read(dir, store, file);
      if (doc === undefined) continue;
      const found = parseTombstones(doc);
      if (found === null) throw new Error(`Cannot read ${store}`);
      tombstones.push(...found);
      rows(doc.tombstones, (row, index) => {
        if (row.record_id === "local") localTombstones.add(slot(store, JSON.stringify([row.key, row.account, index]), "removed_at", row));
        else if (typeof row.removed_at === "string") floor(row.removed_at);
      });
    }
    const removalStore = prefix + REMOVAL_FILE;
    const evidence = read(dir, removalStore, REMOVAL_FILE);
    if (evidence === undefined && (hasJournal || pc?.evidence_written)) throw new Error(`${removalStore} is missing`);
    const parsed = evidence === undefined ? undefined : parseEvidence(evidence);
    if (parsed === null) throw new Error(`Cannot read ${removalStore}`);
    const journalError = restampJournalProblem(journal, parsed?.row_drops ?? []);
    if (journalError !== null) throw new Error(`${prefix}${DEVICE_JOURNAL_FILE} ${journalError}`);
    if (evidence !== undefined && parsed !== undefined) {
      // paired_over holds IDs of these marker removals, never independent timestamps.
      for (const marker of parsed.markers) for (const removal of marker.removals) floor(removal.at);
      unrevokes.set(removalStore, parsed.unrevokes);
      // The Revoke ID changes with its at; key, account and file position do not.
      rows(evidence.revokes, (row, index) => { revokes.add(slot(removalStore, JSON.stringify([row.key, row.account, index]), "at", row)); });
      rows(evidence.unrevokes, (row) => slot(removalStore, String(row.id), "at", row));
    }
    const log = read(dir, prefix + SAFETY_LOG_FILE, SAFETY_LOG_FILE);
    if (log === undefined && hasJournal) throw new Error(`${prefix}${SAFETY_LOG_FILE} is missing`);
    const parsedLog = log === undefined ? undefined : parseLog(log);
    if (typeof parsedLog === "string" || parsedLog?.overflowed || lstatSync(join(dir, SAFETY_OVERFLOW_FILE), { throwIfNoEntry: false })) {
      throw new Error(`Cannot trust ${prefix}${SAFETY_LOG_FILE}`);
    }
    if (parsedLog !== undefined) {
      for (const entry of parsedLog.entries) {
        const cutoff = entry.asof?.legacy_created_at;
        if (cutoff !== undefined) nonOwn = Math.max(nonOwn, cutoff);
        // Startup replays standing signed Blocks into removal markers if their marker did not reach disk.
        if (entry.record.kind === "block") floor(entry.record.signed_at);
      }
      for (const { record } of parsedLog.waiting) floor(record.signed_at);
    }
    if (parsed) ledgers.push(parsed);
    bindings.push({ dir, path: bindingPath, pc, registry, log: parsedLog });
  }
  const [active, peer] = bindings;
  const safety = SafetyLog.projectedState(active?.log, peer?.log);
  const holdImports = safety.locked || safety.freezes.length > 0;
  const ledger = mergedRemovalEvidence(ledgers);
  for (const [index, { dir, path, pc, registry }] of bindings.entries()) {
    const counterpart = bindings[1 - index];
    const binding = counterpart?.pc ? mergePcBinding(pc, counterpart.pc).binding : pc?.binding;
    const boundAccount = pc && (!pc.counterOnly || pc.clears.length) ? binding?.account ?? null : undefined;
    const members = counterpart === undefined ? registry.kind === "ok" ? registry.devices : []
      : projectMergedMembers([dir, counterpart.dir], [registry, counterpart.registry], { holdImports, ...(boundAccount === undefined ? {} : { boundAccount }) });
    const journal = journals.get(dir);
    const ended = endedJournalRows(isJournalDoc(journal) ? journal.entries : []);
    const kept = members.filter(row => !ended.has(row.id) && (!safety.locked || row.origin?.from === "pc"));
    const evidence = RemovalEvidence.projected(join(dir, REMOVAL_FILE), ledger, safety, tombstones, repairEvidenceRows(kept.filter(row => !futureLegacyPairing(row, isJournalDoc(journal) ? journal.entries : [], Date.now())), Number.POSITIVE_INFINITY));
    const retained = kept.filter(row => !evidence.covers(row, binding?.account ?? null)
      && !safety.blocks.some(({ record }) => row.relay_public_key === record.target && record.kind === "block" && !evidence.hasRemoval(record.target, record.account, record.id)));
    const problem = restampMemberProblem(path, pc, counterpart?.pc ?? null, retained);
    if (problem !== null) throw new RestampTrustError(problem);
  }
  return { own, nonOwn, docs, revokes, localTombstones, unrevokes, journals };
}

/** A definition (or its local tombstone) has one derived ID before and after the timestamp move. */
function revokeMoves(state: ReturnType<typeof readRestampState>, mapping: readonly RestampMove[], rollback: boolean) {
  const moveBySlot = new Map(mapping.map((move) => [restampAddress(move), move]));
  const ids = new Map<string, { old: string; next: string }>();
  const oldByNew = new Map<string, string>();
  const occupied = new Map<unknown, Slot[]>();
  for (const slot of [...state.revokes, ...state.localTombstones]) {
    const { key, account } = slot.row;
    if (typeof key !== "string" || !(account === null || typeof account === "string")) throw new Error("Invalid Revoke or local tombstone");
    const id = slot.field === "removed_at" ? localRevokeId(key, account ?? "", slot.value) : slot.row.id;
    const copies = occupied.get(id);
    if (copies) copies.push(slot);
    else occupied.set(id, [slot]);
    const move = moveBySlot.get(restampAddress(slot));
    if (!move) continue;
    const old = localRevokeId(key, account ?? "", move.old);
    const next = localRevokeId(key, account ?? "", move.new);
    if (slot.value !== move.old && slot.value !== move.new && rollback) continue;
    if (id !== (slot.value === move.old ? old : next)) throw new Error("A Revoke does not have its derived ID");
    if (old === next || (oldByNew.has(next) && oldByNew.get(next) !== old)) throw new Error("A restamped Revoke ID would collide");
    oldByNew.set(next, old);
    ids.set(restampAddress(slot), { old, next });
  }
  if (!rollback) for (const { old, next } of ids.values()) {
    if (occupied.get(next)?.some((slot) => ids.get(restampAddress(slot))?.old !== old) ||
      occupied.get(old)?.some((slot) => ids.get(restampAddress(slot))?.next !== next)) throw new Error("A restamped Revoke ID would collide");
  }
  return { ids, oldByNew };
}

/** Reserve dangling Unrevoke targets too. Only references actually recorded in the plan may be replayed. */
export function restampLinks(state: ReturnType<typeof readRestampState>, mapping: readonly RestampMove[], approved?: readonly RestampLink[]): RestampLink[] {
  const { oldByNew } = revokeMoves(state, mapping, false);
  const nextByOld = new Map([...oldByNew].map(([next, old]) => [old, next]));
  const links: RestampLink[] = [];
  for (const [store, rows] of state.unrevokes) for (const row of rows) {
    const link = approved?.find(entry => entry.store === store && entry.ref === row.id);
    if (link) {
      if (nextByOld.get(link.old) !== link.new || (row.revoke !== link.old && row.revoke !== link.new)) {
        throw new Error("An Unrevoke reference changed since restamp was queued");
      }
      links.push(link);
      continue;
    }
    if (oldByNew.has(row.revoke)) throw new Error("A restamped Revoke ID would collide with an Unrevoke reference");
    const next = nextByOld.get(row.revoke);
    if (next !== undefined) links.push({ store, ref: row.id, old: row.revoke, new: next });
  }
  return links;
}

/** Prepare a whole generation before the first replacement. A rollback only reverses fields this plan names. */
export function rewriteRestamp(state: ReturnType<typeof readRestampState>, mapping: readonly RestampMove[], links: readonly RestampLink[], rollback = false) {
  const changed = new Set<string>();
  const { ids } = revokeMoves(state, mapping, rollback);
  for (const move of mapping) {
    const address = restampAddress(move);
    const slot = state.own.get(address);
    if (!slot && !rollback) throw new Error("A restamp timestamp does not name an own time");
    if (slot?.value === (rollback ? move.new : move.old)) {
      const id = ids.get(address);
      if (id && state.revokes.has(slot)) slot.row.id = rollback ? id.old : id.next;
      slot.row[slot.field] = rollback ? move.old : move.new;
      changed.add(slot.store);
    }
  }
  for (const [store, { doc }] of state.docs) {
    if (!store.endsWith(REMOVAL_FILE) || !Array.isArray(doc.unrevokes)) continue;
    for (const row of doc.unrevokes) {
      if (!isJsonObject(row)) continue;
      const link = links.find(entry => entry.store === store && entry.ref === row.id);
      if (link && row.revoke === (rollback ? link.new : link.old)) {
        row.revoke = rollback ? link.old : link.new;
        changed.add(store);
      }
    }
  }
  return [...state.docs].filter(([store]) => changed.has(store)).map(([, doc]) => doc);
}
