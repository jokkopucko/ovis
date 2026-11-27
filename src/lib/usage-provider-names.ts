import type { UsageProviderId } from "../../shared/usage.ts";

export const PROVIDER_NAME: Readonly<Record<UsageProviderId, string>> = {
  claude: "Claude", codex: "Codex", cursor: "Cursor", copilot: "GitHub Copilot", grok: "Grok", antigravity: "Antigravity", opencode: "OpenCode", devin: "Devin", kimi: "Kimi",
};
