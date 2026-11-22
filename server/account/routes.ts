import { ACCOUNT_ENROLL_MAX, ACCOUNT_RECORDS_MAX, isAccountKeyEncoding } from "../../shared/account-records.ts";
import type { Access } from "../access.ts";
import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { parseIntroducedPcs } from "./introductions.ts";
import { ACCOUNT_HELD_MAX } from "./holds.ts";
import { applyAccountRecords, applyEnrollment, applyLink, type LinkRefusal } from "./records.ts";

const LINK_STATUS: Record<LinkRefusal, number> = {
  record_invalid: 400, signature_invalid: 400, account_mismatch: 409, signer_not_member: 403,
  tombstoned: 409, link_not_owner: 403, key_in_use: 409, account_unavailable: 503, enrolling: 409, removal_pending: 409,
  link_required: 403, unverified_device: 403, pairing_ended: 409, older_device: 403, closed: 409, read_pending: 409,
  replacement_needs_app: 409,
};

/**
 * /api/account/* (docs/account.md, "PC API"): drive access only, directly or through the relay,
 * and the app's own mutation guard for changes.
 */
export async function handleAccountRequest(request: Request, pathname: string, context: ServerContext, access: Access): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const devices = context.services.devices;
  const peer = context.peer;
  // a device that waits to link (it paired with a code made for a PC in no account; docs/account.md, "Who may admit
  // a device") makes two calls here: it reads its own status, and sends its link
  const waiting = peer.kind === "relay" && peer.device.provisional === true ? peer.device.id : null;
  // the one route a watching device may use: its own introduction, over its own session
  if (pathname === "/api/account/introduction" && request.method === "GET") {
    setRequestRoute(pathname);
    const pcs = peer.kind === "relay" ? context.services.accountIntroductions.get(peer.key) : null;
    return pcs ? reply({ pcs }) : fail("introduction_none", "No introduction waits for this device", 404);
  }
  if (waiting !== null && pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    // this one body, whatever else the PC holds: it names no account, and no mailbox is read for it (`fresh` is
    // ignored). The read is a moment the device's time is judged at
    if (!devices.provisionalStands(waiting)) return fail("link_required", "This device did not link itself into an account in time. Pair it again.", 403);
    return reply({ account: null, members: 0, unlinked: [waiting], own_word: [], removals: [], adds: [], blocked: [], enrolling: false, blocked_all: false, mailbox: { last_pull_at: null, error: null } });
  }
  const ownLink = waiting !== null && pathname === "/api/account/link" && request.method === "POST";
  if (!ownLink && (access.level !== "full" || access.role !== "drive")) return fail("read_only", "this device can only watch", 403);
  if (pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    const mailbox = context.services.accountMailbox;
    // a client about to enroll another PC reads this one's removals after its mailbox, so one waiting there counts too
    const fresh = new URL(request.url).searchParams.get("fresh") === "1" ? await mailbox.freshen() : undefined;
    const blocked = [...new Set([...devices.tombstoneKeys(), ...mailbox.waitingRemoveKeys(), ...context.services.accountHolds.list()])];
    return reply({
      account: devices.account(), ...(devices.accountPolicyActive() ? { pc_add_from_account: devices.accountError === null ? true : "unavailable" } : {}),
      ...devices.accountRows(), removals: devices.accountRemovals(), adds: devices.accountAdds(), blocked,
      enrolling: context.services.accountHolds.enrolling(), blocked_all: mailbox.holdsEveryAdd(), ...(fresh === undefined ? {} : { fresh }), mailbox: { last_pull_at: mailbox.lastPullAt, error: mailbox.error },
    });
  }
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Manage the account from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const serverId = peer.kind === "relay" ? peer.serverId : context.services.relay.currentIdentity()?.server_id ?? null;
  switch (pathname) {
    case "/api/account/relay-account": {
      setRequestRoute(pathname);
      // the account this PC asks its relay pass under (docs/relay.md, "Relay pass"): named over a direct
      // connection with drive access (the PC's own screen, after listing it), or through the relay only by a
      // member of this PC's own account
      const account = body.account;
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      if (peer.kind === "relay" && !(devices.isAccountApproverSession(peer.device.id, peer.key) && devices.account() === account)) return fail("account_required", "Name this PC's account from a device linked to it", 403);
      if (!context.services.relay.setRelayAccount(account)) return fail("invalid_account", "Name the account", 400);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/one-press": {
      if (!devices.opensAll()) return fail("not_found", "Unknown account action", 404);
      setRequestRoute(pathname);
      // only the PC's owner here names the account it joins: never a device through the relay (security-triage, t13r)
      if (peer.kind === "relay") return fail("owner_only", "Add this PC to your account on this PC itself.", 403);
      const account = body.account;
      if (typeof account !== "string") return fail("invalid_account", "Name the account", 400);
      // the account the owner's browser is signed in to must be the one named for this PC, which a press never sets
      if (context.services.relay.savedRelayAccount() !== account) return fail("account_mismatch", "This PC was set up for another account. Sign in to that one, or add this PC again.", 409);
      if (devices.account() !== null) return fail("in_account", "This PC is already in an account", 409);
      // a Revoke all, a reset or a denial while the service answers raises this: the press then binds nothing (PADD-1)
      const generation = devices.gen();
      // a relay identity reset meanwhile makes this another PC to the account service: its answer was for the old one
      const identity = context.services.relay.currentIdentity()?.server_id ?? null;
      let admitted: Awaited<ReturnType<typeof context.services.accountMailbox.admission>>;
      try { admitted = await context.services.accountMailbox.admission(account); }
      catch (error) { return fail("account_unavailable", error instanceof Error ? error.message : String(error), 503); }
      if (admitted === null) return fail("no_admission", "The account service did not admit this PC in one press", 404);
      // the service's word counts only for the account named here (G1)
      if (admitted.account !== account) return fail("account_mismatch", "The account service answered for another account", 502);
      // what the PC was named for, or its account, may have changed while the service answered: decided again now
      if (context.services.relay.savedRelayAccount() !== account) return fail("account_mismatch", "This PC was set up for another account. Sign in to that one, or add this PC again.", 409);
      if (devices.account() !== null) return fail("in_account", "This PC is already in an account", 409);
      if ((context.services.relay.currentIdentity()?.server_id ?? null) !== identity) return fail("identity_changed", "This PC's relay identity was reset while it was being added. Add it again.", 409);
      if (devices.gen() !== generation) return fail("revoked", "Every device was revoked on this PC while it was being added. Add it again.", 409);
      devices.bindByService(account);
      await context.services.accountMailbox.readSnapshot();
      // the account may have stopped listing this PC during that first read: then it is in no account, and says so
      if (devices.account() !== account) return fail("not_listed", "The account removed this PC while it was being added", 409);
      return reply({ account });
    }
    case "/api/account/introduce": {
      setRequestRoute(pathname);
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key)) return fail("account_required", "Introduce devices from a device linked to the account", 403);
      if (typeof body.key !== "string" || !devices.wasAddedByMember(body.key)) return fail("introduction_unknown_key", "No account member added that device here", 404);
      const pcs = parseIntroducedPcs(body.pcs);
      if (!pcs) return fail("introduction_invalid", "List at most 32 PCs, each with a server_id its key derives", 400);
      context.services.accountIntroductions.set(body.key, pcs);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/link": {
      setRequestRoute(pathname);
      // a link proves the key of the row whose session sends it, and only the relay carries a row's key
      if (peer.kind !== "relay") return fail("link_not_owner", "Link a device from its own connection through the relay", 403);
      // what stood when the link arrived, before its signature is checked: its checks are held to it. A row that
      // waits to link sends five links, whatever each is answered; the next turned it away
      const arrival = devices.linkArrived(peer.device.id, peer.device.provisional === true);
      if (arrival === null) return fail("link_required", "The link was refused: link_required", LINK_STATUS.link_required);
      // a link that may bring this PC into an account: account adds wait until its member enrolls it. On disk
      // first, so a stop keeps them waiting; never lifted by a refused link, as another may be on its way
      // (with no account here no add applies anyway, and the next first member takes the barrier over)
      if (context.services.accountHolds.error !== null) return fail("account_unavailable", context.services.accountHolds.error, 503);
      const first = devices.account() === null;
      // a barrier confirmed by a member who has since left (the PC has no account again) is this link's to take over.
      // Nothing of a device that waits to link is written before its link has passed every check: its barrier goes to
      // disk in the turn that writes its row, before it (applyLink). So one whose link is refused, or outlives its
      // time, leaves none
      if (first && !arrival.provisional) context.services.accountHolds.startEnrolling(peer.device.id, { stale: true });
      const linked = await applyLink(devices, body.record, { deviceId: peer.device.id, serverId: peer.serverId, sessionKey: peer.key, sessionId: peer.sessionId }, arrival, {
        gates: context.services.accountMailbox.gates(),
        barrier: () => context.services.accountHolds.startEnrollingBeforeRow(peer.device.id),
        setUpFor: () => context.services.relay.savedRelayAccount(),
        vouch: (account, key, firstLink) => context.services.accountMailbox.vouch(account, key, firstLink),
      });
      if ("refused" in linked) {
        const refused = fail(linked.refused, linked.message ?? `The link was refused: ${linked.refused}`, LINK_STATUS[linked.refused]);
        // when the PC may ask the account service again: the device sends the same link after it
        if (linked.retryAfter !== undefined) refused.headers.set("retry-after", String(linked.retryAfter));
        return refused;
      }
      // the wait is this device's to end: a link refused meanwhile may have named another; the first link that succeeds keeps it
      if (first) context.services.accountHolds.confirmEnrolling(peer.device.id);
      return reply({ device: linked.device });
    }
    case "/api/account/records": {
      setRequestRoute(pathname);
      const records = body.records;
      if (!Array.isArray(records) || records.length > ACCOUNT_RECORDS_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_RECORDS_MAX} records`, 400);
      const mailbox = context.services.accountMailbox;
      // with the release flag on a block applies at once, each with its own receipt (T51, T60); an app that sends none
      // gets today's answer
      const blocks = context.services.safetyLog === null ? [] : records.filter((record) => (record as { kind?: unknown } | null)?.kind === "block");
      const wasMember = blocks.length > 0 && peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      const receipts = [];
      for (const block of blocks) receipts.push(await devices.applyBlock(block, "handed"));
      const gates = { ...mailbox.gates(), safetyLog: context.services.safetyLog, deferAdd: devices.opensAll() ? (record: unknown) => mailbox.wait(record) : undefined,
        requestRead: devices.opensAll() ? () => { void mailbox.readSnapshot(); } : undefined };
      const remaining = records.filter((record) => !blocks.includes(record));
      // Only a current member's session may leave a removal waiting. A session blocked in this batch may do neither that nor apply any other record.
      const member = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      const results = wasMember && !member
        ? remaining.map((record: unknown) => ({
          id: typeof record === "object" && record !== null && "id" in record && typeof record.id === "string" ? record.id : null,
          outcome: "refused", code: "account_required",
        }))
        : await applyAccountRecords(devices, remaining, serverId, Date.now(), gates, member ? (record) => mailbox.wait(record) : undefined);
      return reply({ results, ...(blocks.length > 0 ? { receipts } : {}) });
    }
    case "/api/account/enroll": {
      setRequestRoute(pathname);
      const { records, held, held_full: heldFull, last } = body;
      if (!Array.isArray(records) || records.length > ACCOUNT_ENROLL_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_ENROLL_MAX} records`, 400);
      if ((last !== undefined && typeof last !== "boolean") || (heldFull !== undefined && typeof heldFull !== "boolean")) return fail("record_invalid", "last and held_full are true or false", 400);
      if (held !== undefined && (!Array.isArray(held) || held.length > ACCOUNT_HELD_MAX || !held.every(isAccountKeyEncoding))) return fail("record_invalid", `Hold at most ${ACCOUNT_HELD_MAX} account keys`, 400);
      // what a member hands a PC it brought into the account: the caller is a member of that account here already
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key) || typeof body.account !== "string" || devices.account() !== body.account) {
        return fail("account_required", "Link this device to the account on this PC first", 403);
      }
      const holds = context.services.accountHolds;
      const mailbox = context.services.accountMailbox;
      if (holds.error !== null) return fail("account_unavailable", holds.error, 503);
      // before any add, and before the barrier lifts: the keys the member found removed elsewhere stay out of every path
      holds.hold(held ?? []);
      // more keys than one enrollment carries: every add is held back from now on, rather than one let in by the cut
      if (heldFull === true) holds.overflow();
      const gates = mailbox.gates();
      // only the member whose link brought this PC in hands over its adds during the wait; another member's wait with the mailbox's
      // the member whose link brought this PC in, or any member once that one is no longer a drive member here (revoked, say)
      const named = holds.enrollingMember();
      const linker = named === peer.device.id || (named !== null && !devices.isAccountApprover(named));
      const results = await applyEnrollment(devices, records, serverId, { gates: { enrolling: () => !linker && holds.enrolling(), held: gates.held, ...(gates.removing ? { removing: gates.removing } : {}) }, wait: (record) => mailbox.wait(record), settle: () => mailbox.settle() });
      // only the member that linked this PC ends its wait, with the last part of its enrollment, once every remove was decided
      const undecided = results.some((result) => result.outcome === "refused" && result.code === "account_unavailable");
      if (last !== false && !undecided && linker) {
        // the hand-over is journalled before the barrier ends: a journal that cannot be written keeps it (T14)
        devices.journalEvent({ kind: "account", how: "enrolled", key: peer.key, no: null, row: peer.device.id, label: peer.device.label, by: null, account: body.account });
        holds.endEnrolling();
        await mailbox.settle();
      }
      return reply({ results });
    }
    default: return fail("not_found", "Unknown account action", 404);
  }
}
