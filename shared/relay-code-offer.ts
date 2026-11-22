/**
 * Exactly one exchange per call: a call is one tap on Pair, and nothing here
 * tries again with the code it was given, so a relay acting as the PC gets one guess per tap.
 * The offer is then checked as a scanned link's is (its key must give its PC id) and must carry a
 * pairing code; the hosted shell, or Settings → Remote PCs on a PC that adds another, shows the
 * PC's ID to compare before it pairs with it.
 */
import type { RelaySocket } from "./relay-channel.ts";
import { importPublicKey } from "./relay-e2ee.ts";
import { GLOBAL_RELAY } from "./relay-regions.ts";
import { validateOffer, type RelayOffer } from "./relay-offer.ts";
import { normalizePairCode, PAIR_CLOSE, PairCodeExpiredError, PairCodeGuest, splitPairCode } from "./relay-pair-code.ts";
import { deriveServerId } from "./relay-server-proof.ts";

export type TypedCodeFailure = "not-a-code" | "no-pc" | "wrong" | "expired" | "busy" | "unreachable" | "forged";

export const TYPED_CODE_FAILURES: readonly TypedCodeFailure[] = ["not-a-code", "no-pc", "wrong", "expired", "busy", "unreachable", "forged"];

export class TypedCodeError extends Error {
  constructor(readonly failure: TypedCodeFailure) { super(failure); }
}

const { NO_HOST, BUSY, DROPPED } = PAIR_CLOSE;
const EXCHANGE_MS = 30_000;

export interface TypedCodeOptions {
  relay?: string;
  signal?: AbortSignal;
  connect?: (url: string) => RelaySocket;
}

export function offerFromCode(input: string, options: TypedCodeOptions = {}): Promise<RelayOffer> {
  const code = normalizePairCode(input);
  if (code === null) return Promise.reject(new TypedCodeError("not-a-code"));
  const url = new URL("/v1/pair", (options.relay ?? GLOBAL_RELAY).replace(/^wss:/, "https:"));
  url.protocol = "wss:";
  url.search = new URLSearchParams({ nameplate: splitPairCode(code).nameplate, role: "guest", v: "1" }).toString();
  return new Promise<RelayOffer>((resolve, reject) => {
    const guest = new PairCodeGuest(code);
    let answered = false;
    let settled = false;
    let socket: RelaySocket;
    const settle = (result: RelayOffer | TypedCodeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      try { socket.close(); } catch { }
      if (result instanceof TypedCodeError) reject(result);
      else resolve(result);
    };
    const aborted = () => settle(new TypedCodeError("unreachable"));
    const timer = setTimeout(() => settle(new TypedCodeError("unreachable")), EXCHANGE_MS);
    options.signal?.addEventListener("abort", aborted);
    try { socket = (options.connect ?? ((address) => new WebSocket(address)))(url.href); }
    catch { settle(new TypedCodeError("unreachable")); return; }
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (typeof event.data === "string" || settled) return;
      const frame = new Uint8Array(event.data as ArrayBuffer);
      if (!answered) {
        answered = true;
        try { socket.send(guest.answer(frame).slice().buffer); } catch { settle(new TypedCodeError("wrong")); }
        return;
      }
      let text: string;
      try { text = guest.open(frame); }
      catch (error) { settle(new TypedCodeError(error instanceof PairCodeExpiredError ? "expired" : "wrong")); return; }
      settle(checkedOffer(text));
    };
    socket.onclose = (event) => {
      // once the PC had its answer, only its drop (a plain close) means it turned the guess away
      settle(new TypedCodeError(answered ? (event.code === DROPPED ? "wrong" : "unreachable") : event.code === NO_HOST ? "no-pc" : event.code === BUSY ? "busy" : "unreachable"));
    };
  });
}

/** The offer as a scanned link's is taken: its key must give its PC id, and it must carry a pairing code. */
function checkedOffer(text: string): RelayOffer | TypedCodeError {
  let offer: RelayOffer;
  try { offer = validateOffer(JSON.parse(text)); } catch { return new TypedCodeError("forged"); }
  let keyId: string | null;
  try { keyId = deriveServerId(importPublicKey(offer.server_public_key)); } catch { keyId = null; }
  if (keyId !== offer.server_id || offer.code === undefined) return new TypedCodeError("forged");
  return offer;
}
