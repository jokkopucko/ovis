/**
 * A person's press on a link to a PC (a row of My PCs, the dashboard, a sidebar), kept for the page that press leads
 * to. That page takes it once: a reload of it, a tab the browser restored, and a page the phone app reopened by itself
 * as it started find none. A PC that only a press may open (one the account names and the device's list does not
 * hold) is opened by its own page only on that word.
 */
const TAPPED = "ovis-pc-tapped";

export function notePcTap(serverId: string): void {
  try { sessionStorage.setItem(TAPPED, serverId); } catch { /* no storage: the PC's page asks for the press itself */ }
}

/** The PC a press on this tab's last page led to, if any; read once. */
export function takePcTap(): string | null {
  try { const id = sessionStorage.getItem(TAPPED); sessionStorage.removeItem(TAPPED); return id; } catch { return null; }
}
