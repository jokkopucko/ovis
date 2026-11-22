import { useCallback, useEffect, useState } from "react";

export interface RenameRequest { machineId: string; paneId: string }

export function useRenameRequest(selectedMachineId: string, selectedPaneId: string | null) {
  const [renameRequest, setRenameRequest] = useState<RenameRequest | null>(null);
  useEffect(() => setRenameRequest(null), [selectedMachineId, selectedPaneId]);
  const requestRename = useCallback((machineId: string, paneId: string) => setRenameRequest({ machineId, paneId }), []);
  const clearRenameRequest = useCallback(() => setRenameRequest(null), []);
  return { renameRequest, requestRename, clearRenameRequest };
}
