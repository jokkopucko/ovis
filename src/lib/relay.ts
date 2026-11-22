import { lazyChunk } from "./lazyChunk.ts";

export const loadRelayChannel = lazyChunk(() => import("./relay/channel.ts"));

export const loadRelayShell = lazyChunk(() => import("./relay/shell.tsx"));
