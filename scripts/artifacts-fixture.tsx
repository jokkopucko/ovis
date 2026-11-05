/** The real artifact chip, API and composer styles, with an isolated HTTP fixture. */
import { createRoot } from "react-dom/client";
import { Artifacts } from "../src/components/Artifacts.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import "../src/styles.css";
import "../src/components/Composer.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<SettingsProvider>
  <header style={{ height: 56 }}>Artifact fixture</header>
  <main style={{ height: "calc(100dvh - 56px)", display: "flex", flexDirection: "column" }}>
    <div style={{ flex: 1 }}>Conversation</div>
    <div className="composer">
      <div className="composer-surface" data-compact="">
        <textarea className="composer-text" aria-label="Message" style={{ height: 200 }} defaultValue="A tall draft leaves less room for published pages." />
        <div className="composer-controls composer-controls-left"><Artifacts paneId="fixture" status="done" /></div>
      </div>
    </div>
  </main>
</SettingsProvider>);
