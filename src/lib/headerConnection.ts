/**
 * The connection line in the header's title area: the selected PC's connection said in words where the
 * crumb (PC › workspace › folder) is, as a messenger says "Connecting…" under a chat's name. Lost after
 * this page had it, the line says Reconnecting; back, it says Connected for a moment, then the crumb
 * returns. The first connection to a pane is the chip's to tell: a pane opening is not a reconnect.
 * Each PC's news is its own: a recovery is shown only while the PC it came back on is the one shown.
 * Output stopped for a stall is not a reconnect (ws.ts retries nothing then): the chip says Disconnected.
 */
import { useEffect, useState } from "react";

export type HeaderConnection = "reconnecting" | "connected" | null;

export interface ConnectionFacts {
  /** the PC the header shows, with the split half showing it: the line is about that connection only */
  scope: string;
  /** the half and PC whose terminal reported the facts below (null: none yet). Facts another half left
   *  behind, before the active one reports, say nothing about it */
  reportedBy: string | null;
  connected: boolean;
  /** this page has had the connection before (useConnectionChip) */
  connectedBefore: boolean;
  /** the bridge stopped the output for a stall: nothing reconnects until an attach */
  outputStopped: boolean;
}

/** What the line remembers between renders: where it last said the connection was lost, and where it
 *  came back (null: no Connected to show) */
export interface ConnectionTrack {
  lostOn: string | null;
  recoveredOn: string | null;
}

export const NO_TRACK: ConnectionTrack = { lostOn: null, recoveredOn: null };

/** how long Connected stays before the crumb comes back */
export const CONNECTED_SHOWN_MS = 2000;

const lost = (facts: ConnectionFacts): boolean => !facts.connected && facts.connectedBefore && !facts.outputStopped;

/** The next track, given new facts: only a loss and a return on the same scope, both reported by it, make Connected. */
export function stepConnection(track: ConnectionTrack, facts: ConnectionFacts): ConnectionTrack {
  if (facts.reportedBy !== facts.scope) return NO_TRACK;
  if (lost(facts)) return { lostOn: facts.scope, recoveredOn: null };
  if (facts.connected && track.lostOn === facts.scope) return { lostOn: null, recoveredOn: facts.scope };
  if (facts.connected && track.recoveredOn === facts.scope) return track;
  return NO_TRACK;
}

/** What the line says, given the connection and the track. A loss on this scope says Connected the render
 *  the connection is back, before the effect moves the track: the crumb never shows between the two. */
export function headerConnection(facts: ConnectionFacts, track: ConnectionTrack): HeaderConnection {
  if (facts.reportedBy !== facts.scope) return null;
  if (!facts.connected) return lost(facts) ? "reconnecting" : null;
  return track.recoveredOn === facts.scope || track.lostOn === facts.scope ? "connected" : null;
}

/** The line, with Connected held for CONNECTED_SHOWN_MS after a reconnect on the scope shown. */
export function useHeaderConnection(facts: ConnectionFacts): HeaderConnection {
  const [track, setTrack] = useState<ConnectionTrack>(NO_TRACK);
  const isLost = lost(facts);
  useEffect(() => {
    setTrack((previous) => stepConnection(previous, facts));
    // the facts that move the track: a fact elsewhere in the object does not
  }, [isLost, facts.connected, facts.scope, facts.reportedBy]);
  useEffect(() => {
    if (track.recoveredOn === null) return;
    const timer = setTimeout(() => setTrack((previous) => ({ ...previous, recoveredOn: null })), CONNECTED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [track.recoveredOn]);
  return headerConnection(facts, track);
}
