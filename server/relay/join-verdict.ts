/**
 * What this PC does with one join whose digits were compared and that brought no card for the account's list (that one
 * is the list's to decide, session.ts allowIntoList), decided in one place and read without writing anything: the
 * session acts on it once both sides confirmed (session.ts admitCompared), and GET /api/relay/joins and the answer to
 * POST /api/relay/join show what an approval in this PC's own window or at `ovis approve` meets. `pairRelayApproved`
 * stays the last gate: its rate limit and the relay's refusal of a new device are known only in the turn that writes
 * the row.
 */
import type { RequestServices } from "../dispatch.ts";
import type { KeptOut } from "../devices.ts";

/**
 * `out`: nobody is let in. `by`: `guard`, this PC's admission guard keeps the key out; `approval`, an approval from
 * another device of the account no longer stands, which counts as a failed pairing. `why` names what keeps the key out,
 * or is null where only the approver's own standing ended it (an enrollment, an approver gone or being removed), which
 * the device is not told.
 */
export type JoinVerdict = { readonly lets: "in" } | { readonly lets: "out"; readonly by: "guard" | "approval"; readonly why: KeptOut | null };

/** `fromAfar`: the account member `by` approved it from another device, for the row `id`; unset for an approval on this PC itself. */
export function joinVerdict(services: Pick<RequestServices, "devices" | "accountMailbox">, key: string, fromAfar?: { readonly by: string; readonly id: string }): JoinVerdict {
  const { devices, accountMailbox } = services;
  if (fromAfar !== undefined) {
    const gates = accountMailbox.gates();
    // a hold of the key itself is the account's word on that key: named, as the guard names it where it asks
    if (gates.held(key)) return { lets: "out", by: "approval", why: devices.keptOut(key) ?? "account_hold" };
    const approverKey = devices.relayKeyOf(fromAfar.by);
    // the recheck of the approver's standing is account work (flag on); flag off keeps main's held check only
    if (devices.opensAll() && devices.has(fromAfar.id) && (gates.enrolling() || !approverKey || gates.removing?.(approverKey))) {
      return { lets: "out", by: "approval", why: null };
    }
  }
  const why = devices.keptOut(key, { pairingHere: fromAfar === undefined });
  return why === null ? { lets: "in" } : { lets: "out", by: "guard", why };
}
