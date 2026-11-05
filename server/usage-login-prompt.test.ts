import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loginPrompt, screenText } from "./usage-login-prompt.ts";

/** What the real CLIs wrote to a private PTY (Bun.spawn's terminal), recorded in a throwaway HOME before any approval. */
const fixture = (name: string): string => screenText(readFileSync(join(import.meta.dir, "fixtures/usage-login", `${name}.pty`), "utf8"));

describe("screenText", () => {
  it("drops a hyperlink's hidden target with its escape, so an address shows once", () => {
    const linked = "visit: \u001b]8;;https://claude.com/x?a=1\u0007https://claude.com/x?a=1\u001b]8;;\u0007\r\n";
    expect(screenText(linked)).toBe("visit: https://claude.com/x?a=1\n");
  });
});

describe("loginPrompt", () => {
  it("reads Codex's device page and one-time code (codex-cli 0.163.0)", () => {
    expect(loginPrompt("codex", fixture("codex-device"))).toEqual({ url: "https://auth.openai.com/codex/device", user_code: "PG8L-CV4AR", wants_code: false });
  });

  it("reads Claude Code's whole sign-in address once, and its paste-code prompt (2.1.312)", () => {
    const text = fixture("claude");
    const prompt = loginPrompt("claude", text);
    expect(prompt.url).toStartWith("https://claude.com/cai/oauth/authorize?code=true&client_id=");
    expect(prompt.url).toEndWith("&state=KfijVgmbSDNX1H5_O_Ybg_Cnhm536OEuSUabhQPIkiw");
    expect(text.split("https://claude.com/cai/oauth/authorize").length - 1).toBe(1);
    expect(prompt.user_code).toBeNull();
    expect(prompt.wants_code).toBe(true);
  });

  it("says nothing before the CLI has printed its address", () => {
    expect(loginPrompt("claude", "Opening browser to sign in…\n")).toEqual({ url: null, user_code: null, wants_code: false });
    expect(loginPrompt("codex", "Welcome to Codex [v0.163.0]\n")).toEqual({ url: null, user_code: null, wants_code: false });
  });

  it("offers no address outside the provider's own sign-in hosts, nor a plain http one", () => {
    expect(loginPrompt("claude", "If the browser didn't open, visit: https://claude.com.evil.example/cai/oauth/authorize?x=1\nPaste code here if prompted > ").url).toBeNull();
    expect(loginPrompt("codex", "1. Open this link\n   http://auth.openai.com/codex/device\n2. Enter this one-time code\n   ABCD-12345\n").url).toBeNull();
  });

  it("takes the latest address and code when a login printed more than once", () => {
    const twice = `${fixture("codex-device")}\n${fixture("codex-device").replace("PG8L-CV4AR", "ZZZZ-11111")}`;
    expect(loginPrompt("codex", twice).user_code).toBe("ZZZZ-11111");
  });
});
