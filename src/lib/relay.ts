import { lazyChunk } from "./lazyChunk.ts";

export const loadRelayShell = lazyChunk(() => import("./relay/shell.tsx"));
