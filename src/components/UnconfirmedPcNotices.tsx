import { Monitor } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCOUNT_OS_NAMES, accountLabel, placeName, type AccountAsker } from "../../shared/account-asker.ts";
import { addPostedPc, NUMBER_TRIES, numberWith, postedPcs, type AddNumber, type AddPcOutcome, type NumberRefusal } from "../lib/account/listAdd.ts";
import { listNames } from "../lib/account/listGenesis.ts";
import { inviteLetsIn, invitedPcs, type InvitedPc } from "../lib/account/listInvited.ts";
import { endInviteAtService, serviceInviteId } from "../lib/account/listInvite.ts";
import { accountHasList, pageListReading, readPageList } from "../lib/account/listPcs.ts";
import type { ListWriter } from "../lib/account/accountList.ts";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { pageAccountList } from "../lib/account/pageList.ts";
import { noteAct } from "../lib/account/seenPcs.ts";
import { newPcNoticeKey } from "../lib/account/newPcNotice.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountServiceError, indexedAccountService, SignedOutError, type AccountService, type DirectoryPc } from "../lib/account/service.ts";
import type { AccountProvider, AccountSession } from "../lib/account/store.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { NewPcNotice } from "./NewPcNotices.tsx";
import { addRefusal, numberRefusal, refusal, type Problem } from "./pcAddRefusals.ts";
import { usePcRemoval } from "./usePcRemoval.tsx";

import "./DevicePairedNotice.css";
import "./UpdateControls.css";

/**
 * security-triage condition 3: Add only while the listing is this young, by its added_at, and never past the account
 * service's own window for a listing that asks to join (`asking_until`); after it, that one's request ran out (No alone),
 * and any other unconfirmed PC (`asking_until` null: one no window applies to, which may be a PC in use) offers its removal
 */
const ADD_WINDOW_MS = 10 * 60_000;
/** how often the time left is drawn again */
const TICK_MS = 15_000;
/** the add a Sign in again was pressed for, by account, PC and listing: the sign-in comes back as a page load, which goes on with it once */
const PENDING_ADD = "ovis:confirm-pc";

/** the add pressed before a Sign in again: that PC, and the listing its card showed when the service gave one (account#67) */
type PendingAdd = { readonly server_id: string; readonly listing_id?: string };
type Listing = { readonly session: AccountSession; readonly pcs: readonly DirectoryPc[]; readonly pending: PendingAdd | null };

function takePendingAdd(account: string): PendingAdd | null {
  try {
    const kept = sessionStorage.getItem(PENDING_ADD);
    sessionStorage.removeItem(PENDING_ADD);
    const parsed: unknown = kept === null ? null : JSON.parse(kept);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { account: of, server_id, listing_id } = parsed as { account?: unknown; server_id?: unknown; listing_id?: unknown };
    return of === account && typeof server_id === "string" ? { server_id, ...(typeof listing_id === "string" ? { listing_id } : {}) } : null;
  } catch { return null; }
}

function keepPendingAdd(account: string, pc: DirectoryPc): void {
  try { sessionStorage.setItem(PENDING_ADD, JSON.stringify({ account, server_id: pc.server_id, ...(typeof pc.listing_id === "string" ? { listing_id: pc.listing_id } : {}) })); }
  catch { /* not kept: Add is pressed again after the sign-in */ }
}

/**
 * The add pressed before a Sign in again goes on only for the listing it was pressed on: a replacement waits for its own
 * press, and so does any listing when the kept add names none (an older Ovis kept it) or another. Only where the service
 * gives the PC no listing ID at all is there nothing to tell listings apart by, and an add kept without one goes on.
 */
const pendingFor = (pending: PendingAdd | null, pc: DirectoryPc): boolean =>
  pending?.server_id === pc.server_id && pending.listing_id === (typeof pc.listing_id === "string" ? pc.listing_id : undefined);

