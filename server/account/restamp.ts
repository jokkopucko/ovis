/** Queue a confirmed clock repair on the live PC, and apply it before account startup can replay any store. */
import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isIsoTime } from "../../shared/account-records.ts";
import { isJsonObject } from "../http.ts";
import { preparePrivateState, publishPrivateState, syncDirectory, writePrivateState } from "../private-state.ts";
import { DeviceJournal, type JournalInput } from "./device-journal.ts";
import { RESTAMP_PARTICIPANT as PARTICIPANT, RESTAMP_PLAN as FILE, RESTAMP_ROLLBACK as ROLLBACK } from "./restamp-files.ts";
import { replayRestampRevokeAll } from "./restamp-revoke-all.ts";
import { checkRestampFile, checkRestampInputs, openRestampAudit, readRestampJson, readRestampState, restampAddress, restampLinks, restampRelayId, RestampTrustError, rewriteRestamp, type RestampAddress, type RestampFolders, type RestampLink, type RestampMove } from "./restamp-state.ts";

const DAY = 86_400_000;
const FOLDER_ID = "restamp-folder-id.json";
type Plan = { readonly v: 2; readonly by: string; readonly at: string; readonly base: string; readonly origin: string; readonly originId: string; readonly originRelay: string | null; readonly sibling: string | null; readonly siblingId: string | null; readonly siblingRelay: string | null; readonly mapping: readonly RestampMove[]; readonly links?: readonly RestampLink[] };
type Participant = { readonly origin: string; readonly digest: string; readonly rollback?: true };
type TimedSlot = RestampAddress & { readonly value: string };
type Install = "plugin" | "desktop" | "other";
type Applied = { readonly problem?: string; readonly retry?: true; readonly reconcile?: true; readonly sibling?: string | null };

const iso = (at: number) => new Date(at).toISOString();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const event = (by: string, how: string, label = how): JournalInput =>
  ({ kind: "account", how, key: null, no: null, row: null, by, account: null, label });
const digestOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value;
const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
const real = (dir: string) => realpathSync(dir);
const isId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id);

