import type { AccountOs } from "../../shared/account-asker.ts";
import type { RemoteAccess } from "../../shared/protocol.ts";

export interface PageLocation {
  protocol: string;
  hostname: string;
  origin: string;
  secure: boolean;
  shell?: boolean;
}

export type PhonePlan =
  | { kind: "here"; url: string }
  | { kind: "served"; url: string }
  | { kind: "command"; command: string; url: string | null }
  | { kind: "stopped" }
  | { kind: "missing" }
  | { kind: "unknown" };

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]" || hostname === "::1";
}

export function phonePlan(page: PageLocation, access: RemoteAccess | null): PhonePlan {
  if (page.protocol === "https:" && page.secure && !page.shell && !isLoopbackHost(page.hostname)) return { kind: "here", url: page.origin };
  if (access === null) return { kind: "unknown" };
  const tailscale = access.tailscale;
  if (tailscale.state !== "running") return { kind: tailscale.state };
  if (tailscale.serving_url !== null) return { kind: "served", url: tailscale.serving_url };
  if (tailscale.serve_command !== null) return { kind: "command", command: tailscale.serve_command, url: tailscale.serve_url };
  return { kind: "unknown" };
}

export function deviceOs(userAgent: string, maxTouchPoints = 0): AccountOs | null {
  const ua = userAgent;
  return /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "ios" : /Android/.test(ua) ? "android" : /Macintosh/.test(ua) ? "macos"
    : /Windows/.test(ua) ? "windows" : /CrOS/.test(ua) ? "chromeos" : /Linux/.test(ua) ? "linux" : null;
}

export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|Chromium\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  return browser ? `${device} · ${browser}` : device;
}

/** The `?pair=CODE` a QR code carries, taken off the address at once so it stays out of history and referrers. */
export function takePairCode(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const code = url.searchParams.get("pair") ?? "";
  if (code !== "") {
    url.searchParams.delete("pair");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }
  return code.replace(/\D/g, "").slice(0, 6);
}
