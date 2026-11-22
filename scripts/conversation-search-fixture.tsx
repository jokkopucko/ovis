import "../src/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import { OpenFileContext } from "../src/lib/filePaths.ts";

declare global {
  interface Window {
    searchQa: { open: () => void };
  }
}

function Fixture() {
  const [request, setRequest] = useState(0);
  window.searchQa = { open: () => setRequest((value) => value + 1) };
  return <div className="terminal-host"><div className="terminal-stack is-chat" style={{ position: "relative", height: window.innerHeight }}>
    <OpenFileContext.Provider value={() => {}}>
      <ChatView paneId="search-pane" refreshKey={0} connected ended={false} agent="claude" agentStatus="idle" searchRequest={request} />
    </OpenFileContext.Provider>
  </div></div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Search fixture root missing");
createRoot(root).render(<SettingsProvider><Fixture /></SettingsProvider>);
