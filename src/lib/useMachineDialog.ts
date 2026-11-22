import { useCallback, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "./actions.ts";
import { focusWorkspaceListToggle } from "./focus.ts";

export function useMachineDialog() {
  const [machineDialog, setMachineDialog] = useState<Machine | "new" | null>(null);
  const [addPcPreset, setAddPcPreset] = useState<AddPcPreset | null>(null);
  const addPcFocusReturn = useRef(false);
  const closeMachineDialog = useCallback(() => {
    setMachineDialog(null);
    setAddPcPreset(null);
    if (!addPcFocusReturn.current) return;
    addPcFocusReturn.current = false;
    focusWorkspaceListToggle();
  }, []);
  return { machineDialog, setMachineDialog, addPcPreset, setAddPcPreset, addPcFocusReturn, closeMachineDialog };
}
