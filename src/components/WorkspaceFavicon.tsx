import { useEffect, useState, type ReactNode } from "react";

import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { probeFavicon } from "../lib/projectFavicon.ts";
import { useResourceUrl } from "../lib/useResourceUrl.ts";

/**
 * The project's own icon in place of `fallback`, when its folder keeps one. The folder is probed
 * once per session through that PC's /api/fs/favicon; with no icon (or one that will not draw)
 * the fallback stays exactly as it was.
 */
export function WorkspaceFavicon({ root, fallback }: { root: string | null; fallback: ReactNode }) {
  const machineId = useMachineId();
  const { fileUrl } = useMachineApi();
  const [found, setFound] = useState<{ root: string; path: string } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  useEffect(() => {
    if (root === null) return;
    let live = true;
    void probeFavicon(machineId, root).then((path) => { if (live && path !== null) setFound({ root, path }); });
    return () => { live = false; };
  }, [root, machineId]);
  const src = useResourceUrl(found === null ? null : fileUrl(found.path, null));

  if (root === null || found === null || found.root !== root || broken === found.path) return <>{fallback}</>;
  return <span className="sidebar-mark workspace-favicon" aria-hidden="true"><img src={src ?? undefined} alt="" width={16} height={16} onError={() => setBroken(found.path)} /></span>;
}
