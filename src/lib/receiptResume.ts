import { RECEIPT_RESUME_ID } from "../../shared/receipt-resume.ts";

/** Presentation-only correlation; never a credential, lease, or permission to send input. */
const KEY = "ovis:pi-receipt-resume";
let memory: string | undefined;
export function receiptResumeId(): string {
  if (memory) return memory;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && RECEIPT_RESUME_ID.test(saved)) return memory = saved;
  } catch {}
  if (typeof crypto.randomUUID === "function") memory = crypto.randomUUID();
  else {
    // Like API request IDs, this must work on plain-HTTP LAN origins too.
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
      const value = index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte;
      return value.toString(16).padStart(2, "0");
    }).join("");
    memory = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  try { localStorage.setItem(KEY, memory); } catch {}
  return memory;
}
