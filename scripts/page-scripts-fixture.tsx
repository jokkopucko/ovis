/** Owned, synthetic fixture for the file viewer's Page view: a field that stands for the message box, and the viewer as a popup or beside it. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import "../src/styles.css";

interface Shown { path: string; docked: boolean; at: number }
declare global { interface Window { pageScriptsQa: { open: (path: string, docked: boolean) => void; close: () => void; messages: Array<Record<string, unknown>> } } }
function Fixture() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [messages] = useState<Array<Record<string, unknown>>>([]);
  // `at`: every open is a viewer of its own, as closing and opening a file is in the app
  window.pageScriptsQa = { open: (path, docked) => setShown({ path, docked, at: Date.now() }), close: () => setShown(null), messages };
  return <SettingsProvider>
    <div style={{ display: "flex", height: "100vh" }}>
      <main style={{ flex: "1 1 0", minWidth: 0, padding: 16 }}>
        <textarea id="composer" aria-label="Message" rows={3} style={{ width: "100%" }} />
      </main>
      {shown?.docked && <FileViewer key={shown.at} docked path={shown.path} paneId={null} onClose={() => setShown(null)} />}
    </div>
    {shown && !shown.docked && <FileViewer key={shown.at} path={shown.path} paneId={null} onClose={() => setShown(null)} />}
  </SettingsProvider>;
}
// what a page's script says to the app around it: the probe pages say when they ran and which keys they got
addEventListener("message", (event) => { if (event.data && typeof event.data === "object" && "probe" in event.data) window.pageScriptsQa?.messages.push(event.data as Record<string, unknown>); });
createRoot(document.getElementById("root")!).render(<Fixture />);
