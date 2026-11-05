import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { ServerMessage } from "../../shared/protocol.ts";

/** Keeps the active terminal connection-chip state. */
export function useConnectionChip() {
  const [connected, setConnected] = useState(false);
  /** the active terminal's socket has been connected on this page before (PaneTerminal reports it): not
   *  connected, the chip says reconnecting; before this page's first connection to the PC, connecting */
  const [connectedBefore, setConnectedBefore] = useState(false);
  // the active slot's pane could not be drawn: no terminal is attached there to say so itself
  const paneLost = useCallback(() => setConnected(false), []);
  const [outputStopped, setOutputStopped] = useState(false);
  /** the split half and PC (`slot:machineId`) whose terminal last reported the state above: the header's
   *  connection line ignores state another half left behind (lib/headerConnection.ts) */
  const [reportedBy, setReportedBy] = useState<string | null>(null);
  return { connected, setConnected, connectedBefore, setConnectedBefore, paneLost, outputStopped, setOutputStopped, reportedBy, setReportedBy };
}

/** Creates the callback for server messages affecting the connection chip. */
export function useServerMessageHandler(setOutputStopped: Dispatch<SetStateAction<boolean>>) {
  const handleServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);
  }, []);
  return handleServerMessage;
}
