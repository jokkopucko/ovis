import { getTransport } from "./transport.ts";

/** Only this app's API gets correlation metadata; never change the global fetch function. */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const origin = typeof location === "undefined" ? "http://localhost" : location.origin;
  const target = new URL(url, origin);
  if (target.origin !== origin || !target.pathname.startsWith("/api/")) return getTransport().fetch(url, init);
  const headers = new Headers(init?.headers);
  if (!headers.has("x-request-id")) {
    // getRandomValues works on plain-HTTP LAN origins too; randomUUID does not.
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
      const value = index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte;
      return value.toString(16).padStart(2, "0");
    }).join("");
    headers.set("x-request-id", `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
  }
  return getTransport().fetch(url, { ...init, headers });
}
