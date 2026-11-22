import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/fonts/fonts.css";
import "../src/styles.css";
import { FilesDialog } from "../src/components/FilesDialog.tsx";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { RepoDiffViewer } from "../src/components/RepoDiffViewer.tsx";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { SettingsProvider, useSettings, type Settings } from "../src/lib/settings.ts";
import { useFileViewer } from "../src/lib/useFileViewer.ts";
import { useRepoDiffViewer } from "../src/lib/useRepoDiffViewer.ts";
import type { RepoDiffTarget } from "../src/lib/repoDiff.ts";

interface Files { machine: string; paneId: string; directory: string }
declare global { interface Window { repoDiffQA: { openFiles: (machine: string, paneId: string, directory: string) => void; closeFiles: () => void; settings: (patch: Partial<Settings>) => void; openDiff: (target: RepoDiffTarget) => void } } }

function Fixture() {
  const [files, setFiles] = useState<Files | null>(null);
  const { viewing: file, openFile, closeFile } = useFileViewer();
  const { viewing: diff, openDiff, closeDiff } = useRepoDiffViewer();
  const { update } = useSettings();
  window.repoDiffQA = { openFiles: (machine, paneId, directory) => setFiles({ machine, paneId, directory }), closeFiles: () => setFiles(null), settings: update, openDiff };
  return <main>
    <button type="button" id="outside">Outside</button>
    {files && <MachineContext.Provider value={files.machine}>
      <FilesDialog start={files.directory} paneId={files.paneId} viewing={file !== null || diff !== null}
        onOpenFile={(path) => openFile({ path, paneId: files.paneId, machineId: files.machine })}
        onOpenDiff={(comparison, entry) => openDiff({ machineId: files.machine, paneId: files.paneId, directory: files.directory, ...comparison, path: entry.path, oldPath: entry.old_path })}
        onBrowseFolders={() => {}}
        onClose={() => setFiles(null)} />
    </MachineContext.Provider>}
    {diff && <MachineContext.Provider value={diff.machineId}>
      <RepoDiffViewer key={`${diff.scope}:${diff.path}`} target={diff} onClose={closeDiff} onOpenFile={(path) => openFile({ path, paneId: diff.paneId, machineId: diff.machineId })} keyboardActive={file === null} />
    </MachineContext.Provider>}
    {file && <MachineContext.Provider value={file.machineId}>
      <FileViewer key={file.path} path={file.path} paneId={file.paneId} onClose={closeFile} />
    </MachineContext.Provider>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
