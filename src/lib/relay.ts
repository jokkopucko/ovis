import { lazyChunk } from "./lazyChunk.ts";

/** Hosted-shell callers load cryptography and mux code only when connecting to a PC. */
export const loadRelayChannel = lazyChunk(() => import("./relay/channel.ts"));

/** The shell's screens and the connection they lead to, loaded by lib/relay/boot.ts once the offer has left the address. */
export const loadRelayShell = lazyChunk(() => import("./relay/shell.tsx"));
