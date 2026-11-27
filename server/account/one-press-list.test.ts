/**
 * A take over SSH that names the account's signed list, on the PC it adds (one-press.ts takeByList), with the list and
 * the relay stood in for: the guards around the join and the relay wait that a contract test does not reach (the
 * review of P8, its surviving mutants M07, M08 and M27).
 */
import { expect, test } from "bun:test";
import type { RelayStatus } from "../../shared/protocol.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayService } from "../relay/service.ts";
import type { JoinOutcome, ListFollow } from "./list-follow.ts";
import type { AccountMailbox } from "./mailbox.ts";
import { takeByList } from "./one-press.ts";

const SERVER = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "acct_1";
const NAMED = { list: "a".repeat(64), adder: "adder-key" };
const status = (phase: RelayStatus["phase"]): RelayStatus =>
  ({ phase, blocked: null, relay: "wss://relay.test", app: "https://app.test", sessions: 0, error: null, error_code: null, account_named: true });

/** A PC in no account whose join by the list `joins` answers; what happened, in order, is kept in `steps`. */
function services(options: { joins: () => JoinOutcome; identity?: () => string; bound?: () => string | null }) {
  const steps: string[] = [];
  let bound: string | null = null;
  let pinned: string | null = null;
  const devices = { account: () => (options.bound ?? (() => bound))(), listRemovedFrom: () => false, gen: () => 0 } as unknown as DeviceStore;
  const relay = {
    currentIdentity: () => ({ server_id: options.identity?.() ?? SERVER }),
    setRelayAccount: (account: string) => { steps.push(`named ${account}`); return true; },
    switchSet: () => false, start: () => status("connecting"), status: () => status("connecting"),
  } as unknown as RelayService;
  const accountList = {
    status: () => ({ pinned_list: pinned }),
    joinList: async () => { steps.push("join"); const joined = options.joins(); if ("joined" in joined) { bound = ACCOUNT; pinned = NAMED.list; } return joined; },
    cardFor: async () => ({ key: "pc-key", enc: "pc-enc", card: "pc-card" }),
  } as unknown as ListFollow;
  return { services: { devices, relay, accountMailbox: { joinedByList: () => {} } as unknown as AccountMailbox, accountList }, steps, bound: () => bound };
}

const JOINED = { joined: { pinned: true } } as unknown as JoinOutcome;

test("a PC in no account is named for the account before it joins by the list, so its relay pass is asked under it from the first take on", async () => {
  const made = services({ joins: () => ({ waiting: "waiting" }) });
  expect(await takeByList(made.services, ACCOUNT, SERVER, NAMED, 400)).toMatchObject({ state: "waiting" });
  expect(made.steps).toEqual([`named ${ACCOUNT}`, "join"]);
});

test("a PC that left the account while the take waited for its relay is not answered as added", async () => {
  let left = false;
  const made = services({ joins: () => JOINED, bound: () => (left ? null : ACCOUNT) });
  const pending = takeByList(made.services, ACCOUNT, SERVER, NAMED, 400);
  setTimeout(() => { left = true; }, 50);
  expect(await pending).toMatchObject({ refused: { code: "not_listed" } });
});

test("a relay identity reset while the take waited for its relay is not answered as added", async () => {
  let identity = SERVER;
  const made = services({ joins: () => JOINED, identity: () => identity });
  const pending = takeByList(made.services, ACCOUNT, SERVER, NAMED, 400);
  setTimeout(() => { identity = "f".repeat(32); }, 50);
  expect(await pending).toMatchObject({ refused: { code: "identity_changed" } });
});

test("a Revoke all on this PC while the join read the list ends the take with nothing bound (PR #4645 review)", async () => {
  let generation = 1;
  const made = services({ joins: () => JOINED });
  // the join reads the list over the network; a Revoke all at the PC meanwhile moves the denial counter
  (made.services.devices as unknown as { gen: () => number }).gen = () => generation;
  made.services.accountList.joinList = async (given) => {
    generation += 1;
    return given.live?.() === false ? { refused: "ended" } : JOINED;
  };
  expect(await takeByList(made.services, ACCOUNT, SERVER, NAMED, 400)).toMatchObject({ refused: { code: "revoked" } });
});

test("a PC that follows another list, or none, once the relay wait is over is not answered as added by this take (PR #4645 review)", async () => {
  let pinned: string | null = null;
  const made = services({ joins: () => { pinned = NAMED.list; return JOINED; } });
  made.services.accountList.status = (() => ({ pinned_list: pinned })) as never;
  const pending = takeByList(made.services, ACCOUNT, SERVER, NAMED, 400);
  setTimeout(() => { pinned = "b".repeat(64); }, 50);
  expect(await pending).toMatchObject({ refused: { code: "not_listed" } });
});