function directoryId(dir: string): string | null {
  try {
    if (real(dir) !== dir) return null;
    const path = join(dir, FOLDER_ID);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new RestampTrustError(`${path} is not private`);
    const value = readRestampJson(path);
    if (value === undefined) return null;
    if (!isId(value)) throw new RestampTrustError(`Invalid restamp folder ID in ${dir}`);
    return value;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

function ensureDirectoryId(dir: string): string {
  const existing = directoryId(dir);
  if (existing !== null) {
    syncRestampDirectory(dir);
    return existing;
  }
  const path = join(dir, FOLDER_ID);
  const created = randomBytes(16).toString("hex");
  const temp = preparePrivateState(path, created);
  try { linkSync(temp, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally { rmSync(temp); }
  syncRestampDirectory(dir);
  const id = directoryId(dir);
  if (id === null) throw new Error(`Cannot read restamp folder ID in ${dir}`);
  return id;
}

function syncRestampDirectory(dir: string): void {
  if (!syncDirectory(dir, process.platform).directorySynced) throw new Error(`Cannot make the restamp transaction durable in ${dir}`);
}

function moves(slots: Iterable<TimedSlot>, base: number): RestampMove[] {
  const future = [...slots].filter(({ value }) => Date.parse(value) > base).sort((a, b) => Date.parse(a.value) - Date.parse(b.value));
  const mapping: RestampMove[] = [];
  let count = 0;
  let last: string | undefined;
  for (const { store, ref, field, value } of future) {
    if (value !== last) { last = value; count++; }
    const next = iso(base + count);
    if (next !== value) mapping.push({ store, ref, field, old: value, new: next });
  }
  return mapping;
}

function readPlan(path: string): Plan {
  const value = readRestampJson(path);
  if (!isJsonObject(value) || Object.keys(value).some(key => !["v", "by", "at", "base", "origin", "originId", "originRelay", "sibling", "siblingId", "siblingRelay", "mapping", "links"].includes(key)) ||
    value.v !== 2 || typeof value.by !== "string" || value.by.length === 0 ||
    !absolute(value.origin) || !isId(value.originId) || !(value.originRelay === null || isId(value.originRelay)) ||
    !(value.sibling === null && value.siblingId === null && value.siblingRelay === null ||
      absolute(value.sibling) && value.sibling !== value.origin && isId(value.siblingId) && (value.siblingRelay === null || isId(value.siblingRelay))) ||
    !isIsoTime(value.at) || !isIsoTime(value.base) || !Array.isArray(value.mapping) || value.mapping.length === 0) {
    throw new Error("Invalid restamp.json shape");
  }
  const mapping = value.mapping.map((entry: unknown): RestampMove => {
    if (!isJsonObject(entry) || Object.keys(entry).length !== 5 || typeof entry.store !== "string" || typeof entry.ref !== "string" ||
      !(entry.field === "created_at" || entry.field === "confirmed_at" || entry.field === "removed_at" || entry.field === "at") ||
      !isIsoTime(entry.old) || !isIsoTime(entry.new) || entry.new >= entry.old) throw new Error("Invalid restamp.json mapping entry");
    return { store: entry.store, ref: entry.ref, field: entry.field, old: entry.old, new: entry.new };
  });
  let links: RestampLink[] | undefined;
  if (value.links !== undefined) {
    if (!Array.isArray(value.links)) throw new Error("Invalid restamp.json links");
    const seen = new Set<string>();
    links = value.links.map((link: unknown): RestampLink => {
      const id = /^[0-9a-f]{32}$/;
      if (!isJsonObject(link) || Object.keys(link).length !== 4 ||
        (link.store !== "account-removed.json" && link.store !== "sibling/account-removed.json") ||
        typeof link.ref !== "string" || typeof link.old !== "string" || typeof link.new !== "string" ||
        !id.test(link.old) || !id.test(link.new) || link.old === link.new) throw new Error("Invalid restamp.json link");
      const address = JSON.stringify([link.store, link.ref]);
      if (seen.has(address)) throw new Error("A restamp.json link is named twice");
      seen.add(address);
      return { store: link.store, ref: link.ref, old: link.old, new: link.new };
    });
  }
  return { v: 2, by: value.by, at: value.at, base: value.base, origin: value.origin, originId: value.originId, originRelay: value.originRelay,
    sibling: value.sibling, siblingId: value.siblingId, siblingRelay: value.siblingRelay, mapping, ...(links === undefined ? {} : { links }) };
}

function matchesPlan(plan: Plan, state: ReturnType<typeof readRestampState>): boolean {
  const at = Date.parse(plan.at);
  const base = Date.parse(plan.base);
  if (base < at || base > at + DAY) throw new Error("Invalid restamp.json base");
  const original = new Map(state.own);
  const seen = new Set<string>();
  let matches = true;
  let last: RestampMove | undefined;
  for (const entry of plan.mapping) {
    const address = restampAddress(entry);
    const slot = original.get(address);
    if (seen.has(address) || Date.parse(entry.new) <= base || (last &&
      (entry.old < last.old || (entry.old === last.old ? entry.new !== last.new : entry.new <= last.new)))) {
      throw new Error("Invalid restamp.json timestamp order");
    }
    last = entry;
    seen.add(address);
    if (slot && (slot.value === entry.old || slot.value === entry.new)) original.set(address, { ...slot, value: entry.old });
    else matches = false;
  }
  return matches && Bun.deepEquals(moves(original.values(), base), plan.mapping);
}

function readParticipant(dir: string): Participant | undefined {
  const path = join(dir, PARTICIPANT);
  if (!present(path)) return undefined;
  const value = readRestampJson(path);
  if (!isJsonObject(value) || !absolute(value.origin) || typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest) ||
      !(value.rollback === undefined || value.rollback === true)) throw new Error("Invalid restamp participant record");
  return { origin: value.origin, digest: value.digest, ...(value.rollback ? { rollback: true } : {}) };
}

function pendingAt(origin: string) {
  const paths = [FILE, ROLLBACK].filter(name => present(join(origin, name)));
  if (paths.length > 1) throw new Error("Multiple restamp plans are pending in one folder");
  const name = paths[0];
  if (name === undefined) return undefined;
  const path = join(origin, name);
  const plan = readPlan(path);
  if (plan.origin !== origin || plan.originId !== directoryId(origin)) throw new Error("restamp.json belongs to a different origin folder");
  return { path, plan, rollback: name === ROLLBACK };
}

function participantFinished(participant: Participant): boolean {
  return ["restamp-done.json", "restamp-refused.json"].some(name => {
    const path = join(participant.origin, name);
    if (!present(path)) return false;
    const plan = readPlan(path);
    return plan.origin === participant.origin && plan.originId === directoryId(participant.origin) && digestOf(plan) === participant.digest;
  });
}

function pendingPlan(folders: RestampFolders, markUnavailable = false) {
  const active = present(folders.stateDir) ? real(folders.stateDir) : resolve(folders.stateDir);
  const own = pendingAt(active);
  const participant = readParticipant(active);
  if (participant) {
    if (directoryId(participant.origin) === null) {
      if (markUnavailable) {
        checkRestampInputs({ stateDir: active });
        if (!participant.rollback) writePrivateState(join(active, PARTICIPANT), { ...participant, rollback: true }, undefined, true);
        syncRestampDirectory(active);
      }
      throw new Error(`Restamp origin ${participant.origin} is unavailable; rollback remains pending`);
    }
    const other = pendingAt(participant.origin);
    if (other && other.plan.sibling === active && digestOf(other.plan) === participant.digest) {
      if (own) throw new Error("Multiple restamp plans are pending across the two folders");
      return other;
    }
    if (!participantFinished(participant)) throw new Error(`Restamp origin ${participant.origin} has no matching transaction`);
    if (markUnavailable) {
      syncRestampDirectory(participant.origin);
      rmSync(join(active, PARTICIPANT));
    }
  }
  if (own) return own;
  if (!folders.sibling || !present(folders.sibling)) return undefined;
  const sibling = real(folders.sibling);
  if (active === sibling) return undefined;
  try {
    const other = pendingAt(sibling);
    return other?.plan.sibling === active ? other : undefined;
  } catch (error) {
    // A candidate's unreadable plan belongs to us only if we cannot prove it is another PC.
    // A readable plan that names us is authenticated against its journal before reading relay identity.
    let foreign = false;
    try {
      const mine = restampRelayId(active), theirs = restampRelayId(sibling);
      foreign = mine !== null && theirs !== null && mine !== theirs;
    } catch { /* Indeterminate identity is not proof the plan is foreign. */ }
    if (!foreign) throw error;
    return undefined;
  }
}

function unresolvedDigest(plan: Plan, state: ReturnType<typeof readRestampState>): string | undefined {
  const changed = plan.mapping.flatMap(move => {
    const value = state.own.get(restampAddress(move))?.value;
    return value === move.old || value === move.new ? [] : [[restampAddress(move), value]];
  });
  const links = (plan.links ?? []).flatMap(link => {
    const target = state.unrevokes.get(link.store)?.find(row => row.id === link.ref)?.revoke;
    return target === link.old || target === link.new ? [] : [[link.store, link.ref, target]];
  });
  return changed.length || links.length ? digestOf([digestOf(plan), changed, links]) : undefined;
}

function checkRelayScope(plan: Plan): void {
  if (restampRelayId(plan.origin) !== plan.originRelay || (plan.sibling !== null && restampRelayId(plan.sibling) !== plan.siblingRelay)) {
    throw new Error("A restamp participant's relay identity changed");
  }
}

export function applyRestamp(folders: RestampFolders): Applied {
  let audit: ((problem: string) => void) | undefined;
  try {
    const windows = process.platform === "win32";
    const entry = pendingPlan(folders, !windows);
    if (!entry) return {};
    if (windows) return { problem: "A restamp plan is pending; Windows cannot apply it." };
    const { plan } = entry;
    const dir = plan.origin;
    const scope = { stateDir: dir, sibling: plan.sibling };
    const rollbackMarker = join(dir, ROLLBACK);
    const participantPath = plan.sibling ? join(plan.sibling, PARTICIPANT) : null;
    const planId = digestOf(plan);
    const unavailable = plan.sibling !== null && directoryId(plan.sibling) !== plan.siblingId;
    checkRestampInputs(unavailable ? { stateDir: dir } : scope);
    for (const path of [rollbackMarker, join(dir, "restamp-done.json"), join(dir, "restamp-refused.json"), participantPath]) {
      if (path && !(unavailable && path === participantPath)) checkRestampFile(path);
    }
    const journal = DeviceJournal.open(dir);
    const journalRefusal = journal.restampRefusal(openRestampAudit(dir));
    if (journalRefusal !== null) throw new Error(journalRefusal);
    if (!journal.approvesRestamp(planId)) throw new Error("restamp.json does not match the approved plan in the device journal");
    audit = problem => {
      journal.auditRestamp(planId, event(plan.by, "restamp refused", `${problem} ${planId}`));
      syncRestampDirectory(dir);
    };
    if (unavailable) {
      if (restampRelayId(dir) !== plan.originRelay) throw new Error("The restamp origin's relay identity changed");
      if (!entry.rollback) publishPrivateState(entry.path, rollbackMarker);
      syncRestampDirectory(dir);
      throw new Error(`Restamp participant ${plan.sibling} is unavailable; rollback remains pending`);
    }
    let participant = plan.sibling ? readParticipant(plan.sibling) : undefined;
    if (participant && (participant.origin !== dir || participant.digest !== planId)) {
      if (!participantFinished(participant)) throw new Error("The restamp participant has a different pending transaction");
      syncRestampDirectory(participant.origin);
      participant = undefined; // Replace a pointer left by a stop immediately after the old archive rename.
    }
    if (plan.sibling && pendingAt(plan.sibling)) throw new Error("Multiple restamp plans are pending across the two folders");
    checkRelayScope(plan);
    if (present(join(dir, "revoke-all.json"))) replayRestampRevokeAll(dir, plan.originRelay, journal);
    if (plan.sibling && present(join(plan.sibling, "revoke-all.json"))) {
      replayRestampRevokeAll(plan.sibling, plan.siblingRelay, DeviceJournal.open(plan.sibling));
    }
    const state = readRestampState(scope, plan.originRelay);
    const matches = matchesPlan(plan, state);
    const limit = Date.now() + DAY;
    const replacements = new Map(plan.mapping.map((entry) => [restampAddress(entry), Date.parse(entry.new)]));
    let reason = state.nonOwn > limit || plan.mapping.some(move => Date.parse(move.new) <= state.nonOwn) ? "A time from elsewhere changed" :
      !matches ? "An own timestamp changed" : entry.rollback || participant?.rollback ? "The restamp inputs changed or a participant was unavailable" : null;
    const links = plan.links ?? [];
    if (reason === null) {
      try {
        if (!Bun.deepEquals(restampLinks(state, plan.mapping, links), links)) reason = "An Unrevoke reference changed";
      } catch (error) { reason = message(error); }
    }
    if (reason === null && [...state.own].some(([address, slot]) => (replacements.get(address) ?? Date.parse(slot.value)) > limit)) {
      throw new Error("This clock is still too far behind the restamp.json plan; correct the clock and restart Ovis");
    }
    const rollback = reason !== null;
    const archive = join(dir, rollback ? "restamp-refused.json" : "restamp-done.json");
    const unmatched = rollback ? unresolvedDigest(plan, state) : undefined;
    const acknowledged = unmatched !== undefined && [dir, ...(plan.sibling ? [plan.sibling] : [])].some(folder =>
      DeviceJournal.open(folder).approvesRestampReconciliation(unmatched));
    const writes = rewriteRestamp(state, plan.mapping, links, rollback);
    if (!plan.sibling && real(folders.stateDir) !== dir) throw new Error("A local restamp cannot run from another folder");
    if (participantPath && !participant) writePrivateState(participantPath, { origin: dir, digest: planId }, undefined, true);
    // Publish the rollback decision before any rollback write. A crash cannot turn it back into an apply.
    if (rollback && !entry.rollback) publishPrivateState(entry.path, rollbackMarker);
    syncRestampDirectory(dir);
    if (plan.sibling) syncRestampDirectory(plan.sibling);
    for (const { path, doc, original } of writes) {
      const temp = preparePrivateState(path, doc, undefined, true);
      try {
        // Ordinary writers publish by rename without a cross-process lock. Do not
        // publish an older image over a change made while the new image was staged.
        if (JSON.stringify(readRestampJson(path)) !== original) throw new RestampTrustError(`${path} changed while applying the clock repair; restart Ovis`);
        publishPrivateState(temp, path);
      } finally { rmSync(temp, { force: true }); }
    }
    if (plan.sibling) syncRestampDirectory(plan.sibling);
    if (unmatched !== undefined && !acknowledged) {
      const problem = "Independently changed restamp values remain; run ovis recover --restamp to reconcile them.";
      audit(problem);
      return { problem, retry: true, reconcile: true, sibling: real(folders.stateDir) === dir ? plan.sibling : dir };
    }
    const problem = reason === null || acknowledged ? undefined : `${reason} after restamp.json was queued; run ovis recover --restamp again.`;
    const how = rollback ? "restamp refused" : "restamp applied";
    journal.auditRestamp(planId, event(plan.by, how, `${problem ?? (acknowledged ? "Independent times accepted by owner" : how)} ${planId}`));
    syncRestampDirectory(dir);
    publishPrivateState(rollback ? rollbackMarker : entry.path, archive);
    syncRestampDirectory(dir);
    if (participantPath) rmSync(participantPath, { force: true });
    return problem === undefined ? {} : { problem, retry: true, sibling: real(folders.stateDir) === dir ? plan.sibling : dir };
  } catch (error) {
    if (audit && !(error instanceof RestampTrustError)) {
      try { audit(message(error)); }
      catch (auditError) { return { problem: `Cannot record the restamp.json refusal: ${message(auditError)}. Only this PC itself gets in.` }; }
    }
    return { problem: `Cannot apply restamp.json: ${message(error)}. Only this PC itself gets in.` };
  }
}

export function restampAct(options: RestampFolders & {
  readonly problem: () => string | null;
  readonly journal: DeviceJournal;
  readonly install: Install;
}) {
  let preview: { token: string; plan: Plan } | { token: string; reconcile: string } | undefined;
  return (confirm: string | undefined, user: string) => {
    try {
      // One synchronous turn covers the readability check, plan recheck, journal and private replacement.
      const refused = options.problem();
      if (refused !== null) return { error: refused };
      const approved = preview;
      if (confirm !== undefined && (approved === undefined || confirm !== approved.token)) {
        return { error: "The restamp preview no longer matches; run ovis recover --restamp again." };
      }
      const origin = real(options.stateDir);
      const other = options.sibling ? real(options.sibling) : null;
      const sibling = other === origin ? null : other;
      const pending = pendingPlan(options);
      if (pending) {
        if (!pending.rollback) return { error: "A restamp is already pending; restart Ovis before queuing another." };
        const { plan } = pending;
        if (plan.sibling !== null && directoryId(plan.sibling) !== plan.siblingId) return { error: "A restamp participant is unavailable; restart Ovis after restoring it." };
        checkRelayScope(plan);
        const state = readRestampState({ stateDir: plan.origin, sibling: plan.sibling }, plan.originRelay);
        const journalRefusal = options.journal.restampRefusal(state.journals.get(origin));
        if (journalRefusal !== null) return { error: journalRefusal };
        if (!DeviceJournal.open(plan.origin).approvesRestamp(digestOf(plan))) return { error: "Cannot reconcile an unapproved restamp." };
        const reconcile = unresolvedDigest(plan, state);
        if (!reconcile) return { error: "Rollback is still pending; restart Ovis to finish it." };
        if (confirm === undefined) {
          const token = randomBytes(16).toString("hex");
          preview = { token, reconcile };
          return { confirm: token, moves: [], reconcile: true };
        }
        preview = undefined;
        if (!approved || !("reconcile" in approved) || approved.reconcile !== reconcile) return { error: "The independently changed values differ from the preview; run ovis recover --restamp again." };
        options.journal.approveRestampReconciliation(reconcile, event(user, "restamp reconcile", `Keep independent restamp values ${reconcile}`));
        syncRestampDirectory(origin);
        return { queued: true, install: options.install };
      }
      const scope = { stateDir: origin, sibling };
      checkRestampInputs(scope);
      const originRelay = restampRelayId(origin), siblingRelay = sibling === null ? null : restampRelayId(sibling);
      if (originRelay !== null && siblingRelay !== null && originRelay !== siblingRelay) return { error: "The other folder belongs to a different relay identity; restart Ovis." };
      const state = readRestampState(scope, originRelay);
      const journalRefusal = options.journal.restampRefusal(state.journals.get(origin));
      if (journalRefusal !== null) return { error: journalRefusal };
      const now = Date.now();
      const at = approved && "plan" in approved && confirm !== undefined ? approved.plan.at : iso(now);
      const base = Math.max(Date.parse(at), state.nonOwn);
      if (base > now + DAY) return { error: "A time from elsewhere is more than a day ahead; this PC stays closed." };
      if (![...state.own.values()].some(({ value }) => Date.parse(value) > now + DAY)) {
        return { error: "No own timestamp is more than a day ahead now; check the clock and restart Ovis." };
      }
      const mapping = moves(state.own.values(), base);
      const replacements = new Map(mapping.map(entry => [restampAddress(entry), Date.parse(entry.new)]));
      if (mapping.length === 0 || [...state.own].some(([address, slot]) => (replacements.get(address) ?? Date.parse(slot.value)) > now + DAY)) {
        return { error: "The restamp would leave a time more than a day ahead; this PC stays closed." };
      }
      const links = restampLinks(state, mapping);
      const path = join(origin, FILE);
      checkRestampFile(path);
      // The preview pins both IDs. Confirmation only reads them: a replacement folder never inherits approval.
      const savedOriginId = directoryId(origin), savedSiblingId = sibling === null ? null : directoryId(sibling);
      const originId = savedOriginId ?? (confirm === undefined ? ensureDirectoryId(origin) : null);
      const siblingId = savedSiblingId ?? (confirm === undefined && sibling !== null ? ensureDirectoryId(sibling) : null);
      if (originId === null || (sibling !== null && siblingId === null)) return { error: "A restamp participant is unavailable; restart Ovis." };
      const plan: Plan = { v: 2, by: user, at, base: iso(base), origin, originId, originRelay, sibling, siblingId, siblingRelay, mapping, ...(links.length ? { links } : {}) };
      if (confirm === undefined) {
        const token = randomBytes(16).toString("hex");
        preview = { token, plan };
        return { confirm: token, moves: mapping };
      }
      preview = undefined;
      if (!approved || !("plan" in approved) || JSON.stringify(plan) !== JSON.stringify(approved.plan)) {
        return { error: "The restamp inputs changed; run ovis recover --restamp again." };
      }
      const digest = digestOf(plan);
      options.journal.approveRestamp(digest, event(user, "restamp asked", `restamp asked ${digest}`));
      syncRestampDirectory(origin);
      writePrivateState(path, plan, undefined, true);
      syncRestampDirectory(origin);
      return { queued: true, install: options.install };
    } catch (error) {
      return { error: `${message(error)}. This PC stays closed.` };
    }
  };
}
