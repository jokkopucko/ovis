import React, { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "../src/components/ChatView.css";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";

declare global { interface Window { outlineQA: { keyboard: (active: boolean) => void } } }

function Fixture() {
  const [keyboardActive, setKeyboardActive] = useState(true);
  window.outlineQA = { keyboard: (active) => flushSync(() => setKeyboardActive(active)) };
  const docked = new URLSearchParams(location.search).has("docked");
  const viewer = <FileViewer path="guide.md" paneId={null} docked={docked} keyboardActive={keyboardActive} onClose={() => document.getElementById("root")!.replaceChildren()} />;
  return docked ? <div style={{ display: "flex", height: "100vh" }}><main style={{ flex: 1 }}><textarea aria-label="Pane input" /></main>{viewer}</div> : viewer;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
