import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { damagedCopy } from "./state-document.ts";

/** Seen's asynchronous atomic replacement; the generic synchronous writer stays unchanged. */
export async function persistSeen(path: string, text: string, keepDamaged: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const backup = `${temporary}.bad`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    if (keepDamaged) {
      try {
        // Copy, rather than move, so a failed final rename leaves the original intact.
        const copy = await open(backup, "wx", 0o600);
        await copy.close();
        await copyFile(path, backup);
        await chmod(backup, 0o600);
        const kept = await open(backup, "r+");
        try { await kept.sync(); } finally { await kept.close(); }
        await rename(backup, damagedCopy(path));
      } catch (error) {
        throw new Error(`Cannot keep the damaged ${basename(path)} as ${basename(damagedCopy(path))} (${(error as NodeJS.ErrnoException).code ?? String(error)}), so it was not replaced`);
      }
    }
    await rename(temporary, path);
    // As with writeStateDocument, directory durability is best effort on unsupported platforms.
    if (process.platform !== "win32") {
      try {
        const directory = await open(dirname(path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {}
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    await rm(backup, { force: true }).catch(() => undefined);
  }
}
