import { useEffect, useState } from "react";

export type HeaderConnection = "reconnecting" | "connected" | null;

export interface ConnectionFacts {
  scope: string;
  reportedBy: string | null;
  connected: boolean;
  connectedBefore: boolean;
  outputStopped: boolean;
}

export interface ConnectionTrack {
  lostOn: string | null;
  recoveredOn: string | null;
}

export const NO_TRACK: ConnectionTrack = { lostOn: null, recoveredOn: null };

export const CONNECTED_SHOWN_MS = 2000;

const lost = (facts: ConnectionFacts): boolean => !facts.connected && facts.connectedBefore && !facts.outputStopped;

export function stepConnection(track: ConnectionTrack, facts: ConnectionFacts): ConnectionTrack {
  if (facts.reportedBy !== facts.scope) return NO_TRACK;
  if (lost(facts)) return { lostOn: facts.scope, recoveredOn: null };
  if (facts.connected && track.lostOn === facts.scope) return { lostOn: null, recoveredOn: facts.scope };
  if (facts.connected && track.recoveredOn === facts.scope) return track;
  return NO_TRACK;
}

export function headerConnection(facts: ConnectionFacts, track: ConnectionTrack): HeaderConnection {
  if (facts.reportedBy !== facts.scope) return null;
  if (!facts.connected) return lost(facts) ? "reconnecting" : null;
  return track.recoveredOn === facts.scope || track.lostOn === facts.scope ? "connected" : null;
}

export function useHeaderConnection(facts: ConnectionFacts): HeaderConnection {
  const [track, setTrack] = useState<ConnectionTrack>(NO_TRACK);
  const isLost = lost(facts);
  useEffect(() => {
    setTrack((previous) => stepConnection(previous, facts));
  }, [isLost, facts.connected, facts.scope, facts.reportedBy]);
  useEffect(() => {
    if (track.recoveredOn === null) return;
    const timer = setTimeout(() => setTrack((previous) => ({ ...previous, recoveredOn: null })), CONNECTED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [track.recoveredOn]);
  return headerConnection(facts, track);
}
