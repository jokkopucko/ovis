import { useCallback, useState } from "react";
import type { SplitSlot } from "./split.ts";

export interface SearchRequest {
  slot: SplitSlot;
  machineId: string;
  paneId: string;
  serial: number;
}

export function useSearchRequest(setDrawerOpen: (open: boolean) => void) {
  const [searchRequest, setSearchRequest] = useState<SearchRequest>({ slot: "a", machineId: "", paneId: "", serial: 0 });
  const requestSearch = useCallback((slot: SplitSlot, machineId: string, paneId: string) => {
    setDrawerOpen(false);
    setSearchRequest((request) => ({ slot, machineId, paneId, serial: request.serial + 1 }));
  }, [setDrawerOpen]);
  return { searchRequest, requestSearch };
}
