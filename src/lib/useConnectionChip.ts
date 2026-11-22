import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { ServerMessage } from "../../shared/protocol.ts";

export function useConnectionChip() {
  const [connected, setConnected] = useState(false);
  const [connectedBefore, setConnectedBefore] = useState(false);
  const paneLost = useCallback(() => setConnected(false), []);
  const [outputStopped, setOutputStopped] = useState(false);
  const [reportedBy, setReportedBy] = useState<string | null>(null);
  return { connected, setConnected, connectedBefore, setConnectedBefore, paneLost, outputStopped, setOutputStopped, reportedBy, setReportedBy };
}

export function useServerMessageHandler(setOutputStopped: Dispatch<SetStateAction<boolean>>) {
  const handleServerMessage = useCallback((message: ServerMessage) => {
    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);
  }, []);
  return handleServerMessage;
}
