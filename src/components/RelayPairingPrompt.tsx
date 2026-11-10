import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";

import "./DevicePairedNotice.css";
import "./RelayPairingPrompt.css";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { inFocusTrap } from "../lib/useFocusTrap.ts";
import { failureText } from "./RelayPanel.tsx";

/** Whole seconds from `now` until `at`, never below 0. */
export function secondsLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * When a request runs out on this window's clock; null when nothing says. The PC's `left_ms` is counted
 * from when this window first saw the request (each telling is a new object), since a window's clock need
 * not match the PC's `expires_at`: a tablet two minutes fast would read "0 s left" for its whole life.
 */
const heard = new WeakMap<RelayPairingRequest, number>();
export function deadlineOf(pairing: RelayPairingRequest, now: number): number | null {
  const known = heard.get(pairing);
  if (known !== undefined) return known;
  const left = pairing.left_ms;
  // an older server sends no `left_ms`: its `expires_at` against this clock is all there is
  const at = typeof left === "number" && Number.isFinite(left) && left >= 0 ? now + left : Date.parse(pairing.expires_at);
  if (Number.isNaN(at)) return null;
  heard.set(pairing, at);
  return at;
}

/**
 * The two halves of a sentence that names the digits in its middle, so each language keeps its own word
 * order. The template is cut at its own `{digits}` before the name goes in: the name is whatever the
 * asking device sent, and must not be able to move the cut or drop what follows it.
 */
export function aroundDigits(template: string, name: string): [string, string] {
  const at = template.indexOf("{digits}");
  const named = (part: string) => part.replaceAll("{name}", () => name);
  return at < 0 ? [`${named(template)} `, ""] : [named(template.slice(0, at)), named(template.slice(at + "{digits}".length))];
}

/**
 * Where the person may be typing: a field (a terminal's is a textarea), or a frame, whose page has the keys
 * while this document only sees the frame focused (the in-app browser's popup, an HTML or PDF preview).
 * Its keys stay its own.
 */
const TEXT_ENTRY = 'input, textarea, select, iframe, embed, object, [contenteditable]:not([contenteditable="false"])';
/**
 * Whether a prompt that arrives may take the focus from `active`. Only where it would be far otherwise:
 * nothing has the focus, or a modal dialog holds Tab inside itself (Settings). Never from a field or a
 * frame, where the keys already on their way (a shell's Tab, then Enter) would land on Approve; the layer's
 * live region announces the prompt there, and it is a click or a Tab away: a dialog's Tab round goes on
 * from its last stop to the prompt (Shift+Tab from its first), on the prompt itself before its buttons
 * (`overlayStops` in lib/useFocusTrap.ts). That dialog is one whose Tab round `useFocusTrap` holds, not
 * every `aria-modal` surface: one that keeps Tab by a key handler of its own (session history, the worktree
 * dialog, a row's sheet) does not hear a Tab pressed on the prompt, which would go on to the page it covers.
 */
export function takesFocus(active: Element | null): boolean {
  if (active === null || active === document.body) return true;
  if (!(active instanceof HTMLElement) || active.closest(TEXT_ENTRY) !== null) return false;
  return inFocusTrap(active);
}

/**
 * Approving lets a device into this PC, so it must be meant for the prompt it lands on, by someone who had
 * the time to read it. How long a key cannot press Approve after the prompt arrived, moved to another place
 * in the stack or was handed the focus: keys typed for what was there before it (a Tab and an Enter by
 * habit, right after the prompt above was approved).
 */
export const APPROVE_KEY_GUARD_MS = 1000;
/** The same for a pointer, which is aimed by sight: a click on its way to what the prompt now covers, or to the prompt that was in its place. */
export const APPROVE_POINTER_GUARD_MS = 500;

