import { useCallback, useEffect, useRef, useState } from "react";

import { WEB_PANEL_BELOW_KEY, sheetStep, webPagesBelow } from "./historyKeys.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";
import { diffTargetFromState, diffTargetState, type RepoDiffTarget } from "./repoDiff.ts";

export function useRepoDiffViewer() {
  const [viewing, setViewing] = useState(() => diffTargetFromState(window.history.state));
  const closing = useRef(false);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      if (sheetStep.taking(event) || sheetStep.holds(event)) return;
      closing.current = false;
      setViewing(diffTargetFromState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openDiff = useCallback((target: RepoDiffTarget) => {
    if (closing.current) return;
    const state = diffTargetState(window.history.state, target);
    if (diffTargetFromState(window.history.state)) window.history.replaceState(state, "");
    else {
      const { [WEB_PANEL_BELOW_KEY]: _below, ...pushed } = state;
      window.history.pushState(pushed, "");
    }
    setViewing(target);
  }, []);

  const closeDiff = useCallback(() => {
    if (closing.current) return;
    if (diffTargetFromState(window.history.state)) {
      closing.current = true;
      backUnderCurrentEntry(1 + webPagesBelow(window.history.state))?.catch(() => { closing.current = false; });
    } else setViewing(null);
  }, []);

  const releaseDiff = useCallback(() => {
    window.history.replaceState(diffTargetState(window.history.state, null), "");
    setViewing(null);
  }, []);

  return { viewing, openDiff, closeDiff, releaseDiff };
}
