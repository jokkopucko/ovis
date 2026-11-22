import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { ChatView } from "../src/components/ChatView.tsx";
import { SettingsProvider } from "../src/lib/settings.ts";
import type { AgentStatus, ConversationMetadata } from "../shared/protocol.ts";
declare global { interface Window { chatFallbackQA: {
  pane: (pane: string) => void; refresh: () => void; agent: (agent: string | null) => void; status: (status: AgentStatus | undefined) => void;
  metadata: (pane: string) => ConversationMetadata | null | undefined;
  forwarded: () => number;
  listening: () => boolean; output: () => void;
  until: (check: () => boolean) => Promise<void>;
} } }
const metadata = new Map<string, ConversationMetadata | null>();
let forwarded = 0;
let terminalOutput: (() => void) | null = null;
const waiting = new Set<() => void>();
const changed = (): void => { for (const wake of [...waiting]) wake(); };
const onMetadata = (pane: string, value: ConversationMetadata | null): void => { metadata.set(pane, value); forwarded += 1; changed(); };
const onTerminalOutput = (listener: (() => void) | null): void => { terminalOutput = listener; changed(); };
function Fixture() {
  const [agent, setAgent] = useState<string | null>("codex");
  const [pane, setPane] = useState("agent");
  const [refresh, setRefresh] = useState(0);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
  window.chatFallbackQA = {
    pane: setPane, agent: setAgent, status: setStatus, refresh: () => setRefresh((key) => key + 1),
    metadata: (id) => metadata.get(id), forwarded: () => forwarded, listening: () => terminalOutput !== null, output: () => terminalOutput?.(),
    until: (check) => new Promise<void>((resolve) => {
      const wake = () => { if (check()) { waiting.delete(wake); resolve(); } };
      waiting.add(wake);
      wake();
    }),
  };
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}><div style={{ position: "relative", flex: 1, minHeight: 0 }}><ChatView key={pane} paneId={pane} refreshKey={refresh} promptRefreshKey={refresh} promptDock={dock} connected ended={false} agent={pane === "shell" ? null : agent} agentStatus={status} conversationPushes={new URLSearchParams(location.search).has("pushes")} onMetadata={onMetadata} onTerminalOutput={onTerminalOutput} /></div><div ref={setDock} /></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