/** "Linux · Seoul, South Korea": what the account service knows of who is asking, null when it knows nothing */
function askerLine(asker: AccountAsker | undefined, language: string): string | null {
  if (asker === undefined) return null;
  const parts = [asker.os === null ? null : ACCOUNT_OS_NAMES[asker.os], placeName(language, asker)].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** What the card says when its number ran out: a new one at Add, while the card has tries left. */
const numberEnded = (t: Translate, tries: number): Problem => ({ text: tries >= NUMBER_TRIES ? numberRefusal(t, "spent") : t("That number ran out. Press Add for a new one; if the PC already said the numbers match, start again on the PC."), signInAgain: false });

/** What a card places, and goes on placing at Try again: the very post the number came from, by the member key it was worked out with. */
type Placing = {
  readonly post: AddNumber["post"]; readonly member: string;
  /**
   * The invite the PC joined with: ended in the same request, and at the account service after it. `optional` beside a
   * compared number (an invite that is over refuses nothing then); the one-press Add of an invited PC needs it open.
   */
  readonly invite?: { readonly key: string; readonly optional: boolean };
  /** the invite the one-press Add needed ended after the admission: Try again cannot place it, so only No is offered */
  readonly ended?: true;
};

/** A card held by the parent while its Add places the PC (`admitted`: the account took it already). */
type Held = { readonly pc: DirectoryPc; readonly placing: Placing; readonly admitted: boolean };

/** No number came for a PC that asks to be added (listAdd.ts). */
class NumberError extends Error {
  constructor(readonly why: NumberRefusal) {
    super(`No number for that PC (${why})`);
    this.name = "NumberError";
  }
}

/** The list did not take the PC, or the account did not admit it. */
class AddRefused extends Error {
  constructor(readonly outcome: Extract<AddPcOutcome, { readonly added: false }>) {
    super(`The PC was not added to the account's list (${outcome.why})`);
    this.name = "AddRefused";
  }
}

/**
 * PCL-1: the PCs a device code listed in the account (anyone may type one for any PC) and no app's own sign-in confirmed,
 * each offered to this device while its sign-in is an app's own; a device code's sign-in is offered nothing. Read on
 * mount, focus and when the account's PCs change. Add is the account's one-press admission of the PC, which also
 * confirms its listing: the PC then takes it with its own key's proof (`ovis add` waits for it; docs/relay.md, "A PC
 * with no screen"). `tellConfirmed`: after Add, the PC's new-PC card (C3) is drawn here, where no NewPcNotices tells of
 * it already. `onSignInAgain`: a fresh own sign-in, after which the add goes on.
 */
export function UnconfirmedPcNotices({ service = indexedAccountService, enabled = true, tellConfirmed = true, now = Date.now, numberWaitMs, onSignInAgain }: {
  readonly service?: AccountService;
  /** how long a card waits for a PC's answer before it shows a number; a test's own */
  readonly numberWaitMs?: number | undefined;
  readonly enabled?: boolean;
  readonly tellConfirmed?: boolean;
  readonly now?: () => number;
  readonly onSignInAgain?: ((provider: AccountProvider) => void) | undefined;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [confirmed, setConfirmed] = useState<readonly DirectoryPc[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  // The cards whose Add is placing a PC, with what they place, held here from before the admission: once the account
  // admitted the PC its directory no longer lists it as asking, and a read of it while the entry goes out would take
  // the card away. They stay until the device's own copy holds the PC or the person says No (`admitted`: the account
  // took the PC, so Try again places it with no admission)
  const [kept, setKept] = useState<readonly Held[]>([]);
  const release = (serverId: string): void => setKept((prior) => prior.filter((each) => each.pc.server_id !== serverId));
  useEffect(() => {
    if (!enabled) { setListing(null); return; }
    let version = 0;
    const read = async (): Promise<void> => {
      const mine = ++version;
      try {
        const session = await service.session();
        if (mine !== version) return;
        if (session === undefined) { setListing(null); return; }
        const directory = service.forSignIn(session);
        const [own, pcs] = await Promise.all([directory.ownSignIn(), directory.listUnconfirmedPcs()]);
        if (mine !== version) return;
        // a device code's sign-in cannot admit, and it is no one's to remove a PC with: nothing is offered to it
        setListing((prior) => own ? { session, pcs, pending: prior?.session.account === session.account ? prior.pending : takePendingAdd(session.account) } : null);
      } catch (error) {
        if (mine !== version) return;
        if (error instanceof SignedOutError) setListing(null);
        else if (error instanceof Error) console.warn("Ovis: the account's unconfirmed PCs could not be read", error.name);
        else throw error;
      }
    };
    const visibleRead = (): void => { if (document.visibilityState === "visible") void read(); };
    const signInChanged = (): void => { setListing(null); setConfirmed([]); setKept([]); void read(); };
    void read();
    document.addEventListener("visibilitychange", visibleRead);
    window.addEventListener("focus", visibleRead);
    window.addEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    return () => {
      version++;
      document.removeEventListener("visibilitychange", visibleRead);
      window.removeEventListener("focus", visibleRead);
      window.removeEventListener(ACCOUNT_SIGN_OUT_EVENT, signInChanged);
      window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, visibleRead);
    };
  }, [service, enabled]);

  if (listing === null) return null;
  const { session } = listing;
  const told = new Set(confirmed.map((pc) => pc.server_id));
  const asking = new Set(listing.pcs.map((pc) => pc.server_id));
  const cards = [...listing.pcs, ...kept.map((each) => each.pc).filter((pc) => !asking.has(pc.server_id))];
  return (
    <>
      {cards.filter((pc) => !told.has(pc.server_id) && !removed.has(pc.server_id)).map((pc) => (
        <UnconfirmedPcNotice key={`${session.account}:${pc.server_id}:${pc.listing_id ?? pc.added_at}`} pc={pc} session={session} service={service} now={now} retry={pendingFor(listing.pending, pc)} numberWaitMs={numberWaitMs}
          {...(onSignInAgain ? { onSignInAgain } : {})}
          onConfirmed={(row) => setConfirmed((prior) => [...prior.filter((each) => each.server_id !== row.server_id), row])}
          placing={kept.find((each) => each.pc.server_id === pc.server_id && each.admitted)?.placing ?? null}
          onHold={(placing, admitted) => setKept((prior) => [...prior.filter((each) => each.pc.server_id !== pc.server_id), { pc, placing, admitted }])}
          onRelease={() => release(pc.server_id)}
          onRemoved={() => { setRemoved((prior) => new Set([...prior, pc.server_id])); release(pc.server_id); }} />
      ))}
      {tellConfirmed && confirmed.map((pc) => <NewPcNotice key={`${session.account}:new:${pc.server_id}`} pc={pc} session={session} dismissalKey={newPcNoticeKey(session.account, pc)} />)}
    </>
  );
}

/** The question for a PC that joined with an invite of the account: whose invite it was, where this device can read that. */
export function invitedTitle(t: Translate, invited: Pick<InvitedPc, "by">, members: readonly { readonly key: string; readonly self: boolean; readonly name: { readonly label: string } | null }[] = pageAccountList()?.view().devices ?? []): string {
  const placer = members.find((device) => device.key === invited.by);
  if (placer?.self === true) return t("Add this PC to your account? (joined with your invite)");
  const name = placer?.name?.label;
  return name === undefined ? t("Add this PC to your account? (joined with an invite of your account)") : t("Add this PC to your account? (joined with the invite from {device})", { device: name });
}

function UnconfirmedPcNotice({ pc, session, service, now, retry, numberWaitMs, onSignInAgain, onConfirmed, placing, onHold, onRelease, onRemoved }: {
  readonly pc: DirectoryPc;
  readonly session: AccountSession;
  readonly service: AccountService;
  readonly now: () => number;
  readonly retry: boolean;
  /** how long the card waits for the PC's answer before it shows a number (listAdd.ts, NUMBER_WAIT_MS); a test's own */
  readonly numberWaitMs?: number | undefined;
  readonly onSignInAgain?: (provider: AccountProvider) => void;
  readonly onConfirmed: (row: DirectoryPc) => void;
  /** what this card goes on placing once the account admitted the PC and the list did not take its entry; null otherwise */
  readonly placing: Placing | null;
  /** the parent holds the card and what it places from before the admission on, whatever the directory says since */
  readonly onHold: (placing: Placing, admitted: boolean) => void;
  readonly onRelease: () => void;
  readonly onRemoved: () => void;
}) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  const added = Date.parse(pc.added_at);
  // the account service names a window only for a listing that asks to join; null or absent, the card is as it was
  const [toldExpired, setToldExpired] = useState(false);
  const asking = typeof pc.asking_until === "string" || toldExpired;
  const askedUntil = typeof pc.asking_until === "string" ? Date.parse(pc.asking_until) : Number.POSITIVE_INFINITY;
  const until = Math.min(added + ADD_WINDOW_MS, askedUntil);
  const youngAt = (at: number): boolean => !(at > until);
  const [young, setYoung] = useState(() => youngAt(now()));
  const ranOut = asking && !young;
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const inFlight = useRef(false);
  // On an account with a signed list, for a PC that posted its keys for it: the number both screens show, worked out
  // with the PC (listAdd.ts). The person confirms it at the PC first; the Add beside it then signs the PC into the list.
  const [number, setNumber] = useState<AddNumber | null>(null);
  // The PC joined with an invite of this account, by this device's own check of the line's signature over the PC's
  // card (listInvited.ts): its Add needs no number. null: it did not, or that is not known.
  const [invited, setInvited] = useState<InvitedPc | null>(null);
  // Read again whenever what it stands on may have changed: the list (an entry placed, a revoke), the posts (a proof
  // that came after the card was drawn), the account's PCs, the page coming back to the front, and the invite's end
  const [reread, setReread] = useState(0);
  useEffect(() => {
    const again = (): void => setReread((count) => count + 1);
    const unsubscribe = pageAccountList()?.subscribe(again);
    window.addEventListener("focus", again);
    window.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, again);
    return () => { unsubscribe?.(); window.removeEventListener("focus", again); window.removeEventListener(ACCOUNT_PCS_CHANGED_EVENT, again); };
  }, [session.account]);
  useEffect(() => {
    let live = true;
    void (async () => {
      const list = pageListReading(session.account) === "in" ? pageAccountList() : null;
      const writer = list?.writer() ?? null;
      if (list === null || writer === null) { if (live) setInvited(null); return; }
      const found = (await invitedPcs(list, await writer.service.listPosts(writer.list), now())).find((each) => each.server_id === pc.server_id) ?? null;
      if (live) setInvited(found);
    })().catch((error: unknown) => { console.warn("Ovis: the PCs that joined with an invite could not be read", error instanceof Error ? error.name : error); });
    return () => { live = false; };
  }, [session.account, pc, now, reread]);
  useEffect(() => {
    if (invited === null) return;
    // at the invite's end by this device's clock the card stops offering the one press, whatever a read of the posts
    // answers then; and it reads them again
    const timer = setTimeout(() => {
      setInvited((current) => (current !== null && now() >= current.exp * 1000 ? null : current));
      setReread((count) => count + 1);
    }, Math.max(0, invited.exp * 1000 - now()) + 1_000);
    return () => clearTimeout(timer);
  }, [invited, now]);
  // the numbers this card asked for: NUMBER_TRIES at most, Not the same and a number that ran out included
  const [tries, setTries] = useState(0);
  const spent = tries >= NUMBER_TRIES && number === null;
  const numberEnd = useRef<AbortController | null>(null);
  useEffect(() => () => numberEnd.current?.abort(new DOMException("The card closed", "AbortError")), []);
  useEffect(() => {
    if (number === null) return;
    // the PC takes a yes for a number only so long: after that the card asks for a new one
    const timer = setTimeout(() => { setNumber(null); setProblem(numberEnded(t, tries)); }, Math.max(0, number.until - now()));
    return () => clearTimeout(timer);
  }, [number, t, tries, now]);
  const removal = usePcRemoval(service, () => {
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    onRemoved();
  });
  useEffect(() => {
    if (!young) return;
    const timer = setTimeout(() => setYoung(false), Math.max(0, Math.min(ADD_WINDOW_MS, until - now())));
    const tick = setInterval(() => setTick((count) => count + 1), TICK_MS);
    return () => { clearTimeout(timer); clearInterval(tick); };
  }, [young, until, now]);
  // what an Add was told says nothing once the request ran out
  useEffect(() => { if (ranOut) setProblem(null); }, [ranOut]);

  const act = async (work: () => Promise<void>, failed: (error: Error) => Problem): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try { await work(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      setProblem(failed(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const directory = service.forSignIn(session);
  // the ten minutes are checked again at the press: a page left open never adds an old listing
  const add = (): Promise<void> => act(async () => {
    if (!youngAt(now())) { setYoung(false); return; }
    // The account has a list, by this device's own knowledge of it: a PC that posted for the list is added by the
    // number, and nothing else (no admission of the directory's alone, whatever became of the post or of this
    // device's standing). A page that has not read its list yet says so, and reads it for the next press
    const page = pageAccountList();
    const known = page !== null && await accountHasList(page, session.account);
    const list = known && pageListReading(session.account) === "in" ? page : null;
    if (known && (list === null || list.writer() === null)) {
      if (page.view().account !== session.account) void readPageList(session.account);
      throw new AddRefused({ added: false, why: "blocked", retryAfterMs: null });
    }
    // A PC that joined with an invite of this account: the line's own signature says that it is this PC, so the one
    // press admits it, signs its entry and ends the invite. It is checked again at the press.
    // The press is for the card that was shown: the very keys, card and invite. A post that changed since (other keys
    // under the same relay key, another invite) is drawn again for a press of its own, and nothing is signed for it
    const shownCard = invited;
    const writer = list?.writer() ?? null;
    if (list !== null && writer !== null && shownCard !== null) {
      const posted = (await invitedPcs(list, await writer.service.listPosts(shownCard.list), now())).find((each) => each.server_id === pc.server_id) ?? null;
      const same = posted !== null && posted.endpoint === shownCard.endpoint && posted.key === shownCard.key && posted.enc === shownCard.enc && posted.card === shownCard.card && posted.invite === shownCard.invite && posted.list === shownCard.list;
      if (!same) { setInvited(posted); return; }
      await place({ post: shownCard, member: writer.keys.key, invite: { key: shownCard.invite, optional: false } });
      return;
    }
    const post = list === null ? undefined : (await postedPcs(list)).find((each) => each.server_id === pc.server_id);
    if (known && post === undefined) throw new NumberError("gone");
    if (list !== null && post !== undefined) {
      if (tries >= NUMBER_TRIES) throw new NumberError("spent");
      setTries((count) => count + 1);
      numberEnd.current?.abort(new DOMException("Another number was asked for", "AbortError"));
      const end = new AbortController();
      numberEnd.current = end;
      const outcome = await numberWith(list, post, { signal: end.signal, now, ...(numberWaitMs === undefined ? {} : { waitMs: numberWaitMs }) });
      if (!outcome.shown) throw new NumberError(outcome.why);
      setNumber(outcome.number);
      return;
    }
    // account#67: the admit names no listing, so the one waiting is read first. When it is no longer the one this card
    // showed (another device said No, the PC listed itself again), nothing is admitted and the card is drawn again
    const waiting = (await directory.listUnconfirmedPcs()).find((each) => each.server_id === pc.server_id);
    if (waiting === undefined || waiting.listing_id !== pc.listing_id) {
      window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
      return;
    }
    let admitted: { readonly new_until: string; readonly admitted_at: string | null };
    try { admitted = await directory.admitPc(pc.server_id, undefined, typeof waiting.listing_id === "string" ? waiting.listing_id : undefined); }
    catch (error) {
      // the service's own window for it ended: nothing was admitted, and the request is started again on the PC
      if (error instanceof AccountServiceError && error.code === "listing_expired") { setToldExpired(true); setYoung(false); return; }
      // the account no longer lists it, or lists another listing of it: nothing was admitted, and the card is drawn again.
      // A key proof signs the listing it read, so a listing replaced meanwhile is refused as the sign-in's age: read again
      const changed = error instanceof AccountServiceError && (error.code === "unknown_pc" || error.code === "listing_changed"
        || (error.code === "session_not_fresh" && await directory.listUnconfirmedPcs().then((pcs) => pcs.find((each) => each.server_id === pc.server_id)?.listing_id !== pc.listing_id, () => false)));
      if (!changed) throw error;
      window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
      return;
    }
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    // Nothing of this press goes into the device's own record of its PCs (seenPcs.ts): no number was compared and no
    // QR code scanned, so the press proves nothing about whose PC the account service listed.
    // the new-PC card's dismissal is kept under the admission's time (newPcNoticeKey): the service's own, as its directory
    // row gives it, never this device's clock, so a card closed here stays closed when the row is read again
    const at = admitted.admitted_at ?? (await directory.listPcs().catch(() => [])).find((each) => each.server_id === pc.server_id)?.admitted_at ?? null;
    const { unconfirmed: _unconfirmed, asking: _asking, asking_until: _until, ...listed } = pc;
    onConfirmed({ ...listed, new_until: admitted.new_until, admitted_at: at });
  }, (error) => error instanceof NumberError ? { text: numberRefusal(t, error.why), signInAgain: false } : error instanceof AddRefused ? addRefusal(t, error.outcome) : refusal(t, error));
  /** Add, beside the number: the account admits the PC, and this device signs it into the list with the card the number came from. */
  /**
   * Signs the PC into the list with the card the number came from. Once the account admitted the PC and the list did
   * not take its entry, the card stays (held by the parent, onHold) and says so, and Try again goes again with the same card and member key:
   * the request kept for it is sent again, or signed anew on a new head. Nothing is admitted a second time.
   */
  const place = async (shown: Placing, until?: number): Promise<void> => {
    const list = pageAccountList();
    if (list === null) return;
    let admitted = placing !== null;
    const invite = shown.invite;
    // the service's id of the invite this request ends, found before its end is placed
    const serviceId = invite === undefined ? null : await serviceInviteId(list, invite.key);
    // held by the parent before the admission: a read of the account's PCs while the entry goes out keeps the card
    // a number lives so long: checked again after the last lookup, right before the admission (a retry of a PC the
    // account admitted already goes on)
    if (!admitted && until !== undefined && now() >= until) { setNumber(null); setProblem(numberEnded(t, tries)); return; }
    onHold(shown, admitted);
    const outcome = await addPostedPc(list, shown.post, listNames(accountLabel(pc.label), pc.asking?.os ?? null), {
      expect: { account: session.account, list: shown.post.list }, member: shown.member,
      admit: async () => {
        if (admitted) return;
        await directory.admitPc(pc.server_id, undefined, typeof pc.listing_id === "string" ? pc.listing_id : undefined);
        admitted = true;
        onHold(shown, true);
      },
      ...(invite === undefined ? {} : { invite: { key: invite.key, open: (writer: ListWriter) => inviteLetsIn(writer, invite.key, writer.issued_at), ...(invite.optional ? { optional: true as const } : {}) } }),
    });
    // the service's own window for the listing ended: nothing was admitted, and the request is started again on the PC
    if (!outcome.added && outcome.why === "admit" && outcome.code === "listing_expired") { onRelease(); setNumber(null); setToldExpired(true); setYoung(false); return; }
    // nothing admitted: the card is the directory's again; admitted, it stays with Try again (the parent holds it)
    if (!outcome.added && !admitted) onRelease();
    if (!outcome.added && admitted) setNumber(null);
    // the invite ended after the admission: the card stays with No alone (Try again would need that very invite)
    if (!outcome.added && admitted && outcome.why === "invite_ended") onHold({ ...shown, ended: true }, true);
    if (!outcome.added) throw new AddRefused(outcome);
    // The person pressed Add where a number was compared on both screens (`added`), or on the card of a PC whose line's
    // own proof says it joined with a member's invite (`invited`): kept in this device's own record of its PCs, by the
    // relay key, before the card goes (a tab closed right after keeps it). It only records.
    await noteAct(session.account, shown.post.endpoint, invite !== undefined && !invite.optional ? "invited" : "added").catch(() => undefined);
    // the invite this request ended in the list is ended at the account service too, whoever made it
    if (invite !== undefined) void endInviteAtService(list, invite.key, serviceId);
    setNumber(null);
    window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
    onRemoved();
  };
  const placed = (error: Error): Problem => error instanceof AddRefused ? addRefusal(t, error.outcome) : refusal(t, error);
  const addByNumber = (shown: AddNumber): Promise<void> => act(async () => {
    // the number lives so long: a press after it adds nothing, whatever the timer did not draw yet
    if (now() >= shown.until) { setNumber(null); setProblem(numberEnded(t, tries)); return; }
    // A PC that joined with a member's invite, as the line's own proof for this very card says now: the invite is ended
    // beside its entry, so the same line adds no second PC (it was compared by the number all the same)
    const list = pageAccountList();
    const writer = list?.writer() ?? null;
    let joined: InvitedPc | undefined;
    if (list !== null && writer !== null) {
      try { joined = (await invitedPcs(list, await writer.service.listPosts(writer.list), now())).find((each) => each.endpoint === shown.post.endpoint && each.key === shown.post.key && each.enc === shown.post.enc && each.card === shown.post.card); }
      catch { joined = undefined; }
    }
    await place({ post: shown.post, member: shown.member, ...(joined === undefined ? {} : { invite: { key: joined.invite, optional: true } }) }, shown.until);
  }, placed);
  const placeAgain = (shown: Placing): Promise<void> => act(() => place(shown), placed);
  const notTheSame = (): void => {
    numberEnd.current?.abort(new DOMException("The numbers were not the same", "AbortError"));
    setNumber(null);
    setProblem({ text: tries >= NUMBER_TRIES ? numberRefusal(t, "spent") : t("The numbers did not match. This PC was not added."), signInAgain: false });
  };
  // No: a listing that asks is removed by its id (account#67); a PC the account admitted already no longer asks, so
  // the PC itself is removed, which the account service takes for an admitted PC
  const remove = (): Promise<void> => act(async () => { await removal.remove(session, pc.server_id, placing === null && typeof pc.listing_id === "string" ? pc.listing_id : undefined); },
    () => ({ text: t("The PC could not be removed. Try again."), signInAgain: false }));
  const latestAdd = useRef(add);
  latestAdd.current = add;
  useEffect(() => { if (retry) void latestAdd.current(); }, [retry]);

  const time = new Date(added).toLocaleTimeString(resolvedLanguage, { hour: "2-digit", minute: "2-digit" });
  const asker = askerLine(pc.asking, resolvedLanguage);
  return (
    <div className="update-notice is-paired device-notice" role="status" data-unconfirmed-pc={pc.server_id} {...(asking ? { "data-asking": young ? "open" : "ran-out" } : {})}>
      <Monitor aria-hidden="true" />
      <span className="device-notice-text">
        {young && <span>{invited === null ? t("Add this PC to your account?") : invitedTitle(t, invited)}</span>}
        {number !== null && young && (
          <>
            <span>{t("Check that the PC shows this number and confirm it there, then Add")}</span>
            <span className="relay-shell-digits" aria-label={number.digits.split("").join(" ")}>{`${number.digits.slice(0, 3)} ${number.digits.slice(3)}`}</span>
          </>
        )}
        <span>{t("Name the PC gave itself: \"{name}\"", { name: accountLabel(pc.label) })}</span>
        {asker !== null && <span className="settings-hint" data-asker>{asker}</span>}
        {/* a PC that joined with an invite, by the line's own proof, came with no sign-in code: nothing is said of one */}
        {invited === null && <span className="settings-hint">{t("A PC was added to your account with a sign-in code at {time}.", { time })}{young ? ` ${t("Add it only if you started adding that PC yourself and entered the code it showed. If someone else gave you the code, or you did not start this, press No.")}` : ""}</span>}
        {asking && young && <span className="settings-hint">{t("Expires in {minutes} min", { minutes: Math.min(10, Math.max(1, Math.ceil((until - now()) / 60_000))) })}</span>}
        {ranOut && <span>{t("This request ran out. To add this PC, start again on the PC.")}</span>}
        {placing !== null && <span>{placing.ended ? t("This request ran out. To add this PC, start again on the PC.") : t("{name} is not in your account's list yet. Try again.", { name: accountLabel(pc.label) })}</span>}
        {problem !== null && <span className="account-error" role="alert">{problem.text}</span>}
        {removal.prompt}
      </span>
      <div className="device-paired-actions">
        {!ranOut && problem?.signInAgain === true && onSignInAgain !== undefined && (
          <button type="button" className="btn" disabled={busy} onClick={() => { keepPendingAdd(session.account, pc); onSignInAgain(session.provider); }}>{t("Sign in again")}</button>
        )}
        {placing !== null ? (
          <>
            {!placing.ended && <button type="button" className="btn" disabled={busy} onClick={() => void placeAgain(placing)}>{t("Try again")}</button>}
            <button type="button" className="btn" disabled={busy} onClick={remove}>{t("No|account pc")}</button>
          </>
        ) : young && number !== null ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => void addByNumber(number)}>{t("Add|account pc")}</button>
            <button type="button" className="btn" disabled={busy} onClick={notTheSame}>{t("Not the same")}</button>
          </>
        ) : young ? (
          <>
            {!spent && <button type="button" className="btn" disabled={busy} onClick={add}>{t("Add|account pc")}</button>}
            <button type="button" className="btn" disabled={busy} onClick={remove}>{t("No|account pc")}</button>
          </>
        ) : <button type="button" className="btn" disabled={busy} onClick={remove}>{ranOut ? t("No|account pc") : t("Remove from my account")}</button>}
      </div>
    </div>
  );
}