/**
 * The devices waiting for this PC's approval (`relay-pairings`), a prompt each. One that arrives over
 * a modal dialog takes the focus on its own surface, never on Approve, and a dialog's focus trap counts
 * it and its buttons among its own Tab stops (lib/useFocusTrap.ts). Approve waits for a moment after its
 * prompt arrived, moved or was handed the focus (`approve`). It is a group, not a dialog: it
 * covers nothing, so the page's "a dialog is open" checks (Escape handlers, pane cover) must not count it.
 */
export function RelayPairingPrompt({ pairings }: { pairings: readonly RelayPairingRequest[] }) {
  const t = useT();
  const id = useId();
  const [busy, setBusy] = useState<{ id: string; decision: "approve" | "decline" } | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const decide = async (id: string, decision: "approve" | "decline") => {
    setBusy({ id, decision });
    setFailure(null);
    try { await decideRelayPairing(id, decision); }
    catch (error) { setFailure({ id, text: failureText(error instanceof Error ? error : new Error(String(error))) }); }
    finally { setBusy(null); }
  };

  const ids = pairings.map((pairing) => pairing.id).join(" ");
  const [now, setNow] = useState(() => Date.now());
  // read once per telling (deadlineOf keeps it), at the moment this window heard it
  const deadlines = pairings.map((pairing) => deadlineOf(pairing, Date.now()));
  const timed = deadlines.some((at) => at !== null);
  useEffect(() => {
    if (!timed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
    // a list that changes starts the seconds again from its own arrival
  }, [timed, ids]);

  const layer = useRef<HTMLDivElement>(null);
  const prompts = useRef(new Map<string, HTMLDivElement>());
  /** when each prompt arrived, last moved to another place in the stack or was last handed the focus: Approve's guards count from it */
  const since = useRef(new Map<string, number>());
  /** each prompt's place in the stack, as last drawn */
  const places = useRef(new Map<string, number>());
  /** the focus is, or was until its prompt went, inside the layer */
  const held = useRef(false);
  /** what had the focus before the first prompt took it, or before Tab brought it into one */
  const opener = useRef<HTMLElement | null>(null);
  /** the focus was given back by a cleanup React ran only to run the effects again (development's replay): it is taken again */
  const replayed = useRef(false);
  useLayoutEffect(() => {
    const arrived = pairings.filter((pairing) => !since.current.has(pairing.id));
    const at = Date.now();
    // one that moved up when the prompt above it went is new where it is now: a click or a key on its way
    // to the prompt that was there must not press it
    since.current = new Map(pairings.map((pairing, index) => [pairing.id, places.current.get(pairing.id) === index ? since.current.get(pairing.id) ?? at : at]));
    places.current = new Map(pairings.map((pairing, index) => [pairing.id, index]));
    const active = document.activeElement;
    if (replayed.current) { replayed.current = false; held.current = true; }
    // a prompt being read keeps the focus when another arrives
    if (layer.current?.contains(active)) return;
    if (!takesFocus(active)) return;
    // a new prompt takes it; so does the next one when the prompt that had it was decided or ran out,
    // but not when the person had taken the focus back to the page meanwhile
    const next = arrived[0] ?? (held.current ? pairings[0] : undefined);
    const node = next && prompts.current.get(next.id);
    if (!node) return;
    const before = held.current ? opener.current : active instanceof HTMLElement ? active : null;
    node.focus({ preventScroll: true });
    // refused under an inert pane column (a phone's open drawer): nothing was taken, so nothing goes back
    if (document.activeElement !== node) return;
    opener.current = before;
    held.current = true;
    // handed the focus, not walked to: the next keys may be habit (Tab, Enter), so its guard starts again
    since.current.set(next.id, at);
    // several devices in a short window scroll: the one with the focus is in view. A stack that moved
    // for it put other prompts under the pointer, so theirs start again too
    const scrolled = layer.current?.scrollTop;
    node.scrollIntoView({ block: "nearest" });
    if (layer.current?.scrollTop !== scrolled) for (const moved of since.current.keys()) since.current.set(moved, at);
  }, [ids]);
  useLayoutEffect(() => {
    const node = layer.current;
    return () => {
      // the last prompt went: the focus it took goes back where it was, unless it has moved on since
      const active = document.activeElement;
      const from = opener.current;
      if (!held.current || !from?.isConnected) return;
      if (active !== null && active !== document.body && !node?.contains(active)) return;
      from.focus({ preventScroll: true });
      // read by this component only if it is still there: a prompt that really went has no next effect
      replayed.current = true;
    };
  }, []);
  /** `clicks`: the click's `detail`. 0 is Enter or Space on the button (a click that no pointer made), 2 the second click of a double-click */
  const approve = (id: string, clicks: number): void => {
    // aimed at whatever the first click pressed, which may be gone with this prompt in its place
    if (clicks > 1) return;
    const from = since.current.get(id);
    if (from === undefined || Date.now() - from < (clicks === 0 ? APPROVE_KEY_GUARD_MS : APPROVE_POINTER_GUARD_MS)) return;
    void decide(id, "approve");
  };

  return (
    <div ref={layer} className="relay-pairing-layer" role="region" aria-live="assertive" aria-label={t("Devices waiting for approval")}
      onFocus={(event) => {
        // walked in by Tab from a modal dialog's round: that stop gets the focus back when the last prompt goes.
        // Not from the page (a tap on Approve from a terminal must not raise a phone's keyboard again afterwards)
        const from = event.relatedTarget;
        if (!held.current && from instanceof HTMLElement && !event.currentTarget.contains(from) && inFocusTrap(from)) opener.current = from;
        held.current = true;
      }}
      // to nothing (Approve pressed by a key is disabled, then gone: the browser drops the focus) is not the person moving on
      onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) held.current = false; }}>
      {pairings.map((pairing, index) => {
        const deciding = busy?.id === pairing.id ? busy.decision : null;
        const digits = <strong className="relay-pairing-digits">{`${pairing.digits.slice(0, 3)} ${pairing.digits.slice(3)}`}</strong>;
        // the device this PC is added from shows an input, not digits (AddPcSheet): its person types this PC's there
        const [before, after] = pairing.local_only
          ? aroundDigits(t("{name} wants to add this PC to your account. Type {digits} on {name}, or check that {name} shows the same number, then press Approve here."), pairing.label)
          : [`${t("{name} wants to pair through the relay. Approve it only if its screen shows", { name: pairing.label })} `, ""];
        const until = deadlines[index] ?? null;
        // `now` is a tick behind a request that has just arrived: never more than the PC said is left
        const left = until === null ? null : secondsLeft(until, Math.max(now, until - (pairing.left_ms ?? Infinity)));
        return (
          <div key={pairing.id} ref={(node) => { if (node) prompts.current.set(pairing.id, node); else prompts.current.delete(pairing.id); }}
            className="update-notice is-paired relay-pairing-prompt" role="group" aria-labelledby={`${id}-${pairing.id}`} tabIndex={-1}
            data-testid="relay-pairing-prompt" data-local-only={pairing.local_only ? "true" : undefined}>
            <Smartphone aria-hidden="true" />
            <span>
              <span id={`${id}-${pairing.id}`}>{before}{digits}{after}</span>
              {/* a second that passes is not news: the layer announces the prompt, not its clock */}
              {left !== null && <span className="relay-pairing-left" aria-live="off" data-testid="relay-pairing-left"> {t("{n} s left", { n: left })}</span>}
              {failure?.id === pairing.id && <span className="relay-error" role="alert"> {failure.text}</span>}
            </span>
            <div className="device-paired-actions">
              <button type="button" className="btn btn-primary" disabled={deciding !== null} aria-busy={deciding === "approve" ? true : undefined} onClick={(event) => approve(pairing.id, event.detail)}>{t("Approve")}</button>
              <button type="button" className="btn" disabled={deciding !== null} aria-busy={deciding === "decline" ? true : undefined} onClick={() => void decide(pairing.id, "decline")}>{t("Decline")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
