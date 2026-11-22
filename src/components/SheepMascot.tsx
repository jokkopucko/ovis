import "./SheepMascot.css";

import { useEffect, useRef } from "react";

import { SHEEP_FOR, type SheepScreen } from "../lib/relay/sheepBadges.ts";

export type SheepSize = 56 | 80 | 112;

/**
 * The owner's mascot for one pairing screen, decorative. Its engine is a chunk of its own, fetched when
 * the first sheep shows; until then the box keeps its size. It plays one pass, then rests; reduced motion draws its first pose.
 */
export function SheepMascot({ screen, size, badge = false }: { readonly screen: SheepScreen; readonly size: SheepSize; readonly badge?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const state = SHEEP_FOR[screen];
  useEffect(() => {
    const target = host.current;
    if (target === null) return;
    let stop: (() => void) | null = null, gone = false;
    const quiet = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    import("../lib/relay/mascot.ts")
      .then(({ playMascot, SMALL_BELOW_PX }) => { if (!gone) stop = playMascot(target, state, { small: size < SMALL_BELOW_PX, quiet }); })
      .catch((error: unknown) => { console.warn("Ovis: the mascot was not drawn", error); });
    return () => { gone = true; stop?.(); };
  }, [state, size]);
  const sheep = <span ref={host} className={`sheep-mascot sheep-mascot-${size}`} data-sheep={state} />;
  return badge ? <span className={`sheep-badge sheep-badge-${size}`}>{sheep}</span> : sheep;
}
